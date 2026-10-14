import os from 'os'
import path from 'path'
import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { ApEdition, DefaultProjectRole, ExecutionMode, FileLocation, NetworkMode, PieceSyncMode } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { DatabaseType } from '../../database/database-type'
import { RedisType } from '../../database/redis/types'
import { pinoLogging } from '../logger'
import { AppSystemProp, ContainerType, environmentVariables, SystemProp } from './system-props'



const systemPropDefaultValues: Partial<Record<SystemProp, string>> = {
    [AppSystemProp.API_RATE_LIMIT_AUTHN_ENABLED]: 'true',
    [AppSystemProp.API_RATE_LIMIT_AUTHN_MAX]: '50',
    [AppSystemProp.API_RATE_LIMIT_AUTHN_WINDOW]: '1 minute',
    // Tighter, IP-scoped tier applied only to sign-up / sign-in / password-reset
    // routes (see authentication.controller.ts, otp-controller.ts,
    // enterprise-local-authn-controller.ts) — these are the routes an attacker
    // would actually script against, so they get a lower ceiling than the general
    // AUTHN tier above (which also covers the already-authenticated
    // switch-platform route). Gated by the same AP_API_RATE_LIMIT_AUTHN_ENABLED
    // flag that registers the underlying @fastify/rate-limit plugin.
    [AppSystemProp.API_RATE_LIMIT_AUTHN_ABUSE_MAX]: '10',
    [AppSystemProp.API_RATE_LIMIT_AUTHN_ABUSE_WINDOW]: '1 minute',
    // Looser tier for the RFC 7591 MCP OAuth dynamic-registration endpoint
    // (POST /register — see mcp-oauth-register.controller.ts). Unlike the
    // token/revoke endpoints, register authenticates no secret, so the
    // concern is not brute force but the unbounded one-DB-row-per-request
    // creation it allows. A ceiling of 20/min/IP bounds that to ~28.8k
    // rows/day per IP while staying far above legitimate use — MCP clients
    // register once at setup, so even a bursty shared-NAT onboarding has
    // ample headroom. Gated by the same AP_API_RATE_LIMIT_AUTHN_ENABLED flag
    // as the other authn-surface tiers.
    [AppSystemProp.API_RATE_LIMIT_AUTHN_MCP_REGISTER_MAX]: '20',
    [AppSystemProp.API_RATE_LIMIT_AUTHN_MCP_REGISTER_WINDOW]: '1 minute',
    // IP-scoped tier for routes that synchronously run piece code or fan out to
    // upstream AI/search providers inside the API process (execute, executions
    // list/create, knowledge-search, AI providers). 60/min/IP stays far above dashboard
    // polling while capping cheap parallel-request DoS. Gated by
    // AP_API_RATE_LIMIT_SYNC_ENABLED, which registers the same underlying
    // @fastify/rate-limit plugin instance as the AUTHN tier.
    [AppSystemProp.API_RATE_LIMIT_SYNC_ENABLED]: 'true',
    [AppSystemProp.API_RATE_LIMIT_SYNC_MAX]: '60',
    [AppSystemProp.API_RATE_LIMIT_SYNC_WINDOW]: '1 minute',
    // Per-email (not per-IP) counter on failed sign-in attempts, so credential
    // stuffing against a single account from many IPs/a botnet can't outrun the
    // per-IP tier above. 5 failed attempts / 15-minute window per email is a
    // standard OWASP-style lockout threshold; a legitimate user mistyping their
    // password a couple of times is unaffected, and the counter is cleared on the
    // next successful sign-in (see sign-in-email-throttle.ts).
    [AppSystemProp.API_SIGN_IN_EMAIL_THROTTLE_ENABLED]: 'true',
    [AppSystemProp.API_SIGN_IN_EMAIL_THROTTLE_MAX_ATTEMPTS]: '5',
    [AppSystemProp.API_SIGN_IN_EMAIL_THROTTLE_WINDOW_SECONDS]: '900',
    // Header used to extract the client IP behind reverse proxies (e.g. 'x-real-ip').
    // Note: When deployed behind a reverse proxy, the proxy MUST overwrite or sanitize
    // this header to prevent untrusted clients from spoofing client IPs or draining rate-limit buckets.
    // When the header value is absent or empty, extractClientRealIp falls back to request.ip.
    [AppSystemProp.CLIENT_REAL_IP_HEADER]: 'x-real-ip',
    [AppSystemProp.CLOUD_AUTH_ENABLED]: 'true',
    [AppSystemProp.CONFIG_PATH]: path.join(os.homedir(), '.activepieces'),
    [AppSystemProp.DB_TYPE]: DatabaseType.POSTGRES,
    [AppSystemProp.EDITION]: ApEdition.COMMUNITY,
    [AppSystemProp.APP_WEBHOOK_SECRETS]: '{}',
    [AppSystemProp.CONTAINER_TYPE]: ContainerType.WORKER_AND_APP,
    [AppSystemProp.PORT]: '3000',
    [AppSystemProp.EXECUTION_DATA_RETENTION_DAYS]: '30',
    [AppSystemProp.PAUSED_FLOW_TIMEOUT_DAYS]: '30',
    [AppSystemProp.PIECES_SYNC_MODE]: PieceSyncMode.OFFICIAL_AUTO,
    [AppSystemProp.USE_CDN_FOR_BUNDLES]: 'false',
    [AppSystemProp.ENVIRONMENT]: 'prod',
    [AppSystemProp.EXECUTION_MODE]: ExecutionMode.UNSANDBOXED,
    [AppSystemProp.WEBHOOK_TIMEOUT_SECONDS]: '30',
    [AppSystemProp.LOAD_TRANSLATIONS_FOR_DEV_PIECES]: 'false',
    [AppSystemProp.LOG_LEVEL]: 'info',
    [AppSystemProp.LOG_PRETTY]: 'false',
    [AppSystemProp.S3_USE_SIGNED_URLS]: 'false',
    [AppSystemProp.MAX_FILE_SIZE_MB]: '25',
    [AppSystemProp.MAX_FLOW_RUN_LOG_SIZE_MB]: '50',
    [AppSystemProp.MAX_WEBHOOK_PAYLOAD_SIZE_MB]: '25',
    [AppSystemProp.WEBHOOK_PAYLOAD_INLINE_THRESHOLD_KB]: '512',
    [AppSystemProp.FILE_STORAGE_LOCATION]: FileLocation.DB,
    [AppSystemProp.SANDBOX_MEMORY_LIMIT]: '1048576',
    [AppSystemProp.FLOW_TIMEOUT_SECONDS]: '600',
    [AppSystemProp.TRIGGER_TIMEOUT_SECONDS]: '60',
    [AppSystemProp.REDIS_FAILED_JOB_RETENTION_DAYS]: '30',
    [AppSystemProp.REDIS_FAILED_JOB_RETENTION_MAX_COUNT]: '100000',
    [AppSystemProp.TELEMETRY_ENABLED]: 'true',
    [AppSystemProp.REDIS_TYPE]: RedisType.STANDALONE,
    [AppSystemProp.TRIGGER_DEFAULT_POLL_INTERVAL]: '5',
    [AppSystemProp.DEFAULT_CONCURRENT_JOBS_LIMIT]: '5',
    [AppSystemProp.PROJECT_EXECUTION_CONCURRENCY_LIMITER_ENABLED]: 'false',
    // Every execution (trigger RUN, the only path that reaches the shared 10-slot
    // in-process sandbox pool for a project-attributable run) holds one slot for its
    // duration. 5 concurrent in-flight runs is generous for a single project on a
    // typical self-hosted deployment while still stopping one project from occupying
    // the whole shared pool. Disabled by default so an existing self-hosted deployment
    // never starts rejecting requests it didn't reject before.
    [AppSystemProp.PROJECT_EXECUTION_CONCURRENCY_LIMIT]: '5',
    // Backstop only: a slot's TTL is refreshed on every acquire, so it never expires
    // while the project keeps executing. It only matters if a process dies mid-execution
    // without releasing its slot — the TTL self-heals that leak. Set comfortably above
    // FLOW_TIMEOUT_SECONDS' default (600s) plus provisioning/queueing overhead.
    [AppSystemProp.PROJECT_EXECUTION_CONCURRENCY_SLOT_TTL_SECONDS]: '900',
    [AppSystemProp.PROJECT_RATE_LIMITER_ENABLED]: 'false',
    // 300 req/min per project comfortably covers a busy builder session (flow
    // editor autosave + polling) and normal webhook/API traffic for a single
    // project, while still capping a runaway script or misbehaving integration.
    [AppSystemProp.PROJECT_RATE_LIMITER_MAX_REQUESTS]: '300',
    [AppSystemProp.PROJECT_RATE_LIMITER_WINDOW_SECONDS]: '60',
    [AppSystemProp.API_KEY_RATE_LIMITER_ENABLED]: 'false',
    // Per-key (not per-project, not per-IP) tier: a service credential that leaks or
    // misbehaves is capped independently of how many other keys/projects share the
    // same platform. 120 req/min per key is generous for typical machine-to-machine
    // polling/webhook traffic while still bounding a runaway or compromised key.
    [AppSystemProp.API_KEY_RATE_LIMITER_MAX_REQUESTS]: '120',
    [AppSystemProp.API_KEY_RATE_LIMITER_WINDOW_SECONDS]: '60',
    // How long a rotated-out key keeps authenticating after `rotate` mints its
    // replacement, so callers have a window to swap the new value in before the old
    // one is rejected. 24h covers a typical deploy cycle without forcing a hard cutover.
    [AppSystemProp.API_KEY_ROTATION_GRACE_PERIOD_SECONDS]: '86400',
    [AppSystemProp.MAX_RECORDS_PER_TABLE]: '10000',
    [AppSystemProp.MAX_FIELDS_PER_TABLE]: '100',
    [AppSystemProp.ENABLE_FLOW_ON_PUBLISH]: 'true',
    [AppSystemProp.ISSUE_ARCHIVE_DAYS]: '7',
    [AppSystemProp.POSTGRES_IDLE_TIMEOUT_MS]: '300000',
    [AppSystemProp.POSTGRES_CONNECTION_TIMEOUT_MS]: '10000',
    [AppSystemProp.SCIM_DEFAULT_PROJECT_ROLE]: DefaultProjectRole.EDITOR,
    [AppSystemProp.NETWORK_MODE]: NetworkMode.UNRESTRICTED,
    [AppSystemProp.LOG_SAMPLE_RATE_INFO]: '100',
    [AppSystemProp.LOG_KEEP_SLOW_MS]: '2000',
}

let globalLogger: FastifyBaseLogger
export const system = {
    globalLogger(): FastifyBaseLogger {
        if (isNil(globalLogger)) {
            globalLogger = pinoLogging.initLogger()
        }
        return globalLogger
    },
    get<T extends string>(prop: SystemProp): T | undefined {
        return getEnvVarOrReturnDefaultValue(prop) as T | undefined
    },

    getNumberOrThrow(prop: SystemProp): number {
        const value = system.getNumber(prop)

        if (isNil(value)) {
            throw new ActivepiecesError(
                {
                    code: ErrorCode.SYSTEM_PROP_NOT_DEFINED,
                    params: {
                        prop,
                    },
                },
                `System property AP_${prop} is not defined, please check the documentation`,
            )
        }
        return value

    },
    getNumber(prop: SystemProp): number | null {
        const stringNumber = getEnvVarOrReturnDefaultValue(prop)

        if (!stringNumber) {
            return null
        }

        const parsedNumber = Number.parseInt(stringNumber, 10)

        if (Number.isNaN(parsedNumber)) {
            return null
        }

        return parsedNumber
    },

    getBoolean(prop: SystemProp): boolean | undefined {
        const value = getEnvVarOrReturnDefaultValue(prop)

        if (isNil(value)) {
            return undefined
        }
        return value === 'true'
    },

    getBooleanOrThrow(prop: SystemProp): boolean {
        const value = this.getBoolean(prop)
        if (isNil(value)) {
            throw new ActivepiecesError(
                {
                    code: ErrorCode.SYSTEM_PROP_NOT_DEFINED,
                    params: {
                        prop,
                    },
                },
                `System property AP_${prop} is not defined, please check the documentation`,
            )
        }
        return value
    },
    getList(prop: SystemProp): string[] {
        const values = getEnvVarOrReturnDefaultValue(prop)

        if (isNil(values)) {
            return []
        }
        return values.split(',').map((value) => value.trim())
    },
    getOrThrow<T extends string>(prop: SystemProp): T {
        const value = getEnvVarOrReturnDefaultValue(prop) as T | undefined

        if (value === undefined) {
            throw new ActivepiecesError(
                {
                    code: ErrorCode.SYSTEM_PROP_NOT_DEFINED,
                    params: {
                        prop,
                    },
                },
                `System property AP_${prop} is not defined, please check the documentation`,
            )
        }

        return value
    },
    getEdition(): ApEdition {
        return this.getOrThrow<ApEdition>(AppSystemProp.EDITION)
    },
    isWorker(): boolean {
        return [ContainerType.WORKER, ContainerType.WORKER_AND_APP].includes(
            this.getOrThrow<ContainerType>(AppSystemProp.CONTAINER_TYPE),
        )
    },
    isApp(): boolean {
        return [ContainerType.APP, ContainerType.WORKER_AND_APP].includes(
            this.getOrThrow<ContainerType>(AppSystemProp.CONTAINER_TYPE),
        )
    },
}

const getEnvVarOrReturnDefaultValue = (prop: SystemProp): string | undefined => {
    return environmentVariables.getEnvironment(prop) ?? systemPropDefaultValues[prop]
}
