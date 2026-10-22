import { createHmac, timingSafeEqual } from 'node:crypto'

export function getSafeExecutionEnv(sourceEnv: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const safeEnv: Record<string, string | undefined> = Object.create(null)
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (key.startsWith('FLOWSCRIPT_ENV_')) {
      safeEnv[key] = value
      const strippedKey = key.slice('FLOWSCRIPT_ENV_'.length)
      if (strippedKey && !Object.prototype.hasOwnProperty.call(safeEnv, strippedKey)) {
        safeEnv[strippedKey] = value
      }
    } else if (key === 'NODE_ENV' || key === 'TZ') {
      safeEnv[key] = value
    }
  }
  return safeEnv
}

export function getGatewaySecret(): string {
  return (
    process.env.FLOWSCRIPT_GATEWAY_SECRET?.trim() ||
    process.env.FLOWSCRIPT_AUTH_SECRET?.trim() ||
    (process.env.NODE_ENV === 'test' ? 'test-flowscript-gateway-secret' : '')
  )
}

export function signProjectId(projectId: string, secret: string = getGatewaySecret()): string {
  if (!secret) {
    throw new Error('Cannot sign project ID: gateway secret is not configured')
  }
  return createHmac('sha256', secret).update(projectId).digest('hex')
}

export function generateProjectToken(projectId: string, secret: string = getGatewaySecret()): string {
  const signature = signProjectId(projectId, secret)
  return `${projectId}.${signature}`
}

const PROJECT_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/

export function stripUntrustedProjectHeaders(headers: Record<string, unknown>): void {
  delete headers['x-project-id']
  delete headers['x-project-signature']
  delete headers['x-gateway-signature']
}

export function verifyProjectIdentity(
  request: { headers: Record<string, string | string[] | undefined> },
  secret: string = getGatewaySecret(),
): { valid: boolean; projectId: string | null; error?: string; code?: string } {
  if (!secret) {
    return {
      valid: false,
      projectId: null,
      code: 'GATEWAY_SECRET_MISSING',
      error: 'Gateway authentication secret is not configured; refusing project access',
    }
  }

  const authHeader = request.headers['authorization']
  const signatureHeader = request.headers['x-project-signature'] ?? request.headers['x-gateway-signature']
  const rawProjectId = request.headers['x-project-id']

  let candidateProjectId: string | null = null
  let candidateSignature: string | null = null

  // 1. Check Authorization: Bearer <projectId>.<signature>
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    const dotIndex = token.indexOf('.')
    if (dotIndex > 0) {
      candidateProjectId = token.slice(0, dotIndex)
      candidateSignature = token.slice(dotIndex + 1)
    }
  }

  // If a Bearer token was supplied, verify that any caller-supplied x-project-id does not contradict it
  if (candidateProjectId && typeof rawProjectId === 'string') {
    const trimmedRaw = rawProjectId.trim()
    if (trimmedRaw && trimmedRaw !== candidateProjectId) {
      return {
        valid: false,
        projectId: null,
        code: 'FORGED_PROJECT_HEADER',
        error: 'Project identity conflict: x-project-id header does not match authenticated bearer token',
      }
    }
  }

  // 2. Check x-project-id + signature header
  if (!candidateProjectId && typeof rawProjectId === 'string' && rawProjectId.trim().length > 0) {
    candidateProjectId = rawProjectId.trim()
    if (typeof signatureHeader === 'string' && signatureHeader.length > 0) {
      candidateSignature = signatureHeader.trim()
    }
  }

  if (!candidateProjectId) {
    return {
      valid: false,
      projectId: null,
      code: 'MISSING_PROJECT_IDENTITY',
      error: 'Verified x-project-id header is required (or Bearer token) from the trusted API gateway',
    }
  }

  if (!PROJECT_ID_REGEX.test(candidateProjectId)) {
    return {
      valid: false,
      projectId: null,
      code: 'INVALID_PROJECT_ID_FORMAT',
      error: 'Project ID contains invalid characters or exceeds 128 characters',
    }
  }

  if (!candidateSignature) {
    return {
      valid: false,
      projectId: null,
      code: 'UNVERIFIED_PROJECT_IDENTITY',
      error: 'Unverified project identity: cryptographic signature is required',
    }
  }

  try {
    const expectedSig = signProjectId(candidateProjectId, secret)
    const sigBuf = Buffer.from(candidateSignature, 'hex')
    const expBuf = Buffer.from(expectedSig, 'hex')

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return {
        valid: false,
        projectId: null,
        code: 'INVALID_PROJECT_SIGNATURE',
        error: 'Invalid project identity signature',
      }
    }
  } catch {
    return {
      valid: false,
      projectId: null,
      code: 'INVALID_PROJECT_SIGNATURE',
      error: 'Invalid project identity signature',
    }
  }

  return { valid: true, projectId: candidateProjectId }
}
