import { z } from "zod";

/** Execution engines a run or session can record; continuations inherit their parent's. */
export const RUN_ENGINES = ["pi-executor", "pi-harness"] as const;
export const runEngine = z.enum(RUN_ENGINES);
export type RunEngine = z.infer<typeof runEngine>;

/** Pi thinking levels; thinking output is billed as output tokens by the providers we price. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const thinkingLevel = z.enum(THINKING_LEVELS);
export type ThinkingLevelId = z.infer<typeof thinkingLevel>;
