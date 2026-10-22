import http from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeHttp } from '../src/safe-http'

const FILTER_MESSAGE = /DNS lookup .* not allowed|IP .* is not allowed/i

describe('safeHttp SSRF edge cases (issue #143)', () => {
    it.each([
        ['decimal IP', 'http://2130706433/'],
        ['octal IP', 'http://0177.0.0.1/'],
        ['hex IP', 'http://0x7f.0.0.1/'],
        ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
        ['unspecified address', 'http://0.0.0.0/'],
    ])('blocks loopback in %s form', async (_label, url) => {
        const instance = safeHttp.createAxios({ timeout: 3000 })
        await expect(instance.get(url)).rejects.toMatchObject({
            message: expect.stringMatching(FILTER_MESSAGE),
        })
    })

    describe('redirects', () => {
        let server: http.Server
        let port = 0
        const originalAllowList = process.env['AP_SSRF_ALLOW_LIST']

        beforeEach(async () => {
            process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'
            server = http.createServer((req, res) => {
                if (req.url === '/redirect-to-private') {
                    res.writeHead(302, { location: 'http://10.0.0.1/' })
                    res.end()
                    return
                }
                res.writeHead(200, { 'content-type': 'text/plain' })
                res.end('ok')
            })
            await new Promise<void>((resolve) => {
                server.listen(0, '127.0.0.1', () => {
                    port = (server.address() as AddressInfo).port
                    resolve()
                })
            })
        })

        afterEach(async () => {
            await new Promise<void>((resolve) => {
                server.close(() => resolve())
            })
            if (originalAllowList === undefined) {
                delete process.env['AP_SSRF_ALLOW_LIST']
            }
            else {
                process.env['AP_SSRF_ALLOW_LIST'] = originalAllowList
            }
        })

        it('re-checks redirect targets and blocks private IPs', async () => {
            const instance = safeHttp.createAxios({ timeout: 3000 })
            await expect(instance.get(`http://127.0.0.1:${port}/redirect-to-private`)).rejects.toMatchObject({
                message: expect.stringMatching(FILTER_MESSAGE),
            })
        })

        it('allows allowlisted loopback for the initial request', async () => {
            const instance = safeHttp.createAxios({ timeout: 3000 })
            const response = await instance.get(`http://127.0.0.1:${port}/`)
            expect(response.status).toBe(200)
            expect(response.data).toBe('ok')
        })
    })
})
