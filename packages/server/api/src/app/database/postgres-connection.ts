import { TlsOptions } from 'node:tls'
import 'pg'
import { isNil, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { DataSource } from 'typeorm'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { commonProperties } from './database-connection'
import { Migration } from './migration'
import { InitialSchema1700000000000 } from './migration/postgres/1700000000000-InitialSchema'
import { AddApiKeyExpiry1790152916876 } from './migration/postgres/1790152916876-AddApiKeyExpiry'
import { AddPositionToField1790153790769 } from './migration/postgres/1790153790769-AddPositionToField'
import { AddAgentEntity1790153850000 } from './migration/postgres/1790153850000-AddAgentEntity'
import { AddMcpOAuthTokenLineage1790154000000 } from './migration/postgres/1790154000000-AddMcpOAuthTokenLineage'
import { AddConnectionHealthCheckColumns1791869626000 } from './migration/postgres/1791869626000-AddConnectionHealthCheckColumns'

const getSslConfig = (): boolean | TlsOptions => {
    const useSsl = system.get(AppSystemProp.POSTGRES_USE_SSL)
    if (useSsl === 'true') {
        return {
            ca: system.get(AppSystemProp.POSTGRES_SSL_CA)?.replace(/\\n/g, '\n'),
        }
    }
    return false
}

/**
 * pg-pool only emits `'error'` for background client errors (e.g. an idle connection dropped by
 * the server) — without this handler those errors are unhandled and crash the process. It does
 * NOT fire for pool-checkout timeouts (`connectTimeoutMS`); those reject the specific query the
 * caller is awaiting instead. See `postgres-pool-metrics.ts` for the periodic saturation snapshot
 * that covers checkout-side pressure.
 */
const poolErrorHandler = (error: unknown): void => {
    system.globalLogger().error({
        pool: {
            poolError: error,
        },
    }, '[postgres-connection] Postgres pool raised a background client error')
}

/**
 * This fork squashed the entire historical migration chain (350+ files going back to
 * the original Activepieces schema, many referencing tables/columns from features this
 * fork has since removed — flow builder, templates, trigger sources) into one migration
 * generated directly from the current `getEntities()` list. A fresh install now gets the
 * current schema in one step instead of replaying years of since-diverged history.
 * The old migration files remain on disk (unregistered, never executed) — see the repo
 * root's audit notes for why they weren't deleted outright.
 */
export const getMigrations = (): (new () => Migration)[] => {
    const migrations = [
        InitialSchema1700000000000,
        AddApiKeyExpiry1790152916876,
        AddPositionToField1790153790769,
        AddAgentEntity1790153850000,
        AddMcpOAuthTokenLineage1790154000000,
        AddConnectionHealthCheckColumns1791869626000,
    ]
    return migrations
}


export const createPostgresDataSource = (): DataSource => {
    const migrationConfig: MigrationConfig = {
        migrationsRun: true,
        migrationsTransactionMode: 'each',
        migrations: getMigrations(),
        synchronize: false,
    }

    const connectTimeoutMS = system.getNumberOrThrow(AppSystemProp.POSTGRES_CONNECTION_TIMEOUT_MS)

    const url = system.get(AppSystemProp.POSTGRES_URL)

    if (!isNil(url)) {
        return new DataSource({
            type: 'postgres',
            url,
            ssl: getSslConfig(),
            connectTimeoutMS,
            poolErrorHandler,
            ...spreadIfDefined('poolSize', system.get(AppSystemProp.POSTGRES_POOL_SIZE)),
            ...migrationConfig,
            ...commonProperties,
        })
    }

    const database = system.getOrThrow(AppSystemProp.POSTGRES_DATABASE)
    const host = system.getOrThrow(AppSystemProp.POSTGRES_HOST)
    const password = system.getOrThrow(AppSystemProp.POSTGRES_PASSWORD)
    const serializedPort = system.getOrThrow(AppSystemProp.POSTGRES_PORT)
    const port = Number.parseInt(serializedPort, 10)
    const idleTimeoutMillis = system.getNumberOrThrow(AppSystemProp.POSTGRES_IDLE_TIMEOUT_MS)
    const username = system.getOrThrow(AppSystemProp.POSTGRES_USERNAME)

    return new DataSource({
        type: 'postgres',
        host,
        port,
        username,
        password,
        database,
        ssl: getSslConfig(),
        connectTimeoutMS,
        poolErrorHandler,
        ...spreadIfDefined('poolSize', system.get(AppSystemProp.POSTGRES_POOL_SIZE)),
        ...commonProperties,
        ...migrationConfig,
        extra: {
            idleTimeoutMillis,
        },
    })
}

type MigrationConfig = {
    migrationsRun?: boolean
    migrationsTransactionMode?: 'all' | 'none' | 'each'
    migrations?: (new () => Migration)[]
    synchronize: false
}
