import { dirname } from "node:path";
import type { RunEvent } from "@nimplex/contracts";
import type { NimplexRuntime } from "@nimplex/runtime";
import { eventText, safeText } from "../display.ts";
import { projectInstructions } from "./local-io.ts";
import { emptyResources, loadResources } from "./resources.ts";
import type { Preferences, Session, SessionStore, Turn } from "./store.ts";

export interface Choice {
  value: string;
  label: string;
  description?: string;
}
export interface TerminalView {
  refresh(): void;
  notice(title: string, text: string): void;
  choose(title: string, choices: Choice[]): Promise<string | undefined>;
  draft(text: string): void;
  externalEditor(text: string): Promise<string>;
  exit(): void;
  authenticate(provider?: string): Promise<void>;
  refreshResources?(): void;
}
export interface ActiveTask {
  session: Session;
  turn: Turn;
  observer: AbortController;
  stopRequested: boolean;
}

export class Controller {
  resources = emptyResources();
  session: Session;
  view!: TerminalView;
  readonly tasks = new Map<string, ActiveTask>();
  nextContextMode: "continue" | "reset" | "compact" = "continue";
  closed = false;
  constructor(
    readonly client: NimplexRuntime,
    readonly store: SessionStore,
    readonly preferences: Preferences,
    readonly cwd: string,
  ) {
    this.session = store.create();
  }
  changed() {
    this.view.refresh();
  }
  settingsChanged() {
    this.store.savePreferences(this.preferences);
    this.changed();
  }
  reloadResources() {
    const preferences = this.store.preferences(this.preferences, true);
    if (!this.client.models().some((model) => model.model === preferences.model))
      throw new Error(`Model is not in the priced catalog: ${preferences.model}. Reload canceled.`);
    const resources = loadResources(this.cwd, dirname(this.store.directory));
    // Publish one validated snapshot. Existing turns already captured their own configuration.
    Object.assign(this.preferences, preferences);
    this.resources = resources;
    this.view?.refreshResources?.();
    this.changed();
  }
  get active() {
    return this.tasks.get(this.session.id);
  }
  get head() {
    return this.session.headRunId;
  }
  requireHead() {
    if (!this.head)
      throw new Error(
        "This conversation has no workspace yet. Send a task or resume a saved conversation.",
      );
    return this.head;
  }
  fresh() {
    this.session = this.store.create();
    this.nextContextMode = "continue";
    this.changed();
  }
  /** Queue durable in-flight input for the running turn of this conversation. */
  async queue(kind: "steer" | "followUp", text: string) {
    const task = this.active;
    if (!task?.turn.runId) throw new Error("No running task to steer in this conversation.");
    const queued = await this.client.queueInput(task.session.id, { kind, text });
    this.view.notice(
      kind === "steer" ? "Steering queued" : "Follow-up queued",
      `${kind === "steer" ? "Pi interrupts at its next boundary" : "Pi continues after the current work"} (${queued.entryId}).`,
    );
  }
  async submit(prompt: string, attachments?: { path: string; content: string }[]) {
    if (this.active) {
      // Pi harness sessions steer the running turn, like Pi's own terminal.
      if (this.session.engine === "pi-harness" && this.active.turn.runId) {
        await this.queue("steer", prompt);
        return;
      }
      throw new Error(
        "A task is running. Stop it with Esc, or use /background before starting another conversation.",
      );
    }
    const owner = this.session;
    if (!owner.turns.length && owner.title === "New conversation")
      owner.title = prompt.slice(0, 70);
    const turn: Turn = { prompt, events: [] };
    owner.turns.push(turn);
    const task: ActiveTask = {
      session: owner,
      turn,
      observer: new AbortController(),
      stopRequested: false,
    };
    this.tasks.set(owner.id, task);
    const preferences = { ...this.preferences };
    const contextMode = this.nextContextMode;
    this.nextContextMode = "continue";
    this.store.save(owner);
    this.changed();
    try {
      const result = await this.client.startTurn(owner.id, {
        prompt,
        model: preferences.model,
        sandbox: preferences.sandbox,
        instructions: [
          preferences.mode === "read_only"
            ? "Inspect the supplied workspace with read tools and propose a plan."
            : "Complete the user's coding task in /workspace. Preserve existing work and explain the result.",
          projectInstructions(owner.cwd),
        ]
          .filter(Boolean)
          .join("\n\n"),
        timeout: preferences.timeout,
        contextMode,
        executionMode: preferences.mode,
        ...(preferences.thinking ? { thinking: preferences.thinking } : {}),
        attachments,
      });
      turn.runId = result.runId;
      owner.headRunId = result.runId;
      this.store.save(owner);
      if (task.stopRequested) await this.client.stopTurn(result.runId);
      await this.observe(task);
    } catch (error) {
      if (!turn.runId) owner.turns.splice(owner.turns.indexOf(turn), 1);
      if (!task.observer.signal.aborted)
        this.view.notice(
          "Task needs attention",
          `${errorMessage(error)}${turn.runId ? `\nRun: ${turn.runId}. Use /resume to reconnect; the committed history is stored locally.` : "\nThe request was not retried. Check /runs before submitting again."}`,
        );
    } finally {
      this.store.save(owner);
      this.tasks.delete(owner.id);
      this.changed();
    }
  }
  private async observe(task: ActiveTask) {
    const { turn, observer } = task;
    if (!turn.runId) return;
    const after = turn.events.at(-1)?.seq;
    for await (const event of this.client.events(turn.runId, {
      after,
      signal: observer.signal,
    })) {
      if (event.type === "run.snapshot") continue;
      turn.events.push(event);
      if (event.type.startsWith("sandbox."))
        task.session.sandbox = this.client.sandboxUsage(task.session.id);
      this.store.save(task.session);
      this.changed();
    }
    turn.result = await this.client.getTurn(turn.runId);
    task.session.sandbox = this.client.sandboxUsage(task.session.id);
    this.store.save(task.session);
    this.changed();
  }
  async resume(session: Session): Promise<void> {
    this.session = this.tasks.get(session.id)?.session ?? session;
    this.changed();
    if (!session.headRunId || this.tasks.has(session.id)) return;
    const result = await this.client.getTurn(session.headRunId);
    const turn = session.turns.find((t) => t.runId === session.headRunId);
    if (!turn) return;
    if (result.error === "runtime_interrupted") {
      const choice = await this.view.choose("Resume interrupted work", [
        {
          value: "resume",
          label: "Resume execution",
          description: "Continue from committed progress; model calls may incur cost",
        },
        {
          value: "view",
          label: "View history",
          description: "Open the saved conversation without executing",
        },
      ]);
      if (choice === "resume") {
        await this.client.resumeTurn(session.id);
        return this.resume(this.client.getSession(session.id));
      }
    }
    turn.result = result;
    if (["completed", "failed", "killed", "canceled"].includes(result.status)) {
      // Replay any events missed while the terminal was closed.
      for await (const event of this.client.events(session.headRunId, {
        after: turn.events.at(-1)?.seq,
      })) {
        if (event.type !== "run.snapshot") turn.events.push(event);
      }
      this.store.save(session);
      this.changed();
      return;
    }
    const task = { session, turn, observer: new AbortController(), stopRequested: false };
    this.tasks.set(session.id, task);
    void this.observe(task)
      .catch((error) => {
        if (!task.observer.signal.aborted)
          this.view.notice("Connection interrupted", errorMessage(error));
      })
      .finally(() => {
        this.tasks.delete(session.id);
        this.changed();
      });
  }
  async stop() {
    const task = this.active;
    if (!task) return;
    task.stopRequested = true;
    if (task.turn.runId) {
      await this.client.stopTurn(task.turn.runId);
      this.view.notice("Stopping", "The runtime stopped the turn.");
    } else
      this.view.notice("Stopping", "The task will be stopped as soon as its run ID is returned.");
  }
  async stopAll() {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.stopRequested = true;
    const outcomes = await Promise.allSettled(
      tasks.map((task) =>
        task.turn.runId ? this.client.stopTurn(task.turn.runId) : Promise.resolve(),
      ),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.view.notice(
      "Stopping conversations",
      `${tasks.length} running conversation(s) received a stop request.`,
    );
  }
  fork(index = this.session.turns.length - 1) {
    const selected = this.session.turns[index];
    if (
      selected &&
      (!selected.runId ||
        !selected.result ||
        !["completed", "failed", "killed", "canceled"].includes(selected.result.status))
    )
      throw new Error("Choose a completed or stopped turn before forking.");
    this.session = this.client.forkSession(this.session.id, selected?.runId);
    this.changed();
  }
  lastAnswer() {
    return (
      this.session.turns
        .at(-1)
        ?.events.filter((e) => e.type === "message.delta")
        .map((e) => String((e.payload as { text: string }).text))
        .join("\n\n") ?? ""
    );
  }
  transcript() {
    return `# ${safeText(this.session.title)}\n\n${this.session.turns
      .map(
        (turn) =>
          `## You\n\n${turn.prompt}\n\n${turn.events
            .map((event) => eventText(event, Number.MAX_SAFE_INTEGER))
            .filter(Boolean)
            .join("\n")}\n`,
      )
      .join("\n")}`;
  }
  close() {
    this.closed = true;
    for (const task of this.tasks.values()) task.observer.abort();
    this.view.exit();
  }
}
export function errorMessage(error: unknown) {
  return safeText(error instanceof Error ? error.message : error, 2000);
}
export function textEvent(event: RunEvent): string {
  return String((event.payload as { text?: string })?.text ?? "");
}
