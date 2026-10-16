import { describe, expect, it } from 'vitest'
import { buildServer, getSafeExecutionEnv, validateFlowIR } from './server.js'

const base = {
  irVersion: 1,
  name: 'daily-digest',
  version: 1,
  trigger: { kind: 'manual' },
  inputSchema: {},
  steps: [
    { id: 'fetch', kind: 'integration', config: { integration: 'gmail', action: 'search' }, dependsOn: [] },
    { id: 'digest', kind: 'transform', config: { operation: 'digest' }, dependsOn: ['fetch'] },
  ],
}

describe('validateFlowIR', () => {
  it('accepts a valid minimal flow IR', () => {
    expect(validateFlowIR(base).valid).toBe(true)
  })

  it('rejects unsupported IR versions', () => {
    const result = validateFlowIR({ ...base, irVersion: 2 })
    expect(result.valid).toBe(false)
  })

  it('rejects duplicate step ids', () => {
    const result = validateFlowIR({
      ...base,
      steps: [base.steps[0], { ...base.steps[1], id: 'fetch' }],
    })
    expect(result.valid).toBe(false)
  })

  it('rejects missing dependencies', () => {
    const result = validateFlowIR({
      ...base,
      steps: [{ ...base.steps[0], dependsOn: ['missing'] }],
    })
    expect(result.valid).toBe(false)
  })
})

describe('getSafeExecutionEnv', () => {
  it('filters out arbitrary server environment variables while preserving FLOWSCRIPT_ENV_ variables', () => {
    const rawEnv = {
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      SECRET_KEY: 'super_secret',
      FLOWSCRIPT_ENV_CUSTOM_API: 'https://api.example.com',
      FLOWSCRIPT_ENV_FEATURE_FLAG: 'enabled',
      NODE_ENV: 'production',
      TZ: 'UTC',
    }

    const safeEnv = getSafeExecutionEnv(rawEnv)

    // Raw secrets are excluded
    expect(safeEnv.DATABASE_URL).toBeUndefined()
    expect(safeEnv.SECRET_KEY).toBeUndefined()

    // Allowed vars are included
    expect(safeEnv.FLOWSCRIPT_ENV_CUSTOM_API).toBe('https://api.example.com')
    expect(safeEnv.CUSTOM_API).toBe('https://api.example.com')
    expect(safeEnv.FEATURE_FLAG).toBe('enabled')
    expect(safeEnv.NODE_ENV).toBe('production')
    expect(safeEnv.TZ).toBe('UTC')
  })
})

describe('server endpoints', () => {
  const app = buildServer()

  it('/v1/ir/execute-local isolates server environment secrets', async () => {
    process.env.FLOWSCRIPT_TEST_SECRET = 'leak_me_if_you_can'
    process.env.FLOWSCRIPT_ENV_SAFE_VAR = 'safe_local_val'

    try {
      // 1. Attempting to access an unfiltered server secret fails because it was sanitized out
      const secretResponse = await app.inject({
        method: 'POST',
        url: '/v1/ir/execute-local',
        payload: {
          flow: {
            irVersion: 1,
            name: 'env-test-secret',
            version: 1,
            trigger: { kind: 'manual' },
            inputSchema: {},
            steps: [
              {
                id: 'read_secret',
                kind: 'transform',
                config: {
                  value: {
                    secret: { $env: 'FLOWSCRIPT_TEST_SECRET' },
                  },
                },
                dependsOn: [],
              },
            ],
          },
        },
      })

      expect(secretResponse.statusCode).toBe(422)
      expect(secretResponse.json().steps[0].error).toContain('Missing environment variable "FLOWSCRIPT_TEST_SECRET"')

      // 2. Accessing a whitelisted FLOWSCRIPT_ENV_ variable succeeds
      const safeResponse = await app.inject({
        method: 'POST',
        url: '/v1/ir/execute-local',
        payload: {
          flow: {
            irVersion: 1,
            name: 'env-test-safe',
            version: 1,
            trigger: { kind: 'manual' },
            inputSchema: {},
            steps: [
              {
                id: 'read_safe',
                kind: 'transform',
                config: {
                  value: {
                    safe: { $env: 'SAFE_VAR' },
                  },
                },
                dependsOn: [],
              },
            ],
            output: {
              data: { $ref: 'steps.read_safe' },
            },
          },
        },
      })

      expect(safeResponse.statusCode).toBe(200)
      const safeBody = safeResponse.json()
      expect(safeBody.status).toBe('succeeded')
      expect(safeBody.output.data.safe).toBe('safe_local_val')
    } finally {
      delete process.env.FLOWSCRIPT_TEST_SECRET
      delete process.env.FLOWSCRIPT_ENV_SAFE_VAR
    }
  })

  it('/v1/ir/execute-local rejects integration steps with 501', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ir/execute-local',
      payload: { flow: base },
    })
    expect(response.statusCode).toBe(501)
    expect(response.json().error).toContain('Trusted InboxFM Connect integration executor is not wired into this service yet')
  })

  it('/v1/flows/:name/deploy rejects requests without x-project-id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/flows/my-flow/deploy',
      payload: { versionId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toContain('Verified x-project-id header is required')
  })

  it('/v1/flows/:name/deploy validates request body parameters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/flows/my-flow/deploy',
      headers: { 'x-project-id': 'proj_123' },
      payload: { versionId: 'invalid-not-a-uuid' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('Invalid deployment request')
  })
})
