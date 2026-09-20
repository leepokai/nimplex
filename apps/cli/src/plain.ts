import { createInterface } from "node:readline/promises";
import { HELP, readOptions } from "./config.ts";
import { eventText, runText } from "./display.ts";
import { openRuntime } from "./local-runtime.ts";
import { attachmentsFromPrompt, projectInstructions } from "./terminal/local-io.ts";

/** Headless is a product surface over the same session runtime as the TUI. */
export async function main() {
  const options = readOptions(process.argv.slice(2));
  if (options.help) return console.log(HELP);
  const runtime = openRuntime(options["state-dir"]);
  let active: string | undefined;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    if (active) void runtime.stopTurn(active);
  };
  const terminate = () => {
    interrupted = true;
    void runtime.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", terminate);
  try {
    if (options.files) {
      console.log(
        runtime
          .files(options.files)
          .map((f) => `${f.path}  ${f.bytes} bytes`)
          .join("\n") || "No files.",
      );
      return;
    }
    if (options.kill) {
      console.log(runText(await runtime.stopTurn(options.kill)));
      return;
    }
    const watch = async (id: string) => {
      active = id;
      if (interrupted) await runtime.stopTurn(id);
      for await (const event of runtime.events(id)) {
        const text = eventText(event);
        if (text) console.log(text);
      }
      console.log(runText(runtime.getTurn(id)));
      if (runtime.getTurn(id).status !== "completed") process.exitCode = 1;
      active = undefined;
    };
    if (options.watch) {
      await watch(options.watch);
      return;
    }
    let prompt = options.prompt;
    if (!prompt && !process.stdin.isTTY) {
      // Decode as a stream so multi-byte characters split across chunks stay intact.
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        prompt += chunk;
        if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error("Piped input exceeds 1 MiB.");
      }
      prompt = prompt.trim();
    }
    if (options["request-id"] && !prompt)
      throw new Error("--request-id requires a one-shot task argument or piped prompt.");
    const session = options.resume
      ? runtime.getSession(options.resume)
      : runtime.createSession(process.cwd());
    console.log(`Session: ${session.id}`);
    if (!prompt && options.resume) {
      const result = await runtime.resumeTurn(session.id);
      await watch(result.runId);
      return;
    }
    const execute = async (text: string) => {
      const turn = await runtime.startTurn(session.id, {
        requestId: options["request-id"],
        prompt: text,
        instructions: [
          "Complete the user's coding task in /workspace. Preserve existing work.",
          projectInstructions(session.cwd),
        ]
          .filter(Boolean)
          .join("\n\n"),
        model: options.model,
        sandbox: options.sandbox,
        timeout: options.timeout,
        ...(options.thinking ? { thinking: options.thinking } : {}),
        executionMode: "build",
        contextMode: "continue",
        attachments: attachmentsFromPrompt(text, session.cwd),
      });
      console.log(`Turn: ${turn.runId}`);
      console.log(`Request: ${turn.requestId}`);
      await watch(turn.runId);
    };
    if (prompt) {
      await execute(prompt);
      return;
    }
    if (!process.stdin.isTTY)
      throw new Error("Supply a task argument or pipe a prompt into nimplex.");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (!interrupted) {
        const text = (await input.question("nimplex › ")).trim();
        if (text === "/exit") break;
        if (text) await execute(text);
      }
    } finally {
      input.close();
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", terminate);
    await runtime.close();
  }
}
