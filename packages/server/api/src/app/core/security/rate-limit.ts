import RateLimitPlugin, { RateLimitOptions } from '@fastify/rate-limit'
import FastifyPlugin from 'fastify-plugin'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { redisConnections } from '../../database/redis-connections'
import { networkUtils } from '../../helper/network-utils'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
export const rateLimitModule: FastifyPluginAsyncZod = FastifyPlugin(
    async (app) => {
        if (
            system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED) ||
            system.getBoolean(AppSystemProp.API_RATE_LIMIT_SYNC_ENABLED)
        ) {
            await app.register(RateLimitPlugin, {
                global: false,
                keyGenerator: (req) =>
                    networkUtils.extractClientRealIp(req, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER)) || req.ip,
                redis: await redisConnections.create(),
            })
        }
    },
)

// Tighter, IP-scoped tier for the routes an attacker would actually script against
// (sign-up, sign-in, password-reset request/confirm, and the MCP OAuth token/revoke
// endpoints, which authenticate client secrets and consume one-time authorization
// codes) — lower than the general AUTHN tier above, which also covers the
// already-authenticated switch-platform route. Shared across
// authentication.controller.ts, otp-controller.ts,
// enterprise-local-authn-controller.ts, and the MCP OAuth token/revoke controllers
// so the limit is defined once. 10/min/IP is far above a legitimate MCP client's
// refresh cadence. Gated dynamically via allowList on API_RATE_LIMIT_AUTHN_ENABLED.
export const authAbuseRateLimitOptions: RateLimitOptions = {
    allowList: () => !system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED),
    max: () => Number.parseInt(
        system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_ABUSE_MAX),
        10,
    ),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_ABUSE_WINDOW),
}

// Looser, IP-scoped tier for the RFC 7591 MCP OAuth dynamic-registration endpoint
// (POST /register). Registration authenticates no secret, so brute force is not the
// concern — it persists one DB row per unauthenticated request, and the ceiling
// exists to bound that row creation (RFC 7591 §6). MCP clients register once at
// setup, so twice the abuse tier leaves legitimate use — including bursts behind a
// shared NAT — ample headroom. Gated dynamically via allowList on
// API_RATE_LIMIT_AUTHN_ENABLED, same as the abuse tier.
export const mcpOAuthRegisterRateLimitOptions: RateLimitOptions = {
    allowList: () => !system.getBoolean(AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED),
    max: () => Number.parseInt(
        system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MCP_REGISTER_MAX),
        10,
    ),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MCP_REGISTER_WINDOW),
}

// IP-scoped rate-limit tier for synchronous execution and AI-provider routes.
// Gated dynamically via allowList on API_RATE_LIMIT_SYNC_ENABLED so disabling
// the sync tier does not require disabling the authn tier or vice versa.
export const syncExecutionRateLimitOptions: RateLimitOptions = {
    allowList: () => !system.getBoolean(AppSystemProp.API_RATE_LIMIT_SYNC_ENABLED),
    max: () => Number.parseInt(
        system.getOrThrow(AppSystemProp.API_RATE_LIMIT_SYNC_MAX),
        10,
    ),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_SYNC_WINDOW),
}
