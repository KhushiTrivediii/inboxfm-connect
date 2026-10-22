import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalScheduler } from '../src/local-scheduler'
import cron from 'node-cron'

describe('LocalScheduler Lifecycle & Resilience', () => {
    it('cancels the first task during concurrent same-name registration', async () => {
        const task = cron.schedule('* * * * *', () => undefined)
        const stop = vi.spyOn(task, 'stop')
        const schedule = vi.spyOn(cron, 'schedule').mockReturnValue(task)
        try {
            const ids = await Promise.all([
                LocalScheduler.cron({ name: 'concurrent', cronExpression: '* * * * *', fn: () => undefined }),
                LocalScheduler.cron({ name: 'concurrent', cronExpression: '* * * * *', fn: () => undefined }),
            ])
            expect(ids).toEqual(['concurrent', 'concurrent'])
            expect(schedule).toHaveBeenCalledTimes(2)
            expect(stop).toHaveBeenCalledTimes(1)
            expect(LocalScheduler.getActiveTaskCount()).toBe(1)
        }
        finally {
            await LocalScheduler.shutdown()
            schedule.mockRestore()
            stop.mockRestore()
            task.stop()
        }
    })
    beforeEach(async () => {
        vi.useFakeTimers()
        await LocalScheduler.shutdown()
    })

    afterEach(async () => {
        await LocalScheduler.shutdown()
        vi.useRealTimers()
    })

    describe('once() lifecycle', () => {
        it('executes task after delay and cleans up from active task registry', async () => {
            const fnMock = vi.fn()
            const id = await LocalScheduler.once({
                name: 'test-once-success',
                delayMs: 15,
                fn: fnMock,
            })

            expect(LocalScheduler.has(id)).toBe(true)
            expect(LocalScheduler.getActiveTaskCount()).toBe(1)
            expect(LocalScheduler.getTaskIds()).toContain(id)

            await vi.advanceTimersByTimeAsync(40)

            expect(fnMock).toHaveBeenCalledTimes(1)
            expect(LocalScheduler.has(id)).toBe(false)
            expect(LocalScheduler.getActiveTaskCount()).toBe(0)
        })

        it('cancels scheduled once task cleanly before execution', async () => {
            const fnMock = vi.fn()
            const id = await LocalScheduler.once({
                name: 'test-once-cancelled',
                delayMs: 40,
                fn: fnMock,
            })

            await LocalScheduler.cancel(id)

            expect(LocalScheduler.has(id)).toBe(false)
            await vi.advanceTimersByTimeAsync(60)
            expect(fnMock).not.toHaveBeenCalled()
        })

        it('recovers from synchronous exception and routes to onError callback', async () => {
            const onErrorMock = vi.fn()
            const expectedError = new Error('Sync failure in once')

            const id = await LocalScheduler.once({
                name: 'test-once-sync-error',
                delayMs: 10,
                fn: () => {
                    throw expectedError
                },
                onError: onErrorMock,
            })

            await vi.advanceTimersByTimeAsync(40)

            expect(onErrorMock).toHaveBeenCalledTimes(1)
            expect(onErrorMock).toHaveBeenCalledWith({
                id,
                name: 'test-once-sync-error',
                error: expectedError,
            })
            expect(LocalScheduler.has(id)).toBe(false)
        })

        it('recovers from async promise rejection and routes to onError callback', async () => {
            const onErrorMock = vi.fn()
            const expectedError = new Error('Async failure in once')

            const id = await LocalScheduler.once({
                name: 'test-once-async-error',
                delayMs: 10,
                fn: async () => {
                    throw expectedError
                },
                onError: onErrorMock,
            })

            await vi.advanceTimersByTimeAsync(40)

            expect(onErrorMock).toHaveBeenCalledTimes(1)
            expect(onErrorMock).toHaveBeenCalledWith({
                id,
                name: 'test-once-async-error',
                error: expectedError,
            })
        })

        it('safely catches exceptions thrown inside onError callback without uncaught throw', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
            try {
                await LocalScheduler.once({
                    name: 'test-once-throwing-onerror',
                    delayMs: 10,
                    fn: () => {
                        throw new Error('Task error')
                    },
                    onError: () => {
                        throw new Error('Callback failure')
                    },
                })

                await expect(vi.advanceTimersByTimeAsync(40)).resolves.not.toThrow()
                expect(consoleErrorSpy).toHaveBeenCalledWith(
                    expect.stringContaining('[LocalScheduler] Error in onError handler'),
                    expect.any(Error),
                )
            }
            finally {
                consoleErrorSpy.mockRestore()
            }
        })

        it('safely catches asynchronous rejections inside onError callback without unhandled rejection', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
            try {
                await LocalScheduler.once({
                    name: 'test-once-async-throwing-onerror',
                    delayMs: 10,
                    fn: () => {
                        throw new Error('Task error')
                    },
                    onError: async () => {
                        throw new Error('Async callback failure')
                    },
                })

                await vi.advanceTimersByTimeAsync(40)
                expect(consoleErrorSpy).toHaveBeenCalledWith(
                    expect.stringContaining('[LocalScheduler] Error in onError handler'),
                    expect.any(Error),
                )
            }
            finally {
                consoleErrorSpy.mockRestore()
            }
        })
    })

    describe('every() lifecycle & error recovery', () => {
        it('executes task repeatedly at intervals until cancelled', async () => {
            const fnMock = vi.fn()
            const id = await LocalScheduler.every({
                name: 'test-interval',
                intervalMs: 20,
                fn: fnMock,
            })

            expect(LocalScheduler.has(id)).toBe(true)

            await vi.advanceTimersByTimeAsync(55)
            expect(fnMock.mock.calls.length).toBeGreaterThanOrEqual(2)

            await LocalScheduler.cancel(id)
            expect(LocalScheduler.has(id)).toBe(false)

            const countAfterCancel = fnMock.mock.calls.length
            await vi.advanceTimersByTimeAsync(40)
            expect(fnMock.mock.calls.length).toBe(countAfterCancel)
        })

        it('continues subsequent ticks after a task throws an error (error-recovery resilience)', async () => {
            let callCount = 0
            const onErrorMock = vi.fn()

            const id = await LocalScheduler.every({
                name: 'test-resilient-interval',
                intervalMs: 15,
                fn: () => {
                    callCount++
                    if (callCount === 1) {
                        throw new Error('Failure on tick 1')
                    }
                },
                onError: onErrorMock,
            })

            await vi.advanceTimersByTimeAsync(50)

            await LocalScheduler.cancel(id)
            expect(onErrorMock).toHaveBeenCalledTimes(1)
            expect(callCount).toBeGreaterThanOrEqual(2)
        })
    })

    describe('cron() lifecycle & re-registration idempotency', () => {
        it('automatically cancels previous task if re-registered with same name', async () => {
            const fn1 = vi.fn()
            const fn2 = vi.fn()

            await LocalScheduler.cron({
                name: 'idempotent-cron',
                cronExpression: '* * * * *',
                fn: fn1,
            })

            expect(LocalScheduler.getActiveTaskCount()).toBe(1)
            expect(LocalScheduler.has('idempotent-cron')).toBe(true)

            // Re-register under same name
            await LocalScheduler.cron({
                name: 'idempotent-cron',
                cronExpression: '*/5 * * * *',
                fn: fn2,
            })

            expect(LocalScheduler.getActiveTaskCount()).toBe(1)
            expect(LocalScheduler.has('idempotent-cron')).toBe(true)

            await LocalScheduler.cancel('idempotent-cron')
            expect(LocalScheduler.has('idempotent-cron')).toBe(false)
        })

        it('supports timezone and recoverMissedExecutions options without error', async () => {
            const id = await LocalScheduler.cron({
                name: 'tz-cron',
                cronExpression: '0 8 * * *',
                timezone: 'America/New_York',
                recoverMissedExecutions: false,
                fn: vi.fn(),
            })

            expect(LocalScheduler.has(id)).toBe(true)
            await LocalScheduler.cancel(id)
            expect(LocalScheduler.has(id)).toBe(false)
        })
    })

    describe('shutdown() lifecycle', () => {
        it('cancels all active tasks (once, every, cron) and empties the registry', async () => {
            await LocalScheduler.once({
                name: 'pending-once',
                delayMs: 500,
                fn: vi.fn(),
            })

            await LocalScheduler.every({
                name: 'pending-every',
                intervalMs: 500,
                fn: vi.fn(),
            })

            await LocalScheduler.cron({
                name: 'pending-cron',
                cronExpression: '* * * * *',
                fn: vi.fn(),
            })

            expect(LocalScheduler.getActiveTaskCount()).toBe(3)

            await LocalScheduler.shutdown()

            expect(LocalScheduler.getActiveTaskCount()).toBe(0)
            expect(LocalScheduler.getTaskIds()).toEqual([])
        })
    })
})
