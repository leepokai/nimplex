/**
 * Drizzle 0.45 wraps query failures in DrizzleQueryError; the Postgres error is in cause.
 * Extract SQLSTATE here (23505 unique violation, 22023 invalid parameter), not via err.code.
 */
export function pgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_INVALID_PARAMETER_VALUE = "22023";
