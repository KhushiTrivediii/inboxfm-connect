import {
    FlowActionType,
    GenericStepOutput,
    StepOutputStatus,
} from '@inboxfm-connect/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loggingUtils, parseNumberEnv } from '../../src/lib/helper/logging-utils'

describe('loggingUtils.maybeTruncateInput', () => {
    const threshold = 2 * 1024

    it('returns input unchanged when every value is within the threshold', () => {
        const input = { a: 'small', b: { nested: 1 }, c: [1, 2, 3] }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toBe(input)
    })

    it('replaces over-threshold top-level values with a sized placeholder', () => {
        const large = 'x'.repeat(4096)
        const input = { keep: 'small', drop: large }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toEqual({
            keep: 'small',
            drop: expect.stringMatching(/^\(truncated, original size \d+ KB\)$/),
        })
    })

    it('does not recurse into nested objects', () => {
        const large = 'x'.repeat(4096)
        const input = { outer: { inner: large } }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toEqual({
            outer: expect.stringMatching(/^\(truncated, original size \d+ KB\)$/),
        })
    })

    it('uses MB units with one decimal place for values over 1024 KB', () => {
        const large = 'x'.repeat(2 * 1024 * 1024)
        const input = { drop: large }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toEqual({
            drop: expect.stringMatching(/^\(truncated, original size \d+\.\d MB\)$/),
        })
    })

    it('returns the input unchanged when it is not a plain record', () => {
        expect(loggingUtils.maybeTruncateInput(undefined, threshold)).toBeUndefined()
        expect(loggingUtils.maybeTruncateInput(null, threshold)).toBeNull()
        const arr = [1, 2, 3]
        expect(loggingUtils.maybeTruncateInput(arr, threshold)).toBe(arr)
        expect(loggingUtils.maybeTruncateInput('hello', threshold)).toBe('hello')
    })

    it('does not mutate the original input record', () => {
        const large = 'x'.repeat(4096)
        const input = { keep: 'small', drop: large }
        loggingUtils.maybeTruncateInput(input, threshold)
        expect(input.drop).toBe(large)
    })
})

describe('loggingUtils.isWithinSizeLimit', () => {
    it('returns true when steps fit under the cap', () => {
        const steps = {
            step1: GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: { tiny: 'ok' },
            }),
        }
        expect(loggingUtils.isWithinSizeLimit(steps, 10 * 1024)).toBe(true)
    })

    it('returns false when steps blow the cap', () => {
        const steps = {
            step1: GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: { large: 'x'.repeat(4096) },
            }),
        }
        expect(loggingUtils.isWithinSizeLimit(steps, 128)).toBe(false)
    })
})

describe('parseNumberEnv', () => {
    it('falls back to the default for undefined, empty and whitespace-only values', () => {
        expect(parseNumberEnv(undefined, 50)).toBe(50)
        expect(parseNumberEnv('', 50)).toBe(50)
        expect(parseNumberEnv('   ', 50)).toBe(50)
    })

    it('falls back to the default for non-numeric and negative values', () => {
        expect(parseNumberEnv('fifty', 50)).toBe(50)
        expect(parseNumberEnv('50mb', 50)).toBe(50)
        expect(parseNumberEnv('-5', 50)).toBe(50)
        expect(parseNumberEnv('NaN', 50)).toBe(50)
    })

    it('parses valid numbers, including padded and decimal ones', () => {
        expect(parseNumberEnv('12', 50)).toBe(12)
        expect(parseNumberEnv('  12 ', 50)).toBe(12)
        expect(parseNumberEnv('1.5', 50)).toBe(1.5)
        expect(parseNumberEnv('0', 50)).toBe(0)
    })
})

describe('loggingUtils size caps from environment', () => {
    // The caps are module-level constants, so each case re-imports a fresh
    // module instance under a stubbed environment.
    const importFreshLoggingUtils = async () => {
        vi.resetModules()
        return (await import('../../src/lib/helper/logging-utils')).loggingUtils
    }

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.resetModules()
    })

    it('keeps the default max log size when AP_MAX_FLOW_RUN_LOG_SIZE_MB is non-numeric', async () => {
        // Regression: Number('not-a-number') is NaN, MAX_SIZE_FOR_ALL_ENTRIES
        // became NaN, and isWithinSizeLimit rejected every flow run.
        vi.stubEnv('AP_MAX_FLOW_RUN_LOG_SIZE_MB', 'not-a-number')
        const fresh = await importFreshLoggingUtils()

        const steps = {
            step1: GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: { tiny: 'ok' },
            }),
        }
        expect(fresh.isWithinSizeLimit(steps)).toBe(true)
    })

    it('keeps the default truncate threshold when AP_FLOW_RUN_LOG_INPUT_TRUNCATE_THRESHOLD_KB is non-numeric', async () => {
        // Regression: a NaN threshold made `size > threshold` always false and
        // silently disabled input truncation.
        vi.stubEnv('AP_FLOW_RUN_LOG_INPUT_TRUNCATE_THRESHOLD_KB', 'not-a-number')
        const fresh = await importFreshLoggingUtils()

        const large = 'x'.repeat(4096)
        const input = { keep: 'small', drop: large }
        expect(fresh.maybeTruncateInput(input)).toEqual({
            keep: 'small',
            drop: expect.stringMatching(/^\(truncated, original size \d+ KB\)$/),
        })
    })

    it('honours a valid AP_MAX_FLOW_RUN_LOG_SIZE_MB override', async () => {
        vi.stubEnv('AP_MAX_FLOW_RUN_LOG_SIZE_MB', '1')
        const fresh = await importFreshLoggingUtils()

        expect(fresh.maxLogSizeMb).toBe(1)
        const steps = {
            step1: GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: { tiny: 'ok' },
            }),
        }
        // 1 MB cap minus the 256 KB error offset still fits this tiny step...
        expect(fresh.isWithinSizeLimit(steps)).toBe(true)
        // ...but a 2 MB payload does not.
        const bigSteps = {
            step1: GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: { large: 'x'.repeat(2 * 1024 * 1024) },
            }),
        }
        expect(fresh.isWithinSizeLimit(bigSteps)).toBe(false)
    })
})
