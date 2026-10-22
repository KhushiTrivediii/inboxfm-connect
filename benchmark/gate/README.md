# Performance regression gate

A repeatable benchmark that compares a run against a committed, reviewed baseline and fails
when latency, throughput, or the error rate regresses beyond a noise-aware threshold. Plain Node
(>= 22) with no dependencies, so it runs anywhere the repo is checked out.

The one-off fleet measurements in [`../EXPERIMENTS.md`](../EXPERIMENTS.md) and the older
`benchmark/*.sh` harness drive flow webhooks (`/v1/webhooks/:flowId/sync`), which the headless
Connect API no longer has. This gate targets the headless API instead.

## Tiers

| Tier | Where | Target | Fails on |
|---|---|---|---|
| **selftest** | every PR touching `benchmark/gate/**` (`benchmark.yml` → `gate-selftest`) | in-process stub server | the gate itself missing an injected 60 ms slowdown |
| **nightly** | nightly cron + manual dispatch (`benchmark.yml` → `regression-gate`) | a configured deployment | a regression against `benchmark/baselines/<scenario>.nightly.json` |
| **full fleet** | manual, opt-in (cloud cost) | GKE via `benchmark/run-gke.sh` | not gated yet, see the known gaps below |

The nightly tier is **zero-setup safe**. If the target isn't configured, the job skips with a
notice instead of failing or reporting a false pass.

## Scenarios

| Scenario | Request | Needs |
|---|---|---|
| `execute-text-helper` | `POST /v1/execute` running `@inboxfm-connect/piece-text-helper` `concat`, asserting the output | `BENCH_BASE_URL`, `BENCH_API_KEY`, `BENCH_PROJECT_ID`, `BENCH_CONNECTION_ID` |
| `connections-list` | `GET /v1/connections?projectId=…` (auth + DB read path) | `BENCH_BASE_URL`, `BENCH_API_KEY`, `BENCH_PROJECT_ID` |
| `stub` | `GET /` against `stub-server.mjs` | `BENCH_BASE_URL` |

`BENCH_BASE_URL` is the API root, for example `https://connect.example.com/api`. It's the same value the
Connect SDK takes as `baseUrl`. The Text Helper connection is set up the same way as the SDK release
smoke (`packages/connect-sdk/test/live-smoke.mjs`).

## Running locally

```bash
node benchmark/gate/cli.mjs selftest
node benchmark/gate/cli.mjs run --scenario execute-text-helper --tier nightly --out results.json
node benchmark/gate/cli.mjs compare --baseline benchmark/baselines/execute-text-helper.nightly.json --results results.json --summary summary.md
```

`run` options include `--concurrency`, `--requests` (per round), `--rounds`, `--warmup`, `--workers`,
`--apps`, `--timeout-ms`, and `--environment`. `BENCH_IMAGE` and `BENCH_ENVIRONMENT` are recorded in
the results metadata.

Exit codes: `0` passed, or no baseline has been seeded yet; `1` regression; `2` results are not
comparable (the scenario, shape, or schema differs) or the input is invalid.

## Results format

`results.json` (schema version 1) contains:

- `metadata`: commit, ref, image, environment, target host, runner, Node version, and timestamps
- `config.shape`: concurrency, requests per round, rounds, workers, and apps. A baseline only compares
  against the same shape.
- `aggregate`: the median across rounds for p50, p95, and p99 latency, throughput, and throughput per
  worker. The error rate is summed across all rounds, so an error burst in a single round still counts.
- `rounds[]`: per-round summaries. `raw.latenciesMs` holds every sample. `errorSamples` holds the
  first failures.

## How the threshold works

For each metric in the baseline, the allowed delta is the largest of:

1. `tolerancePct` of the baseline value
2. `minAbsoluteDelta` (a floor, so sub-millisecond jitter on fast paths doesn't fail the gate)
3. `3 × noise`, where `noise` is the spread across the baseline's own rounds. A baseline recorded
   on a jittery runner widens its own band instead of producing flaky failures.

Separately, `errorRate` has a hard `maxValue` ceiling (default 1%) that applies whatever the
baseline is. Improvements are reported but never fail the gate.

## Updating a baseline

Thresholds and baselines only change through a reviewed PR:

1. Dispatch **Benchmark** with `record_baseline: true`.
2. Download `proposed-baseline.json` from the run artifacts and copy it over
   `benchmark/baselines/<scenario>.nightly.json`. `promote` keeps any hand-tuned `tolerancePct`,
   `minAbsoluteDelta`, or `maxValue` from the previous file and refreshes only `baseline` and `noise`.
3. Open a PR explaining why the baseline moved. A `shape` change (for example, higher concurrency)
   also needs a baseline update; otherwise `compare` refuses to compare.

The committed baselines start **unseeded** (`"metrics": {}`), so the nightly job only records
results until a maintainer seeds a baseline from a real run on the target environment.

## Configuring the nightly target

Create a GitHub environment named `benchmark` with:

- **vars:** `BENCH_BASE_URL`, `BENCH_PROJECT_ID`, `BENCH_CONNECTION_ID`, and optionally
  `BENCH_ENVIRONMENT` and `BENCH_IMAGE`
- **secret:** `BENCH_API_KEY`, a project-scoped key used only for benchmarking

Point it at a dedicated, otherwise idle deployment. Shared staging traffic shows up as noise.

## Known gaps

The gate currently measures request latency, throughput, and errors from the client side. These
parts of #49 aren't covered yet:

- cold-start phase breakdown, queue age, and infrastructure saturation (CPU and memory)
- reproducing the documented GKE fleet shapes from a clean environment (`run-gke.sh` still drives
  the flow-webhook path)
