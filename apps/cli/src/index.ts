import { existsSync } from "node:fs";
import { HELP, readOptions } from "./config.ts";

export async function main() {
  try {
    const options = readOptions(process.argv.slice(2));
    if (options.help) {
      console.log(HELP);
      return;
    }
    const envFile = options["env-file"] ?? ".env";
    if (options["env-file"] || existsSync(envFile)) process.loadEnvFile(envFile);
    const [command, provider = "anthropic"] = options.prompt.split(/\s+/);
    if (command === "login" || command === "logout") {
      const auth = await import("./auth.ts");
      if (command === "login") await auth.login(provider);
      else await auth.logout(provider);
      return;
    }
    if (
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !options.help &&
      !options.prompt &&
      !options.watch &&
      !options.files &&
      !options.kill &&
      !options["request-id"]
    ) {
      const { startTerminal } = await import("./terminal/start.ts");
      await startTerminal(options);
    } else {
      const plain = await import("./plain.ts");
      await plain.main();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to start nimplex.");
    process.exitCode = 1;
  }
}
