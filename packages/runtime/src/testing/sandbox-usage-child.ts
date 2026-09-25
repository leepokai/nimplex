// Child process for the sandbox-usage SIGKILL test: starts a native command in a
// disk-backed fake E2B sandbox and reports once it has launched; the parent kills it.
import { startTurnRequest } from "@nimplex/contracts";
import { registerSandboxProvider } from "@nimplex/sandbox";
import { fakeSandboxProvider, nativeExecutor } from "@nimplex/testkit";
import { NimplexRuntime } from "../runtime.ts";

const [root, directory] = process.argv.slice(2);
if (!root || !directory) throw new Error("usage: sandbox-usage-child ROOT STATE_DIR");
let ids = { sessionId: "", runId: "" };
const fake = fakeSandboxProvider({
  root,
  backendId: "e2b",
  pause: true,
  commandMs: 2500,
  onLaunch: () => process.send?.({ stage: "launched", ...ids }),
});
registerSandboxProvider(fake.provider);
const runtime = new NimplexRuntime({
  directory,
  credential: () => ({ apiKey: "unused", baseUrl: null }),
  engine: "pi-executor",
  executor: nativeExecutor(1),
});
const session = runtime.createSession(directory);
ids = { sessionId: session.id, runId: "" };
const turn = await runtime.startTurn(
  session.id,
  startTurnRequest.parse({ prompt: "Native", sandbox: "e2b" }),
);
ids.runId = turn.runId;
