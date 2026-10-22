import { timingSafeEqual } from 'node:crypto'
import { isNil } from '@inboxfm-connect/core-utils'
import { FastifyInstance, FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { appsumoService } from './appsumo.service'

export const appSumoModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(appsumoController, { prefix: '/v1/appsumo' })
}

const ActionRequest = z.object({
    action: z.string(),
    plan_id: z.string(),
    uuid: z.string(),
    activation_email: z.string(),
})

type ActionRequest = z.infer<typeof ActionRequest>

const ExchangeTokenRequest = z.object({
    username: z.string(),
    password: z.string(),
})
type ExchangeTokenRequest = z.infer<typeof ExchangeTokenRequest>

const AuthorizationHeaders = z.object({
    authorization: z.string(),
})
type AuthorizationHeaders = z.infer<typeof AuthorizationHeaders>

// Constant-time, fail-closed credential comparison (see issue #463).
// 1. The token is read at REQUEST time, not import time — the previous
//    top-level `const token = system.get(...)` captured the value once, so a
//    deployment that never set AP_APPSUMO_TOKEN baked `undefined` into the
//    module forever, and `Bearer ${token}` coerced to the literal string
//    "Bearer undefined", which an attacker could send verbatim to pass the
//    gate on the public /v1/appsumo/action endpoint.
// 2. isNil short-circuits to reject: an unset token must never match
//    anything, including a client that literally sends "undefined".
// 3. timingSafeEqual prevents the prefix-based timing signal of a plain
//    `!==` (same shape as the admin API-key compare fixed for #369); the
//    length check first avoids its throw — length is not secret material.
function isCertainTokenCredential(a: string | undefined, b: string | undefined): boolean {
    if (isNil(a) || isNil(b)) {
        return false
    }
    const aBuf = Buffer.from(a)
    const bBuf = Buffer.from(b)
    return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
}

const appsumoController: FastifyPluginAsyncZod = async (
    fastify: FastifyInstance,
) => {
    fastify.post(
        '/token',
        {
            config: {
                security: securityAccess.public(),
            },
            schema: {
                body: ExchangeTokenRequest,
            },
        },
        async (
            request: FastifyRequest<{
                Body: ExchangeTokenRequest
            }>,
            reply,
        ) => {
            const appsumoToken = system.get(AppSystemProp.APPSUMO_TOKEN)
            const matchesCredentials =
                isCertainTokenCredential(request.body.username, appsumoToken) &&
                isCertainTokenCredential(request.body.password, appsumoToken)
            if (matchesCredentials) {
                return reply.status(StatusCodes.OK).send({
                    access: appsumoToken,
                })
            }
            else {
                return reply.status(StatusCodes.UNAUTHORIZED).send()
            }
        },
    )

    fastify.post(
        '/action',
        {
            config: {
                security: securityAccess.public(),
            },
            schema: {
                headers: AuthorizationHeaders,
                body: ActionRequest,
            },
        },
        async (
            request: FastifyRequest<{
                Headers: AuthorizationHeaders
                Body: ActionRequest
            }>,
            reply,
        ) => {
            const appsumoToken = system.get(AppSystemProp.APPSUMO_TOKEN)
            const authorization = request.headers.authorization
            const bearerScheme = 'Bearer '
            const bearerToken = authorization?.startsWith(bearerScheme) === true
                ? authorization.slice(bearerScheme.length)
                : undefined
            if (!isCertainTokenCredential(bearerToken, appsumoToken)) {
                return reply.status(StatusCodes.UNAUTHORIZED).send()
            }
            else {
                const { plan_id, action, uuid, activation_email } = request.body
                await appsumoService(request.log).handleRequest({
                    plan_id,
                    action,
                    uuid,
                    activation_email,
                })
                switch (action) {
                    case 'activate':
                        return reply.status(StatusCodes.CREATED).send({
                            redirect_url:
                'https://cloud.activepieces.com/sign-up?email=' +
                encodeURIComponent(activation_email),
                            message: 'success',
                        })
                    default:
                        return reply.status(StatusCodes.OK).send({
                            message: 'success',
                        })
                }
            }
        },
    )
}
