# 2026-09-09 · MVP demo sprint (deadline: Monday, 2026-09-14)

> Historical 09-09 progress and demo schedule. See the [09-10 runtime contract](2026-09-10-harness-runtime.md) for the later implementation and acceptance.
> Kevin requested an MVP demo by the following Monday. This five-day schedule uses his noon-to-02:00 work window, with core blocks from noon and 21:00–01:00 buffers. Calendar events were synchronized per block with the prefix `nimplex MVP D-n`.
> Scope: **Slice 1** from 09-06 §7—Tier 0, Tier 1, Pi loop-outside, durable external logs. Demonstrate completion after worker SIGKILL within the model budget.

## Demo script and acceptance

```text
1. POST /v1/runs: create /workspace/hello.txt with the date, then grep it; budget_usd 0.20
2. Stream run.started → model.call → tool.call(write) → tool.result → …
3. After the second model.call, kill -9 the worker
4. Start another worker; reclaim within 60 seconds after lease expiry, rebuild Pi messages from run_events and files from Tier 0
5. Reach completed; GET /v1/runs/:id reports spent_usd ≤ 0.20; Tier 0 contains hello.txt
6. Repeat with budget_usd 0.01 → killed(budget_exceeded)
```

Both fake-upstream/no-key and real Haiku modes must work. Use the real model for the live demo.

## Progress recorded on 2026-09-09

**All Slice 1 work and demo acceptance landed on D-5**, originally scheduled through D-3:

- Four Pi decision gates passed in 30 minutes: headless Agent, just-bash VFS through createBashTool operations, fake BYOK base_url, and message_end usage. `sandbox/pi-spike/spike.ts` and spike2.ts covered clean/dirty resume. **Decision: Pi kernel.**
- Tier 0: workspace_files bytea table, migration 0007, loadWorkspace/saveWorkspace delta writes in the same transaction as turn events.
- Tier 1: pi-executor.ts, one work item per turn; model.call.message/tool.result project to Pi messages, Tier 0 seeds VFS. Events include model.call, message.delta, tool.call/result, file.changed, spend.updated, run.resumed.
- Worker: 20-second heartbeat; abort models on lease loss or terminal run; stub removed.
- API/SDK: GET run files and file?path=; runs.files()/readFile().
- Testkit: stateless scripted bash toolCalls and delayMs.
- Automated demo-kill.ts passed fake and real Haiku modes: worker B resumed after A's SIGKILL and lease expiry, five model.call events, four fake step files or real hello.txt, and $0.0175 / approximately $0.006 ≤ $0.20.
- Still pending at that date: Opus review, commit including 09-06 removals, README demo section, recording.

## Schedule

| Day | Time | Deliverable | Completion criterion |
|---|---|---|---|
| Wed 9/9, D-5 | 12:00–15:00 | Opus high review of 09-06 removals, fixes, commit | Commit created |
| | 17:00–21:00; project meeting at 15:30 | Pi library spike: headless Agent, custom bash operations, BYOK base URL, usage | Four gates within three hours; otherwise a roughly 200-line loop using Anthropic SDK and four tools |
| | 21:30–01:00 | Finish spike or start Tier 0 early | Buffer |
| Thu 9/10, D-4 | 12:00–15:00 | Tier 0 table/migration, workspace load/save, write-through | Write/reload content equality |
| | 16:00–20:00 | just-bash over Tier 0, Pi read/write/edit/bash/grep/find/ls operations, post-exec diff | echo/cat state persists across two Bash instances |
| | 21:00–01:00 | Finish Tiers 0/1 | Both tests green |
| Fri 9/11, D-3 | 12:00–15:00 | Pi event translation, usage × prices into usage_records/spent_usd, budget kill | E2E with $0.01 reaches killed |
| | 16:00–20:00 | Resume from events/files; mark dangling tools interrupted | Manual SIGKILL recovery |
| | 21:00–01:00 | Finish crash recovery | Manual demo passes |
| Sat 9/12, D-2 | 19:00–01:00; Cake career fair during day | Scripted testkit tool calls and automated demo-kill.ts | No-key demo passes |
| Sun 9/13, D-1 | 12:00–15:00 | Opus review, fixes, commit, README demo | Commit created |
| | 17:00–20:00 | Real Haiku rehearsal, asciinema/GIF recording, buffer | Recording available |
| | 21:00–01:00 | Clean-DB rehearsal, then freeze code | Final buffer |
| Mon 9/14 | Class 13:20–15:10 | **Demo** | — |

Approximately 24 core hours, 40 including buffers.

## Deferred beyond this MVP plan

- Slice 2 native escalation, Git synchronization, generation.
- Slice 3 compaction and tool-result offload.
- Single-process `npx nimplex dev`.
- Dev-droplet deployment; demo runs locally.
- Tier 0 write-event replay: initially write through whole files for small workspaces; snapshots/replay for larger repositories later.

## Risks recorded at planning time

1. **Pi library integration:** createBashTool operations were documented, but headless driving, base URL overrides, and usage needed the Wednesday decision gate.
2. **just-bash change detection:** no change hook, so MVP uses full-tree post-exec diff; potentially slow for large workspaces. Record a `ponytail:` size limit.
3. **Saturday availability:** only about four evening hours remained, so compressible E2E/demo scripting work was assigned there.
