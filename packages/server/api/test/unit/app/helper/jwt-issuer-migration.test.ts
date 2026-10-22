import { beforeEach, describe, expect, it } from 'vitest'
import { JwtSignAlgorithm, jwtUtils } from '../../../../src/app/helper/jwt-utils'

const SECRET = 'test-secret-for-jwt-issuer-migration-tests'
const LEGACY = 'activepieces'
const CONFIGURED = 'inboxfm-connect'

// Issue #373: the issuer must be configuration-aware with a dual-issuer
// verification window, so flipping AP_JWT_ISSUER for new mints does not brick
// tokens minted before the change (100-year worker tokens, sessions, signed
// file tokens). These tests pin every window state.
describe('jwtUtils issuer migration window (#373)', () => {
    beforeEach(() => {
        delete process.env['AP_JWT_ISSUER']
    })

    it('default: signs with the legacy issuer and verifies (window closed)', async () => {
        const token = await jwtUtils.sign({ payload: { sub: 'u1' }, key: SECRET })
        const decoded = await jwtUtils.decodeAndVerify<{ sub: string }>({ jwt: token, key: SECRET })
        expect(decoded.sub).toBe('u1')
    })

    it('configured issuer: new tokens mint under it and verify (window open)', async () => {
        process.env['AP_JWT_ISSUER'] = CONFIGURED
        const token = await jwtUtils.sign({ payload: { sub: 'u2' }, key: SECRET })
        const decoded = await jwtUtils.decodeAndVerify<{ sub: string, iss: string }>({ jwt: token, key: SECRET })
        expect(decoded.iss).toBe(CONFIGURED)
    })

    it('legacy tokens minted before the change still verify during the window', async () => {
        // A token from before the issuer flip carries the legacy issuer.
        const legacyToken = await jwtUtils.sign({ payload: { sub: 'u3' }, key: SECRET, issuer: LEGACY })
        process.env['AP_JWT_ISSUER'] = CONFIGURED
        // Window is open: verification must accept the legacy-issuer token.
        const decoded = await jwtUtils.decodeAndVerify<{ sub: string }>({ jwt: legacyToken, key: SECRET })
        expect(decoded.sub).toBe('u3')
    })

    it('a third-party issuer is rejected even while the window is open', async () => {
        process.env['AP_JWT_ISSUER'] = CONFIGURED
        const forged = await jwtUtils.sign({ payload: { sub: 'attacker' }, key: SECRET, issuer: 'evil-issuer' })
        await expect(jwtUtils.decodeAndVerify({ jwt: forged, key: SECRET })).rejects.toThrow()
    })

    it('window closes when the configured issuer equals the legacy one', async () => {
        process.env['AP_JWT_ISSUER'] = LEGACY
        const thirdParty = await jwtUtils.sign({ payload: { sub: 'x' }, key: SECRET, issuer: 'evil-issuer' })
        await expect(jwtUtils.decodeAndVerify({ jwt: thirdParty, key: SECRET })).rejects.toThrow()
    })

    it('explicit caller-provided issuer still overrides the configured default on sign', async () => {
        process.env['AP_JWT_ISSUER'] = CONFIGURED
        const explicit = await jwtUtils.sign({ payload: { sub: 'u4' }, key: SECRET, issuer: LEGACY })
        const decoded = await jwtUtils.decodeAndVerify<{ iss: string }>({ jwt: explicit, key: SECRET })
        expect(decoded.iss).toBe(LEGACY)
    })

    it('algorithm pinning still applies during the window (HS385 forgery rejected)', async () => {
        process.env['AP_JWT_ISSUER'] = CONFIGURED
        const legacyToken = await jwtUtils.sign({ payload: { sub: 'u5' }, key: SECRET, issuer: LEGACY })
        const decodedHeader = jwtUtils.decode<{ header: { alg: string } }>({ jwt: legacyToken })
        expect(decodedHeader.header.alg).toBe(JwtSignAlgorithm.HS256)
    })
})
