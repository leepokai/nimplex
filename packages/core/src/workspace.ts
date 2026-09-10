// Tier 0 ceilings. budget_usd prices model tokens only, so the file tree needs its own cap or a
// single `head -c 1G /dev/zero > big` turn would be stored for free.
// ponytail: flat per-run limits; per-org quotas when someone actually asks.

export const WORKSPACE_MAX_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_MAX_FILES = 2_000;

import type { WorkspaceMetadata } from "@nimplex/contracts";

/** Returns a human-readable reason when the tree exceeds the ceilings, else null. */
export function checkWorkspaceLimits(
  files: Record<string, Uint8Array>,
  metadata: WorkspaceMetadata = {},
): string | null {
  const paths = [...new Set([...Object.keys(files), ...Object.keys(metadata)])];
  if (paths.length > WORKSPACE_MAX_FILES) {
    return `workspace_too_large: ${paths.length} files (max ${WORKSPACE_MAX_FILES})`;
  }
  let total = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
  for (const p of paths) total += files[p]?.byteLength ?? 0;
  if (total > WORKSPACE_MAX_BYTES) {
    return `workspace_too_large: ${total} bytes (max ${WORKSPACE_MAX_BYTES})`;
  }
  return null;
}
