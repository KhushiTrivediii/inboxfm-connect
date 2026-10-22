#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { compileFlowSource, validateRunInput } from './compiler.js'
import { executeFlowIR } from './runtime.js'

export async function runCli(argv: string[], io: CliIo = {
  stdout: (msg: string) => console.log(msg),
  stderr: (msg: string) => console.error(msg),
  exit: (code: number) => process.exit(code),
  cwd: process.cwd(),
}): Promise<void> {
  const [command, file, ...args] = argv
  if (!command || !file) {
    io.stderr(`FlowScript CLI
  flow init <name> [--out <file.flow>] [--force]
  flow fmt <file.flow> [--check]
  flow lint <file.flow>
  flow compile <file.flow>
  flow test <file.flow> [--input <file.json>] [--mock] [--mock-integrations <file.json>]
  flow run <file.flow> [--input <file.json>] [--mock] [--mock-integrations <file.json>]`)
    return io.exit(2)
  }

  if (command === 'init') {
    const name = file
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      io.stderr(`ERROR: Invalid flow name "${name}". Names must match ^[a-zA-Z][a-zA-Z0-9_-]*$`)
      return io.exit(1)
    }

    const outIndex = args.indexOf('--out')
    const outPath = outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : `${name}.flow`
    const resolvedOut = resolve(io.cwd, outPath)
    const force = args.includes('--force')

    try {
      const existing = await readFile(resolvedOut, 'utf8')
      if (existing && !force) {
        io.stderr(`ERROR: File "${outPath}" already exists. Use --force to overwrite.`)
        return io.exit(1)
      }
    } catch {
      // File does not exist yet, continue
    }

    const template = `flow: ${name}
version: 1
description: Minimal flow created with FlowScript CLI
trigger:
  kind: manual
inputSchema:
  message:
    type: string
steps:
  - id: step_1
    kind: transform
    config:
      value:
        echo:
          $ref: input.message
    dependsOn: []
output:
  result:
    $ref: steps.step_1
`
    await writeFile(resolvedOut, template, 'utf8')
    io.stdout(`✓ Created ${outPath}`)
    return
  }

  if (command === 'fmt') {
    const targetPath = resolve(io.cwd, file)
    let source: string
    try {
      source = await readFile(targetPath, 'utf8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Cannot read "${file}": ${msg}`)
      return io.exit(1)
    }

    let parsed: unknown
    try {
      parsed = parseYaml(source)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to parse YAML in "${file}": ${msg}`)
      return io.exit(1)
    }

    const formatted = stringifyYaml(parsed, { indent: 2, lineWidth: 0 })
    const isCheck = args.includes('--check')

    if (isCheck) {
      if (source.trim() === formatted.trim()) {
        io.stdout(`✓ ${file} is formatted`)
        return
      }
      io.stderr(`✗ ${file} is not formatted`)
      return io.exit(1)
    }

    await writeFile(targetPath, formatted, 'utf8')
    io.stdout(`✓ Formatted ${file}`)
    return
  }

  let source: string
  try {
    source = await readFile(resolve(io.cwd, file), 'utf8')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    io.stderr(`ERROR: Cannot read "${file}": ${msg}`)
    return io.exit(1)
  }

  const compiled = compileFlowSource(source)
  if (!compiled.ok) {
    for (const diagnostic of compiled.diagnostics) {
      io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
    }
    return io.exit(1)
  }

  if (command === 'lint') {
    io.stdout(`✓ ${compiled.ir.name}: no errors (sha256:${compiled.hash})`)
    return
  }

  if (command === 'compile') {
    io.stdout(JSON.stringify({ hash: compiled.hash, ir: compiled.ir }, null, 2))
    return
  }

  if (command === 'test' || command === 'run') {
    const inputIndex = args.indexOf('--input')
    if (inputIndex >= 0 && !args[inputIndex + 1]) {
      io.stderr('ERROR: --input flag requires a file path argument')
      return io.exit(2)
    }
    const inputFile = inputIndex >= 0 ? args[inputIndex + 1] : undefined
    let input: Record<string, unknown> = {}
    if (inputFile) {
      try {
        const raw = await readFile(resolve(io.cwd, inputFile), 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed)) {
          input = parsed
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        io.stderr(`ERROR: Failed to parse input file "${inputFile}": ${msg}`)
        return io.exit(1)
      }
    }

    const inputValidation = validateRunInput(compiled.ir.inputSchema ?? {}, input)
    if (!inputValidation.ok) {
      for (const diagnostic of inputValidation.diagnostics) {
        io.stderr(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
      }
      return io.exit(1)
    }

    const hasIntegration = compiled.ir.steps.some(step => step.kind === 'integration')
    const isMock = args.includes('--mock') || args.includes('--mock-integrations')
    const mockFileIndex = args.indexOf('--mock-integrations')
    const mockFile = mockFileIndex >= 0 ? args[mockFileIndex + 1] : undefined

    let mockData: Record<string, unknown> = {}
    if (mockFile) {
      try {
        const raw = await readFile(resolve(io.cwd, mockFile), 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed)) {
          mockData = parsed
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        io.stderr(`ERROR: Failed to parse mock file "${mockFile}": ${msg}`)
        return io.exit(1)
      }
    }

    let integrationExecutor: ((config: Record<string, unknown>, context: { outputs: Record<string, unknown> }) => Promise<unknown>) | undefined

    if (hasIntegration) {
      if (!isMock) {
        io.stderr('Local live integration execution is not wired yet. Integration steps require the trusted Connect runtime adapter. Use --mock or --mock-integrations <file.json> to test locally.')
        return io.exit(3)
      }

      integrationExecutor = async (config, context) => {
        const stepId = isRecord(config) && typeof config.stepId === 'string' ? config.stepId : undefined
        if (stepId && mockData[stepId] !== undefined) {
          return mockData[stepId]
        }
        return { mock: true, config, outputs: context.outputs }
      }
    }

    const result = await executeFlowIR(compiled.ir, {
      input,
      trigger: { source: 'cli' },
      integrationExecutor,
    })

    io.stdout(JSON.stringify(result, null, 2))
    if (result.status !== 'succeeded') {
      return io.exit(1)
    }
    return
  }

  io.stderr(`Unknown command: ${command}`)
  return io.exit(2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isMainModule = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
)

if (isMainModule) {
  void runCli(process.argv.slice(2))
}

export type CliIo = {
  stdout: (msg: string) => void
  stderr: (msg: string) => void
  exit: (code: number) => void
  cwd: string
}
