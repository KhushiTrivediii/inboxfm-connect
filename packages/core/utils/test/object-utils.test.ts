import {
    applyFunctionToValues,
    applyFunctionToValuesSync,
    deleteProperties,
    deleteProps,
    groupBy,
    isObject,
    omit,
    sanitizeObjectForPostgresql,
    spreadIfDefined,
    spreadIfNotUndefined,
} from '../src/lib/object-utils'

describe('sanitizeObjectForPostgresql', () => {
    it('should remove null bytes from a string', () => {
        const input = 'hello\u0000world'
        const result = sanitizeObjectForPostgresql(input)
        expect(result).toBe('helloworld')
    })

    it('should remove multiple null bytes across nested objects and arrays', () => {
        const input = {
            title: 'doc\u0000name',
            tags: ['alpha\u0000', 'beta'],
            metadata: {
                nested: 'val\u0000ue',
                count: 42,
                active: true,
            },
        }
        const result = sanitizeObjectForPostgresql(input)
        expect(result).toEqual({
            title: 'docname',
            tags: ['alpha', 'beta'],
            metadata: {
                nested: 'value',
                count: 42,
                active: true,
            },
        })
    })

    it('should remove lone high surrogate characters without low surrogates', () => {
        // \uD83D alone without \uDE00 is an unpaired high surrogate
        const loneHigh = 'prefix\uD83Dsuffix'
        const result = sanitizeObjectForPostgresql(loneHigh)
        expect(result).toBe('prefixsuffix')
    })

    it('should remove lone low surrogate characters without high surrogates', () => {
        // \uDE00 alone without \uD83D is an unpaired low surrogate
        const loneLow = 'start\uDE00end'
        const result = sanitizeObjectForPostgresql(loneLow)
        expect(result).toBe('startend')
    })

    it('should preserve valid surrogate pairs such as emoji', () => {
        // \uD83D\uDE00 is 😀 (valid surrogate pair)
        const emoji = 'Hello 😀 World \uD83D\uDE00'
        const result = sanitizeObjectForPostgresql(emoji)
        expect(result).toBe('Hello 😀 World \uD83D\uDE00')
    })

    it('should handle primitives and nullish values unchanged', () => {
        expect(sanitizeObjectForPostgresql(null)).toBeNull()
        expect(sanitizeObjectForPostgresql(undefined)).toBeUndefined()
        expect(sanitizeObjectForPostgresql(12345)).toBe(12345)
        expect(sanitizeObjectForPostgresql(false)).toBe(false)
        expect(sanitizeObjectForPostgresql(true)).toBe(true)
    })

    it('should not mutate the original object', () => {
        const original = { text: 'clean\u0000me' }
        const result = sanitizeObjectForPostgresql(original)
        expect(result.text).toBe('cleanme')
        expect(original.text).toBe('clean\u0000me')
    })
})

describe('omit', () => {
    it('should remove specified keys from an object', () => {
        const source = { a: 1, b: 'two', c: true, d: [1, 2] }
        const result = omit(source, ['b', 'd'])
        expect(result).toEqual({ a: 1, c: true })
    })

    it('should return a new object and not mutate original', () => {
        const source = { x: 10, y: 20 }
        const result = omit(source, ['x'])
        expect(result).toEqual({ y: 20 })
        expect(source).toEqual({ x: 10, y: 20 })
    })

    it('should handle empty keysToOmit array', () => {
        const source = { key: 'value' }
        const result = omit(source, [])
        expect(result).toEqual({ key: 'value' })
    })

    it('should handle empty objects', () => {
        const source = {}
        const result = omit(source, [])
        expect(result).toEqual({})
    })
})

describe('spreadIfNotUndefined', () => {
    it('should return object with key and value when value is defined', () => {
        expect(spreadIfNotUndefined('foo', 'bar')).toEqual({ foo: 'bar' })
        expect(spreadIfNotUndefined('count', 0)).toEqual({ count: 0 })
        expect(spreadIfNotUndefined('flag', false)).toEqual({ flag: false })
        expect(spreadIfNotUndefined('empty', null)).toEqual({ empty: null })
    })

    it('should return empty object when value is undefined', () => {
        expect(spreadIfNotUndefined('foo', undefined)).toEqual({})
    })
})

describe('spreadIfDefined', () => {
    it('should return object when value is not null or undefined', () => {
        expect(spreadIfDefined('foo', 'bar')).toEqual({ foo: 'bar' })
        expect(spreadIfDefined('num', 0)).toEqual({ num: 0 })
        expect(spreadIfDefined('bool', false)).toEqual({ bool: false })
    })

    it('should return empty object when value is null or undefined', () => {
        expect(spreadIfDefined('foo', null)).toEqual({})
        expect(spreadIfDefined('bar', undefined)).toEqual({})
    })
})

describe('deleteProperties and deleteProps', () => {
    it('should delete properties using deleteProperties without mutating input', () => {
        const original: Record<string, unknown> = { id: 1, secret: 'shh', role: 'admin' }
        const copy = deleteProperties(original, ['secret', 'role'])
        expect(copy).toEqual({ id: 1 })
        expect(original).toEqual({ id: 1, secret: 'shh', role: 'admin' })
    })

    it('should delete properties using deleteProps without mutating input', () => {
        const original = { id: 'p1', apiKey: 'secret', env: 'prod' }
        const stripped = deleteProps(original, ['apiKey'])
        expect(stripped).toEqual({ id: 'p1', env: 'prod' })
        expect(original.apiKey).toBe('secret')
    })
})

describe('applyFunctionToValuesSync', () => {
    it('should transform all string values synchronously in nested structure', () => {
        const data = {
            name: 'alice',
            nested: {
                city: 'paris',
                zip: 75001,
            },
            list: ['first', 'second'],
        }
        const upper = applyFunctionToValuesSync<typeof data>(data, (s) => s.toUpperCase())
        expect(upper).toEqual({
            name: 'ALICE',
            nested: {
                city: 'PARIS',
                zip: 75001,
            },
            list: ['FIRST', 'SECOND'],
        })
    })

    it('should return null, undefined, and non-string primitives as-is', () => {
        expect(applyFunctionToValuesSync(null, (s) => s.toUpperCase())).toBeNull()
        expect(applyFunctionToValuesSync(undefined, (s) => s.toUpperCase())).toBeUndefined()
        expect(applyFunctionToValuesSync(999, (s) => s.toUpperCase())).toBe(999)
        expect(applyFunctionToValuesSync(false, (s) => s.toUpperCase())).toBe(false)
    })

    it('should pass non-plain objects through untouched instead of destroying them', () => {
        // Only plain objects are traversable via Object.entries. Builtins like
        // Date have none, so the old recursion turned a Date into `{}` and a
        // Buffer into an index-keyed byte map. They must pass through as-is.
        const date = new Date('2024-06-15T10:30:00.000Z')
        const buffer = Buffer.from('binary-data')
        const map = new Map([['key', 'value']])
        const set = new Set(['a', 'b'])
        const regexp = /pattern/
        const input = { when: date, blob: buffer, mapping: map, unique: set, matcher: regexp, plain: 'x' }
        const result = applyFunctionToValuesSync<typeof input>(input, (s) => s.toUpperCase())
        expect(result.when).toBe(date)
        expect(result.blob).toBe(buffer)
        expect(result.mapping).toBe(map)
        expect(result.unique).toBe(set)
        expect(result.matcher).toBe(regexp)
        expect(result.plain).toBe('X')
    })

    it('should still recurse into nested plain objects and arrays around non-plain objects', () => {
        const date = new Date('2024-06-15T10:30:00.000Z')
        const input = { nested: { when: date, label: 'keep' }, list: [{ note: 'x' }, date] }
        const result = applyFunctionToValuesSync<typeof input>(input, (s) => s.toUpperCase())
        expect(result.nested.when).toBe(date)
        expect(result.nested.label).toBe('KEEP')
        expect(result.list[0].note).toBe('X')
        expect(result.list[1]).toBe(date)
    })
})

describe('applyFunctionToValues', () => {
    it('should transform all string values asynchronously', async () => {
        const data = {
            greeting: 'hello',
            items: ['item1', 'item2'],
        }
        const transformed = await applyFunctionToValues<typeof data>(
            data,
            async (s) => Promise.resolve(`async_${s}`),
        )
        expect(transformed).toEqual({
            greeting: 'async_hello',
            items: ['async_item1', 'async_item2'],
        })
    })

    it('should handle primitives and nullish asynchronously', async () => {
        expect(await applyFunctionToValues(null, async (s) => s)).toBeNull()
        expect(await applyFunctionToValues(undefined, async (s) => s)).toBeUndefined()
        expect(await applyFunctionToValues(42, async (s) => s)).toBe(42)
    })

    it('should pass non-plain objects through untouched asynchronously', async () => {
        const date = new Date('2024-06-15T10:30:00.000Z')
        const buffer = Buffer.from('binary-data')
        const input = { when: date, blob: buffer, plain: 'x' }
        const result = await applyFunctionToValues<typeof input>(input, async (s) => Promise.resolve(s.toUpperCase()))
        expect(result.when).toBe(date)
        expect(result.blob).toBe(buffer)
        expect(result.plain).toBe('X')
    })
})

describe('groupBy', () => {
    it('should group items by a selected key', () => {
        const users = [
            { id: 1, department: 'engineering' },
            { id: 2, department: 'sales' },
            { id: 3, department: 'engineering' },
        ]
        const grouped = groupBy(users, (u) => u.department)
        expect(grouped).toEqual({
            engineering: [
                { id: 1, department: 'engineering' },
                { id: 3, department: 'engineering' },
            ],
            sales: [{ id: 2, department: 'sales' }],
        })
    })

    it('should return an empty record for an empty array', () => {
        const empty = groupBy<{ id: number }, string>([], (x) => String(x.id))
        expect(empty).toEqual({})
    })
})

describe('isObject', () => {
    it('should return true for plain objects and non-array objects', () => {
        expect(isObject({})).toBe(true)
        expect(isObject({ a: 1 })).toBe(true)
    })

    it('should return false for arrays, null, undefined, and primitives', () => {
        expect(isObject([])).toBe(false)
        expect(isObject([1, 2, 3])).toBe(false)
        expect(isObject(null)).toBe(false)
        expect(isObject(undefined)).toBe(false)
        expect(isObject('string')).toBe(false)
        expect(isObject(123)).toBe(false)
        expect(isObject(true)).toBe(false)
    })
})
