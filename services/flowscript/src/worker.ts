import { closeStore, claimQueuedRun, enqueueDueSchedule, finishRun, initializeStore } from './store.js'
import { executeFlowIR } from './runtime.js'
import { getSafeExecutionEnv } from './server.js'
import type { FlowIR } from './compiler.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let stopping = false

async function main() {
  await initializeStore()
  console.log(JSON.stringify({ service: 'flowscript-worker', status: 'ready' }))
  while (!stopping) {
    try {
      await enqueueDueSchedule()
      const job = await claimQueuedRun()
      if (!job) {
        await sleep(750)
        continue
      }
      try {
        const result = await executeFlowIR(job.ir as FlowIR, {
          input: job.input,
          trigger: { kind: job.trigger_kind, source: 'hosted-worker' },
          projectId: job.project_id,
          runId: job.id,
          env: getSafeExecutionEnv(),
        })
        await finishRun(job.id, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Worker execution failed'
        await finishRun(job.id, { status: 'failed', steps: [], error: message })
      }
    } catch (error) {
      console.error('FlowScript worker poll failed', error)
      await sleep(1500)
    }
  }
  await closeStore()
}

const shutdown = () => { stopping = true }
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
main().catch(error => {
  console.error('FlowScript worker failed to start', error)
  process.exitCode = 1
})
