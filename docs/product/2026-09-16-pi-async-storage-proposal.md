# Proposed Pi async storage and lifecycle seam

Prepared after the [0.85.1 composition experiments](2026-09-16-pi-composition-gate.md).
This is a concrete upstream design proposal, not an implemented Pi API or an
upstream submission. No message or pull request has been sent to Pi maintainers.

**Reassessment:** the pinned package also exports `AgentHarness` and an async
`Storage` port. Positive commit and process-recovery qualification is recorded in
the composition report. Evaluate that public route and its extension compatibility
before treating this AgentSession-specific proposal or a fork as necessary.

## Required change

Add an explicit durable storage participant to AgentSession and its runtime
replacement layer. Observers remain UI notifications. Storage failures propagate
through a separate fatal execution path and cannot be swallowed by extension
error handling or converted into an ordinary successful tool outcome.

Keep Pi's model/tool loop and behavior. Do not duplicate its loop in nimplex.
Retain synchronous JSONL compatibility where applicable, but make durable SDK
operations await a commit before acknowledging success or dispatching dependent
work. One proposed interface, subject to upstream review:

```ts
interface DurableSessionStorage {
  load(sessionId: string): Promise<CommittedSession>;
  commit(change: SessionChange, authority: OwnershipToken): Promise<CommitReceipt>;
}

interface SessionChange {
  expectedSequence: number;
  requestId: string;
  entries: readonly FileEntry[];
  leafId: string | null;
  inboxChanges: readonly InboxChange[];
  resourceVersion: string;
  // The host supplies accounting and workspace changes for the same transaction.
  hostCommit: HostCommit;
}
```

The exported types above describe the proposed seam, not current contracts.
Entry identity is allocated before commit and must remain unchanged after restore.
The host atomically commits entries, leaf, events, ledger, workspace revision and
inbox delivery where a lifecycle operation changes them together. A commit uses
expected sequence and current ownership epoch. A mismatch halts the activation.

## Awaited effect boundaries

1. **Acceptance:** persist input and its stable request ID before returning durable
   acceptance. Queue order and cancellation are records, not in-memory text arrays.
2. **Model request:** await authority and reservation for ordinary inference,
   compaction, branch summaries, retries and extension helpers. Every dispatch
   gets an attempt ID. Uncommitted responses retain unknown accounting state.
3. **Response:** finalize extension transformations, allocate the Pi entry, then
   await response/settlement/intents before any registered tool can execute.
4. **Tool:** await intent/authority; execute the operation; finalize extension
   result transformations; await result/entry/workspace commit. Abort dependent
   work on failure. Do not translate failed persistence into a recoverable tool
   error that triggers another model request.
5. **Session operations:** commit names, labels, selection, compaction, branch/leaf,
   configuration and custom entries before reporting completion. Session tree
   navigation does not imply workspace rollback.
6. **Reload and replacement:** create a candidate without invalidating the current
   runner; verify resource versions and authority; commit; switch the projection.
   On failure discard the candidate. Do not use mutable user JSONL as another store.
7. **Finish:** complete the turn or consume/enqueue continuation atomically. A
   storage failure is sticky until the activation is rebuilt from committed state.

## Extension compatibility

Existing synchronous `appendEntry`, labels, names and queue setters cannot acquire
an async database acknowledgement without an API/lifecycle change. Two possible
upstream-compatible forms need evaluation:

- New async mutation methods, with legacy methods staging changes. Every controlled
  model/tool/lifecycle effect flushes staged changes first. Document that legacy
  return values acknowledge staging only. Provide `await durable.flush()` and
  `await durable.operation(...)` for extension effects needing ordering.
- Async mutation methods throughout, with a versioned extension compatibility
  adapter and explicit migration of callers that depend on synchronous results.

Neither form can infer or roll back arbitrary extension network/file IO. That
remains outside automatic guarantees unless registered with the durable helper.
This boundary must not silently suppress extension loading or claim full parity
without paired behavior tests.

## Rejection semantics and cancellation

A `DurableCommitError` invalidates the live projection and stops new controlled
effects. Preserve the first error; failure handling must not keep attempting
ordinary assistant-message writes through the same failed storage callback.
Recheck authority after provider IO and before final commit. A stale owner cannot
acknowledge input, dispatch a new operation, advance a cursor, or delete resources
belonging to the successor. Already-dispatched opaque effects require reconciliation.

## Verification required before selecting the seam

- Run the 0.85.1 negative fixtures against the proposed seam with opposite safety
  assertions: held/rejected commits must prevent dependencies and acknowledgements.
- Exercise every inventory row, especially internal retries, session replacement,
  custom entries outside a turn and rejected resource reload.
- Kill before dispatch, after response commit, after tool effect, and around the
  atomic workspace/result commit; restore from SQLite and PostgreSQL.
- Restore all Pi entry variants with unchanged IDs/parents, selected leaf and
  extension state; retain original records and reject incompatible engine versions.
- Re-run budget, cancellation, tenant, lease/fence and native/browser recovery
  fixtures before changing the default or claiming parity.

If upstream cannot supply this seam, a pinned maintained patch/fork would need
explicit selection, a documented patch boundary, reproducible package integrity,
license preservation and a forward-port qualification suite. Simply making
`AgentSession._emit` await observers would not address this inventory.

## Structural response reuse, source-level proposal, 2026-09-17

Pinned AgentHarness 0.85.1 commits each nested summary request's usage before
the compaction or branch-summary entry, but does not retain the delivered
response. After process death between usage settlement and the structural
commit, `recoverStructuralGeneration` reports `structural_interrupted` and either
retries with a new paid request or fails, even though nimplex has the original
response committed atomically with that usage (`pi-storage/summary-responses.ts`).

Proposed upstream change to `harness/runtime/drive/structural.ts`, verified in the
ignored `sandbox/summary-recovery-gate/` experiment against a patched copy of the
compiled package, with the installed dependency left untouched:

1. `SummaryGenerationEffectPending` gains `responses?: { index, usageId, response }[]`.
   Absent on older records; only committed responses may be reused.
2. `publishNestedRequestOutcome` requires a matching `request.usageId` and appends
   the delivered response in the same transaction as its usage row.
3. `performStructuralAttempt` replays recorded responses by request index before
   dispatching any new request, so a split-turn compaction issues only the second
   request after recovery.
4. `recoverStructuralGeneration` completes an attempt whose `request` is absent
   and whose response inventory matches `usageIds`; a pending `request` still
   means an unknown external outcome and keeps the existing interrupted path.

Thirteen real SIGKILL cases pass against the patched copy (compaction, branch
summary, split turn before and after the second request, truncated summary,
unknown request, before first request, cancellation, corrupt and legacy records,
stale owner and a rejected recovery commit); the unpatched package still reports
`structural_interrupted`. This remains an experiment: no fork, patch or dependency
change is applied to the workspace, and adopting a maintained patch is a separate
decision. Until upstream accepts a change, the production engine declines
structural summaries instead of dispatching them.
