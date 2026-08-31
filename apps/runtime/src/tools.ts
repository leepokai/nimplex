import type Anthropic from "@anthropic-ai/sdk";

// 沙箱 stub 的最小介面——只依賴我們用到的三個方法，
// 避免綁死 @cloudflare/sandbox 的內部型別（early preview，API 會動）。
export interface SandboxLike {
  exec(
    command: string,
  ): Promise<{ stdout?: string; stderr?: string; success?: boolean; exitCode?: number }>;
  writeFile(path: string, content: string): Promise<unknown>;
  readFile(path: string): Promise<{ content?: string }>;
}

export const toolDefs: Anthropic.Tool[] = [
  {
    name: "bash",
    description:
      "Run a shell command in your personal cloud computer (a persistent Ubuntu container). " +
      "State (files, installed packages) persists across calls within this session.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
  },
  {
    name: "write_file",
    description: "Write a file in your cloud computer. Creates parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path, e.g. /workspace/app.py" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from your cloud computer.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
];

const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

export async function runTool(
  sandbox: SandboxLike,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "bash": {
      const result = await sandbox.exec(String(input.command ?? ""));
      return JSON.stringify({
        success: result.success ?? true,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout ?? ""),
        stderr: truncate(result.stderr ?? ""),
      });
    }
    case "write_file": {
      await sandbox.writeFile(String(input.path ?? ""), String(input.content ?? ""));
      return JSON.stringify({ success: true, path: input.path });
    }
    case "read_file": {
      const file = await sandbox.readFile(String(input.path ?? ""));
      return truncate(file.content ?? "");
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
