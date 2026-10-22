import { ExecutionMode } from '@inboxfm-connect/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cryptoUtils } from '../src/crypto'
import { DatabaseType } from '../src/database-type'
import { apDayjs, apDayjsDuration } from '../src/dayjs-helper'
import { environmentMigrations } from '../src/env-migrations'
import { RedisType } from '../src/redis-type'

describe('server-utils: crypto, dayjs, and environmentMigrations', () => {
    describe('cryptoUtils', () => {
        it('generateRandomPassword generates 64-character hex strings', async () => {
            const pass1 = await cryptoUtils.generateRandomPassword()
            const pass2 = await cryptoUtils.generateRandomPassword()

            expect(pass1).toHaveLength(64)
            expect(pass2).toHaveLength(64)
            expect(/^[0-9a-f]{64}$/.test(pass1)).toBe(true)
            expect(/^[0-9a-f]{64}$/.test(pass2)).toBe(true)
            expect(pass1).not.toBe(pass2)
        })

        it('hashSHA256 generates valid SHA256 hex digest for known vectors', () => {
            // Known empty string hash
            const emptyHash = cryptoUtils.hashSHA256('')
            expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

            const helloHash = cryptoUtils.hashSHA256('hello world')
            expect(helloHash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
        })

        it('hashObject returns deterministic hash of JSON serialized object', async () => {
            const obj1 = { name: 'inboxfm', flag: true, count: 42 }
            const obj2 = { name: 'inboxfm', flag: true, count: 42 }

            const hash1 = await cryptoUtils.hashObject(obj1)
            const hash2 = await cryptoUtils.hashObject(obj2)

            expect(hash1).toBe(hash2)
            expect(hash1).toHaveLength(64)
        })
    })

    describe('dayjsHelper', () => {
        it('apDayjs parses strings, numbers, and default current time', () => {
            const now = apDayjs()
            expect(now.isValid()).toBe(true)

            const iso = apDayjs('2026-10-05T01:00:00Z')
            expect(iso.isValid()).toBe(true)
            expect(iso.year()).toBe(2026)

            const timestamp = apDayjs(1700000000000)
            expect(timestamp.isValid()).toBe(true)
            expect(timestamp.valueOf()).toBe(1700000000000)
        })

        it('supports UTC, timezone and duration plugins', () => {
            const date = apDayjs('2026-10-05T00:00:00Z').utc()
            expect(date.isUTC()).toBe(true)

            const durationOneHour = apDayjsDuration(1, 'hour')
            expect(durationOneHour.asMinutes()).toBe(60)
            expect(durationOneHour.asSeconds()).toBe(3600)
            expect(durationOneHour.asMilliseconds()).toBe(3600000)
        })
    })

    describe('environmentMigrations', () => {
        const originalEnv = { ...process.env }

        beforeEach(() => {
            process.env = { ...originalEnv }
        })

        afterEach(() => {
            process.env = originalEnv
        })

        it('migrates legacy SANDBOXED execution mode to SANDBOX_PROCESS', () => {
            process.env.AP_EXECUTION_MODE = 'SANDBOXED'
            const migrated = environmentMigrations.migrate()
            expect(migrated.AP_EXECUTION_MODE).toBe(ExecutionMode.SANDBOX_PROCESS)
        })

        it('preserves modern execution mode', () => {
            process.env.AP_EXECUTION_MODE = ExecutionMode.UNSANDBOXED
            const migrated = environmentMigrations.migrate()
            expect(migrated.AP_EXECUTION_MODE).toBe(ExecutionMode.UNSANDBOXED)
        })

        it('migrates MEMORY queue mode to RedisType.MEMORY', () => {
            process.env.AP_QUEUE_MODE = 'MEMORY'
            process.env.AP_REDIS_TYPE = 'ANY'
            const migrated = environmentMigrations.migrate()
            expect(migrated.AP_REDIS_TYPE).toBe(RedisType.MEMORY)
        })

        it('migrates SQLITE3 db type to DatabaseType.PGLITE', () => {
            process.env.AP_DB_TYPE = 'SQLITE3'
            const migrated = environmentMigrations.migrate()
            expect(migrated.AP_DB_TYPE).toBe(DatabaseType.PGLITE)
        })

        it('preserves POSTGRES db type', () => {
            process.env.AP_DB_TYPE = DatabaseType.POSTGRES
            const migrated = environmentMigrations.migrate()
            expect(migrated.AP_DB_TYPE).toBe(DatabaseType.POSTGRES)
        })
    })
})
