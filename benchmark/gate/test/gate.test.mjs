import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GateStatus, regressionGate, Verdict } from '../compare.mjs'
import { loadRunner } from '../load.mjs'
import { benchScenarios } from '../scenarios.mjs'
import { benchStats } from '../stats.mjs'
import { stubServer } from '../stub-server.mjs'

describe('benchStats', () => {
    it('uses nearest-rank percentiles so reported values were actually observed', () => {
        const values = [5, 1, 4, 2, 3]
        assert.equal(benchStats.percentile({ values, p: 50 }), 3)
        assert.equal(benchStats.percentile({ values, p: 99 }), 5)
        assert.equal(benchStats.percentile({ values, p: 1 }), 1)
        assert.equal(benchStats.percentile({ values: [], p: 50 }), 0)
    })
})

describe('regressionGate.compare', () => {
    it('passes when metrics stay inside tolerance', () => {
        const baseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const outcome = regressionGate.compare({ baseline, results: makeResults({ p50: 110, rps: 47 }) })
        assert.equal(outcome.status, GateStatus.PASSED)
    })

    it('fails on a latency regression beyond tolerance', () => {
        const baseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const outcome = regressionGate.compare({ baseline, results: makeResults({ p50: 140, rps: 50 }) })
        assert.equal(outcome.status, GateStatus.REGRESSED)
        assert.equal(outcome.checks.find((c) => c.metric === 'latencyP50Ms').verdict, Verdict.REGRESSED)
    })

    it('fails on a throughput drop, where higher is better', () => {
        const baseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const outcome = regressionGate.compare({ baseline, results: makeResults({ p50: 100, rps: 30 }) })
        assert.equal(outcome.status, GateStatus.REGRESSED)
        assert.equal(outcome.checks.find((c) => c.metric === 'throughputRps').verdict, Verdict.REGRESSED)
    })

    it('reports improvements without failing', () => {
        const baseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const outcome = regressionGate.compare({ baseline, results: makeResults({ p50: 50, rps: 90 }) })
        assert.equal(outcome.status, GateStatus.PASSED)
        assert.equal(outcome.checks.find((c) => c.metric === 'latencyP50Ms').verdict, Verdict.IMPROVED)
    })

    it('widens the allowed band by the noise recorded in the baseline rounds', () => {
        const noisy = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50, p50Rounds: [60, 100, 140] }) })
        const quiet = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const current = makeResults({ p50: 200, rps: 50 })
        assert.equal(regressionGate.compare({ baseline: noisy, results: current }).status, GateStatus.PASSED)
        assert.equal(regressionGate.compare({ baseline: quiet, results: current }).status, GateStatus.REGRESSED)
    })

    it('enforces the error-rate hard ceiling regardless of baseline', () => {
        const baseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const outcome = regressionGate.compare({ baseline, results: makeResults({ p50: 100, rps: 50, errorRate: 0.02 }) })
        assert.equal(outcome.status, GateStatus.REGRESSED)
        assert.match(outcome.reasons.join('\n'), /errorRate .* exceeds hard ceiling/)
    })

    it('refuses to compare runs with a different shape', () => {
        const baseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const results = makeResults({ p50: 100, rps: 50 })
        results.config.shape.concurrency = 16
        const outcome = regressionGate.compare({ baseline, results })
        assert.equal(outcome.status, GateStatus.INCOMPARABLE)
    })

    it('records only when the baseline is not seeded', () => {
        const baseline = { schemaVersion: 1, scenario: 'stub', shape: {}, metrics: {} }
        const outcome = regressionGate.compare({ baseline, results: makeResults({ p50: 100, rps: 50 }) })
        assert.equal(outcome.status, GateStatus.NO_BASELINE)
    })

    it('fails when a baselined metric is missing from results', () => {
        const baseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        const results = makeResults({ p50: 100, rps: 50 })
        delete results.aggregate.latencyP99Ms
        assert.equal(regressionGate.compare({ baseline, results }).status, GateStatus.REGRESSED)
    })
})

describe('regressionGate.promote', () => {
    it('keeps reviewed thresholds from the previous baseline while refreshing values', () => {
        const previousBaseline = regressionGate.promote({ results: makeResults({ p50: 100, rps: 50 }) })
        previousBaseline.metrics.latencyP50Ms.tolerancePct = 10
        const next = regressionGate.promote({ results: makeResults({ p50: 80, rps: 60 }), previousBaseline })
        assert.equal(next.metrics.latencyP50Ms.tolerancePct, 10)
        assert.equal(next.metrics.latencyP50Ms.baseline, 80)
        assert.equal(next.recordedFrom.commit, 'abc1234567890')
    })

    it('omits metrics the run could not produce', () => {
        const results = makeResults({ p50: 100, rps: 50 })
        results.aggregate.throughputPerWorkerRps = null
        assert.equal(regressionGate.promote({ results }).metrics.throughputPerWorkerRps, undefined)
    })
})

describe('end to end against a stub target', () => {
    it('fails the gate when a known slowdown is injected', async () => {
        const baseline = regressionGate.promote({ results: await measureStub({ delayMs: 5 }) })
        const healthy = regressionGate.compare({ baseline, results: await measureStub({ delayMs: 5 }) })
        const slowed = regressionGate.compare({ baseline, results: await measureStub({ delayMs: 65 }) })
        assert.equal(healthy.status, GateStatus.PASSED)
        assert.equal(slowed.status, GateStatus.REGRESSED)
    })

    it('counts server errors toward the error rate', async () => {
        const results = await measureStub({ delayMs: 0, errorEvery: 10 })
        assert.ok(results.aggregate.errorRate >= 0.09 && results.aggregate.errorRate <= 0.11)
    })
})

async function measureStub({ delayMs, errorEvery = 0 }) {
    const server = await stubServer.start({ delayMs, errorEvery })
    try {
        const scenario = benchScenarios.resolve({ name: 'stub', env: { BENCH_BASE_URL: server.baseUrl } })
        const shape = { concurrency: 4, requestsPerRound: 60, rounds: 3, workers: 0, apps: 1 }
        const measured = await loadRunner.run({ scenario, concurrency: 4, requestsPerRound: 60, rounds: 3, warmupRequests: 10, timeoutMs: 5000 })
        return {
            schemaVersion: 1,
            scenario: 'stub',
            tier: 'pr',
            metadata: { commit: 'test', environment: 'test' },
            config: { shape },
            aggregate: loadRunner.aggregate({ rounds: measured.rounds, workers: 0 }),
            rounds: measured.rounds,
        }
    }
    finally {
        await server.close()
    }
}

function makeResults({ p50, rps, errorRate = 0, p50Rounds }) {
    const rounds = (p50Rounds ?? [p50, p50, p50]).map((value) => ({
        latencyP50Ms: value,
        latencyP95Ms: value * 2,
        latencyP99Ms: value * 3,
        throughputRps: rps,
        throughputPerWorkerRps: rps / 2,
        errorRate,
    }))
    return {
        schemaVersion: 1,
        scenario: 'stub',
        tier: 'pr',
        metadata: { commit: 'abc1234567890', environment: 'test', finishedAt: '2026-09-24T00:00:00.000Z' },
        config: { shape: { concurrency: 4, requestsPerRound: 100, rounds: 3, workers: 2, apps: 1 } },
        aggregate: {
            latencyP50Ms: p50,
            latencyP95Ms: p50 * 2,
            latencyP99Ms: p50 * 3,
            throughputRps: rps,
            throughputPerWorkerRps: rps / 2,
            errorRate,
        },
        rounds,
    }
}
