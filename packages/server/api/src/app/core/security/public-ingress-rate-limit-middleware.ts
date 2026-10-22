import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { redisConnections } from '../../database/redis-connections'
import { networkUtils } from '../../helper/network-utils'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { RouteKind } from './authorization/common'
import { convertToSecurityAccessRequest } from './v2/authz/authorization-middleware'

// Registered as a global preHandler hook (see app.ts), after the authenticated-tier
// limiters. Bounds the only unauthenticated surface that mints LLM executions:
// `POST /v1/trigger-bindings/:id/run` (securityAccess.public()). Unlike the project
// and api-key limiters — which bucket by an authenticated principal this route does
// not have — this buckets by (binding id, client IP): the capability URL is the only
// credential an ingress caller holds, so the per-binding cap bounds the blast radius
// of one leaked URL, and the per-IP component stops a single source from fanning
// the same URL across the cap. Enabled by default: a leaked webhook URL must not be
// able to farm unlimited paid executions on a default deployment (issue #351).
export const publicIngressRateLimitMiddleware = async (request: FastifyRequest): Promise<void> => {
    const security = await convertToSecurityAccessRequest(request)
    if (security.kind !== RouteKind.PUBLIC) {
        return
    }
    if (request.method !== 'POST') {
        return
    }
    // The run URL shape is /v1/trigger-bindings/:id/run — the binding id is the bucket key.
    const bindingId = extractBindingId(request.url)
    if (bindingId === null) {
        return
    }
    const clientIp = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
    await assertWithinPublicIngressLimit({ bindingId, clientIp, log: request.log })
}

function extractBindingId(url: string): string | null {
    const match = /trigger-bindings\/([^/]+)\/run(?:[?#]|$)/.exec(url)
    return match ? match[1] : null
}

// Same fixed-window-counter trade-offs as api-key-rate-limit-middleware.ts: INCR is
// atomic, EXPIRE is only set on the window's first request, so a window can rarely
// run very slightly long — acceptable for a rate limit, and needs no infra beyond
// the ioredis connection already used for BullMQ/distributedLock.
async function assertWithinPublicIngressLimit({ bindingId, clientIp, log }: { bindingId: string, clientIp: string | undefined, log: FastifyBaseLogger }): Promise<void> {
    const enabled = system.getBoolean(AppSystemProp.PUBLIC_INGRESS_RATE_LIMITER_ENABLED) ?? true
    if (!enabled) {
        return
    }
    // Semantic clamps (codeant findings on #353): system props are plain numbers, so
    // a negative/zero/malformed MAX_REQUESTS would reject every request (429 across
    // the board) and a zero/negative WINDOW_SECONDS would divide to Infinity / a
    // non-expiring or instantly-expiring bucket. Fall back to the documented defaults
    // instead of letting a bad config take the ingress down or silently unlimit it.
    const rawMax = system.getNumber(AppSystemProp.PUBLIC_INGRESS_RATE_LIMITER_MAX_REQUESTS)
    const maxRequests = Number.isFinite(rawMax) && rawMax! > 0 ? rawMax! : DEFAULT_MAX_REQUESTS
    const rawWindow = system.getNumber(AppSystemProp.PUBLIC_INGRESS_RATE_LIMITER_WINDOW_SECONDS)
    const windowSeconds = Number.isFinite(rawWindow) && rawWindow! > 0 ? rawWindow! : DEFAULT_WINDOW_SECONDS

    const redis = await redisConnections.useExisting()
    const windowStart = Math.floor(Date.now() / 1000 / windowSeconds)
    // When the configured CLIENT_REAL_IP_HEADER is missing on the request, there is
    // no address to bucket by: use an explicit shared label (not the string
    // 'undefined', which would collide with a literal IP) and warn so the operator
    // can fix the header config (codeant finding on #353).
    const effectiveClientIp = clientIp ?? UNKNOWN_CLIENT_IP_LABEL
    const key = `${PUBLIC_INGRESS_RATE_LIMIT_KEY_PREFIX}:${bindingId}:${effectiveClientIp}:${windowStart}`
    if (clientIp === undefined) {
        log.warn({ bindingId }, 'Public ingress rate limiter: client IP unavailable - requests share one per-binding bucket until CLIENT_REAL_IP_HEADER is configured correctly')
    }
    const requestCount = await redis.incr(key)
    if (requestCount === 1) {
        await redis.expire(key, windowSeconds)
    }
    if (requestCount <= maxRequests) {
        return
    }
    log.warn({ triggerBinding: { id: bindingId }, clientIp, requestCount, limit: maxRequests }, 'Public trigger-binding ingress exceeded rate limit')
    throw new ActivepiecesError({
        code: ErrorCode.PUBLIC_INGRESS_RATE_LIMIT_EXCEEDED,
        params: {
            bindingId,
            limit: maxRequests,
            windowSeconds,
        },
    })
}

const PUBLIC_INGRESS_RATE_LIMIT_KEY_PREFIX = 'public-ingress-rate-limit'
const UNKNOWN_CLIENT_IP_LABEL = 'unknown-client-ip'
const DEFAULT_MAX_REQUESTS = 30
const DEFAULT_WINDOW_SECONDS = 60
