import { apDayjs } from '@inboxfm-connect/server-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPutIfAbsent = vi.fn()
const mockCron = vi.fn()
const mockOnce = vi.fn()
const mockGetJobHandler = vi.fn()

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedStore: { putIfAbsent: (...args: unknown[]) => mockPutIfAbsent(...args) },
}))

vi.mock('@inboxfm-connect/scheduler', () => ({
    scheduler: {
        cron: (...args: unknown[]) => mockCron(...args),
        once: (...args: unknown[]) => mockOnce(...args),
        shutdown: vi.fn(),
    },
}))

vi.mock('../../../../../src/app/helper/system-jobs/job-handlers', () => ({
    systemJobHandlers: {
        getJobHandler: (...args: unknown[]) => mockGetJobHandler(...args),
    },
}))

import { SystemJobName } from '../../../../../src/app/helper/system-jobs/common'
import { nextSystemJobRetryAttempt, SYSTEM_JOB_RETRY_DELAYS_MS, systemJobsSchedule } from '../../../../../src/app/helper/system-jobs/system-job'

const mockLog = {
    info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(),
    child: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: 'info',
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

describe('systemJobsSchedule — repeated (cron) jobs claim one cluster-wide leader per tick', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockCron.mockResolvedValue('task-id')
        mockGetJobHandler.mockReturnValue(vi.fn().mockResolvedValue(undefined))
    })

    it('acquires the tick lock before running the handler', async () => {
        mockPutIfAbsent.mockResolvedValue(true)
        const handler = vi.fn().mockResolvedValue(undefined)
        mockGetJobHandler.mockReturnValue(handler)

        await systemJobsSchedule(mockLog).upsertJob({
            job: { name: SystemJobName.FILE_CLEANUP_TRIGGER, data: {}, jobId: SystemJobName.FILE_CLEANUP_TRIGGER },
            schedule: { type: 'repeated', cron: '30 */1 * * *' },
        })

        const [[{ fn: tick }]] = mockCron.mock.calls
        await tick()

        expect(mockPutIfAbsent).toHaveBeenCalledWith(
            expect.stringContaining(SystemJobName.FILE_CLEANUP_TRIGGER),
            expect.anything(),
            expect.any(Number),
        )
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('skips the handler entirely when another replica already claimed this tick', async () => {
        mockPutIfAbsent.mockResolvedValue(false)
        const handler = vi.fn().mockResolvedValue(undefined)
        mockGetJobHandler.mockReturnValue(handler)

        await systemJobsSchedule(mockLog).upsertJob({
            job: { name: SystemJobName.TRIAL_TRACKER, data: {}, jobId: SystemJobName.TRIAL_TRACKER },
            schedule: { type: 'repeated', cron: '*/59 23 * * *' },
        })

        const [[{ fn: tick }]] = mockCron.mock.calls
        await tick()

        expect(handler).not.toHaveBeenCalled()
        expect(mockLog.debug).toHaveBeenCalled()
    })

    it('fails open (still runs) when Redis is unreachable, instead of starving the job cluster-wide', async () => {
        mockPutIfAbsent.mockRejectedValue(new Error('ECONNREFUSED'))
        const handler = vi.fn().mockResolvedValue(undefined)
        mockGetJobHandler.mockReturnValue(handler)

        await systemJobsSchedule(mockLog).upsertJob({
            job: { name: SystemJobName.FILE_CLEANUP_TRIGGER, data: {}, jobId: SystemJobName.FILE_CLEANUP_TRIGGER },
            schedule: { type: 'repeated', cron: '30 */1 * * *' },
        })

        const [[{ fn: tick }]] = mockCron.mock.calls
        await tick()

        expect(handler).toHaveBeenCalledTimes(1)
        expect(mockLog.warn).toHaveBeenCalled()
    })
})

describe('systemJobsSchedule — one-time jobs get a bounded, backed-off retry', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockOnce.mockResolvedValue('task-id')
    })

    it('does not reschedule when the handler succeeds', async () => {
        const handler = vi.fn().mockResolvedValue(undefined)
        mockGetJobHandler.mockReturnValue(handler)

        await systemJobsSchedule(mockLog).upsertJob({
            job: { name: SystemJobName.BUNDLE_PIECE, data: { name: 'p', version: '1.0.0' }, jobId: 'bundle-piece:p:1.0.0' },
            schedule: { type: 'one-time', date: apDayjs() },
        })

        expect(mockOnce).toHaveBeenCalledTimes(1)
        const [[{ fn: attempt }]] = mockOnce.mock.calls
        await attempt()

        expect(handler).toHaveBeenCalledTimes(1)
        expect(mockOnce).toHaveBeenCalledTimes(1)
    })

    it('re-schedules itself with the configured backoff delay on each failed attempt, then dead-letters', async () => {
        const handler = vi.fn().mockRejectedValue(new Error('transient failure'))
        mockGetJobHandler.mockReturnValue(handler)

        await systemJobsSchedule(mockLog).upsertJob({
            job: { name: SystemJobName.BUNDLE_PIECE, data: { name: 'p', version: '1.0.0' }, jobId: 'bundle-piece:p:1.0.0' },
            schedule: { type: 'one-time', date: apDayjs() },
        })

        // attempt 0..length-1 each fail and reschedule; the (length+1)th invocation (attempt === length)
        // is the one that finally exhausts the budget and dead-letters instead of rescheduling.
        for (let attempt = 0; attempt <= SYSTEM_JOB_RETRY_DELAYS_MS.length; attempt++) {
            expect(mockOnce).toHaveBeenCalledTimes(attempt + 1)
            const [[{ fn: run, delayMs }]] = mockOnce.mock.calls.slice(-1)
            if (attempt > 0) {
                expect(delayMs).toBe(SYSTEM_JOB_RETRY_DELAYS_MS[attempt - 1])
            }
            await run()
        }

        // Retry budget exhausted: no further reschedule, failure is logged instead of dropped silently.
        expect(mockOnce).toHaveBeenCalledTimes(SYSTEM_JOB_RETRY_DELAYS_MS.length + 1)
        expect(handler).toHaveBeenCalledTimes(SYSTEM_JOB_RETRY_DELAYS_MS.length + 1)
        expect(mockLog.error).toHaveBeenCalledWith(
            expect.objectContaining({ jobId: 'bundle-piece:p:1.0.0', attempts: SYSTEM_JOB_RETRY_DELAYS_MS.length }),
            expect.any(String),
        )
    })

    it('recovers and stops retrying once a later attempt succeeds', async () => {
        const handler = vi.fn()
            .mockRejectedValueOnce(new Error('transient failure'))
            .mockResolvedValueOnce(undefined)
        mockGetJobHandler.mockReturnValue(handler)

        await systemJobsSchedule(mockLog).upsertJob({
            job: { name: SystemJobName.BUNDLE_PIECE, data: { name: 'p', version: '1.0.0' }, jobId: 'bundle-piece:p:1.0.0' },
            schedule: { type: 'one-time', date: apDayjs() },
        })

        const [[{ fn: firstAttempt }]] = mockOnce.mock.calls
        await firstAttempt()
        expect(mockOnce).toHaveBeenCalledTimes(2)

        const [[{ fn: secondAttempt }]] = mockOnce.mock.calls.slice(-1)
        await secondAttempt()

        expect(handler).toHaveBeenCalledTimes(2)
        expect(mockOnce).toHaveBeenCalledTimes(2)
    })
})

describe('nextSystemJobRetryAttempt', () => {
    const job = { name: SystemJobName.BUNDLE_PIECE, data: { name: 'p', version: '1.0.0' }, jobId: 'bundle-piece:p:1.0.0' }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns the next backoff delay while retries remain', () => {
        SYSTEM_JOB_RETRY_DELAYS_MS.forEach((delayMs, attempt) => {
            expect(nextSystemJobRetryAttempt({ attempt, job, log: mockLog })).toEqual({
                action: 'retry',
                delayMs,
                nextAttempt: attempt + 1,
            })
        })
    })

    it('dead-letters once the retry budget is exhausted', () => {
        const decision = nextSystemJobRetryAttempt({ attempt: SYSTEM_JOB_RETRY_DELAYS_MS.length, job, log: mockLog })
        expect(decision).toEqual({ action: 'dead-letter' })
        expect(mockLog.error).toHaveBeenCalledTimes(1)
    })
})
