import { closeStore, initializeStore } from './store.js'

async function main() {
  await initializeStore()
  console.log(JSON.stringify({ service: 'flowscript-worker', status: 'ready', note: 'Durable trigger dispatch and integration adapter are not enabled in this slice.' }))
  const shutdown = async () => {
    await closeStore()
    process.exit(0)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
main().catch(error => {
  console.error('FlowScript worker failed to start', error)
  process.exitCode = 1
})
