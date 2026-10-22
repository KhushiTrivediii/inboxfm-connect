import { describe, expect, it, vi } from 'vitest'
import { compileFlowSource, type FlowIR } from './compiler.js'
import { executeFlowIR, topologicallySortSteps } from './runtime.js'
import { ConnectFlowIntegrationExecutor } from './adapter.js'

const source = `flow: hello-world
version: 1
trigger:
  kind: manual
inputSchema: {}
steps:
  - id: greeting
    kind: transform
    config:
      value:
        message: hello
        name:
          $ref: input.name
    dependsOn: []
output:
  greeting:
    $ref: steps.greeting
`

const integrationSource = `flow: integration-flow
version: 1
trigger:
  kind: manual
inputSchema: {}
steps:
  - id: send_message
    kind: integration
    config:
      integration: slack
      action: postMessage
      connectionId: conn_slack_1
      input:
        channel: C12345
        text: Hello from FlowScript
    dependsOn: []
output:
  result:
    $ref: steps.send_message
`

describe('executeFlowIR', () => {
  it('runs pure transform steps and resolves references', async () => {
    const compiled = compileFlowSource(source)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const result = await executeFlowIR(compiled.ir, { input: { name: 'Mihir' } })
    expect(result.status).toBe('succeeded')
    expect(result.output).toEqual({ greeting: { message: 'hello', name: 'Mihir' } })
  })

  it('refuses integration execution without a trusted adapter', async () => {
    const compiled = compileFlowSource(source.replace('kind: transform', 'kind: integration'))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const result = await executeFlowIR(compiled.ir)
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('No trusted integration executor')
  })

  it('executes integration steps with ConnectFlowIntegrationExecutor', async () => {
    const compiled = compileFlowSource(integrationSource)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    const mockPieceMetadata = {
      getPiece: vi.fn(async () => ({
        name: 'slack',
        version: '1.0.0',
        actions: {
          postMessage: {
            name: 'postMessage',
            displayName: 'Post Message',
            props: {},
          },
        },
      })),
    }

    const mockConnectionLookup = {
      getConnection: vi.fn(async () => ({
        id: 'conn_slack_1',
        projectId: 'project_123',
        platformId: 'platform_abc',
        pieceName: 'slack',
      })),
    }

    const mockRuntime = {
      execute: vi.fn(async () => ({
        ts: '1234567890.123456',
        ok: true,
        secretToken: 'secret_leak_123',
      })),
    }

    const executor = new ConnectFlowIntegrationExecutor({
      pieceMetadata: mockPieceMetadata,
      connectionLookup: mockConnectionLookup,
      runtime: mockRuntime,
    })

    const result = await executeFlowIR(compiled.ir, {
      projectId: 'project_123',
      platformId: 'platform_abc',
      runId: 'run_test_456',
      integrationExecutor: executor,
    })

    expect(result.status).toBe('succeeded')
    expect(mockRuntime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: 'slack',
        tool: 'postMessage',
        connectionId: 'conn_slack_1',
        projectId: 'project_123',
        platformId: 'platform_abc',
      }),
    )
    // Secret token in output is redacted
    expect(result.output).toEqual({
      result: {
        ts: '1234567890.123456',
        ok: true,
        secretToken: '[REDACTED]',
      },
    })
  })

  it('redacts sensitive error details when an integration step fails', async () => {
    const compiled = compileFlowSource(integrationSource)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    const mockPieceMetadata = {
      getPiece: vi.fn(async () => ({
        name: 'slack',
        version: '1.0.0',
        actions: { postMessage: { name: 'postMessage', displayName: 'Post Message' } },
      })),
    }

    const mockConnectionLookup = {
      getConnection: vi.fn(async () => ({
        id: 'conn_slack_1',
        projectId: 'project_123',
        platformId: 'platform_abc',
        pieceName: 'slack',
      })),
    }

    const mockRuntime = {
      execute: vi.fn(async () => {
        throw new Error('Upstream failed: Bearer secret_live_token_777 rejected')
      }),
    }

    const executor = new ConnectFlowIntegrationExecutor({
      pieceMetadata: mockPieceMetadata,
      connectionLookup: mockConnectionLookup,
      runtime: mockRuntime,
    })

    const result = await executeFlowIR(compiled.ir, {
      projectId: 'project_123',
      platformId: 'platform_abc',
      runId: 'run_test_456',
      integrationExecutor: executor,
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('Bearer [REDACTED]')
    expect(result.steps[0].error).not.toContain('secret_live_token_777')
  })

  it('isolates process.env when options.env is not provided', async () => {
    const envSource = `flow: env-check
version: 1
trigger:
  kind: manual
inputSchema: {}
steps:
  - id: check_env
    kind: transform
    config:
      value:
        dbPass:
          $env: DATABASE_PASSWORD
    dependsOn: []
output:
  result:
    $ref: steps.check_env
`
    const compiled = compileFlowSource(envSource)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    // Set a test variable in process.env
    process.env.DATABASE_PASSWORD = 'super_secret_db_password'
    try {
      // Since options.env is not provided, context.env defaults to {}, so $env: DATABASE_PASSWORD fails to resolve
      const result = await executeFlowIR(compiled.ir)
      expect(result.status).toBe('failed')
      expect(result.steps[0].error).toContain('Missing environment variable "DATABASE_PASSWORD"')

      // When explicitly provided in options.env, it succeeds
      const resultWithEnv = await executeFlowIR(compiled.ir, {
        env: { DATABASE_PASSWORD: 'allowed_isolated_val' },
      })
      expect(resultWithEnv.status).toBe('succeeded')
      expect((resultWithEnv.output as Record<string, unknown>).result).toEqual({ dbPass: 'allowed_isolated_val' })
    } finally {
      delete process.env.DATABASE_PASSWORD
    }
  })

  it('returns a failed result preserving completed steps if output resolution fails', async () => {
    const outputFailSource = `flow: output-fail
version: 1
trigger:
  kind: manual
inputSchema: {}
steps:
  - id: step_one
    kind: transform
    config:
      value:
        status: ok
    dependsOn: []
output:
  badEnv:
    $env: NON_EXISTENT_ENV_VAR
`
    const compiled = compileFlowSource(outputFailSource)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    const result = await executeFlowIR(compiled.ir)
    expect(result.status).toBe('failed')
    // Step one succeeded and is preserved in steps
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].id).toBe('step_one')
    expect(result.steps[0].status).toBe('succeeded')
    expect((result as { error?: string }).error).toContain('Missing environment variable "NON_EXISTENT_ENV_VAR"')
  })

  it('enforces the maximum step count', async () => {
    const compiled = compileFlowSource(source)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    await expect(executeFlowIR(compiled.ir, { maxSteps: 0 })).rejects.toThrow('maximum step count')
  })

  it('topologically sorts steps so dependencies execute before dependents regardless of declaration order', async () => {
    const irWithReverseSteps: FlowIR = {
      irVersion: 1,
      name: 'reverse-order-flow',
      version: 1,
      trigger: { kind: 'manual' },
      inputSchema: {},
      steps: [
        {
          id: 'step_two',
          kind: 'transform',
          config: {
            value: {
              doubled: 42,
              fromFirst: { $ref: 'steps.step_one.initial' },
            },
          },
          dependsOn: ['step_one'],
        },
        {
          id: 'step_one',
          kind: 'transform',
          config: {
            value: {
              initial: 21,
            },
          },
          dependsOn: [],
        },
      ],
      output: {
        final: { $ref: 'steps.step_two.fromFirst' },
      },
    }

    const result = await executeFlowIR(irWithReverseSteps)
    expect(result.status).toBe('succeeded')
    expect(result.steps).toHaveLength(2)
    // Topological sort orders step_one before step_two
    expect(result.steps[0].id).toBe('step_one')
    expect(result.steps[0].status).toBe('succeeded')
    expect(result.steps[1].id).toBe('step_two')
    expect(result.steps[1].status).toBe('succeeded')
    expect(result.output).toEqual({ final: 21 })
  })

  it('topologicallySortSteps handles complex DAG dependencies', () => {
    const steps = [
      { id: 'd', dependsOn: ['b', 'c'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] },
    ]
    const sorted = topologicallySortSteps(steps)
    const order = sorted.map((s: { id: string }) => s.id)

    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
  })
})

