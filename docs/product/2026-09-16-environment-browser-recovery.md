# Native environment and browser recovery requirements

Confirmed scope addition from Kevin on 2026-09-16. Native sandbox recovery must
cover Chrome/browser session state, execution logs, and snapshots in addition to
conversation and workspace recovery. This extends the
[durable Pi implementation plan](2026-09-16-durable-pi-implementation-plan.md).

## Current evidence

The existing runtime implements provider reconnection, E2B pause/resume, native
supervisor journals, workspace restoration and environment generations. The
SandboxProvider port has no explicit runtime snapshot creation/restore contract.
In the current E2B adapter, the create argument named `snapshot` selects a template;
it does not establish a captured live VM snapshot. No implemented browser recovery
contract was found in the inspected runtime. Older product notes mention browser
sessions, but do not prove these capabilities exist.

## Recovery layers

| Layer | Durable material | Restoration promise and limits |
| --- | --- | --- |
| Agent | Events, Pi entries, inbox, checkpoints | Restore committed conversation and execution decisions |
| Workspace | Files, metadata, revision and verified blobs | Restore committed files, including completed downloads |
| Native environment | Image/version, configuration, provider ID, journal and optional snapshot | Reconnect first; recreate only after confirmed loss; report capability-dependent state loss |
| Browser identity/state | Dedicated profile or selected storage export, browser version, account scope | Recover supported authentication and storage; expired/revoked sessions require login |
| Browser activity | Logical tabs, URLs, action IDs, durable outcomes and checkpoints | Reopen recoverable pages and inspect current state; never blindly replay clicks |
| Diagnostics | Redacted console/network logs, screenshots, traces, download metadata | Explain prior execution; diagnostic logs are not a live browser or VM checkpoint |

A screenshot or DOM snapshot is an observation. A browser storage export is not
browser process memory. A disk snapshot is not automatically a memory snapshot.
Even memory restoration cannot roll back remote websites or guarantee a live
socket remains valid.

## Provider and snapshot contracts

Extend contracts before adapters. Separate image/template identity from immutable
runtime snapshot identity. Declare capabilities for reconnect, pause/resume,
disk snapshots, memory snapshots, snapshot export, expiry and supported restore
targets. Unsupported capabilities must be explicit, not simulated by creating a
fresh environment and reporting successful resume.

Proposed snapshot manifest fields: schema version, tenant/session/environment
identity, generation, event high-water, workspace revision, pending operation IDs,
provider snapshot reference, capture type, image/browser versions, browser-state
reference, digests, creation time, expiry and encryption-key reference. Record the
actual consistency level and any intentionally omitted state.

Capture protocol:

1. Validate ownership and stop new actions at a safe boundary. Drain active tools
   and browser actions; if that cannot be done, abort capture or explicitly mark
   a supported crash-consistent capture and its pending operations.
2. Flush application state. Use a clean browser shutdown or a verified coherent
   volume/process snapshot; do not copy a changing Chrome profile and call it
   consistent. Quiesce background writers too, or report their limitations.
3. Capture required artifacts, verify availability, then commit one manifest
   linking compatible event, workspace, browser and provider versions.
4. Revalidate ownership around provider IO. A failed capture leaves the preceding
   checkpoint authoritative; orphan artifacts are reclaimed later.

Snapshot on explicit request, controlled idle suspension, environment relocation
and before supported upgrades. Add bounded periodic capture for active sessions
with a declared recovery-point objective. Per-operation durable logs remain
necessary; a snapshot is not required after every shell command. Retention, quotas,
reference counting and deletion must preserve snapshots still used by branches.

## Browser restoration

Use an agent-managed Chrome profile by default. Attaching a user's existing
external Chrome is a distinct mode: it may support reconnect and observations,
but the harness must not claim it can snapshot, migrate, or recreate that browser.
Do not silently copy the user's personal browser profile into cloud environments.

First attempt to reattach to the existing browser/provider session. If it is lost,
restore a compatible dedicated profile or scoped storage export, recreate logical
tabs, then observe the live site. Saved CDP endpoints, target IDs, DOM handles and
selectors may be stale; rediscover them and validate context before acting.

Portable state exports need an explicit coverage matrix for cookies, localStorage,
IndexedDB and sessionStorage. Playwright documents reusable authentication state,
including IndexedDB, and separate handling for sessionStorage. A persistent
browser profile has different coverage and portability constraints; version and
OS/keychain compatibility must be verified. Neither path guarantees login after
server-side expiry, account revocation, or changed authentication requirements.
Sources: [Playwright authentication](https://playwright.dev/docs/auth) and
[persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context).

Persist browser action intent before dispatch and outcomes after verification.
For an interrupted submit, purchase, upload, message or other mutation, reconcile
with the external service when possible; otherwise pause with an unknown outcome.
Restoring a snapshot never authorizes repeating that operation. Navigation itself
can have side effects, so page reopening also needs a safe restoration policy.

Browser-state artifacts may contain account credentials. Encrypt them, scope access
to the owning tenant/account, and keep raw cookies/tokens outside model context,
ordinary transcript events and normal workspace exports. Apply redaction and
retention to traces, screenshots, URLs and network/console logs. Branching a
conversation must not implicitly duplicate browser credentials or grant a second
agent concurrent control of the same account/profile.

## Restoration order and degraded states

1. Acquire authority and load the latest verified committed manifest.
2. Reconnect to the original native environment and browser when possible.
3. On confirmed loss, try a compatible provider snapshot; verify its relationship
   to the committed log and reconcile every pending operation before continuing.
4. If unavailable, rebuild the native environment from its image and durable files,
   restore supported browser state, and rediscover runtime handles.
5. Report the actual result: reattached, restored from snapshot, rebuilt, login
   required, unknown action outcome, incompatible checkpoint, or unrecoverable.

Snapshots older than the committed workspace cannot silently overwrite newer
files. Restored processes must not resume side effects before ownership checks;
require a provider pause/control mechanism or fall back to controlled rebuild.
Background processes and open ports need service identity and readiness checks;
when only disk restoration is available, restart supported services explicitly.
Never restore an old checkpoint to bypass a durable cancellation or termination.

## Implementation additions

- Phase 1: versioned manifests, artifact references, browser action IDs and restore
  results; separate sensitive browser artifacts from ordinary workspace storage.
- Phase 3a: provider capability inventory, snapshot create/restore/delete contracts,
  consistent capture, native logs and environment reconstruction tests.
- Phase 3b: browser adapter, dedicated profiles, action journals, logical tab state,
  portable fallback, session validity checks and diagnostic artifact storage.
- Phase 4: explicit checkpoint/restore controls and visible degraded recovery states;
  resource reload must preserve the active browser/environment identity.
- Phase 5: ownership transfer includes browser/profile leases and account scope.
- Phase 6: exercise snapshot retention, backup/restore, expiry and version upgrades.

The initial acceptance provider must be explicitly named after capability testing.
The durable browser workflow is required scope; full-memory restoration is claimed
only for providers where it is demonstrated. A disk-only provider must expose its
lower guarantee rather than blocking all other supported recovery modes.

## Acceptance scenarios

Use a controlled test website with synthetic credentials and observable side-effect
counters. Do not use a user's real account to test duplicate submissions.

- Kill only the executor: reconnect to the same native/browser sessions and collect
  the existing tool/action outcome without duplication.
- Kill Chrome: restore supported profile/storage and logical tabs; detect expired
  authentication and request login without inventing success.
- Destroy the sandbox: restore a verified snapshot or rebuild with explicit losses;
  committed files, completed downloads and diagnostic artifacts remain available.
- Kill during a form submission: distinguish verified completion from uncertainty;
  the test server must not receive an automatic duplicate submission.
- Fail capture/upload/manifest commit: the previous checkpoint stays usable.
- Restore an old snapshot against newer events: preserve committed state and avoid
  replaying already-completed effects.
- Attempt stale-owner writes/browser actions: prevent new dispatch at controlled
  boundaries and reject stale commits; reconcile already-dispatched actions.
- Verify profile isolation, branch policy, artifact encryption/redaction, snapshot
  expiry, incompatible browser versions and capture with background writers.

No browser/snapshot implementation or provider capability test was performed in
this documentation update.
