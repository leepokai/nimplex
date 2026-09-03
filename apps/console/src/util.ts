/** 回應物件去掉伺服器補的欄位（id / created_at…），回填成請求形狀時用。 */
export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const out = { ...obj };
  for (const key of keys) delete out[key];
  return out;
}
