import type { readOptions } from "../config.ts";
import { openRuntime } from "../local-runtime.ts";
import { Controller, errorMessage } from "./controller.ts";
import { loadResources } from "./resources.ts";
import { SessionStore } from "./store.ts";
import { View } from "./view.ts";

export async function startTerminal(options: ReturnType<typeof readOptions>) {
  const client = openRuntime(options["state-dir"]);
  const store = new SessionStore(client, process.cwd());
  const preferences = store.preferences({
    theme: "dark",
    model: options.model,
    sandbox: options.sandbox,
    timeout: options.timeout,
    mode: "build",
    expanded: false,
    statusline: true,
    thinking: options.thinking,
  });
  if (options.explicit.has("model")) preferences.model = options.model;
  if (options.explicit.has("sandbox")) preferences.sandbox = options.sandbox;
  if (options.explicit.has("timeout")) preferences.timeout = options.timeout;
  if (options.explicit.has("thinking")) preferences.thinking = options.thinking;
  const controller = new Controller(client, store, preferences, process.cwd());
  const view = new View(controller);
  controller.view = view;
  const close = () => controller.close();
  process.on("SIGTERM", close);
  try {
    view.start();
    try {
      controller.resources = loadResources(controller.cwd);
      view.refreshResources();
    } catch (error) {
      view.notice(
        "Resources could not be loaded",
        `${errorMessage(error)}\nFix the resource file and run /reload. Built-in commands remain available.`,
      );
    }
    if (options.resume) await controller.resume(client.getSession(options.resume));
    await view.done;
  } finally {
    process.off("SIGTERM", close);
    view.exit();
    await client.close();
  }
}
