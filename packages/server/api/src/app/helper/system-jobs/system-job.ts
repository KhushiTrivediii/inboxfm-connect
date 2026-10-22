import { isNil, tryCatch } from '@inboxfm-connect/core-utils'
import { scheduler } from '@inboxfm-connect/scheduler'
import { apDayjs } from '@inboxfm-connect/server-utils'
import { FastifyBaseLogger } from 'fastify'
import { getSystemJobTickLockKey } from '../../database/redis/keys'
import { distributedStore } from '../../database/redis-connections'
import { SystemJobDefinition, SystemJobHandler, SystemJobName, SystemJobSchedule } from './common'
import { systemJobHandlers } from './job-handlers'

const activeJobIds = new Map<string, string>()

const systemJobsScheduleImpl = (log: FastifyBaseLogger): SystemJobSchedule => ({
    async init(): Promise<void> {
        log.info('[systemJob#init] In-process scheduler initialized')
    },

    async startWorker(): Promise<void> {
        log.info('[systemJob#startWorker] In-process worker started')
    },

    async upsertJob({ job, schedule }): Promise<void> {
        log.info({ jobName: job.name, jobId: job.jobId }, '[systemJob#upsertJob] Upserting job via LocalScheduler')

        const jobHandler = systemJobHandlers.getJobHandler(job.name)

        if (schedule.type === 'repeated') {
            const taskId = await scheduler.cron({
                name: job.name,
                cronExpression: schedule.cron,
                fn: () => runRepeatedJobTick({ job, jobHandler, log }),
            })
            activeJobIds.set(job.jobId, taskId)
        }
        else if (schedule.type === 'one-time') {
            const delayMs = Math.max(0, schedule.date.diff(apDayjs(), 'milliseconds'))
            await scheduleOneTimeJobRun({ job, jobHandler, log, delayMs, attempt: 0 })
        }
    },

    // The in-process scheduler owns no BullMQ job registry, so there is no job handle
    // to return. Handlers already receive their job's data as an argument.
    async getJob() {
        return undefined
    },

    async close(): Promise<void> {
        log.info('[systemJob#close] Closing in-process scheduler')
        await scheduler.shutdown()
        activeJobIds.clear()
    },
})

// Every replica runs its own `@inboxfm-connect/scheduler` node-cron instance (there is no shared
// BullMQ-style job registry backing it), so a repeated job's cron closure fires independently, at
// (approximately) the same wall-clock tick, in every replica's process. Left unguarded, a job like
// FILE_CLEANUP_TRIGGER or TRIAL_TRACKER would run once per replica on every tick instead of once
// cluster-wide. `claimRepeatedJobTick` makes exactly one replica the leader for a given tick via a
// short-lived Redis claim; the rest observe the claim already taken and skip. The TTL is kept under
// 60s — the tightest granularity a standard 5-field cron expression can express — so the claim always
// expires before the earliest possible next tick, and a Redis error fails OPEN (the replica just runs
// the job locally) rather than silently starving the job cluster-wide during a Redis blip. Self-hosted
// single-instance deployments (REDIS_TYPE=memory, no real Redis) always win their own claim, so this
// is a no-op there.
const REPEATED_JOB_TICK_LOCK_TTL_SECONDS = 55

async function claimRepeatedJobTick({ jobId, log }: ClaimRepeatedJobTickParams): Promise<boolean> {
    const result = await tryCatch(() => distributedStore.putIfAbsent(getSystemJobTickLockKey(jobId), 1, REPEATED_JOB_TICK_LOCK_TTL_SECONDS))
    if (result.error === null) {
        return result.data
    }
    log.warn({ jobId, error: result.error }, '[systemJob#claimRepeatedJobTick] Failed to reach Redis for cluster-wide tick leadership — running locally to avoid starving the job')
    return true
}

async function runRepeatedJobTick({ job, jobHandler, log }: RepeatedJobTickParams): Promise<void> {
    const isLeaderForThisTick = await claimRepeatedJobTick({ jobId: job.jobId, log })
    if (!isLeaderForThisTick) {
        log.debug({ jobName: job.name, jobId: job.jobId }, '[systemJob#runRepeatedJobTick] Another replica already claimed this tick — skipping')
        return
    }
    log.debug({ jobName: job.name, jobId: job.jobId }, '[systemJob#runRepeatedJobTick] Executing job')
    const { error } = await tryCatch(() => jobHandler(job.data))
    if (!isNil(error)) {
        log.error(error, `[systemJob#runRepeatedJobTick] Job execution failed: ${job.name}`)
    }
}

// A one-time job handler that threw used to just get logged and dropped — the in-process scheduler
// has no BullMQ-style retry queue behind it, so a transient failure (a blip talking to Postgres/S3,
// etc.) meant the job silently never ran again. `nextSystemJobRetryAttempt` gives one-time jobs a
// bounded, backed-off retry instead. This intentionally does NOT use the cluster-wide tick lock above:
// a one-time job is only ever scheduled (and therefore only ever holds a live setTimeout) on the one
// replica whose in-process handler called `upsertJob`, so nothing else is racing to run it.
export const SYSTEM_JOB_RETRY_DELAYS_MS = [5_000, 30_000, 120_000]

export function nextSystemJobRetryAttempt({ attempt, job, log }: NextSystemJobRetryAttemptParams): SystemJobRetryDecision {
    if (attempt >= SYSTEM_JOB_RETRY_DELAYS_MS.length) {
        log.error({ jobName: job.name, jobId: job.jobId, attempts: attempt }, '[systemJob#nextSystemJobRetryAttempt] exhausted retries — dead-lettering')
        return { action: 'dead-letter' }
    }
    return { action: 'retry', delayMs: SYSTEM_JOB_RETRY_DELAYS_MS[attempt], nextAttempt: attempt + 1 }
}

async function scheduleOneTimeJobRun({ job, jobHandler, log, delayMs, attempt }: ScheduleOneTimeJobRunParams): Promise<void> {
    const taskId = await scheduler.once({
        name: job.name,
        delayMs,
        fn: () => executeOneTimeJobAttempt({ job, jobHandler, log, attempt }),
    })
    activeJobIds.set(job.jobId, taskId)
}

async function executeOneTimeJobAttempt({ job, jobHandler, log, attempt }: ExecuteOneTimeJobAttemptParams): Promise<void> {
    const { error } = await tryCatch(() => jobHandler(job.data))
    if (isNil(error)) {
        return
    }
    log.warn(error, `[systemJob#executeOneTimeJobAttempt] Job execution failed: ${job.name} (attempt ${attempt})`)
    const decision = nextSystemJobRetryAttempt({ attempt, job, log })
    if (decision.action === 'dead-letter') {
        return
    }
    await scheduleOneTimeJobRun({ job, jobHandler, log, delayMs: decision.delayMs, attempt: decision.nextAttempt })
}

export const systemJobsSchedule = systemJobsScheduleImpl

type ClaimRepeatedJobTickParams = {
    jobId: string
    log: FastifyBaseLogger
}

type RepeatedJobTickParams = {
    job: SystemJobDefinition<SystemJobName>
    jobHandler: SystemJobHandler
    log: FastifyBaseLogger
}

type NextSystemJobRetryAttemptParams = {
    attempt: number
    job: SystemJobDefinition<SystemJobName>
    log: FastifyBaseLogger
}

type SystemJobRetryDecision =
    | { action: 'retry', delayMs: number, nextAttempt: number }
    | { action: 'dead-letter' }

type ScheduleOneTimeJobRunParams = {
    job: SystemJobDefinition<SystemJobName>
    jobHandler: SystemJobHandler
    log: FastifyBaseLogger
    delayMs: number
    attempt: number
}

type ExecuteOneTimeJobAttemptParams = Omit<ScheduleOneTimeJobRunParams, 'delayMs'>
