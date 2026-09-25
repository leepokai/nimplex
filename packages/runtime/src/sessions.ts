import { randomUUID } from "node:crypto";
import { posix, resolve } from "node:path";
import type { RunEvent, SessionSnapshot, StartTurnRequest } from "@nimplex/contracts";
import { checkWorkspaceLimits, continuationMessages, isTerminal } from "@nimplex/core";
import { resolveLocalModel } from "./models.ts";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import {
  PI_LANE,
  PI_TENANT,
  type RuntimeStore,
  type SessionEngine,
  type StoredSession,
  type StoredTurn,
} from "./store.ts";

/** Session records and immutable turn snapshots; execution ownership remains in NimplexRuntime. */
export class Sessions {
  constructor(private readonly store: RuntimeStore) {}
  createSession(
    cwd: string,
    title = "New conversation",
    engine: SessionEngine = "pi-harness",
  ): SessionSnapshot {
    const session: StoredSession = {
      id: randomUUID(),
      cwd: resolve(cwd),
      title,
      updatedAt: new Date().toISOString(),
      turnIds: [],
      sandboxGeneration: 0,
      engine,
    };
    this.store.transaction(() => this.store.saveSession(session));
    return this.getSession(session.id);
  }
  getSession(id: string): SessionSnapshot {
    const session = this.store.session(id);
    return {
      version: 1,
      id,
      cwd: session.cwd,
      title: session.title,
      updatedAt: session.updatedAt,
      parentSessionId: session.parentSessionId,
      ...(session.engine ? { engine: session.engine } : {}),
      headRunId: session.turnIds.at(-1),
      turns: session.turnIds.map((id) => {
        const turn = this.store.turn(id);
        return {
          prompt: turn.request.prompt,
          runId: id,
          result: turn.result,
          events: publicEvents(this.store, id),
        };
      }),
    };
  }
  listSessions(): SessionSnapshot[] {
    return this.store
      .sessions()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => this.getSession(s.id));
  }
  renameSession(id: string, title: string) {
    if (!title.trim()) throw new Error("A session title is required.");
    this.store.transaction(() => {
      const session = this.store.session(id);
      session.title = title.slice(0, 120);
      session.updatedAt = new Date().toISOString();
      this.store.saveSession(session);
    });
  }
  forkSession(id: string, turnId?: string): SessionSnapshot {
    const source = this.store.session(id);
    const selected = turnId ?? source.turnIds.at(-1);
    const index = selected ? source.turnIds.indexOf(selected) : -1;
    if (selected && (index < 0 || !isTerminal(this.store.turn(selected).result.status)))
      throw new Error("Choose a completed or stopped turn to fork.");
    if (selected && this.store.turn(selected).result.error === "runtime_interrupted")
      throw new Error("Resume interrupted work before branching from it.");
    const branch: StoredSession = {
      id: randomUUID(),
      cwd: source.cwd,
      title: `${source.title} · branch`,
      updatedAt: new Date().toISOString(),
      turnIds: source.turnIds.slice(0, index + 1),
      parentSessionId: id,
      sandboxGeneration: 0,
      ...(source.engine ? { engine: source.engine } : {}),
    };
    this.store.transaction(() => {
      this.store.saveSession(branch);
      // A harness session's conversation lives in Pi's tree: copy the path that ended
      // the selected turn into the branch's own Pi scope, in this same transaction.
      if (source.engine === "pi-harness" && selected) this.forkPiSession(id, branch.id, selected);
    });
    return this.getSession(branch.id);
  }
  private forkPiSession(sourceId: string, branchId: string, turnId: string) {
    const inline = <T>(operation: () => T) => operation();
    const lookup = this.store.db.prepare(
      "SELECT data FROM pi_store_values WHERE tenant_id=? AND session_id=? AND namespace='pi.result' AND key=?",
    );
    // A branch inherits earlier turns without their Pi results; those stay in the scope of
    // the ancestor that ran them, and fork-copied entries keep their identity. Ancestors
    // cannot disappear: a branch inherits turns only from sessions that own turns, and
    // RuntimeStore.deleteSession refuses any session with turns.
    let ownerId: string | undefined = sourceId;
    let result = lookup.get(PI_TENANT, ownerId, turnId);
    while (!result && ownerId) {
      ownerId = this.store.session(ownerId).parentSessionId;
      if (ownerId) result = lookup.get(PI_TENANT, ownerId, turnId);
    }
    if (!result || !ownerId)
      throw new Error("The selected turn has no settled Pi operation to branch from.");
    const from = new SqlitePiStorage(
      this.store.db,
      { tenantId: PI_TENANT, sessionId: ownerId },
      () => {},
      { transaction: inline },
    );
    const to = new SqlitePiStorage(
      this.store.db,
      { tenantId: PI_TENANT, sessionId: branchId },
      () => {},
      { transaction: inline },
    );
    const { tipId } = JSON.parse(String(result.data)) as { tipId: string | null };
    if (tipId === null) throw new Error("The selected turn left no conversation to branch from.");
    to.importForkSync(from, { scope: "branch", branch: PI_LANE, entryId: tipId, position: "at" });
  }
  seedTurn(sessionId: string, request: StartTurnRequest): StoredTurn {
    const session = this.store.session(sessionId);
    const parentId = session.turnIds.at(-1);
    const parent = parentId ? this.store.turn(parentId) : undefined;
    if (parent && !isTerminal(parent.result.status))
      throw new Error("The previous turn is still active.");
    if (parent?.result.error === "runtime_interrupted")
      throw new Error("Resume the interrupted turn first, or start a new session.");
    const workspace = this.store.workspace(parentId);
    for (const attachment of request.attachments ?? []) {
      const path = attachment.path;
      if (
        !path.startsWith("/workspace/") ||
        posix.normalize(path) !== path ||
        path.includes("\0") ||
        path.endsWith("/")
      )
        throw new Error("Invalid attachment path.");
      if (Buffer.byteLength(attachment.content) > 131072)
        throw new Error("Attachment exceeds 128 KiB.");
      for (
        let ancestor = posix.dirname(path);
        ancestor !== "/workspace";
        ancestor = posix.dirname(ancestor)
      ) {
        if (workspace.files[ancestor] || workspace.metadata[ancestor]?.kind === "symlink")
          throw new Error("Attachment parent is not a directory.");
      }
      if (workspace.metadata[path] && workspace.metadata[path]?.kind !== "file")
        throw new Error("Attachment conflicts with an existing directory or symlink.");
      if (
        [...Object.keys(workspace.files), ...Object.keys(workspace.metadata)].some((existing) =>
          existing.startsWith(`${path}/`),
        )
      )
        throw new Error("Attachment conflicts with an existing directory.");
      workspace.files[path] = new TextEncoder().encode(attachment.content);
      workspace.metadata[path] = { kind: "file", mode: 0o644 };
    }
    const exceeded = checkWorkspaceLimits(workspace.files, workspace.metadata);
    if (exceeded) throw new Error(exceeded);
    if (session.sandboxState && session.sandboxProvider !== request.sandbox)
      throw new Error(
        "This session already owns a different sandbox. Use a new session to change providers.",
      );
    const id = randomUUID(),
      now = new Date().toISOString();
    const requestId = request.requestId ?? randomUUID();
    request = { ...request, requestId };
    const selected = resolveLocalModel(request.model);
    // The legacy executor only speaks Anthropic Messages and Codex, without thinking.
    if (session.engine !== "pi-harness") {
      if (selected.provider !== "anthropic" && selected.provider !== "openai-codex")
        throw new Error(
          "This session runs on the legacy executor, which supports only Anthropic and Codex models. Open a new session on the default Pi harness engine (unset NIMPLEX_ENGINE=pi-executor if it is set).",
        );
      if (request.thinking && request.thinking !== "off")
        throw new Error(
          "This session runs on the legacy executor, which has no thinking levels. Open a new session on the default Pi harness engine (unset NIMPLEX_ENGINE=pi-executor if it is set).",
        );
    }
    const turn: StoredTurn = {
      sessionId,
      request,
      config: {
        instructions: request.instructions,
        input: request.prompt,
        prior_messages:
          parent && request.contextMode !== "reset"
            ? continuationMessages(parent.config, this.store.events(parent.result.id))
            : [],
        execution_mode: request.executionMode,
        compact_context: request.contextMode === "compact",
      },
      result: {
        id,
        status: "running",
        external_user_id: null,
        model: {
          provider: selected.provider,
          id: selected.id,
        },
        sandbox: { provider: request.sandbox },
        sandbox_ref: null,
        billing_mode: selected.billing,
        spent_usd: 0,
        workspace_revision: parent?.result.workspace_revision ?? 0,
        sandbox_generation: session.sandboxGeneration,
        error: null,
        created_at: now,
        started_at: now,
        completed_at: null,
      },
    };
    this.store.transaction(() => {
      session.turnIds.push(id);
      session.updatedAt = now;
      if (session.title === "New conversation") session.title = request.prompt.slice(0, 70);
      this.store.saveSession(session);
      this.store.saveTurn(turn);
      this.store.saveWorkspace(id, workspace);
      this.store.saveAcceptedInput({
        version: 1,
        sessionId,
        requestId,
        turnId: id,
        acceptedAt: now,
        request,
      });
      this.store.append(id, [
        {
          type: "input.accepted",
          payload: { version: 1, session_id: sessionId, request_id: requestId },
        },
        { type: "run.started", payload: { session_id: sessionId } },
      ]);
    });
    return turn;
  }
}

export function publicEvents(store: RuntimeStore, id: string, after = -1): RunEvent[] {
  return store.events(id, after).map((event) => {
    if (event.type !== "file.changed") return event;
    const { content_base64: _content, ...payload } = event.payload as Record<string, unknown>;
    return { ...event, payload };
  });
}
