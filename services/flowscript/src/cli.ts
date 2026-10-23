#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { compileFlowSource, validateRunInput } from './compiler.js'
import { executeFlowIR } from './runtime.js'

function getOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index >= 0 && args[index + 1]) {
    return args[index + 1]
  }
  return undefined
}

export async function runCli(argv: string[], io: CliIo = {
  stdout: (msg: string) => console.log(msg),
  stderr: (msg: string) => console.error(msg),
  exit: (code: number) => process.exit(code),
  cwd: process.cwd(),
  fetch: globalThis.fetch,
  env: process.env,
}): Promise<void> {
  const [command, file, ...args] = argv
  if (!command) {
    io.stderr(`FlowScript CLI
  flow init <name> [--out <file.flow>] [--force]
  flow fmt <file.flow> [--check]
  flow lint <file.flow>
  flow compile <file.flow>
  flow test <file.flow> [--input <file.json>] [--mock] [--mock-integrations <file.json>]
  flow run <file.flow> [--input <file.json>] [--mock] [--mock-integrations <file.json>]
  flow publish <file.flow> [--api-url <url>] [--project-id <id>]
  flow deploy <name> <versionId> [--env <environment>] [--api-url <url>] [--project-id <id>]
  flow runs [--flow <name>] [--limit <n>] [--api-url <url>] [--project-id <id>]
  flow logs <run-id> [--api-url <url>] [--project-id <id>]
  flow rollback <name> [--env <environment>] [--api-url <url>] [--project-id <id>]
  flow triggers <name> [--api-url <url>] [--project-id <id>]
  flow cancel <run-id> [--reason <msg>] [--api-url <url>] [--project-id <id>]
  flow replay <run-id> [--api-url <url>] [--project-id <id>]
  flow metrics [--api-url <url>] [--project-id <id>]`)
    return io.exit(2)
  }

  const fetchClient = io.fetch ?? globalThis.fetch
  const envVars = io.env ?? process.env
  const allArgs = argv.slice(1)
  const apiUrl = getOption(allArgs, '--api-url') ?? envVars.FLOWSCRIPT_API_URL ?? 'http://localhost:8081'
  const projectId = getOption(allArgs, '--project-id') ?? envVars.FLOWSCRIPT_PROJECT_ID ?? 'default-project'

  if (command === 'init') {
    const name = file
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      io.stderr(`ERROR: Invalid flow name "${name}". Names must match ^[a-zA-Z][a-zA-Z0-9_-]*$`)
      return io.exit(1)
    }

    const outPath = getOption(args, '--out') ?? `${name}.flow`
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
    if (!file) {
      io.stderr('ERROR: File path required for fmt')
      return io.exit(2)
    }
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

  if (command === 'publish') {
    if (!file) {
      io.stderr('ERROR: Flow file path required for publish')
      return io.exit(2)
    }
    let source: string
    try {
      source = await readFile(resolve(io.cwd, file), 'utf8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Cannot read "${file}": ${msg}`)
      return io.exit(1)
    }

    try {
      const res = await fetchClient(`${apiUrl}/v1/flows/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-project-id': projectId,
        },
        body: JSON.stringify({ source }),
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Publish failed (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      if (isRecord(data) && typeof data.id === 'string' && typeof data.flow === 'string') {
        io.stdout(`✓ Published flow "${data.flow}" (version: ${String(data.version)}, id: ${data.id})`)
      } else {
        io.stdout(JSON.stringify(data, null, 2))
      }
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }



  if (command === 'rollback') {
    const flowName = file
    if (!flowName) {
      io.stderr('ERROR: flow rollback requires <name>')
      return io.exit(2)
    }
    const environment = getOption(allArgs, '--env') ?? 'production'

    try {
      const res = await fetchClient(`${apiUrl}/v1/flows/${encodeURIComponent(flowName)}/rollback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-project-id': projectId,
        },
        body: JSON.stringify({ environment }),
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Rollback failed (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      if (isRecord(data)) {
        io.stdout(`✓ Rolled back flow "${flowName}" in ${environment} to version ${String(data.version)} (id: ${String(data.versionId)})`)
      } else {
        io.stdout(`✓ Rolled back flow "${flowName}" in ${environment}`)
      }
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }

  if (command === 'triggers') {
    const flowName = file
    if (!flowName) {
      io.stderr('ERROR: flow triggers requires <name>')
      return io.exit(2)
    }

    try {
      const res = await fetchClient(`${apiUrl}/v1/flows/${encodeURIComponent(flowName)}/triggers`, {
        method: 'GET',
        headers: { 'x-project-id': projectId },
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Failed to fetch triggers (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      if (Array.isArray(data)) {
        if (data.length === 0) {
          io.stdout(`No triggers registered for flow "${flowName}".`)
          return
        }
        for (const trigger of data) {
          if (isRecord(trigger)) {
            const status = trigger.enabled ? 'ENABLED' : 'DISABLED'
            io.stdout(`[${status}] ${String(trigger.id)} (${String(trigger.kind)}) - env: ${String(trigger.environment)}`)
          }
        }
      } else {
        io.stdout(JSON.stringify(data, null, 2))
      }
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }
  if (command === 'deploy') {
    const flowName = file
    const versionId = args[0]
    if (!flowName || !versionId) {
      io.stderr('ERROR: flow deploy requires <name> and <versionId>')
      return io.exit(2)
    }
    const environment = getOption(args, '--env') ?? 'production'

    try {
      const res = await fetchClient(`${apiUrl}/v1/flows/${encodeURIComponent(flowName)}/deploy`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-project-id': projectId,
        },
        body: JSON.stringify({ versionId, environment }),
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Deploy failed (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      io.stdout(`✓ Deployed flow "${flowName}" to ${environment}`)
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }

  if (command === 'runs') {
    const filterFlow = getOption(allArgs, '--flow') ?? (file && !file.startsWith('--') ? file : undefined)
    const limit = getOption(allArgs, '--limit') ?? '20'
    const query = new URLSearchParams()
    if (filterFlow) query.set('flow', filterFlow)
    query.set('limit', limit)

    try {
      const res = await fetchClient(`${apiUrl}/v1/runs?${query.toString()}`, {
        method: 'GET',
        headers: { 'x-project-id': projectId },
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Failed to fetch runs (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      if (isRecord(data) && Array.isArray(data.runs)) {
        if (data.runs.length === 0) {
          io.stdout('No runs found.')
          return
        }
        for (const run of data.runs) {
          if (isRecord(run)) {
            io.stdout(`[${String(run.status).toUpperCase()}] ${String(run.id)} - flow: ${String(run.flow)} (env: ${String(run.environment)})`)
          }
        }
      } else {
        io.stdout(JSON.stringify(data, null, 2))
      }
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }

  if (command === 'logs') {
    const runId = file
    if (!runId) {
      io.stderr('ERROR: flow logs requires <run-id>')
      return io.exit(2)
    }

    try {
      const res = await fetchClient(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}`, {
        method: 'GET',
        headers: { 'x-project-id': projectId },
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Failed to fetch run logs (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      io.stdout(JSON.stringify(data, null, 2))
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }

  if (command === 'cancel') {
    const runId = file
    if (!runId) {
      io.stderr('ERROR: flow cancel requires <run-id>')
      return io.exit(2)
    }
    const reason = getOption(args, '--reason')

    try {
      const res = await fetchClient(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-project-id': projectId,
        },
        body: JSON.stringify({ reason }),
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Cancel failed (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      io.stdout(`✓ Cancelled run ${runId}`)
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }

  if (command === 'replay') {
    const runId = file
    if (!runId) {
      io.stderr('ERROR: flow replay requires <run-id>')
      return io.exit(2)
    }

    try {
      const res = await fetchClient(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}/replay`, {
        method: 'POST',
        headers: {
          'x-project-id': projectId,
        },
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Replay failed (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      if (isRecord(data) && typeof data.id === 'string') {
        io.stdout(`✓ Replayed run ${runId} -> new run ${data.id}`)
      } else {
        io.stdout(JSON.stringify(data, null, 2))
      }
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }


  if (command === 'metrics') {
    try {
      const res = await fetchClient(`${apiUrl}/v1/metrics`, {
        headers: {
          'x-project-id': projectId,
        },
      })

      const data: unknown = await res.json()
      if (!res.ok) {
        const errorMsg = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText
        io.stderr(`ERROR: Metrics fetch failed (${res.status}): ${errorMsg}`)
        return io.exit(1)
      }

      if (isRecord(data)) {
        io.stdout(JSON.stringify(data, null, 2))
      } else {
        io.stdout(String(data))
      }
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.stderr(`ERROR: Failed to connect to FlowScript API at "${apiUrl}": ${msg}`)
      return io.exit(1)
    }
  }

  if (!file) {
    io.stderr(`ERROR: File path required for ${command}`)
    return io.exit(2)
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
    const inputFile = getOption(args, '--input')
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
    const mockFile = getOption(args, '--mock-integrations')

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
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
}
