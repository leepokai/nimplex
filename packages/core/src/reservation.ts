import type { TokenRate } from "./pricing.ts";

/** All reservation arithmetic rounds up to the database's USD micro-unit. */
export function planReservation(
  availableUsd: number,
  inputTokenBound: number,
  rate: TokenRate,
  outputLimit = 4096,
): { reservedUsd: number; maxOutputTokens: number } | null {
  if (!Number.isSafeInteger(inputTokenBound) || inputTokenBound <= 0)
    throw new Error("invalid token bound");
  if (!(rate.inputPerMtok > 0 && rate.outputPerMtok > 0)) throw new Error("invalid token rate");
  const availableMicros = Math.floor(availableUsd * 1e6 + 1e-7);
  const inputMicros = Math.ceil(inputTokenBound * rate.inputPerMtok);
  const maxOutputTokens = Math.min(
    outputLimit,
    Math.floor((availableMicros - inputMicros) / rate.outputPerMtok),
  );
  if (maxOutputTokens < 1) return null;
  return {
    reservedUsd: Math.ceil(inputMicros + maxOutputTokens * rate.outputPerMtok) / 1e6,
    maxOutputTokens,
  };
}
