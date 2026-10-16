import { describe, expect, it, vi } from 'vitest'
import {
  ConnectFlowIntegrationExecutor,
  FlowIntegrationError,
  classifyProviderError,
  redactSensitiveData,
  type AppConnectionLookupLike,
  type HeadlessRuntimeLike,
  type PieceMetadataServiceLike,
} from './adapter.js'

describe('ConnectFlowIntegrationExecutor', () => {
  const mockPieceMetadata: PieceMetadataServiceLike = {
    getPiece: vi.fn(async ({ name }) => {
      if (name === 'gmail') {
        return {
          name: 'gmail',
          version: '1.0.0',
          actions: {
            sendEmail: {
              name: 'sendEmail',
              displayName: 'Send Email',
              props: {
                to: { type: 'SHORT_TEXT', required: true },
                subject: { type: 'SHORT_TEXT', required: false },
              },
            },
          },
        }
      }
      return null
    }),
  }

  const mockConnectionLookup: AppConnectionLookupLike = {
    getConnection: vi.fn(async ({ connectionId, projectId, pieceName }) => {
      if (connectionId === 'conn_valid' && projectId === 'proj_1' && pieceName === 'gmail') {
        return {
          id: 'conn_valid',
          projectId: 'proj_1',
          platformId: 'plat_1',
          pieceName: 'gmail',
        }
      }
      return null
    }),
  }

  const mockRuntime: HeadlessRuntimeLike = {
    execute: vi.fn(async ({ tool, input }) => {
      if (tool === 'sendEmail') {
        return { messageId: 'msg_999', recipient: input.to, status: 'sent' }
      }
      return { success: true }
    }),
  }

  const createExecutor = (overrides?: {
    pieceMetadata?: PieceMetadataServiceLike
    connectionLookup?: AppConnectionLookupLike
    runtime?: HeadlessRuntimeLike
  }) => {
    return new ConnectFlowIntegrationExecutor({
      pieceMetadata: overrides?.pieceMetadata ?? mockPieceMetadata,
      connectionLookup: overrides?.connectionLookup ?? mockConnectionLookup,
      runtime: overrides?.runtime ?? mockRuntime,
    })
  }

  it('successfully executes a valid action and redacts sensitive data in output', async () => {
    const executor = createExecutor()
    const result = await executor.execute({
      projectId: 'proj_1',
      platformId: 'plat_1',
      integrationName: 'gmail',
      actionName: 'sendEmail',
      connectionId: 'conn_valid',
      input: { to: 'test@example.com', subject: 'Hello' },
      runId: 'run_1',
      stepId: 'step_send',
    })

    expect(result).toEqual({ messageId: 'msg_999', recipient: 'test@example.com', status: 'sent' })
    expect(mockRuntime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: 'gmail',
        tool: 'sendEmail',
        connectionId: 'conn_valid',
        projectId: 'proj_1',
        platformId: 'plat_1',
        input: { to: 'test@example.com', subject: 'Hello' },
      }),
    )
  })

  it('rejects execution when required parameters are missing', async () => {
    const executor = createExecutor()

    await expect(
      executor.execute({
        projectId: '',
        platformId: 'plat_1',
        integrationName: 'gmail',
        actionName: 'sendEmail',
        connectionId: 'conn_valid',
        input: {},
        runId: 'run_1',
        stepId: 'step_1',
      }),
    ).rejects.toMatchObject({
      name: 'FlowIntegrationError',
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('Project ID is required'),
    })

    await expect(
      executor.execute({
        projectId: 'proj_1',
        platformId: 'plat_1',
        integrationName: 'gmail',
        actionName: 'sendEmail',
        connectionId: '',
        input: {},
        runId: 'run_1',
        stepId: 'step_1',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('Connection ID is required'),
    })
  })

  it('strictly rejects direct credentials in action inputs', async () => {
    const executor = createExecutor()

    const credentialKeys = ['auth', 'apiKey', 'api_key', 'accessToken', 'access_token', 'password', 'secret', 'token', 'credentials']
    for (const key of credentialKeys) {
      await expect(
        executor.execute({
          projectId: 'proj_1',
          platformId: 'plat_1',
          integrationName: 'gmail',
          actionName: 'sendEmail',
          connectionId: 'conn_valid',
          input: { to: 'test@example.com', [key]: 'raw_secret_val' },
          runId: 'run_1',
          stepId: 'step_1',
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining(`Direct credential or auth property "${key}" is forbidden`),
      })
    }
  })

  it('rejects unknown integration names with INTEGRATION_NOT_FOUND', async () => {
    const executor = createExecutor()

    await expect(
      executor.execute({
        projectId: 'proj_1',
        platformId: 'plat_1',
        integrationName: 'unknown_service',
        actionName: 'doSomething',
        connectionId: 'conn_valid',
        input: {},
        runId: 'run_1',
        stepId: 'step_1',
      }),
    ).rejects.toMatchObject({
      code: 'INTEGRATION_NOT_FOUND',
      message: expect.stringContaining('was not found or is not available'),
    })
  })

  it('rejects unknown actions on existing integrations with ACTION_NOT_FOUND', async () => {
    const executor = createExecutor()

    await expect(
      executor.execute({
        projectId: 'proj_1',
        platformId: 'plat_1',
        integrationName: 'gmail',
        actionName: 'nonExistentAction',
        connectionId: 'conn_valid',
        input: {},
        runId: 'run_1',
        stepId: 'step_1',
      }),
    ).rejects.toMatchObject({
      code: 'ACTION_NOT_FOUND',
      message: expect.stringContaining('Available actions: sendEmail'),
    })
  })

  it('rejects cross-project or unauthorized connections before calling the runtime', async () => {
    const executor = createExecutor()

    // conn_valid exists for proj_1, but proj_2 is requesting it
    await expect(
      executor.execute({
        projectId: 'proj_2',
        platformId: 'plat_1',
        integrationName: 'gmail',
        actionName: 'sendEmail',
        connectionId: 'conn_valid',
        input: { to: 'test@example.com' },
        runId: 'run_1',
        stepId: 'step_1',
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
      message: expect.stringContaining('not found for piece "gmail" in project "proj_2"'),
    })
  })

  it('rejects missing required action props declared in metadata', async () => {
    const executor = createExecutor()

    await expect(
      executor.execute({
        projectId: 'proj_1',
        platformId: 'plat_1',
        integrationName: 'gmail',
        actionName: 'sendEmail',
        connectionId: 'conn_valid',
        input: { subject: 'Missing to field' },
        runId: 'run_1',
        stepId: 'step_1',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('Missing required property "to"'),
    })
  })

  it('classifies provider errors and sanitizes error messages', async () => {
    const failingRuntime: HeadlessRuntimeLike = {
      execute: vi.fn().mockRejectedValue(new Error('Provider rate limit reached: status 429. Bearer secret_token_xyz')),
    }
    const executor = createExecutor({ runtime: failingRuntime })

    await expect(
      executor.execute({
        projectId: 'proj_1',
        platformId: 'plat_1',
        integrationName: 'gmail',
        actionName: 'sendEmail',
        connectionId: 'conn_valid',
        input: { to: 'test@example.com' },
        runId: 'run_1',
        stepId: 'step_1',
      }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('Bearer [REDACTED]'),
      details: expect.objectContaining({ retryable: true }),
    })
  })
})

describe('classifyProviderError', () => {
  it('classifies rate limit errors', () => {
    expect(classifyProviderError(new Error('Rate limit exceeded (429)'))).toEqual({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded (429)',
      retryable: true,
    })
    expect(classifyProviderError({ status: 429, message: 'Too many requests' })).toEqual({
      code: 'RATE_LIMITED',
      message: '[object Object]',
      retryable: true,
    })
  })

  it('classifies authentication expired errors', () => {
    expect(classifyProviderError(new Error('401 Unauthorized: token expired'))).toEqual({
      code: 'AUTHENTICATION_EXPIRED',
      message: '401 Unauthorized: token expired',
      retryable: false,
    })
    expect(classifyProviderError({ statusCode: 401 })).toEqual({
      code: 'AUTHENTICATION_EXPIRED',
      message: '[object Object]',
      retryable: false,
    })
  })

  it('classifies provider 5xx errors', () => {
    expect(classifyProviderError(new Error('502 Bad Gateway from upstream API'))).toEqual({
      code: 'PROVIDER_ERROR',
      message: '502 Bad Gateway from upstream API',
      retryable: true,
    })
  })

  it('classifies timeouts', () => {
    expect(classifyProviderError(new Error('Connection timed out: ETIMEDOUT'))).toEqual({
      code: 'TIMEOUT',
      message: 'Connection timed out: ETIMEDOUT',
      retryable: true,
    })
  })

  it('classifies connection not found', () => {
    expect(classifyProviderError(new Error('entity_not_found: App connection does not exist'))).toEqual({
      code: 'CONNECTION_NOT_FOUND',
      message: 'entity_not_found: App connection does not exist',
      retryable: false,
    })
  })

  it('preserves FlowIntegrationError properties', () => {
    const err = new FlowIntegrationError('CROSS_PROJECT_FORBIDDEN', 'Access forbidden', { retryable: false })
    expect(classifyProviderError(err)).toEqual({
      code: 'CROSS_PROJECT_FORBIDDEN',
      message: '[CROSS_PROJECT_FORBIDDEN] Access forbidden',
      retryable: false,
    })
  })
})

describe('redactSensitiveData', () => {
  it('redacts sensitive keys from objects recursively', () => {
    const input = {
      user: 'alice',
      token: 'super_secret_token_123',
      nested: {
        apiKey: 'key_abc',
        clientPassword: 'pass',
        normalKey: 'safe_value',
      },
      list: [{ secret: 'shh' }, 'harmless'],
    }

    const redacted = redactSensitiveData(input)
    expect(redacted).toEqual({
      user: 'alice',
      token: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        clientPassword: '[REDACTED]',
        normalKey: 'safe_value',
      },
      list: [{ secret: '[REDACTED]' }, 'harmless'],
    })
  })

  it('redacts Bearer tokens and key-value secrets in strings', () => {
    const str = 'Request failed with Bearer ya29.a0AfH6_somelongtoken and api_key="secret123"'
    const redacted = redactSensitiveData(str)
    expect(redacted).toBe('Request failed with Bearer [REDACTED] and api_key=[REDACTED]')
  })
})
