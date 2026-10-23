import { describe, expect, it } from 'vitest'
import { buildServer, generateProjectToken, getSafeExecutionEnv, signProjectId, validateFlowIR, verifyProjectIdentity } from './server.js'

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

  it('rejects dependency cycles in IR', () => {
    const result = validateFlowIR({
      ...base,
      steps: [
        { id: 'step_a', kind: 'transform', config: {}, dependsOn: ['step_b'] },
        { id: 'step_b', kind: 'transform', config: {}, dependsOn: ['step_a'] },
      ],
    })
    expect(result.valid).toBe(false)
    expect((result as { issues: Array<{ message: string }> }).issues[0].message).toContain('Step dependencies contain a cycle')
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
    const sig = signProjectId('proj_123')
    const response = await app.inject({
      method: 'POST',
      url: '/v1/flows/my-flow/deploy',
      headers: { 'x-project-id': 'proj_123', 'x-project-signature': sig },
      payload: { versionId: 'invalid-not-a-uuid' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('Invalid deployment request')
  })

  it('verifyProjectIdentity handles unsigned, signed, forged requests and fails closed without secret', () => {
    const secret = 'super_secret_gateway_key'
    const projectId = 'proj_alpha'

    // 1. Without secret, fails closed
    const unconfigured = verifyProjectIdentity({ headers: { 'x-project-id': projectId } }, '')
    expect(unconfigured.valid).toBe(false)
    expect(unconfigured.error).toContain('Gateway authentication secret is not configured')

    // 2. With secret, unsigned request is rejected
    const unsigned = verifyProjectIdentity({ headers: { 'x-project-id': projectId } }, secret)
    expect(unsigned.valid).toBe(false)
    expect(unsigned.error).toContain('Unverified project identity: cryptographic signature is required')

    // 3. With secret, forged signature is rejected
    const forged = verifyProjectIdentity(
      { headers: { 'x-project-id': projectId, 'x-project-signature': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } },
      secret,
    )
    expect(forged.valid).toBe(false)
    expect(forged.error).toContain('Invalid project identity signature')

    // 4. Valid x-project-signature header succeeds
    const validSig = signProjectId(projectId, secret)
    const signed = verifyProjectIdentity(
      { headers: { 'x-project-id': projectId, 'x-project-signature': validSig } },
      secret,
    )
    expect(signed.valid).toBe(true)
    expect(signed.projectId).toBe(projectId)

    // 5. Valid Authorization: Bearer token succeeds
    const token = generateProjectToken(projectId, secret)
    const bearerSigned = verifyProjectIdentity(
      { headers: { authorization: `Bearer ${token}` } },
      secret,
    )
    expect(bearerSigned.valid).toBe(true)
    expect(bearerSigned.projectId).toBe(projectId)
  })

  it('enforces gateway signature verification on server routes when FLOWSCRIPT_GATEWAY_SECRET is set', async () => {
    const secret = 'production_gateway_secret'
    process.env.FLOWSCRIPT_GATEWAY_SECRET = secret

    try {
      // Unsigned request rejected with 401
      const unsignedRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/deploy',
        headers: { 'x-project-id': 'proj_secured' },
        payload: { versionId: '00000000-0000-0000-0000-000000000000' },
      })
      expect(unsignedRes.statusCode).toBe(401)
      expect(unsignedRes.json().error).toContain('Unverified project identity')

      // Forged signature rejected with 401
      const forgedRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/deploy',
        headers: {
          'x-project-id': 'proj_secured',
          'x-project-signature': 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
        },
        payload: { versionId: '00000000-0000-0000-0000-000000000000' },
      })
      expect(forgedRes.statusCode).toBe(401)
      expect(forgedRes.json().error).toContain('Invalid project identity signature')

      // Properly signed request passes auth check (reaches route validation, failing on invalid uuid with 400 instead of 401)
      const validSig = signProjectId('proj_secured', secret)
      const signedRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/deploy',
        headers: {
          'x-project-id': 'proj_secured',
          'x-project-signature': validSig,
        },
        payload: { versionId: 'invalid-not-a-uuid' },
      })
      expect(signedRes.statusCode).toBe(400)
      expect(signedRes.json().error).toContain('Invalid deployment request')

      // Bearer token passes auth check as well
      const bearerToken = generateProjectToken('proj_secured', secret)
      const bearerRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/deploy',
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
        payload: { versionId: 'invalid-not-a-uuid' },
      })
      expect(bearerRes.statusCode).toBe(400)
      expect(bearerRes.json().error).toContain('Invalid deployment request')
    } finally {
      delete process.env.FLOWSCRIPT_GATEWAY_SECRET
    }
  })

  it('enforces gateway authentication on rollback endpoint', async () => {
    const app = buildServer()
    const secret = 'test-secret-gateway-rollback'
    process.env.FLOWSCRIPT_GATEWAY_SECRET = secret
    try {
      const unauth = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/rollback',
      })
      expect(unauth.statusCode).toBe(401)

      const validSig = signProjectId('proj_secured', secret)
      const signedRes = await app.inject({
        method: 'POST',
        url: '/v1/flows/my-flow/rollback',
        headers: {
          'x-project-id': 'proj_secured',
          'x-project-signature': validSig,
        },
        payload: { environment: 'production' },
      })
      expect(signedRes.statusCode).not.toBe(401)
    } finally {
      delete process.env.FLOWSCRIPT_GATEWAY_SECRET
    }
  })

  it('enforces gateway authentication on run replay endpoint', async () => {
    const app = buildServer()
    const secret = 'test-secret-gateway-replay'
    process.env.FLOWSCRIPT_GATEWAY_SECRET = secret
    try {
      const unauth = await app.inject({
        method: 'POST',
        url: '/v1/runs/00000000-0000-0000-0000-000000000000/replay',
      })
      expect(unauth.statusCode).toBe(401)

      const validSig = signProjectId('proj_secured', secret)
      const signedRes = await app.inject({
        method: 'POST',
        url: '/v1/runs/00000000-0000-0000-0000-000000000000/replay',
        headers: {
          'x-project-id': 'proj_secured',
          'x-project-signature': validSig,
        },
      })
      expect(signedRes.statusCode).not.toBe(401)
    } finally {
      delete process.env.FLOWSCRIPT_GATEWAY_SECRET
    }
  })
});
