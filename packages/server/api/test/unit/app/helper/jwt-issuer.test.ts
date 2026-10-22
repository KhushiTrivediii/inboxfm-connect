import { describe, expect, it } from 'vitest'
import { JwtSignAlgorithm, jwtUtils } from '../../../../src/app/helper/jwt-utils'

const SECRET = 'test-secret-for-jwt-issuer-tests'

describe('jwtUtils issuer validation (#178)', () => {
    it('verifies token signed with default activepieces issuer', async () => {
        const token = await jwtUtils.sign({
            payload: { id: 'worker-1', type: 'WORKER' },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
        })

        const decoded = await jwtUtils.decodeAndVerify<{ id: string, type: string, iss: string }>({
            jwt: token,
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
        })

        expect(decoded.id).toBe('worker-1')
        expect(decoded.type).toBe('WORKER')
        expect(decoded.iss).toBe('activepieces')
    })

    it('rejects a token signed with an invalid or drifted issuer', async () => {
        const token = await jwtUtils.sign({
            payload: { id: 'worker-1', type: 'WORKER' },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            issuer: 'inboxfm-connect', // Drifting from default verifier
        })

        await expect(
            jwtUtils.decodeAndVerify({
                jwt: token,
                key: SECRET,
                algorithm: JwtSignAlgorithm.HS256,
            }),
        ).rejects.toThrowError(/jwt issuer invalid/i)
    })
})
