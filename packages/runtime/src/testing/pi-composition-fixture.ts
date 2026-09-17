import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createAgentSession,
  createWriteTool,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type FakeAnthropicOptions, startFakeAnthropic } from "@nimplex/testkit";

/** Real pinned Pi session; all effects and credentials are synthetic and isolated. */
export async function compositionFixture(
  extension?: ExtensionFactory,
  upstreamOptions?: FakeAnthropicOptions,
) {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-pi-gate-"));
  const upstream = await startFakeAnthropic(0, {
    script: [{ name: "probe", input: { path: "probe.txt", content: "committed?" } }],
    ...upstreamOptions,
  });
  let effects = 0;
  const errors: string[] = [];
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 10 },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        const write = createWriteTool(directory);
        pi.registerTool({
          ...write,
          name: "probe",
          async execute(id, args, signal, update) {
            effects++;
            return write.execute(id, args, signal, update);
          },
        });
      },
      ...(extension ? [extension] : []),
    ],
  });
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "synthetic-pi-gate-key");
    await resourceLoader.reload();
    const model = getBuiltinModels("anthropic")[0];
    if (!model) throw new Error("The pinned Pi catalog contains no Anthropic model.");
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: join(directory, "agent"),
      model: { ...model, baseUrl: upstream.url },
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      tools: ["probe"],
    });
    await session.bindExtensions({ onError: (event) => errors.push(event.error) });
    return {
      session,
      upstream,
      directory,
      errors,
      get effects() {
        return effects;
      },
      async close() {
        await session.abort();
        session.dispose();
        await upstream.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
