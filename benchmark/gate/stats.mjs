function percentile({ values, p }) {
    if (values.length === 0) {
        return 0
    }
    const sorted = [...values].sort((a, b) => a - b)
    // Nearest-rank, so a reported p99 is always a latency that was actually observed.
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

function median(values) {
    return percentile({ values, p: 50 })
}

function mean(values) {
    if (values.length === 0) {
        return 0
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

function spread(values) {
    if (values.length === 0) {
        return 0
    }
    return Math.max(...values) - Math.min(...values)
}

function round({ value, digits = 3 }) {
    const factor = 10 ** digits
    return Math.round(value * factor) / factor
}

export const benchStats = { percentile, median, mean, spread, round }
