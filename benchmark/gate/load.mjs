import { performance } from 'node:perf_hooks'
import { benchStats } from './stats.mjs'

async function run({ scenario, concurrency, requestsPerRound, rounds, warmupRequests, timeoutMs }) {
    await runRound({ scenario, concurrency, totalRequests: warmupRequests, timeoutMs })
    const measured = []
    for (let i = 0; i < rounds; i++) {
        measured.push(await runRound({ scenario, concurrency, totalRequests: requestsPerRound, timeoutMs }))
    }
    return {
        rounds: measured.map(summarizeRound),
        rawLatenciesMs: measured.map((r) => r.samples.map((s) => benchStats.round({ value: s.latencyMs }))),
        errorSamples: measured.flatMap((r) => r.samples.filter((s) => !s.ok)).slice(0, MAX_ERROR_SAMPLES).map((s) => s.error),
    }
}

function aggregate({ rounds, workers }) {
    const pick = (key) => benchStats.median(rounds.map((r) => r[key]))
    const throughputRps = pick('throughputRps')
    const requests = rounds.reduce((sum, r) => sum + r.requests, 0)
    const errors = rounds.reduce((sum, r) => sum + r.errors, 0)
    return {
        throughputRps,
        throughputPerWorkerRps: workers > 0 ? benchStats.round({ value: throughputRps / workers }) : null,
        latencyP50Ms: pick('latencyP50Ms'),
        latencyP95Ms: pick('latencyP95Ms'),
        latencyP99Ms: pick('latencyP99Ms'),
        // Summed rather than medianed: an error burst confined to one round is still a failure.
        errorRate: requests === 0 ? 0 : benchStats.round({ value: errors / requests, digits: 5 }),
    }
}

async function runRound({ scenario, concurrency, totalRequests, timeoutMs }) {
    let issued = 0
    const startedAt = performance.now()
    const lanes = Array.from({ length: Math.min(concurrency, totalRequests) }, async () => {
        const laneSamples = []
        while (issued < totalRequests) {
            issued++
            laneSamples.push(await timeRequest({ scenario, timeoutMs }))
        }
        return laneSamples
    })
    const samples = (await Promise.all(lanes)).flat()
    return { samples, durationMs: performance.now() - startedAt }
}

async function timeRequest({ scenario, timeoutMs }) {
    const request = scenario.buildRequest()
    const startedAt = performance.now()
    try {
        const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await response.text()
        const latencyMs = performance.now() - startedAt
        const failure = scenario.validate({ status: response.status, text })
        return { latencyMs, ok: failure === null, error: failure }
    }
    catch (e) {
        return { latencyMs: performance.now() - startedAt, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
}

function summarizeRound({ samples, durationMs }) {
    const latencies = samples.map((s) => s.latencyMs)
    const errors = samples.filter((s) => !s.ok).length
    return {
        requests: samples.length,
        errors,
        durationMs: benchStats.round({ value: durationMs }),
        throughputRps: benchStats.round({ value: samples.length / (durationMs / 1000) }),
        latencyP50Ms: benchStats.round({ value: benchStats.percentile({ values: latencies, p: 50 }) }),
        latencyP95Ms: benchStats.round({ value: benchStats.percentile({ values: latencies, p: 95 }) }),
        latencyP99Ms: benchStats.round({ value: benchStats.percentile({ values: latencies, p: 99 }) }),
        latencyMaxMs: benchStats.round({ value: latencies.reduce((max, v) => Math.max(max, v), 0) }),
        errorRate: samples.length === 0 ? 0 : benchStats.round({ value: errors / samples.length, digits: 5 }),
    }
}

const MAX_ERROR_SAMPLES = 10

export const loadRunner = { run, aggregate }
