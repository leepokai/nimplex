import { parseArgs } from "node:util";

export const HELP = `nimplex — local coding-agent harness

  nimplex                       Open the interactive terminal
  nimplex "Your task"            Run one turn and exit
  printf 'Your task' | nimplex   Read a task from stdin
  nimplex --resume SESSION_ID    Open a saved session (or append a supplied task)
  nimplex login                 Save a local Anthropic credential
  nimplex login codex           Sign in with a Codex / ChatGPT subscription
  nimplex logout                Remove the saved local credential
  nimplex logout codex          Remove nimplex's Codex subscription login
  nimplex --watch TURN_ID        Read committed turn events
  nimplex --files TURN_ID        List a turn's workspace files

  --model MODEL                 Default: claude-haiku-4-5
                                Subscription: openai-codex/gpt-5.6-sol
  --sandbox e2b|docker           Native execution provider; default: e2b
  --budget USD                  Model budget per turn; default: 0.20
  --timeout SECONDS             Active turn time limit; default: 180
  --state-dir PATH              Select an isolated local state root
  --env-file PATH               Load credentials from this environment file
  --request-id ID               Deduplicate a one-shot task within its session
  --help                        Show this help

No API server, Postgres, or worker is required. Local SQLite stores sessions,
events and workspace snapshots. NIMPLEX_ENGINE=pi-harness opts new sessions into
the experimental Pi harness engine; existing sessions keep their recorded engine. The current directory's .env is loaded when
present; existing environment variables take precedence. ANTHROPIC_API_KEY or
nimplex login supplies the model credential. Native providers need their own setup.

Follow-ups share a session workspace and sandbox. @path attaches selected local
text files; the local project is not automatically copied into /workspace.
Closing nimplex stops execution; /resume can explicitly resume interrupted work.
Sandbox charges are separate from model budgets. Codex subscription models use
provider-managed quota, not the USD model budget; --timeout still applies.`;

export function readOptions(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      model: { type: "string", default: "claude-haiku-4-5" },
      sandbox: { type: "string", default: "e2b" },
      budget: { type: "string", default: "0.20" },
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
  const budget = Number(values.budget);
  const timeout = Number(values.timeout);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("--budget must be greater than 0.");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400)
    throw new Error("--timeout must be an integer between 1 and 86400.");
  const sandbox = values.sandbox;
  if (sandbox !== "e2b" && sandbox !== "docker")
    throw new Error("--sandbox must be e2b or docker.");
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
    budget,
    timeout,
    sandbox: sandbox as "e2b" | "docker",
    prompt,
    explicit: new Set(
      ["model", "sandbox", "budget", "timeout"].filter((name) =>
        argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)),
      ),
    ),
  };
}
