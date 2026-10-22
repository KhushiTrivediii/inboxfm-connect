import { describe, expect, it } from 'vitest'
import {
    STORE_KEY_MAX_LENGTH,
    STORE_VALUE_MAX_SIZE,
    StoreEntry,
} from '../../../src/lib/core/store-entry/store-entry'
import {
    DeleteStoreEntryRequest,
    GetStoreEntryRequest,
    PutStoreEntryRequest,
} from '../../../src/lib/core/store-entry/dto/store-entry-request'

describe('Store Entry Constants', () => {
    it('defines max key length of 128 chars and max value size of 512KB', () => {
        expect(STORE_KEY_MAX_LENGTH).toBe(128)
        expect(STORE_VALUE_MAX_SIZE).toBe(512 * 1024)
        expect(STORE_VALUE_MAX_SIZE).toBe(524288)
    })
})

describe('PutStoreEntryRequest schema', () => {
    it('parses valid store entry with arbitrary value types', () => {
        const strEntry = PutStoreEntryRequest.parse({ key: 'my-config', value: 'hello world' })
        expect(strEntry.key).toBe('my-config')
        expect(strEntry.value).toBe('hello world')

        const objEntry = PutStoreEntryRequest.parse({ key: 'user-profile', value: { theme: 'dark', notifications: true } })
        expect(objEntry.value).toEqual({ theme: 'dark', notifications: true })

        const arrEntry = PutStoreEntryRequest.parse({ key: 'history', value: [1, 2, 3] })
        expect(arrEntry.value).toEqual([1, 2, 3])

        const nullEntry = PutStoreEntryRequest.parse({ key: 'empty', value: null })
        expect(nullEntry.value).toBeNull()

        const numEntry = PutStoreEntryRequest.parse({ key: 'counter', value: 42 })
        expect(numEntry.value).toBe(42)
    })

    it('accepts key up to exactly STORE_KEY_MAX_LENGTH (128 characters)', () => {
        const maxKey = 'k'.repeat(STORE_KEY_MAX_LENGTH)
        const parsed = PutStoreEntryRequest.parse({ key: maxKey, value: 'valid' })
        expect(parsed.key).toHaveLength(128)
    })

    it('rejects key exceeding STORE_KEY_MAX_LENGTH (129 characters)', () => {
        const oversizedKey = 'k'.repeat(STORE_KEY_MAX_LENGTH + 1)
        expect(() => PutStoreEntryRequest.parse({ key: oversizedKey, value: 'invalid' })).toThrow()
    })

    it('allows value to be omitted/undefined', () => {
        const parsed = PutStoreEntryRequest.parse({ key: 'flag-only' })
        expect(parsed.key).toBe('flag-only')
        expect(parsed.value).toBeUndefined()
    })

    it('rejects missing key', () => {
        expect(() => PutStoreEntryRequest.parse({ value: 'val' })).toThrow()
    })
})

describe('GetStoreEntryRequest schema', () => {
    it('parses valid get request with key', () => {
        const parsed = GetStoreEntryRequest.parse({ key: 'session_token' })
        expect(parsed.key).toBe('session_token')
    })

    it('rejects missing or non-string key', () => {
        expect(() => GetStoreEntryRequest.parse({})).toThrow()
        expect(() => GetStoreEntryRequest.parse({ key: 12345 })).toThrow()
    })
})

describe('DeleteStoreEntryRequest schema', () => {
    it('parses valid delete request with key', () => {
        const parsed = DeleteStoreEntryRequest.parse({ key: 'cache_key' })
        expect(parsed.key).toBe('cache_key')
    })

    it('rejects missing key', () => {
        expect(() => DeleteStoreEntryRequest.parse({})).toThrow()
    })
})

describe('StoreEntry type shape verification', () => {
    it('constructs a valid StoreEntry conforming object', () => {
        const entry: StoreEntry = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            key: 'app_state',
            projectId: 'proj-123',
            value: { count: 10 },
        }
        expect(entry.key).toBe('app_state')
        expect(entry.projectId).toBe('proj-123')
    })
})
