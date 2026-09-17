import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import { type Storage, value, type Write } from "@earendil-works/pi-agent-core/harness/session";
import type { PiCompatibilityEntry, PiCompatibilityMetadata } from "@nimplex/contracts";
import { z } from "zod";

const configuration = z.object({
  model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
  thinkingLevel: z.string(),
  activeToolNames: z.array(z.string()),
});
type MetadataEntry = Extract<
  PiCompatibilityEntry,
  {
    type: "model_change" | "thinking_level_change" | "session_info" | "label";
  }
>;
type Fields<T> = T extends unknown ? Omit<T, "id" | "parentId" | "timestamp"> : never;

export interface MetadataProjection {
  fields: Fields<MetadataEntry>;
  mapping: Omit<PiCompatibilityMetadata, "version" | "entryId">;
}

/** Only native value changes create metadata records; tool-list-only changes do not invent Pi history. */
export async function projectMetadata(
  writes: Write[],
  source: Storage,
  metadataLane: string,
  context: Context,
): Promise<MetadataProjection[]> {
  const projected: MetadataProjection[] = [];
  const configurations = new Map<string, z.infer<typeof configuration> | undefined>();
  for (const [sourceWriteIndex, write] of writes.entries()) {
    if (write.kind !== "value") continue;
    const { namespace, key } = write;
    if (namespace === "pi.lane.config") {
      if (write.op !== "set")
        throw new Error("Deleting a configured Pi lane requires explicit migration");
      const next = configuration.parse(write.value);
      if (!configurations.has(key)) {
        const stored = await source.getValue(value(namespace, key), context);
        configurations.set(key, stored ? configuration.parse(stored.value) : undefined);
      }
      const previous = configurations.get(key);
      const mapping = { lane: key, namespace, key, sourceWriteIndex } as const;
      if (
        previous?.model.provider !== next.model.provider ||
        previous?.model.modelId !== next.model.modelId
      )
        projected.push({ fields: { type: "model_change", ...next.model }, mapping });
      if (previous?.thinkingLevel !== next.thinkingLevel)
        projected.push({
          fields: { type: "thinking_level_change", thinkingLevel: next.thinkingLevel },
          mapping,
        });
      configurations.set(key, next);
    } else if (namespace === "pi.session.name") {
      if (key !== "") throw new Error("Invalid Pi session name address");
      const name =
        write.op === "set"
          ? z
              .string()
              .parse(write.value)
              .replace(/[\r\n]+/g, " ")
              .trim()
          : undefined;
      projected.push({
        fields: { type: "session_info", ...(name === undefined ? {} : { name }) },
        mapping: { lane: metadataLane, namespace, key, sourceWriteIndex },
      });
    } else if (namespace === "pi.entry.label") {
      const label = write.op === "set" ? z.string().parse(write.value) : undefined;
      projected.push({
        fields: { type: "label", targetId: key, ...(label === undefined ? {} : { label }) },
        mapping: { lane: metadataLane, namespace, key, sourceWriteIndex },
      });
    }
  }
  return projected;
}
