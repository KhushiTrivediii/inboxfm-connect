import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { PrincipalType, VerifyLicenseKeyRequestBody } from '@inboxfm-connect/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { authAbuseRateLimitOptions } from '../../core/security/rate-limit'
import { licenseKeysService } from './license-keys-service'

export const licenseKeysController: FastifyPluginAsyncZod = async (app) => {

    app.get('/:licenseKey', GetLicenseKeyRequest, async (req) => {
        const licenseKey = await licenseKeysService(app.log).getKey(req.params.licenseKey)
        return licenseKey
    })

    app.post('/verify', VerifyLicenseKeyRequest, async (req) => {
        // Never trust a client-supplied platformId: the security layer already
        // resolved the caller's own platform from their token (platformAdminOnly),
        // so a caller can only ever apply a key to the platform they administer.
        const { licenseKey } = req.body
        const platformId = req.principal.platform.id
        const key = await licenseKeysService(app.log).verifyKeyOrReturnNull({
            platformId,
            license: licenseKey,
        })
        if (isNil(key)) {
            throw new ActivepiecesError({
                code: ErrorCode.INVALID_LICENSE_KEY,
                params: {
                    key: licenseKey,
                },
            })
        }
        await licenseKeysService(app.log).applyLimits(platformId, key)
        return key
    })

}
const VerifyLicenseKeyRequest = {
    config: {
        // Both routes take a caller-supplied key and reach the secrets manager,
        // so they are admin-only on the caller's own platform: cross-tenant
        // plan overwrites via a stolen/guessed key are no longer possible
        // (see issue #354), and the key can't be probed unauthenticated.
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
        rateLimit: authAbuseRateLimitOptions,
    },
    schema: {
        body: VerifyLicenseKeyRequestBody,
    },
}

const GetLicenseKeyRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
        rateLimit: authAbuseRateLimitOptions,
    },
    schema: {
        params: z.object({
            licenseKey: z.string(),
        }),
    },
}
