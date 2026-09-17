import {
  type SessionEntry,
  type SessionHeader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface PiSessionViewSnapshot {
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
}

const READ_METHODS = new Set<keyof SessionManager>([
  "getCwd",
  "getSessionDir",
  "getSessionId",
  "getSessionFile",
  "getLeafId",
  "getLeafEntry",
  "getEntry",
  "getLabel",
  "getBranch",
  "buildContextEntries",
  "getHeader",
  "getEntries",
  "getTree",
  "getSessionName",
  "buildSessionContext",
  "getChildren",
  "isPersisted",
  "usesDefaultSessionDir",
]);

/**
 * Stable read facade for the public ExtensionRunner's concrete SessionManager
 * dependency. Replaces whole in-memory projections through public factories;
 * never patches Pi internals or permits a second writable session authority.
 */
export class PiSessionView {
  readonly manager: SessionManager;
  private current: SessionManager;
  private invalidated = false;

  constructor(snapshot: PiSessionViewSnapshot) {
    this.current = this.build(snapshot);
    this.manager = new Proxy(this.current, {
      get: (_target, key) => {
        // The facade is an ordinary value, including when returned by async extension code.
        if (key === "then") return undefined;
        if (typeof key !== "string" || !READ_METHODS.has(key as keyof SessionManager))
          throw new Error(`Read-only Pi session view: ${String(key)}`);
        // Resolve the current projection when called, including saved method references.
        return (...args: unknown[]) => {
          if (this.invalidated) throw new Error("Pi session view is no longer active");
          const method = Reflect.get(this.current, key) as (...args: unknown[]) => unknown;
          return structuredClone(Reflect.apply(method, this.current, args));
        };
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });
  }

  private build(snapshot: PiSessionViewSnapshot) {
    const known = new Set<string>();
    for (const entry of snapshot.entries) {
      if (known.has(entry.id)) throw new Error(`Duplicate Pi entry: ${entry.id}`);
      if (entry.parentId !== null && !known.has(entry.parentId))
        throw new Error(`Missing Pi parent: ${entry.parentId}`);
      known.add(entry.id);
    }
    if (snapshot.leafId !== null && !known.has(snapshot.leafId))
      throw new Error(`Missing Pi leaf: ${snapshot.leafId}`);
    const manager = SessionManager.inMemory(
      snapshot.header.cwd,
      undefined,
      structuredClone([snapshot.header, ...snapshot.entries]),
    );
    if (snapshot.leafId === null) manager.resetLeaf();
    else manager.branch(snapshot.leafId);
    return manager;
  }

  replace(snapshot: PiSessionViewSnapshot) {
    if (this.invalidated) throw new Error("Pi session view is no longer active");
    if (snapshot.header.id !== this.current.getSessionId())
      throw new Error("Replacing a Pi session identity requires a new extension activation");
    const candidate = this.build(snapshot);
    this.current = candidate;
  }

  invalidate() {
    this.invalidated = true;
  }
}
