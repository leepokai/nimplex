import { parseArgs } from "node:util";
import { THINKING_LEVELS, thinkingLevel } from "@nimplex/contracts";

export const HELP = `nimplex — local coding-agent harness

  nimplex                       Open the interactive terminal
  nimplex "Your task"            Run one turn and exit
  printf 'Your task' | nimplex   Read a task from stdin
  nimplex --resume SESSION_ID    Open a saved session (or append a supplied task)
  nimplex login                 Save a local Anthropic credential
  nimplex login PROVIDER        Sign in using a built-in Pi provider
  nimplex login codex           Sign in with a Codex / ChatGPT subscription
  nimplex logout [PROVIDER] Remove the saved local credential
  nimplex --watch TURN_ID        Read committed turn events
  nimplex --files TURN_ID        List a turn's workspace files

  --model MODEL                 Default: claude-haiku-4-5
                                Pi providers: provider/model
                                Subscription: openai-codex/gpt-5.6-sol
  --thinking LEVEL              off|minimal|low|medium|high|xhigh
  --sandbox e2b|docker           Native execution provider; default: e2b
  --timeout SECONDS             Active turn time limit; default: 180
  --state-dir PATH              Select an isolated local state root
  --env-file PATH               Load credentials from this environment file
  --request-id ID               Deduplicate a one-shot task within its session
  --help                        Show this help

No API server, Postgres, or worker is required. Local SQLite stores sessions,
events and workspace snapshots. New sessions run on the Pi harness engine;
NIMPLEX_ENGINE=pi-executor selects the legacy executor, and existing sessions keep
their recorded engine. The current directory's .env is loaded when
present; existing environment variables take precedence. ANTHROPIC_API_KEY or
nimplex login supplies the Anthropic credential; OPENAI_API_KEY or nimplex login
openai supplies the OpenAI one. Native providers need their own setup.

Follow-ups share a session workspace and sandbox. @path attaches selected local
text files; the local project is not automatically copied into /workspace.
Closing nimplex stops execution; /resume can explicitly resume interrupted work.
Model usage is recorded. Sandbox cost is an estimate: running seconds times the
provider's list rate (E2B by allocated size; Docker is $0), shown as "(est.)". Codex
subscription models use provider-managed quota; --timeout still applies.`;

export function readOptions(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      model: { type: "string", default: "claude-haiku-4-5" },
      sandbox: { type: "string", default: "e2b" },
      thinking: { type: "string" },
      timeout: { type: "string", default: "180" },
      watch: { type: "string" },
      files: { type: "string" },
      kill: { type: "string" },
      resume: { type: "string" },
      "state-dir": { type: "string" },
      "env-file": { type: "string" },
      "request-id": { type: "string" },
    },
  });
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400)
    throw new Error("--timeout must be an integer between 1 and 86400.");
  const sandbox = values.sandbox;
  if (sandbox !== "e2b" && sandbox !== "docker")
    throw new Error("--sandbox must be e2b or docker.");
  const thinking =
    values.thinking === undefined ? undefined : thinkingLevel.safeParse(values.thinking);
  if (thinking && !thinking.success)
    throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
  const prompt = positionals.join(" ").trim();
  if ([values.watch, values.files, values.kill, prompt].filter(Boolean).length > 1)
    throw new Error("Choose one operation at a time: a task, --watch, --files or --kill.");
  if (values["request-id"] !== undefined) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(values["request-id"]))
      throw new Error(
        "--request-id must contain 1–128 letters, digits, dots, underscores, colons or hyphens.",
      );
    if (values.watch || values.files || values.kill)
      throw new Error("--request-id applies only to a submitted task.");
  }
  return {
    ...values,
    timeout,
    thinking: thinking?.data,
    sandbox: sandbox as "e2b" | "docker",
    prompt,
    explicit: new Set(
      ["model", "sandbox", "timeout", "thinking"].filter((name) =>
        argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)),
      ),
    ),
  };
}
