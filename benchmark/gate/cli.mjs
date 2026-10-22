#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { GateStatus, regressionGate } from './compare.mjs'
import { loadRunner } from './load.mjs'
import { benchScenarios } from './scenarios.mjs'
import { stubServer } from './stub-server.mjs'

async function main() {
    const [command, ...rest] = process.argv.slice(2)
    const handler = COMMANDS[command]
    if (!handler) {
        console.error(`Usage: node benchmark/gate/cli.mjs <${Object.keys(COMMANDS).join('|')}> [options]`)
        return ExitCode.INVALID
    }
    const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true })
    return handler(values)
}

async function runCommand(options) {
    const scenario = benchScenarios.resolve({ name: options.scenario, env: process.env })
    const results = await measure({ scenario, options })
    writeJson({ path: options.out, value: results })
    console.log(`Wrote ${options.out}: ${JSON.stringify(results.aggregate)}`)
    return ExitCode.OK
}

async function compareCommand(options) {
    const baseline = readJson(options.baseline)
    const results = readJson(options.results)
    const outcome = regressionGate.compare({ baseline, results })
    const summary = regressionGate.renderSummary({ outcome, baseline, results })
    process.stdout.write(summary)
    if (options.summary) {
        writeFileSync(options.summary, summary)
    }
    return STATUS_EXIT_CODE[outcome.status]
}

async function promoteCommand(options) {
    const results = readJson(options.results)
    const previousBaseline = existsSync(options.baseline) ? readJson(options.baseline) : undefined
    writeJson({ path: options.baseline, value: regressionGate.promote({ results, previousBaseline }) })
    console.log(`Baseline ${options.baseline} updated from ${results.metadata.commit}. Commit it in a reviewed PR.`)
    return ExitCode.OK
}

async function selftestCommand(options) {
    const healthy = await measureStub({ delayMs: 5, options })
    const baseline = regressionGate.promote({ results: healthy })
    const checks = [
        { label: 'healthy rerun passes', delayMs: 5, expected: GateStatus.PASSED },
        { label: 'injected 60ms slowdown fails', delayMs: 65, expected: GateStatus.REGRESSED },
    ]
    let ok = true
    for (const check of checks) {
        const results = await measureStub({ delayMs: check.delayMs, options })
        const outcome = regressionGate.compare({ baseline, results })
        const pass = outcome.status === check.expected
        ok = ok && pass
        console.log(`${pass ? 'PASS' : 'FAIL'} ${check.label}: got ${outcome.status}, expected ${check.expected}`)
        if (!pass) {
            process.stdout.write(regressionGate.renderSummary({ outcome, baseline, results }))
        }
    }
    return ok ? ExitCode.OK : ExitCode.REGRESSED
}

async function measureStub({ delayMs, options }) {
    const server = await stubServer.start({ delayMs })
    try {
        const scenario = benchScenarios.resolve({ name: 'stub', env: { BENCH_BASE_URL: server.baseUrl } })
        return await measure({ scenario, options: { ...options, environment: 'selftest' } })
    }
    finally {
        await server.close()
    }
}

async function measure({ scenario, options }) {
    const shape = {
        concurrency: toCount({ name: 'concurrency', value: options.concurrency, min: 1 }),
        requestsPerRound: toCount({ name: 'requests', value: options.requests, min: 1 }),
        rounds: toCount({ name: 'rounds', value: options.rounds, min: 1 }),
        workers: toCount({ name: 'workers', value: options.workers, min: 0 }),
        apps: toCount({ name: 'apps', value: options.apps, min: 1 }),
    }
    const warmupRequests = toCount({ name: 'warmup', value: options.warmup, min: 0 })
    const timeoutMs = toCount({ name: 'timeout-ms', value: options['timeout-ms'], min: 1 })
    const startedAt = new Date().toISOString()
    const measured = await loadRunner.run({
        scenario,
        concurrency: shape.concurrency,
        requestsPerRound: shape.requestsPerRound,
        rounds: shape.rounds,
        warmupRequests,
        timeoutMs,
    })
    return {
        schemaVersion: regressionGate.SCHEMA_VERSION,
        scenario: scenario.name,
        tier: options.tier,
        metadata: {
            commit: process.env.GITHUB_SHA ?? gitHead(),
            ref: process.env.GITHUB_REF ?? null,
            image: process.env.BENCH_IMAGE ?? null,
            environment: options.environment ?? process.env.BENCH_ENVIRONMENT ?? 'local',
            target: scenario.target,
            runner: process.env.RUNNER_NAME ?? hostname(),
            node: process.version,
            startedAt,
            finishedAt: new Date().toISOString(),
        },
        config: { shape, warmupRequests, timeoutMs },
        aggregate: loadRunner.aggregate({ rounds: measured.rounds, workers: shape.workers }),
        rounds: measured.rounds,
        errorSamples: measured.errorSamples,
        raw: { latenciesMs: measured.rawLatenciesMs },
    }
}

function toCount({ name, value, min }) {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < min) {
        throw new Error(`--${name} must be an integer >= ${min}, got "${value}"`)
    }
    return parsed
}

function gitHead() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    }
    catch {
        return 'unknown'
    }
}

function readJson(path) {
    if (!path) {
        throw new Error('Missing file path argument')
    }
    return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson({ path, value }) {
    if (!path) {
        throw new Error('Missing --out/--baseline path')
    }
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

const ExitCode = {
    OK: 0,
    REGRESSED: 1,
    INVALID: 2,
}

const STATUS_EXIT_CODE = {
    [GateStatus.PASSED]: ExitCode.OK,
    [GateStatus.NO_BASELINE]: ExitCode.OK,
    [GateStatus.REGRESSED]: ExitCode.REGRESSED,
    [GateStatus.INCOMPARABLE]: ExitCode.INVALID,
}

const OPTIONS = {
    scenario: { type: 'string', default: 'execute-text-helper' },
    tier: { type: 'string', default: 'pr' },
    environment: { type: 'string' },
    out: { type: 'string', default: 'bench-results.json' },
    baseline: { type: 'string' },
    results: { type: 'string' },
    summary: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    requests: { type: 'string', default: '200' },
    rounds: { type: 'string', default: '5' },
    warmup: { type: 'string', default: '50' },
    workers: { type: 'string', default: '0' },
    apps: { type: 'string', default: '1' },
    'timeout-ms': { type: 'string', default: '30000' },
}

const COMMANDS = {
    run: runCommand,
    compare: compareCommand,
    promote: promoteCommand,
    selftest: selftestCommand,
}

main().then(
    (code) => process.exit(code),
    (e) => {
        console.error(e instanceof Error ? e.message : e)
        process.exit(ExitCode.INVALID)
    },
)
