import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { type ExtensionRunner, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";
import type { PiExtensionMutations } from "./mutations.ts";

/** Keep Pi's registered-tool context while adapting its public harness signature. */
export function extensionTools(
  runner: ExtensionRunner,
  mutations: PiExtensionMutations,
  assertAuthority: () => void,
  replayPolicy: ReadonlyMap<string, "safe" | "never"> = new Map(),
): AgentHarnessTool<undefined>[] {
  return runner.getAllRegisteredTools().map((registered) => {
    const tool = wrapRegisteredTool(registered, runner);
    return {
      ...tool,
      // An extension cannot declare arbitrary external effects safe on the host's behalf.
      replay: replayPolicy.get(tool.name) ?? "never",
      async execute(id, args, update, _toolContext, _invocation, context) {
        await mutations.flush();
        assertAuthority();
        context.abortSignal?.throwIfAborted();
        const result = await tool.execute(id, args, context.abortSignal, update);
        await mutations.flush();
        assertAuthority();
        return result;
      },
    };
  });
}
