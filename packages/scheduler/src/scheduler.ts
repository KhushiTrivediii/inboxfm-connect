import { LocalScheduler } from './local-scheduler'
import { Scheduler } from './types'

let activeScheduler: Scheduler = LocalScheduler

export const scheduler: Scheduler & { setScheduler: (newScheduler: Scheduler) => void } = {
    once: (params) => activeScheduler.once(params),
    every: (params) => activeScheduler.every(params),
    cron: (params) => activeScheduler.cron(params),
    cancel: (id) => activeScheduler.cancel(id),
    shutdown: () => activeScheduler.shutdown(),
    has: (id) => activeScheduler.has(id),
    getActiveTaskCount: () => activeScheduler.getActiveTaskCount(),
    getTaskIds: () => activeScheduler.getTaskIds(),
    /**
     * Replaces the active scheduler implementation.
     * Automatically shuts down any active jobs on the displaced scheduler
     * to avoid orphaned timer loops or memory leaks on replacement.
     */
    setScheduler: (newScheduler: Scheduler) => {
        if (activeScheduler && typeof activeScheduler.shutdown === 'function') {
            void activeScheduler.shutdown()
        }
        activeScheduler = newScheduler
    },
}
