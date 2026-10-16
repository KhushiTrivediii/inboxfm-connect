export interface FlowIntegrationExecutor {
  execute(input: {
    projectId: string
    platformId: string
    integrationName: string
    actionName: string
    connectionId: string
    input: Record<string, unknown>
    runId: string
    stepId: string
    idempotencyKey?: string
  }): Promise<unknown>
}

export type IntegrationErrorClassification =
  | 'VALIDATION_ERROR'
  | 'INTEGRATION_NOT_FOUND'
  | 'ACTION_NOT_FOUND'
  | 'CONNECTION_NOT_FOUND'
  | 'CROSS_PROJECT_FORBIDDEN'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION_EXPIRED'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'ENGINE_OPERATION_FAILURE'

export class FlowIntegrationError extends Error {
  constructor(
    public readonly code: IntegrationErrorClassification,
    message: string,
    public readonly details?: {
      integrationName?: string
      actionName?: string
      connectionId?: string
      projectId?: string
      platformId?: string
      stepId?: string
      runId?: string
      retryable?: boolean
      status?: number
    },
  ) {
    super(`[${code}] ${message}`)
    this.name = 'FlowIntegrationError'
  }
}

export type PieceMetadataServiceLike = {
  getPiece(params: { name: string; version?: string; platformId?: string }): Promise<{
    name: string
    version: string
    actions: Record<string, {
      name: string
      displayName: string
      props?: Record<string, unknown>
      requireAuth?: boolean
    }>
  } | null>
}

export type AppConnectionLookupLike = {
  getConnection(params: {
    connectionId: string
    projectId: string
    platformId: string
    pieceName: string
  }): Promise<{
    id: string
    projectId: string
    platformId: string
    pieceName: string
    pieceVersion?: string
    externalId?: string
  } | null>
}

export type HeadlessRuntimeLike = {
  execute(params: {
    integration: string
    tool: string
    connectionId: string
    input: Record<string, unknown>
    projectId: string
    platformId: string
    idempotencyKey?: string
    internalApiUrl?: string
    publicApiUrl?: string
  }): Promise<unknown>
}

export interface ConnectFlowIntegrationExecutorOptions {
  pieceMetadata: PieceMetadataServiceLike
  connectionLookup: AppConnectionLookupLike
  runtime: HeadlessRuntimeLike
  internalApiUrl?: string
  publicApiUrl?: string
  logger?: {
    info(obj: Record<string, unknown>, msg?: string): void
    error(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
  }
}

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /api[_-]?key/i,
  /auth/i,
  /bearer/i,
  /private[_-]?key/i,
]

const FORBIDDEN_INPUT_CREDENTIAL_KEYS = new Set([
  'auth',
  'access_token',
  'accesstoken',
  'token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'credentials',
  'private_key',
  'privatekey',
])

function findForbiddenCredentialKey(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findForbiddenCredentialKey(item)
      if (found) return found
    }
    return null
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, '')
    if (FORBIDDEN_INPUT_CREDENTIAL_KEYS.has(key) || FORBIDDEN_INPUT_CREDENTIAL_KEYS.has(normalized)) {
      return key
    }
    const nested = findForbiddenCredentialKey(value)
    if (nested) return nested
  }
  return null
}

export function redactSensitiveData(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    let sanitized = value.replace(/Bearer\s+[A-Za-z0-9_.\-]+/gi, 'Bearer [REDACTED]')
    sanitized = sanitized.replace(/(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_.\-]+['"]?/gi, '$1=[REDACTED]')
    return sanitized
  }
  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveData(item))
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERNS.some(p => p.test(key))) {
        result[key] = '[REDACTED]'
      } else {
        result[key] = redactSensitiveData(val)
      }
    }
    return result
  }
  return value
}

export function classifyProviderError(error: unknown): { code: IntegrationErrorClassification; message: string; retryable: boolean } {
  if (error instanceof FlowIntegrationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.details?.retryable ?? false,
    }
  }

  const rawMessage = error instanceof Error ? error.message : String(error)
  const lower = rawMessage.toLowerCase()
  const status = typeof error === 'object' && error !== null
    ? (error as { status?: number; statusCode?: number; response?: { status?: number } }).status
      ?? (error as { statusCode?: number }).statusCode
      ?? (error as { response?: { status?: number } }).response?.status
    : undefined

  if (status === 429 || lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { code: 'RATE_LIMITED', message: rawMessage, retryable: true }
  }
  if (status === 401 || status === 403 || lower.includes('401') || lower.includes('unauthorized') || lower.includes('token expired') || lower.includes('invalid credentials')) {
    return { code: 'AUTHENTICATION_EXPIRED', message: rawMessage, retryable: false }
  }
  if ((status && status >= 500 && status < 600) || lower.includes('502') || lower.includes('503') || lower.includes('504') || lower.includes('bad gateway') || lower.includes('gateway timeout')) {
    return { code: 'PROVIDER_ERROR', message: rawMessage, retryable: true }
  }
  if (status === 408 || lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return { code: 'TIMEOUT', message: rawMessage, retryable: true }
  }
  if (lower.includes('connection not found') || lower.includes('entity_not_found') || lower.includes('app_connection_not_found')) {
    return { code: 'CONNECTION_NOT_FOUND', message: rawMessage, retryable: false }
  }
  if (status === 404 || lower.includes('not found')) {
    return { code: 'PROVIDER_ERROR', message: rawMessage, retryable: false }
  }

  return { code: 'ENGINE_OPERATION_FAILURE', message: rawMessage, retryable: false }
}

export class ConnectFlowIntegrationExecutor implements FlowIntegrationExecutor {
  constructor(private readonly options: ConnectFlowIntegrationExecutorOptions) {}

  async execute(input: {
    projectId: string
    platformId: string
    integrationName: string
    actionName: string
    connectionId: string
    input: Record<string, unknown>
    runId: string
    stepId: string
    idempotencyKey?: string
  }): Promise<unknown> {
    const { projectId, platformId, integrationName, actionName, connectionId, runId, stepId, idempotencyKey } = input
    const actionInput = input.input ?? {}

    // 1. Parameter presence validations
    if (!projectId) {
      throw new FlowIntegrationError('VALIDATION_ERROR', 'Project ID is required for integration execution', { stepId, runId, retryable: false })
    }
    if (!platformId) {
      throw new FlowIntegrationError('VALIDATION_ERROR', 'Platform ID is required for integration execution', { stepId, runId, retryable: false })
    }
    if (!integrationName) {
      throw new FlowIntegrationError('VALIDATION_ERROR', 'Integration name is required', { stepId, runId, retryable: false })
    }
    if (!actionName) {
      throw new FlowIntegrationError('VALIDATION_ERROR', 'Action name is required', { stepId, runId, retryable: false })
    }
    if (!connectionId) {
      throw new FlowIntegrationError('VALIDATION_ERROR', 'Connection ID is required for integration action execution', { stepId, runId, retryable: false })
    }

    // 2. Reject credentials in input (including nested objects)
    const forbiddenKey = findForbiddenCredentialKey(actionInput)
    if (forbiddenKey) {
      throw new FlowIntegrationError(
        'VALIDATION_ERROR',
        `Direct credential or auth property "${forbiddenKey}" is forbidden in FlowScript input for "${integrationName}.${actionName}". Use a configured connectionId instead.`,
        { integrationName, actionName, connectionId, stepId, runId, retryable: false },
      )
    }

    // 3. Validate connection ownership and platform/project scoping
    const connection = await this.options.connectionLookup.getConnection({
      connectionId,
      projectId,
      platformId,
      pieceName: integrationName,
    })
    if (!connection) {
      throw new FlowIntegrationError(
        'CONNECTION_NOT_FOUND',
        `Connection "${connectionId}" not found for piece "${integrationName}" in project "${projectId}"`,
        { connectionId, projectId, platformId, integrationName, stepId, runId, retryable: false },
      )
    }

    // 4. Metadata verification (pinned to connection's pieceVersion when present)
    const piece = await this.options.pieceMetadata.getPiece({
      name: integrationName,
      version: connection.pieceVersion,
      platformId,
    })
    if (!piece) {
      throw new FlowIntegrationError(
        'INTEGRATION_NOT_FOUND',
        `Integration "${integrationName}" was not found or is not available for platform "${platformId}"`,
        { integrationName, platformId, stepId, runId, retryable: false },
      )
    }

    const action = piece.actions[actionName]
    if (!action) {
      const available = Object.keys(piece.actions).join(', ')
      throw new FlowIntegrationError(
        'ACTION_NOT_FOUND',
        `Action "${actionName}" was not found on integration "${integrationName}". Available actions: ${available || '(none)'}`,
        { integrationName, actionName, stepId, runId, retryable: false },
      )
    }

    // 5. Check required action properties if metadata props are declared
    if (action.props && typeof action.props === 'object') {
      for (const [propName, propDef] of Object.entries(action.props)) {
        const isRequired = typeof propDef === 'object' && propDef !== null && (propDef as Record<string, unknown>).required === true
        if (isRequired && (actionInput[propName] === undefined || actionInput[propName] === null)) {
          throw new FlowIntegrationError(
            'VALIDATION_ERROR',
            `Missing required property "${propName}" for action "${integrationName}.${actionName}"`,
            { integrationName, actionName, connectionId, stepId, runId, retryable: false },
          )
        }
      }
    }

    // 6. Execute through Connect HeadlessRuntime
    try {
      this.options.logger?.info({
        integrationName,
        actionName,
        connectionId,
        projectId,
        runId,
        stepId,
        idempotencyKey,
      }, 'Executing integration action via HeadlessRuntime')

      const rawResult = await this.options.runtime.execute({
        integration: integrationName,
        tool: actionName,
        connectionId,
        input: actionInput,
        projectId,
        platformId,
        idempotencyKey,
        internalApiUrl: this.options.internalApiUrl,
        publicApiUrl: this.options.publicApiUrl,
      })

      return redactSensitiveData(rawResult)
    } catch (error) {
      const classified = classifyProviderError(error)
      const sanitizedMessage = redactSensitiveData(classified.message) as string

      this.options.logger?.error({
        error: sanitizedMessage,
        code: classified.code,
        integrationName,
        actionName,
        runId,
        stepId,
      }, 'Integration action execution failed')

      throw new FlowIntegrationError(
        classified.code,
        sanitizedMessage,
        {
          integrationName,
          actionName,
          connectionId,
          stepId,
          runId,
          retryable: classified.retryable,
        },
      )
    }
  }
}
