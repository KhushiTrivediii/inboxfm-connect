import cron from 'node-cron'
import { Scheduler, SchedulerTaskErrorContext } from './types'

const activeTasks = new Map<string, cron.ScheduledTask | NodeJS.Timeout>()

function handleError({ id, name, error, onError }: SchedulerTaskErrorContext & { onError?: (ctx: SchedulerTaskErrorContext) => Promise<void> | void }): void {
    if (onError) {
        try {
            const res = onError({ id, name, error })
            if (res instanceof Promise) {
                res.catch((callbackError) => {
                    console.error(`[LocalScheduler] Error in onError handler for task "${name}" (${id}):`, callbackError)
                })
            }
        }
        catch (callbackError) {
            console.error(`[LocalScheduler] Error in onError handler for task "${name}" (${id}):`, callbackError)
        }
    }
    else {
        console.error(`[LocalScheduler] Error in task "${name}" (${id}):`, error)
    }
}

function cancelTask({ id }: { id: string }): void {
    const task = activeTasks.get(id)
    if (task === undefined) return
    if ('stop' in task) task.stop()
    else {
        clearTimeout(task)
        clearInterval(task)
    }
    activeTasks.delete(id)
}

const localSchedulerImpl: Scheduler = {
    async once({ name, delayMs, fn, onError }): Promise<string> {
        const id = `${name}-${Math.random().toString(36).substring(2, 9)}`
        const timeout = setTimeout(() => {
            activeTasks.delete(id)
            try {
                const res = fn()
                if (res instanceof Promise) {
                    res.catch((error) => handleError({ id, name, error, onError }))
                }
            }
            catch (err) {
                handleError({ id, name, error: err, onError })
            }
        }, delayMs)
        activeTasks.set(id, timeout)
        return id
    },

    async every({ name, intervalMs, fn, onError }): Promise<string> {
        const id = `${name}-${Math.random().toString(36).substring(2, 9)}`
        const interval = setInterval(() => {
            try {
                const res = fn()
                if (res instanceof Promise) {
                    res.catch((error) => handleError({ id, name, error, onError }))
                }
            }
            catch (err) {
                handleError({ id, name, error: err, onError })
            }
        }, intervalMs)
        activeTasks.set(id, interval)
        return id
    },

    async cron({ name, cronExpression, timezone, recoverMissedExecutions, fn, onError }): Promise<string> {
        const id = name
        cancelTask({ id })
        const task = cron.schedule(
            cronExpression,
            () => {
                try {
                    const res = fn()
                    if (res instanceof Promise) {
                        res.catch((error) => handleError({ id, name, error, onError }))
                    }
                }
                catch (err) {
                    handleError({ id, name, error: err, onError })
                }
            },
            {
                timezone,
                recoverMissedExecutions: recoverMissedExecutions ?? false,
            },
        )
        activeTasks.set(id, task)
        return id
    },

    async cancel(id: string): Promise<void> {
        cancelTask({ id })
    },

    async shutdown(): Promise<void> {
        for (const task of activeTasks.values()) {
            if ('stop' in task) {
                task.stop()
            }
            else {
                clearTimeout(task)
                clearInterval(task)
            }
        }
        activeTasks.clear()
    },

    has(id: string): boolean {
        return activeTasks.has(id)
    },

    getActiveTaskCount(): number {
        return activeTasks.size
    },

    getTaskIds(): string[] {
        return Array.from(activeTasks.keys())
    },
}

export const LocalScheduler = localSchedulerImpl
