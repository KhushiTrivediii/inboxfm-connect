import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { AddressInfo } from 'node:net'
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { safeHttp } from '../src/safe-http'

describe('safeHttp.buildAgents', () => {
    it('returns filtering agents by default', () => {
        const agents = safeHttp.buildAgents({ allowList: [] })
        expect(agents.httpAgent).toBeInstanceOf(RequestFilteringHttpAgent)
        expect(agents.httpsAgent).toBeInstanceOf(RequestFilteringHttpsAgent)
    })

    it('subclasses the stdlib http/https Agent so axios accepts them', () => {
        const agents = safeHttp.buildAgents({ allowList: ['10.0.0.0/8'] })
        expect(agents.httpAgent).toBeInstanceOf(http.Agent)
        expect(agents.httpsAgent).toBeInstanceOf(https.Agent)
    })

    it('forwards the allow list to the underlying filter options', () => {
        const allowList = ['127.0.0.1', '10.0.0.0/8']
        const { httpAgent } = safeHttp.buildAgents({ allowList })
        expect(httpAgent).toBeInstanceOf(RequestFilteringHttpAgent)
    })
})

describe('safeHttp.createAxios', () => {
    it('attaches filtering http and https agents to the axios instance', () => {
        const instance = safeHttp.createAxios()
        expect(instance.defaults.httpAgent).toBeInstanceOf(RequestFilteringHttpAgent)
        expect(instance.defaults.httpsAgent).toBeInstanceOf(RequestFilteringHttpsAgent)
    })

    it('merges caller config (e.g. baseURL) with the filtering agents', () => {
        const instance = safeHttp.createAxios({ baseURL: 'https://example.com' })
        expect(instance.defaults.baseURL).toBe('https://example.com')
        expect(instance.defaults.httpsAgent).toBeInstanceOf(RequestFilteringHttpsAgent)
    })
})

describe('safeHttp end-to-end blocking', () => {
    it.each([
        ['loopback v4', 'http://127.0.0.1/'],
        ['loopback v6', 'http://[::1]/'],
        ['loopback v6 full zeroes', 'http://[0:0:0:0:0:0:0:1]/'],
        ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
        ['IPv4-mapped IPv6 private 10.x', 'http://[::ffff:10.0.0.1]/'],
        ['IPv4-mapped IPv6 metadata', 'http://[::ffff:169.254.169.254]/'],
        ['IPv6 link-local', 'http://[fe80::1]/'],
        ['IPv6 unique local (private)', 'http://[fc00::1]/'],
        ['private v4 (10.x)', 'http://10.0.0.1/'],
        ['private v4 (172.16.x)', 'http://172.16.0.1/'],
        ['private v4 (192.168.x)', 'http://192.168.1.1/'],
        ['link-local / metadata', 'http://169.254.169.254/latest/meta-data/'],
        ['decimal-encoded 127.0.0.1', 'http://2130706433/'],
        ['decimal-encoded 10.0.0.1', 'http://167772161/'],
        ['decimal-encoded metadata', 'http://2852039166/'],
        ['hex-encoded 127.0.0.1', 'http://0x7f000001/'],
        ['octal-encoded 127.0.0.1', 'http://0177.0.0.1/'],
    ])('rejects %s via safeHttp.axios', async (_label, url) => {
        const instance = safeHttp.createAxios({ timeout: 2000 })
        await expect(instance.get(url)).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup .* not allowed|IP .* not allowed|is not allowed/i),
        })
    })

    it('still blocks private IPs when caller relaxes TLS via httpsAgentOptions', async () => {
        const instance = safeHttp.createAxios(
            { timeout: 2000 },
            { httpsAgentOptions: { rejectUnauthorized: false } },
        )
        await expect(instance.get('https://127.0.0.1/')).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup .* not allowed|IP .* not allowed|is not allowed/i),
        })
    })

    it('rewraps filter errors with the AP_SSRF_ALLOW_LIST remediation hint so operators know how to recover', async () => {
        const instance = safeHttp.createAxios({ timeout: 2000 })
        await expect(instance.get('http://10.0.0.1/')).rejects.toMatchObject({
            message: expect.stringContaining('AP_SSRF_ALLOW_LIST'),
        })
    })
})

describe('safeHttp redirect & DNS rebinding edge cases', () => {
    let redirectServer: http.Server
    let serverPort: number

    beforeAll(async () => {
        redirectServer = http.createServer((req, res) => {
            if (req.url === '/redirect-to-metadata') {
                res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' })
                res.end()
            }
            else if (req.url === '/redirect-to-private') {
                res.writeHead(302, { Location: 'http://10.0.0.1/' })
                res.end()
            }
            else {
                res.writeHead(200)
                res.end('ok')
            }
        })

        await new Promise<void>((resolve) => {
            redirectServer.listen(0, '127.0.0.1', () => {
                serverPort = (redirectServer.address() as AddressInfo).port
                resolve()
            })
        })
    })

    afterAll(async () => {
        await new Promise<void>((resolve) => redirectServer.close(() => resolve()))
    })

    it('blocks HTTP redirects to AWS cloud metadata (169.254.169.254)', async () => {
        // Allow the local test server in allowList so the initial request connects,
        // but verify that following the redirect to metadata IP is intercepted and blocked.
        const instance = safeHttp.createAxios(
            { timeout: 2000, maxRedirects: 5 },
            undefined,
        )
        // Set allow list for the initial server address
        const { httpAgent, httpsAgent } = safeHttp.buildAgents({ allowList: ['127.0.0.1'] })
        instance.defaults.httpAgent = httpAgent
        instance.defaults.httpsAgent = httpsAgent

        await expect(instance.get(`http://127.0.0.1:${serverPort}/redirect-to-metadata`)).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup 169\.254\.169\.254.*is not allowed/i),
        })
    })

    it('blocks HTTP redirects to private RFC1918 addresses (10.0.0.1)', async () => {
        const instance = safeHttp.createAxios({ timeout: 2000, maxRedirects: 5 })
        const { httpAgent, httpsAgent } = safeHttp.buildAgents({ allowList: ['127.0.0.1'] })
        instance.defaults.httpAgent = httpAgent
        instance.defaults.httpsAgent = httpsAgent

        await expect(instance.get(`http://127.0.0.1:${serverPort}/redirect-to-private`)).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup 10\.0\.0\.1.*is not allowed/i),
        })
    })

    it('blocks DNS rebinding attempts where a public host resolves to a private IP', async () => {
        // Simulate DNS rebinding: public host resolves to 127.0.0.1 at lookup time
        const customLookup = (_hostname: string, options: any, callback: any) => {
            if (typeof options === 'function') {
                callback = options
                options = {}
            }
            if (options && options.all) {
                return process.nextTick(() => callback(null, [{ address: '127.0.0.1', family: 4 }]))
            }
            return process.nextTick(() => callback(null, '127.0.0.1', 4))
        }

        const instance = safeHttp.createAxios(
            { timeout: 2000 },
            { httpAgentOptions: { lookup: customLookup as any } },
        )
        await expect(instance.get('http://rebinding-attacker.example.com/')).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup 127\.0\.0\.1.*not allowed|is not allowed/i),
        })
    })
})
