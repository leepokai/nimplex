// Test-only preload: exercise real E2B commands with a failing or slow lifecycle API.
import { getSandboxProvider } from "@nimplex/sandbox";

const provider = getSandboxProvider("e2b");
const pause = provider.pause?.bind(provider);
provider.pause = async (state) => {
  console.log("E2E_PAUSE_ENTER");
  if (process.env.NIMPLEX_TEST_PAUSE_FAULT === "reject") throw new Error("injected pause failure");
  await new Promise((done) => setTimeout(done, 4000));
  await pause?.(state);
};
