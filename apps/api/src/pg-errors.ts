/**
 * drizzle 0.45 起所有 query 失敗都包成 DrizzleQueryError，真正的 Postgres 錯誤在 cause。
 * 要看 SQLSTATE（23505 唯一衝突、22023 參數無效…）一律經過這裡，不要直接讀 err.code。
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
