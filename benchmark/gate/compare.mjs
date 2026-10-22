import { benchStats } from './stats.mjs'

function compare({ baseline, results }) {
    const mismatches = findShapeMismatches({ baseline, results })
    if (mismatches.length > 0) {
        return { status: GateStatus.INCOMPARABLE, reasons: mismatches, checks: [] }
    }
    if (Object.keys(baseline.metrics ?? {}).length === 0) {
        return { status: GateStatus.NO_BASELINE, reasons: ['Baseline is not seeded yet; recording only.'], checks: [] }
    }
    const checks = Object.entries(baseline.metrics).map(([metric, policy]) => checkMetric({
        metric,
        policy,
        current: results.aggregate[metric],
    }))
    const regressed = checks.some((c) => c.verdict === Verdict.REGRESSED || c.verdict === Verdict.MISSING)
    return {
        status: regressed ? GateStatus.REGRESSED : GateStatus.PASSED,
        reasons: checks.filter((c) => c.verdict === Verdict.REGRESSED || c.verdict === Verdict.MISSING).map((c) => c.reason),
        checks,
    }
}

function promote({ results, previousBaseline }) {
    const metrics = Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([metric, defaults]) => {
        const previous = previousBaseline?.metrics?.[metric] ?? {}
        const roundValues = results.rounds.map((r) => r[metric]).filter((v) => typeof v === 'number')
        return [metric, {
            ...defaults,
            ...pickPolicyFields(previous),
            baseline: results.aggregate[metric],
            noise: benchStats.round({ value: benchStats.spread(roundValues) }),
        }]
    }).filter(([, policy]) => typeof policy.baseline === 'number'))
    return {
        schemaVersion: SCHEMA_VERSION,
        scenario: results.scenario,
        tier: results.tier,
        shape: results.config.shape,
        recordedFrom: {
            commit: results.metadata.commit,
            image: results.metadata.image,
            environment: results.metadata.environment,
            recordedAt: results.metadata.finishedAt,
        },
        metrics,
    }
}

function renderSummary({ outcome, baseline, results }) {
    const lines = [
        `## Performance gate: ${STATUS_LABEL[outcome.status]}`,
        '',
        `Scenario \`${results.scenario}\` (${results.tier} tier) · commit \`${short(results.metadata.commit)}\` vs baseline from \`${short(baseline.recordedFrom?.commit)}\``,
        `Shape: ${describeShape(results.config.shape)} · ${results.rounds.length} rounds · environment \`${results.metadata.environment}\``,
        '',
    ]
    if (outcome.checks.length > 0) {
        lines.push('| Metric | Baseline | Current | Change | Allowed | Verdict |', '|---|---|---|---|---|---|')
        for (const c of outcome.checks) {
            lines.push(`| ${c.metric} | ${fmt(c.baseline)} | ${fmt(c.current)} | ${formatChange(c)} | ${c.allowedLabel} | ${VERDICT_LABEL[c.verdict]} |`)
        }
        lines.push('')
    }
    for (const reason of outcome.reasons) {
        lines.push(`- ${reason}`)
    }
    return lines.join('\n') + '\n'
}

function checkMetric({ metric, policy, current }) {
    const base = { metric, baseline: policy.baseline, current }
    if (typeof current !== 'number') {
        return { ...base, verdict: Verdict.MISSING, allowedLabel: '-', reason: `${metric} missing from results` }
    }
    if (typeof policy.maxValue === 'number' && current > policy.maxValue) {
        return { ...base, verdict: Verdict.REGRESSED, allowedLabel: `<= ${policy.maxValue}`, reason: `${metric} ${fmt(current)} exceeds hard ceiling ${policy.maxValue}` }
    }
    const allowed = Math.max(
        Math.abs(policy.baseline) * (policy.tolerancePct ?? 0) / 100,
        policy.minAbsoluteDelta ?? 0,
        NOISE_MULTIPLIER * (policy.noise ?? 0),
    )
    const worseBy = policy.direction === Direction.HIGHER_IS_BETTER ? policy.baseline - current : current - policy.baseline
    const allowedLabel = `±${fmt(allowed)}`
    if (worseBy > allowed) {
        return { ...base, verdict: Verdict.REGRESSED, allowedLabel, reason: `${metric} regressed: ${fmt(policy.baseline)} → ${fmt(current)} (allowed ${allowedLabel})` }
    }
    if (-worseBy > allowed) {
        return { ...base, verdict: Verdict.IMPROVED, allowedLabel, reason: null }
    }
    return { ...base, verdict: Verdict.WITHIN_NOISE, allowedLabel, reason: null }
}

function findShapeMismatches({ baseline, results }) {
    const reasons = []
    if (baseline.schemaVersion !== SCHEMA_VERSION || results.schemaVersion !== SCHEMA_VERSION) {
        reasons.push(`Schema version mismatch (baseline ${baseline.schemaVersion}, results ${results.schemaVersion}, expected ${SCHEMA_VERSION})`)
    }
    if (baseline.scenario !== results.scenario) {
        reasons.push(`Scenario mismatch: baseline \`${baseline.scenario}\`, results \`${results.scenario}\``)
    }
    for (const key of SHAPE_KEYS) {
        const expected = baseline.shape?.[key]
        const actual = results.config?.shape?.[key]
        if (expected !== undefined && expected !== actual) {
            reasons.push(`Shape mismatch on \`${key}\`: baseline ${expected}, results ${actual}. Update the baseline in a reviewed PR to change shape.`)
        }
    }
    return reasons
}

function pickPolicyFields(policy) {
    return Object.fromEntries(Object.entries(policy).filter(([key]) => POLICY_FIELDS.includes(key)))
}

function formatChange({ baseline, current }) {
    if (typeof current !== 'number' || typeof baseline !== 'number' || baseline === 0) {
        return '-'
    }
    const pct = ((current - baseline) / baseline) * 100
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function describeShape(shape) {
    return Object.entries(shape ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
}

function fmt(value) {
    return typeof value === 'number' ? String(benchStats.round({ value })) : '-'
}

function short(commit) {
    return typeof commit === 'string' ? commit.slice(0, 10) : 'unknown'
}

// A delta must also beat 3x the spread observed across the baseline's own rounds, so a baseline
// recorded on a jittery runner widens its own band instead of producing flaky failures.
const NOISE_MULTIPLIER = 3
const SCHEMA_VERSION = 1
const SHAPE_KEYS = ['concurrency', 'requestsPerRound', 'rounds', 'workers', 'apps']
const POLICY_FIELDS = ['direction', 'tolerancePct', 'minAbsoluteDelta', 'maxValue']

export const Direction = {
    LOWER_IS_BETTER: 'lower',
    HIGHER_IS_BETTER: 'higher',
}

export const GateStatus = {
    PASSED: 'passed',
    REGRESSED: 'regressed',
    NO_BASELINE: 'no-baseline',
    INCOMPARABLE: 'incomparable',
}

export const Verdict = {
    WITHIN_NOISE: 'within-noise',
    IMPROVED: 'improved',
    REGRESSED: 'regressed',
    MISSING: 'missing',
}

const STATUS_LABEL = {
    [GateStatus.PASSED]: 'passed',
    [GateStatus.REGRESSED]: 'REGRESSION DETECTED',
    [GateStatus.NO_BASELINE]: 'no baseline (recording only)',
    [GateStatus.INCOMPARABLE]: 'results not comparable to baseline',
}

const VERDICT_LABEL = {
    [Verdict.WITHIN_NOISE]: 'ok',
    [Verdict.IMPROVED]: 'improved',
    [Verdict.REGRESSED]: '**regressed**',
    [Verdict.MISSING]: '**missing**',
}

export const DEFAULT_POLICY = {
    latencyP50Ms: { direction: Direction.LOWER_IS_BETTER, tolerancePct: 25, minAbsoluteDelta: 5 },
    latencyP95Ms: { direction: Direction.LOWER_IS_BETTER, tolerancePct: 35, minAbsoluteDelta: 10 },
    latencyP99Ms: { direction: Direction.LOWER_IS_BETTER, tolerancePct: 50, minAbsoluteDelta: 20 },
    throughputRps: { direction: Direction.HIGHER_IS_BETTER, tolerancePct: 20, minAbsoluteDelta: 1 },
    throughputPerWorkerRps: { direction: Direction.HIGHER_IS_BETTER, tolerancePct: 20, minAbsoluteDelta: 0.5 },
    errorRate: { direction: Direction.LOWER_IS_BETTER, tolerancePct: 0, minAbsoluteDelta: 0.001, maxValue: 0.01 },
}

export const regressionGate = { compare, promote, renderSummary, SCHEMA_VERSION }
