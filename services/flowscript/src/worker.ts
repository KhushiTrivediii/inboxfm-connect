import { randomUUID } from 'node:crypto'
import {
  closeStore,
  claimQueuedRun,
  enqueueDueSchedule,
  finishRun,
  heartbeatRun,
  initializeStore,
  markRunNonIdempotentStep,
  recordStepAttemptFinish,
  recordStepAttemptStart,
  recoverStaleRuns,
} from './store.js'
import { executeFlowIR } from './runtime.js'
import { getSafeExecutionEnv } from './auth.js'
import type { FlowIR } from './compiler.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const workerId = process.env.FLOWSCRIPT_WORKER_ID || `worker-${randomUUID()}`
const MAX_CONCURRENT_RUNS = Number(process.env.FLOWSCRIPT_MAX_CONCURRENT_RUNS || 5)
const LEASE_DURATION_MS = Number(process.env.FLOWSCRIPT_LEASE_MS || 30_000)
const HEARTBEAT_INTERVAL_MS = Number(process.env.FLOWSCRIPT_HEARTBEAT_MS || 10_000)

let stopping = false
const activeRuns = new Set<Promise<void>>()

async function processJob(job: NonNullable<Awaited<ReturnType<typeof claimQueuedRun>>>) {
  const abortController = new AbortController()

  // Start background heartbeat
  const heartbeatTimer = setInterval(async () => {
    try {
      const hb = await heartbeatRun(job.id, workerId, LEASE_DURATION_MS)
      if (hb.cancelled || !hb.active) {
        abortController.abort()
      }
    } catch (err) {
      console.warn('Worker heartbeat failed', err)
    }
  }, HEARTBEAT_INTERVAL_MS)

  const startTime = Date.now()
  try {
    const result = await executeFlowIR(job.ir as FlowIR, {
      input: job.input,
      trigger: { kind: job.trigger_kind, source: 'hosted-worker' },
      projectId: job.project_id,
      runId: job.id,
      env: getSafeExecutionEnv(),
      signal: abortController.signal,
      onStepAttemptStart: async (stepId, attempt) => {
        return recordStepAttemptStart({ runId: job.id, stepId, attempt })
      },
      onStepAttemptFinish: async (attemptId, details) => {
        if (typeof attemptId === 'string') {
          await recordStepAttemptFinish(attemptId, details)
        }
      },
      onNonIdempotentStep: async () => {
        await markRunNonIdempotentStep(job.id)
      },
    })

    if (result.status === 'cancelled') {
      await finishRun(job.id, {
        status: 'cancelled',
        steps: result.steps,
        error: result.error,
        cancellationReason: 'Execution cancelled',
      })
      console.log(JSON.stringify({ event: 'run_cancelled', runId: job.id, durationMs: Date.now() - startTime }))
    } else {
      await finishRun(job.id, result)
      console.log(JSON.stringify({
        event: 'run_completed',
        runId: job.id,
        status: result.status,
        durationMs: Date.now() - startTime,
        attempt: job.attempt_count,
      }))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Worker execution failed'
    await finishRun(job.id, { status: 'failed', steps: [], error: message })
    console.error(JSON.stringify({ event: 'run_failed', runId: job.id, error: message, durationMs: Date.now() - startTime }))
  } finally {
    clearInterval(heartbeatTimer)
  }
}

async function main() {
  await initializeStore()
  console.log(JSON.stringify({ service: 'flowscript-worker', workerId, status: 'ready', maxConcurrency: MAX_CONCURRENT_RUNS }))

  let lastRecoveryCheck = 0

  while (!stopping) {
    try {
      // Periodically recover stale/expired runs
      const now = Date.now()
      if (now - lastRecoveryCheck > 15_000) {
        lastRecoveryCheck = now
        await recoverStaleRuns()
      }

      await enqueueDueSchedule()

      if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
        await sleep(500)
        continue
      }

      const job = await claimQueuedRun(workerId, LEASE_DURATION_MS)
      if (!job) {
        await sleep(750)
        continue
      }

      console.log(JSON.stringify({ event: 'run_claimed', runId: job.id, workerId, attempt: job.attempt_count }))

      const runPromise = processJob(job).finally(() => {
        activeRuns.delete(runPromise)
      })
      activeRuns.add(runPromise)
    } catch (error) {
      console.error('FlowScript worker poll failed', error)
      await sleep(1500)
    }
  }

  // Graceful drain
  console.log(JSON.stringify({ service: 'flowscript-worker', status: 'draining', activeCount: activeRuns.size }))
  if (activeRuns.size > 0) {
    await Promise.race([
      Promise.allSettled(Array.from(activeRuns)),
      sleep(10_000),
    ])
  }

  await closeStore()
  console.log(JSON.stringify({ service: 'flowscript-worker', status: 'stopped' }))
}

const shutdown = () => {
  if (!stopping) {
    stopping = true
    console.log(JSON.stringify({ service: 'flowscript-worker', status: 'stopping' }))
  }
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

main().catch(error => {
  console.error('FlowScript worker failed to start', error)
  process.exitCode = 1
})
