import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import {
  operationMeta,
  operationState,
  type Storage,
  setValue,
  value,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import { type PiSummaryResponse, piSummaryResponse } from "@nimplex/contracts";
import type { PiSummaryBoundary } from "../pi-summary-models.ts";

export const summaryResponseAddress = (usageId: string) =>
  value<PiSummaryResponse>("nimplex.pi.summary.response", usageId);
type Scope = {
  operationId: string;
  lane: string;
  attempt: number;
  kind: "compaction" | "branch_summary";
};

function json<T>(input: T): T {
  return JSON.parse(
    JSON.stringify(input, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item))
        throw new Error("Summary response must contain finite JSON numbers");
      return item;
    }),
  ) as T;
}

/** Enforced response/usage transaction boundary over Pi's public Storage and Models ports. */
export class PiSummaryResponses {
  readonly storage: Storage;
  readonly boundary: PiSummaryBoundary;
  private readonly metadataKey = `nimplex-summary-${randomUUID()}`;
  private readonly bindings = new Map<string, Scope>();
  private readonly pending = new Map<string, PiSummaryResponse>();
  private readonly activeRequests = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(
    private readonly source: Storage,
    context: Context,
    private readonly assertAuthority: () => void,
  ) {
    this.storage = new Proxy(source, {
      get: (target, property) => {
        if (property === "commit")
          return (writes: Write[], context: Context) => {
            this.assertOpen();
            const frozen = structuredClone(writes);
            const result = this.queue.then(() => this.commit(frozen, context));
            this.queue = result.then(
              () => {},
              () => {},
            );
            return result;
          };
        if (property === "close")
          return (context: Context) => {
            this.closing ??= this.queue.then(async () => {
              this.bindings.clear();
              this.pending.clear();
              this.activeRequests.clear();
              await source.close(context);
            });
            return this.closing;
          };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    this.boundary = {
      begin: async (model, options) => {
        this.assertOpen();
        const token = options?.metadata?.[this.metadataKey];
        const scope = typeof token === "string" ? this.bindings.get(token) : undefined;
        if (!scope) throw new Error("Summary request is missing its host binding");
        this.bindings.delete(token as string);
        const [stored, meta] = await Promise.all([
          source.getValue(operationState(scope.operationId), context),
          source.getValue(operationMeta(scope.operationId), context),
        ]);
        const state = stored?.value;
        if (
          state?.at !== "summary.effect_pending" ||
          !state.request ||
          state.attempt !== scope.attempt ||
          meta?.value.lane !== scope.lane
        )
          throw new Error("Summary request does not match its committed intent");
        const selected = state.summaryContext.configuration.model;
        if (selected.provider !== model.provider || selected.modelId !== model.id)
          throw new Error("Summary request model does not match its committed intent");
        const kind =
          state.task.boundary.kind === "commit_navigation" ? "branch_summary" : "compaction";
        if (kind !== scope.kind)
          throw new Error("Summary request kind does not match its committed intent");
        const identity = {
          ...scope,
          taskId: state.task.taskId,
          requestIndex: state.request.index,
          usageId: state.request.usageId,
          model: selected,
        };
        const committed = await source.getValue(summaryResponseAddress(identity.usageId), context);
        // Recheck live admissions after the read: two callers may await the same
        // absent durable record. No await may separate this check and admission.
        if (
          committed ||
          this.pending.has(identity.usageId) ||
          this.activeRequests.has(identity.usageId)
        )
          throw new Error("Summary request identity was already used");
        const metadata = { ...options?.metadata };
        delete metadata[this.metadataKey];
        this.assertOpen();
        options?.signal?.throwIfAborted();
        this.assertAuthority();
        this.activeRequests.add(identity.usageId);
        return {
          options: { ...options, metadata },
          capture: (original, delivered) => {
            this.assertOpen();
            if (!this.activeRequests.has(identity.usageId))
              throw new Error("Summary response was captured twice");
            const record = piSummaryResponse.parse(
              json({
                version: 1,
                ...identity,
                response: original,
                delivered: {
                  stopReason: delivered.stopReason,
                  errorMessage: delivered.errorMessage,
                },
              }),
            );
            this.pending.set(record.usageId, record);
            this.activeRequests.delete(record.usageId);
          },
        };
      },
    };
  }

  private assertOpen() {
    if (this.closing) throw new Error("Summary response storage is closed");
  }

  attach(harness: Pick<AgentHarness, "hooks" | "events">) {
    const clear = (operationId: string) => {
      for (const [token, scope] of this.bindings)
        if (scope.operationId === operationId) this.bindings.delete(token);
    };
    const dispose = harness.hooks.on("before_request", (event) => {
      if (event.step !== "compaction" && event.step !== "branch_summary") return undefined;
      this.assertOpen();
      clear(event.runId);
      const token = randomUUID();
      this.bindings.set(token, {
        operationId: event.runId,
        lane: event.lane,
        attempt: event.attempt,
        kind: event.step,
      });
      return { streamOptions: { metadata: { [this.metadataKey]: token } } };
    });
    const outcomes = [
      harness.events.on("compaction_end", (event) => clear(event.runId)),
      harness.events.on("navigation_end", (event) => clear(event.runId)),
      harness.events.on("run_end", (event) => clear(event.runId)),
    ];
    return () => {
      dispose();
      for (const dispose of outcomes) dispose();
      this.bindings.clear();
    };
  }

  private async commit(writes: Write[], context: Context) {
    if (
      writes.some(
        (write) =>
          write.kind === "value" && write.namespace === summaryResponseAddress("").namespace,
      )
    )
      throw new Error("Summary response records are immutable and host-owned");
    const extras: Write[] = [];
    const captured: string[] = [];
    const usage = writes.filter((write) => write.kind === "usage");
    for (const write of writes) {
      if (!usage.length || write.kind !== "value" || write.namespace !== "pi.op.state") continue;
      const previous = (await this.source.getValue(operationState(write.key), context))?.value;
      if (previous?.at !== "summary.effect_pending" || !previous.request) continue;
      const row = usage.find((write) => write.row.id === previous.request?.usageId)?.row;
      if (!row) continue;
      const next = write.op === "set" ? (write.value as typeof previous) : undefined;
      if (
        next?.at !== "summary.effect_pending" ||
        next.request !== undefined ||
        next.task.taskId !== previous.task.taskId ||
        next.attempt !== previous.attempt ||
        !isDeepStrictEqual(next.usageIds, [...previous.usageIds, row.id]) ||
        captured.includes(row.id)
      )
        throw new Error("Summary response has an invalid native settlement transition");
      const record = this.pending.get(row.id);
      if (
        !record ||
        record.operationId !== write.key ||
        record.taskId !== previous.task.taskId ||
        record.attempt !== previous.attempt ||
        record.requestIndex !== previous.request.index
      )
        throw new Error("Summary usage has no matching captured response");
      const response = record.response as { usage?: unknown };
      if (!isDeepStrictEqual(json(row.usage), response.usage))
        throw new Error("Summary usage does not match its original response");
      if (await this.source.getValue(summaryResponseAddress(row.id), context))
        throw new Error("Summary response identity was already committed");
      extras.push(setValue(summaryResponseAddress(row.id), record));
      captured.push(row.id);
    }
    for (const write of usage) {
      if (this.pending.has(write.row.id) && !captured.includes(write.row.id))
        throw new Error("Captured summary response is missing its native settlement transition");
    }
    const receipt = await this.source.commit([...writes, ...extras], context);
    for (const id of captured) this.pending.delete(id);
    return receipt;
  }

  async read(context: Context): Promise<PiSummaryResponse[]> {
    return (await this.source.scanValues(summaryResponseAddress(""), context)).map((row) =>
      piSummaryResponse.parse(row.value),
    );
  }
}
