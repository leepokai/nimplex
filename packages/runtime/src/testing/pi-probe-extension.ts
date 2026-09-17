import { createWriteTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Bash } from "just-bash";

export interface ExtensionWitness {
  restored: number;
  effects: number;
}

/** The same extension hooks run against baseline Pi and the candidate bridge. */
export function probeExtension(
  witness: ExtensionWitness,
  write?: ReturnType<typeof createWriteTool>,
): ExtensionFactory {
  return (pi) => {
    if (write)
      pi.registerTool({
        ...write,
        name: "probe",
        async execute(id, args, signal, update) {
          witness.effects++;
          return write.execute(id, args, signal, update);
        },
      });
    let counter = 0;
    pi.on("session_start", (_event, ctx) => {
      for (const entry of ctx.sessionManager.getEntries())
        if (entry.type === "custom" && entry.customType === "probe-state")
          counter = (entry.data as { counter: number }).counter;
      witness.restored = counter;
    });
    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant") return;
      pi.appendEntry("probe-state", { counter: ++counter });
      if (event.message.stopReason === "stop")
        return {
          message: { ...event.message, content: [{ type: "text", text: "EXTENSION FINAL" }] },
        };
    });
    pi.on("tool_call", (event) => {
      if (event.toolName === "probe") event.input.content = "EXTENSION FILE";
    });
    pi.on("tool_result", () => ({
      content: [{ type: "text", text: "EXTENSION RESULT" }],
      details: { transformed: true },
    }));
  };
}

export function workspaceProbe(bash: Bash, witness: ExtensionWitness) {
  return probeExtension(
    witness,
    createWriteTool("/workspace", {
      operations: {
        writeFile: async (path, content) => {
          await bash.fs.writeFile(path, content);
        },
        mkdir: async (path) => {
          await bash.fs.mkdir(path, { recursive: true });
        },
      },
    }),
  );
}
