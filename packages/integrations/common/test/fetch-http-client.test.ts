import { createServer as createHttpServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https'
import { AddressInfo } from 'node:net'
import * as crypto from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HttpMethod } from '../src/lib/http/core/http-method'
import { FetchHttpClient } from '../src/lib/http/core/fetch-http-client'

const TLS_BYPASS_ENV_VAR = 'NODE_TLS_REJECT_UNAUTHORIZED'

// Runtime ASN.1 DER self-signed X.509 certificate generator (pure JS, no committed keypairs)
function derLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len])
  const bytes: number[] = []
  let temp = len
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derSequence(contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents)
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body])
}

function derSet(contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents)
  return Buffer.concat([Buffer.from([0x31]), derLength(body.length), body])
}

function derInteger(num: number): Buffer {
  return Buffer.from([0x02, 0x01, num])
}

function derBitString(buf: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x03]), derLength(buf.length + 1), Buffer.from([0x00]), buf])
}

function derOid(oidStr: string): Buffer {
  const parts = oidStr.split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i]
    const encoded = [val & 0x7f]
    while ((val >>= 7) > 0) {
      encoded.unshift((val & 0x7f) | 0x80)
    }
    bytes.push(...encoded)
  }
  return Buffer.concat([Buffer.from([0x06, bytes.length]), Buffer.from(bytes)])
}

function derPrintableString(str: string): Buffer {
  const buf = Buffer.from(str, 'ascii')
  return Buffer.concat([Buffer.from([0x13, buf.length]), buf])
}

function derUtcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0')
  const str =
    String(date.getUTCFullYear()).slice(2) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  const buf = Buffer.from(str, 'ascii')
  return Buffer.concat([Buffer.from([0x17, buf.length]), buf])
}

function generateSelfSignedCert(): { cert: string; key: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const sha256WithRsa = derSequence([derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])])
  const cn = derSequence([derSet([derSequence([derOid('2.5.4.3'), derPrintableString('localhost')])])])

  const now = new Date()
  const nextYear = new Date(now.getTime() + 365 * 24 * 3600 * 1000)
  const validity = derSequence([derUtcTime(now), derUtcTime(nextYear)])

  const tbs = derSequence([derInteger(1), sha256WithRsa, cn, validity, cn, spki])
  const signature = crypto.sign('sha256', tbs, privateKey)
  const certDer = derSequence([tbs, sha256WithRsa, derBitString(signature)])
  const certPem =
    '-----BEGIN CERTIFICATE-----\n' +
    (certDer.toString('base64').match(/.{1,64}/g) ?? []).join('\n') +
    '\n-----END CERTIFICATE-----\n'
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

  return { cert: certPem, key: keyPem }
}

function listen(server: HttpServer | HttpsServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function close(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function tlsFailureCode(error: unknown): string {
  if (!(error instanceof Error) || !isRecord(error.cause)) {
    return ''
  }
  const code = error.cause['code']
  return typeof code === 'string' ? code : ''
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

describe('FetchHttpClient TLS verification', () => {
  let httpServer: HttpServer
  let httpsServer: HttpsServer
  let httpBaseUrl: string
  let httpsBaseUrl: string
  let tlsBypassBeforeSuite: string | undefined

  beforeAll(async () => {
    tlsBypassBeforeSuite = process.env[TLS_BYPASS_ENV_VAR]
    delete process.env[TLS_BYPASS_ENV_VAR]

    httpServer = createHttpServer((_req: IncomingMessage, res: ServerResponse) =>
      respondJson(res, 200, { ok: true })
    )
    const httpPort = await listen(httpServer)
    httpBaseUrl = `http://127.0.0.1:${httpPort}`

    const { cert, key } = generateSelfSignedCert()
    httpsServer = createHttpsServer({ cert, key }, (_req: IncomingMessage, res: ServerResponse) =>
      respondJson(res, 200, { ok: true })
    )
    const httpsPort = await listen(httpsServer)
    httpsBaseUrl = `https://127.0.0.1:${httpsPort}`

    if (tlsBypassBeforeSuite === undefined) {
      delete process.env[TLS_BYPASS_ENV_VAR]
    } else {
      process.env[TLS_BYPASS_ENV_VAR] = tlsBypassBeforeSuite
    }
  })

  afterAll(async () => {
    await Promise.all([close(httpServer), close(httpsServer)])
    if (tlsBypassBeforeSuite === undefined) {
      delete process.env[TLS_BYPASS_ENV_VAR]
    } else {
      process.env[TLS_BYPASS_ENV_VAR] = tlsBypassBeforeSuite
    }
  })

  beforeEach(() => {
    delete process.env[TLS_BYPASS_ENV_VAR]
  })

  afterEach(() => {
    if (tlsBypassBeforeSuite === undefined) {
      delete process.env[TLS_BYPASS_ENV_VAR]
    } else {
      process.env[TLS_BYPASS_ENV_VAR] = tlsBypassBeforeSuite
    }
  })

  it('does not disable certificate verification process-wide while sending a request', async () => {
    const response = await new FetchHttpClient().sendRequest({
      method: HttpMethod.GET,
      url: `${httpBaseUrl}/ok`,
    })

    expect(response.status).toBe(200)
    expect(process.env[TLS_BYPASS_ENV_VAR]).toBeUndefined()
  })

  it('leaves an existing NODE_TLS_REJECT_UNAUTHORIZED value untouched', async () => {
    process.env[TLS_BYPASS_ENV_VAR] = '1'

    await new FetchHttpClient().sendRequest({ method: HttpMethod.GET, url: `${httpBaseUrl}/ok` })

    expect(process.env[TLS_BYPASS_ENV_VAR]).toBe('1')
  })

  it('rejects an HTTPS endpoint presenting a self-signed certificate by default', async () => {
    const failure = await captureRejection(
      new FetchHttpClient().sendRequest({ method: HttpMethod.GET, url: `${httpsBaseUrl}/ok` })
    )

    expect(failure).toBeInstanceOf(Error)
    expect(tlsFailureCode(failure)).toMatch(/CERT|SSL|TLS/)
    expect(process.env[TLS_BYPASS_ENV_VAR]).toBeUndefined()
  })

  it('still performs plain HTTP requests normally', async () => {
    const response = await new FetchHttpClient().sendRequest<{ ok: boolean }>({
      method: HttpMethod.GET,
      url: `${httpBaseUrl}/ok`,
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(process.env[TLS_BYPASS_ENV_VAR]).toBeUndefined()
  })

  it('forwards a caller-supplied custom dispatcher without mutating global env', async () => {
    const originalFetch = globalThis.fetch
    let capturedDispatcher: unknown
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => {
      capturedDispatcher = init?.dispatcher
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const customDispatcher = { mock: true }
      const response = await new FetchHttpClient().sendRequest(
        { method: HttpMethod.GET, url: `${httpBaseUrl}/ok` },
        { dispatcher: customDispatcher }
      )

      expect(response.status).toBe(200)
      expect(capturedDispatcher).toBe(customDispatcher)
      expect(process.env[TLS_BYPASS_ENV_VAR]).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
