import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('MCP OAuth client registration hardening', () => {
    it('accepts an https redirect URI', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['https://client.example.com/callback'],
                client_name: 'test-client',
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.CREATED)
        const body = response?.json()
        expect(body.client_id).toBeDefined()
        expect(body.redirect_uris).toEqual(['https://client.example.com/callback'])
    })

    it('accepts a loopback http redirect URI (RFC 8252)', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['http://127.0.0.1:8765/callback'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.CREATED)
    })

    it('rejects a non-loopback http redirect URI', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['http://client.example.com/callback'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('rejects an unregistered grant type at registration time', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['https://client.example.com/callback'],
                grant_types: ['password'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('caps the number of redirect URIs per client', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: Array.from({ length: 9 }, (_, i) => `https://client${i}.example.com/callback`),
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })
})

describe('MCP OAuth grant-type enforcement at the token endpoint', () => {
    it('rejects the refresh grant for a client registered as authorization_code only', async () => {
        const registerResponse = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['https://code-only.example.com/callback'],
                grant_types: ['authorization_code'],
                token_endpoint_auth_method: 'none',
            },
        })
        expect(registerResponse?.statusCode).toBe(StatusCodes.CREATED)
        const client = registerResponse?.json()

        const tokenResponse = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'refresh_token',
                client_id: client.client_id,
                refresh_token: 'irrelevant-token-value',
            },
        })
        expect(tokenResponse?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(tokenResponse?.json().error).toBe('unauthorized_client')
    })

    it('rejects the authorization_code grant for a client registered as refresh_token only', async () => {
        const registerResponse = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['https://refresh-only.example.com/callback'],
                grant_types: ['refresh_token'],
                token_endpoint_auth_method: 'none',
            },
        })
        expect(registerResponse?.statusCode).toBe(StatusCodes.CREATED)
        const client = registerResponse?.json()

        const tokenResponse = await app?.inject({
            method: 'POST',
            url: '/token',
            payload: {
                grant_type: 'authorization_code',
                client_id: client.client_id,
                code: 'irrelevant-code-value',
                code_verifier: 'irrelevant-verifier',
                redirect_uri: 'https://refresh-only.example.com/callback',
            },
        })
        expect(tokenResponse?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(tokenResponse?.json().error).toBe('unauthorized_client')
    })

    it('rejects a suffix-host lookalike of a loopback address', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['http://127.0.0.1.attacker.com/callback'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('rejects a userinfo trick that hides a remote host', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['http://***@evil.com/callback'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('rejects a subdomain lookalike of localhost', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['http://localhost.evil.com/callback'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('accepts localhost with a port', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['http://localhost:1455/cb'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.CREATED)
    })

    it('accepts IPv6 loopback with a port', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['http://[::1]:1455/cb'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.CREATED)
    })

    it('rejects any redirect URI carrying a fragment (RFC 6749 s3.1.2)', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: '/register',
            payload: {
                redirect_uris: ['https://evil.com/cb#x'],
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })
})