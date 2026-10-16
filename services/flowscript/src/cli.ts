#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compileFlowSource } from './compiler.js'
import { executeFlowIR } from './runtime.js'

function usage(): never {
  console.error(`FlowScript CLI
  flow lint <file.flow>
  flow compile <file.flow>
  flow test <file.flow>
  flow run <file.flow> [--input input.json]`)
  process.exit(2)
}

const [command, file, ...args] = process.argv.slice(2)
if (!command || !file) usage()
const source = await readFile(resolve(file), 'utf8')
const compiled = compileFlowSource(source)
if (!compiled.ok) {
  for (const diagnostic of compiled.diagnostics) console.error(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
  process.exit(1)
}
if (command === 'lint') {
  console.log(`✓ ${compiled.ir.name}: no errors (sha256:${compiled.hash})`)
} else if (command === 'compile') {
  console.log(JSON.stringify({ hash: compiled.hash, ir: compiled.ir }, null, 2))
} else if (command === 'test' || command === 'run') {
  const inputIndex = args.indexOf('--input')
  const inputFile = inputIndex >= 0 ? args[inputIndex + 1] : undefined
  const input = inputFile ? JSON.parse(await readFile(resolve(inputFile), 'utf8')) as Record<string, unknown> : {}
  if (command === 'run' && compiled.ir.steps.some(step => step.kind === 'integration')) {
    console.error('Local live integration execution is not wired yet. Integration steps require the trusted Connect runtime adapter.')
    process.exit(3)
  }
  const result = await executeFlowIR(compiled.ir, { input, trigger: { source: 'cli' } })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'succeeded') process.exit(1)
} else usage()
