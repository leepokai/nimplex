# Pi harness engine: scale and cost evidence (2026-09-18)

Measured with `pnpm bench` (`examples/quickstart/src/harness-bench.ts`) on a
10-core Apple Silicon laptop, Node 22.22, against the fake Anthropic upstream with
zero model latency. The numbers therefore isolate nimplex's own durability overhead:
Pi's harness loop, one SQLite transaction per boundary with `synchronous=FULL`,
workspace snapshots and event projection. Real provider latency (seconds per
request) dominates in production and is not included. Every figure below comes
from one run of the script; rerun it to reproduce or to compare a change.

## Per-turn cost of durability (local SQLite, 20 sessions × 1 turn × 6 tools)

| Metric | Value |
| --- | --- |
| Provider requests per turn | 7 (1 per tool round plus the final answer) |
| Durable commits per turn | 89 (Pi intents, results, usage rows, nimplex projections) |
| Committed nimplex events per turn | 32 (59 rows including reservation/spend/file events) |
| Turn wall time | mean 36 ms, p50 32 ms, p95 109 ms |
| Overhead per commit | 0.41 ms (turn time ÷ commits) |
| Throughput, one process, sequential | 27.6 turns/s |
| SQLite growth per turn (checkpointed main file) | 195 KiB |
| Pi rows per turn | 14 entries, 89 commit records, 7 usage rows |
| Process RSS after the run | 370 MiB |

Storage is dominated by Pi's commit journal (one row per commit, 89 per turn) and
the per-tool workspace snapshots; both are what recovery replays. A pruning policy
for settled journals is not implemented.

## Context growth (one session, 20 follow-up turns)

| Metric | Value |
| --- | --- |
| First request payload | 4.7 KiB (about 1,170 tokens of system prompt and tool schemas) |
| Payload after 20 turns | 10.0 KiB |
| Follow-up turn wall time | p50 6 ms, p95 9 ms (single text response, no tools) |

The fixed per-request input is the nimplex system prompt plus five tool schemas.
At Anthropic Haiku 4.5 rates ($1/MTok input) that is about $0.0012 of input per
request; a 7-request tool turn spends about $0.008 of input before any output or
history. Compaction (`contextMode: "compact"`) bounds history growth.

## Concurrency (one runtime process, one turn per session, 6 tools each)

| Sessions in parallel | Total wall time | Turns/s | Turn latency p50 / p95 | RSS |
| --- | --- | --- | --- | --- |
| 8 | 253 ms | 31.7 | 239 ms / 252 ms | 390 MiB |
| 32 | 1,240 ms | 25.8 | 1,071 ms / 1,232 ms | 435 MiB |

Throughput stays flat while latency grows linearly: one SQLite writer serializes
commits (about 25 to 30 six-tool turns per second per process, or roughly 2,300
commits per second). With real model latency of seconds per request this is far
from the bottleneck for hundreds of concurrent sessions per process; the limit is
memory (Pi harness plus just-bash workspace per active turn) rather than the log.

## Recovery after SIGKILL (3 samples, kill after a committed tool result)

| Metric | Value |
| --- | --- |
| Reopen the state root and classify the interrupted turn | 1.4 ms |
| `resumeTurn` to completed turn (2 remaining requests, 1 remaining tool) | mean 13 ms, max 15 ms |
| Provider requests after restart | 2 in every sample (no committed response re-requested) |
| Duplicate native side effects | none (`append.txt` contains exactly one line) |

## Storage adapter commit latency (1,000 commits, 1 KiB message entry plus one value each)

> The PostgreSQL row is historical: the hosted adapter was removed on 2026-09-20 and
> `pnpm bench` now measures SQLite only.

| Adapter | p50 | p95 | p99 | Commits/s |
| --- | --- | --- | --- | --- |
| SQLite, WAL, `synchronous=FULL`, host transaction | 0.12 ms | 0.16 ms | 1.02 ms | 7,200 |
| PostgreSQL 17 (local Docker, `PostgresPiStorage`, fenced transaction) | 2.28 ms | 2.95 ms | 3.71 ms | 423 |

Hosted commits cost about 20× the local ones, still under 5 ms at p99 on a local
database. A managed database adds network round-trips per transaction; a 6-tool turn
issues about 90 commits, so budget roughly 90 round-trips of write latency per
hosted turn. Batched `unnest` inserts keep multi-row commits at one statement per
table.

## What this does not measure

- Real provider latency, streaming, or rate limits.
- Native sandboxes (E2B/Docker); every tool here ran on just-bash.
- Long sessions beyond 20 turns, compaction cost, or journal pruning.
- Multi-worker hosted throughput; the e2e suite proves correctness of takeover,
  not its throughput.
