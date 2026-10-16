import { StepOutput } from '@inboxfm-connect/shared'
import { utils } from '../utils'
import { sizeofUtils } from './sizeof'

/**
 * `Number(process.env.X)` is NaN when the variable is unset, empty, or non-numeric,
 * which silently corrupts every size cap built from it: a NaN truncate threshold
 * makes `size > threshold` always false (input truncation silently disabled) and
 * a NaN max log size makes `isWithinSizeLimit` reject every flow run. Treat those
 * as "not configured" and fall back to the documented default instead.
 */
export function parseNumberEnv(raw: string | undefined, defaultValue: number): number {
    if (raw === undefined || raw.trim() === '') {
        return defaultValue
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue
}

const DEFAULT_INPUT_TRUNCATE_THRESHOLD_KB = 2
const INPUT_TRUNCATE_THRESHOLD_BYTES = parseNumberEnv(
    process.env.AP_FLOW_RUN_LOG_INPUT_TRUNCATE_THRESHOLD_KB,
    DEFAULT_INPUT_TRUNCATE_THRESHOLD_KB,
) * 1024

const DEFAULT_MAX_LOG_SIZE_MB = 50
const ERROR_OFFSET = 256 * 1024
const MAX_LOG_SIZE = parseNumberEnv(process.env.AP_MAX_FLOW_RUN_LOG_SIZE_MB, DEFAULT_MAX_LOG_SIZE_MB) * 1024 * 1024
const MAX_SIZE_FOR_ALL_ENTRIES = MAX_LOG_SIZE - ERROR_OFFSET

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatSize(bytes: number): string {
    const kb = bytes / 1024
    if (kb < 1024) {
        return `${Math.round(kb)} KB`
    }
    return `${(kb / 1024).toFixed(1)} MB`
}

export const loggingUtils = {
    maybeTruncateInput(input: unknown, threshold: number = INPUT_TRUNCATE_THRESHOLD_BYTES): unknown {
        if (!isPlainRecord(input)) {
            return input
        }
        let copy: Record<string, unknown> | undefined
        for (const [key, value] of Object.entries(input)) {
            const size = utils.sizeof(value)
            if (size > threshold) {
                copy ??= { ...input }
                copy[key] = `(truncated, original size ${formatSize(size)})`
            }
        }
        return copy ?? input
    },
    maxLogSizeMb: MAX_LOG_SIZE / (1024 * 1024),
    isWithinSizeLimit(steps: Record<string, StepOutput>, maxSize: number = MAX_SIZE_FOR_ALL_ENTRIES): boolean {
        return sizeofUtils.recursiveSizeof(steps) <= maxSize
    },
}
