import {
    camelCase,
    chunk,
    debounce,
    deepMergeAndCast,
    ensureTrailingSlash,
    insertAt,
    isBase64,
    isEmpty,
    isEnumValue,
    isNil,
    isString,
    kebabCase,
    mapsAreSame,
    parseToJsonIfPossible,
    partition,
    pickBy,
    startCase,
    stringifyNullOrUndefined,
    truncateString,
    unique,
    validateIndexBound,
} from '../src/lib/utils'

describe('chunk', () => {
    it('should split an array into equal chunks', () => {
        const input = [1, 2, 3, 4, 5, 6]
        const result = chunk(input, 2)
        expect(result).toEqual([[1, 2], [3, 4], [5, 6]])
    })

    it('should place remainder elements into the final chunk', () => {
        const input = ['a', 'b', 'c', 'd', 'e']
        const result = chunk(input, 2)
        expect(result).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    })

    it('should return a single chunk if chunk size exceeds array length', () => {
        const input = [10, 20]
        const result = chunk(input, 5)
        expect(result).toEqual([[10, 20]])
    })

    it('should handle chunk size of 1', () => {
        const input = [1, 2, 3]
        const result = chunk(input, 1)
        expect(result).toEqual([[1], [2], [3]])
    })

    it('should return empty array for empty input', () => {
        const result = chunk([], 3)
        expect(result).toEqual([])
    })

    it('should not mutate the input array', () => {
        const input = [1, 2, 3]
        chunk(input, 2)
        expect(input).toEqual([1, 2, 3])
    })

    it('should return empty array for non-positive chunk size instead of hanging', () => {
        // A size of 0 (or negative) never advances the loop index, which used to
        // spin forever. The shared util must stay total for any numeric input.
        expect(chunk([1, 2, 3], 0)).toEqual([])
        expect(chunk([1, 2, 3], -1)).toEqual([])
        expect(chunk([1, 2, 3], Number.NaN)).toEqual([])
    })
})

describe('partition', () => {
    it('should partition array elements based on predicate', () => {
        const numbers = [1, 2, 3, 4, 5, 6]
        const [evens, odds] = partition(numbers, (n) => n % 2 === 0)
        expect(evens).toEqual([2, 4, 6])
        expect(odds).toEqual([1, 3, 5])
    })

    it('should supply item, index, and array to the predicate', () => {
        const items = ['a', 'b', 'c']
        const indices: number[] = []
        partition(items, (_, index) => {
            indices.push(index)
            return index > 0
        })
        expect(indices).toEqual([0, 1, 2])
    })

    it('should handle all elements matching predicate', () => {
        const [truthy, falsy] = partition([2, 4, 6], (n) => n % 2 === 0)
        expect(truthy).toEqual([2, 4, 6])
        expect(falsy).toEqual([])
    })

    it('should handle no elements matching predicate', () => {
        const [truthy, falsy] = partition([1, 3, 5], (n) => n % 2 === 0)
        expect(truthy).toEqual([])
        expect(falsy).toEqual([1, 3, 5])
    })

    it('should return two empty arrays for empty input', () => {
        const [truthy, falsy] = partition([], () => true)
        expect(truthy).toEqual([])
        expect(falsy).toEqual([])
    })
})

describe('unique', () => {
    it('should deduplicate primitive values', () => {
        expect(unique([1, 2, 2, 3, 1, 4])).toEqual([1, 2, 3, 4])
        expect(unique(['apple', 'banana', 'apple', 'cherry'])).toEqual(['apple', 'banana', 'cherry'])
        expect(unique([true, false, true])).toEqual([true, false])
    })

    it('should deduplicate complex objects using deep serialization', () => {
        const objA = { id: 1, name: 'first' }
        const objADup = { id: 1, name: 'first' }
        const objB = { id: 2, name: 'second' }
        const result = unique([objA, objADup, objB])
        expect(result).toEqual([
            { id: 1, name: 'first' },
            { id: 2, name: 'second' },
        ])
    })

    it('should preserve the first occurrence order', () => {
        const list = ['z', 'a', 'b', 'a', 'z']
        expect(unique(list)).toEqual(['z', 'a', 'b'])
    })

    it('should return empty array for empty input', () => {
        expect(unique([])).toEqual([])
    })
})

describe('debounce', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('should debounce repeated calls with the same key, firing once with the latest args', () => {
        const calls: string[] = []
        const debounced = debounce((...args: string[]) => calls.push(args.join('')), 100)
        debounced('a', 'first')
        debounced('a', 'second')
        vi.advanceTimersByTime(150)
        expect(calls).toEqual(['second'])
    })

    it('should keep pending timers for different keys independent', () => {
        const calls: string[] = []
        const debounced = debounce((...args: string[]) => calls.push(args.join('')), 100)
        debounced('a', 'one')
        debounced('b', 'two')
        vi.advanceTimersByTime(150)
        expect(calls).toHaveLength(2)
        expect(calls).toContain('one')
        expect(calls).toContain('two')
    })

    it('should not fire a superseded same-key call when keys interleave', () => {
        // 'a' is called, then 'b', then 'a' again. The first 'a' call was
        // superseded by the third call, so only the latest 'a' args may fire.
        const calls: string[] = []
        const debounced = debounce((...args: string[]) => calls.push(args.join('')), 100)
        debounced('a', 'a1')
        debounced('b', 'b1')
        debounced('a', 'a2')
        vi.advanceTimersByTime(150)
        expect(calls).toContain('a2')
        expect(calls).toContain('b1')
        expect(calls).not.toContain('a1')
    })
})

describe('truncateString', () => {
    it('should return original string if within maxLength', () => {
        expect(truncateString({ value: 'hello', maxLength: 10 })).toBe('hello')
    })

    it('should truncate and append default ellipsis', () => {
        expect(truncateString({ value: 'hello world', maxLength: 5 })).toBe('hello…')
    })

    it('should respect custom suffix', () => {
        expect(truncateString({ value: 'hello world', maxLength: 5, suffix: '---' })).toBe('hello---')
    })

    it('should avoid splitting a high-surrogate code unit at boundary', () => {
        // 'a' + '😀' is 1 + 2 = 3 code units. If maxLength is 2, it falls inside 😀 (\uD83D)
        const emojiStr = 'a😀b'
        // 'a' = 0x61, '\uD83D', '\uDE00', 'b'
        const truncated = truncateString({ value: emojiStr, maxLength: 2 })
        // It backs off the lone high surrogate and keeps 'a' + '…'
        expect(truncated).toBe('a…')
    })
})

describe('isBase64', () => {
    it('should return true for valid standard base64 strings', () => {
        expect(isBase64(Buffer.from('hello world').toString('base64'))).toBe(true)
        expect(isBase64('YWJj')).toBe(true) // 'abc'
        expect(isBase64('YQ==')).toBe(true) // 'a'
        expect(isBase64('YWI=')).toBe(true) // 'ab'
    })

    it('should return false for invalid base64 strings', () => {
        expect(isBase64('')).toBe(false)
        expect(isBase64('not-base-64!')).toBe(false)
        expect(isBase64('===')).toBe(false)
        expect(isBase64('abc')).toBe(false) // Length 3, not divisible by 4
    })

    it('should support data URIs when allowMime is set', () => {
        const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        expect(isBase64(dataUri, { allowMime: true })).toBe(true)
        expect(isBase64(dataUri, { allowMime: false })).toBe(false)
    })
})

describe('mapsAreSame', () => {
    it('should return true for identical maps', () => {
        const m1 = new Map([['k1', 'v1'], ['k2', 'v2']])
        const m2 = new Map([['k1', 'v1'], ['k2', 'v2']])
        expect(mapsAreSame(m1, m2)).toBe(true)
    })

    it('should return false when sizes differ', () => {
        const m1 = new Map([['k1', 'v1']])
        const m2 = new Map([['k1', 'v1'], ['k2', 'v2']])
        expect(mapsAreSame(m1, m2)).toBe(false)
    })

    it('should return false when keys differ', () => {
        const m1 = new Map([['k1', 'v1']])
        const m2 = new Map([['k2', 'v1']])
        expect(mapsAreSame(m1, m2)).toBe(false)
    })

    it('should return false when values differ', () => {
        const m1 = new Map([['k1', 'v1']])
        const m2 = new Map([['k1', 'diff']])
        expect(mapsAreSame(m1, m2)).toBe(false)
    })
})

describe('pickBy', () => {
    it('should filter object entries based on predicate', () => {
        const input: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 }
        const result = pickBy(input, (val) => val % 2 === 0)
        expect(result).toEqual({ b: 2, d: 4 })
    })
})

describe('insertAt', () => {
    it('should insert element at specified index without mutating source', () => {
        const source = ['first', 'third']
        const result = insertAt(source, 1, 'second')
        expect(result).toEqual(['first', 'second', 'third'])
        expect(source).toEqual(['first', 'third'])
    })
})

describe('ensureTrailingSlash', () => {
    it('should append slash if missing', () => {
        expect(ensureTrailingSlash('https://example.com')).toBe('https://example.com/')
    })

    it('should preserve slash if already present', () => {
        expect(ensureTrailingSlash('https://example.com/')).toBe('https://example.com/')
    })
})

describe('validateIndexBound', () => {
    it('should clamp index to [0, limit - 1]', () => {
        expect(validateIndexBound({ index: -10, limit: 5 })).toBe(0)
        expect(validateIndexBound({ index: 2, limit: 5 })).toBe(2)
        expect(validateIndexBound({ index: 5, limit: 5 })).toBe(4)
        expect(validateIndexBound({ index: 100, limit: 5 })).toBe(4)
    })
})

describe('isEnumValue', () => {
    enum Status {
        ACTIVE = 'ACTIVE',
        PENDING = 'PENDING',
    }

    it('should return true for valid enum values', () => {
        expect(isEnumValue(Status, 'ACTIVE')).toBe(true)
        expect(isEnumValue(Status, 'PENDING')).toBe(true)
    })

    it('should return false for invalid enum values', () => {
        expect(isEnumValue(Status, 'INACTIVE')).toBe(false)
        expect(isEnumValue(Status, 99)).toBe(false)
    })
})

describe('isEmpty', () => {
    it('should return true for empty containers and nullish', () => {
        expect(isEmpty(null)).toBe(true)
        expect(isEmpty(undefined)).toBe(true)
        expect(isEmpty('')).toBe(true)
        expect(isEmpty([])).toBe(true)
        expect(isEmpty({})).toBe(true)
    })

    it('should return false for non-empty containers and primitives', () => {
        expect(isEmpty('hello')).toBe(false)
        expect(isEmpty([1])).toBe(false)
        expect(isEmpty({ a: 1 })).toBe(false)
        expect(isEmpty(0)).toBe(false)
        expect(isEmpty(false)).toBe(false)
    })
})

describe('kebabCase, camelCase, startCase', () => {
    it('should convert strings accurately', () => {
        expect(kebabCase('helloWorld')).toBe('hello-world')
        expect(kebabCase('Hello World')).toBe('hello-world')
        expect(camelCase('hello-world')).toBe('helloWorld')
        expect(camelCase('hello_world')).toBe('helloWorld')
        expect(startCase('helloWorld')).toBe('Hello World')
    })
})

describe('parseToJsonIfPossible', () => {
    it('should parse valid JSON', () => {
        expect(parseToJsonIfPossible('{"count":10}')).toEqual({ count: 10 })
    })

    it('should return raw input when invalid JSON', () => {
        expect(parseToJsonIfPossible('not json')).toBe('not json')
    })
})

describe('isString, isNil, stringifyNullOrUndefined', () => {
    it('should identify string and nil values', () => {
        expect(isString('test')).toBe(true)
        expect(isString(123)).toBe(false)
        expect(isNil(null)).toBe(true)
        expect(isNil(undefined)).toBe(true)
        expect(isNil(0)).toBe(false)
        expect(stringifyNullOrUndefined(null)).toBe('null')
        expect(stringifyNullOrUndefined(undefined)).toBe('undefined')
    })
})

describe('deepMergeAndCast', () => {
    it('should deep merge objects and concatenate arrays', () => {
        const target = { a: 1, nested: { x: 'original' }, list: [1, 2] }
        const source = { b: 2, nested: { y: 'added' }, list: [3, 4] }
        const merged = deepMergeAndCast<typeof target & typeof source>(target, source)
        expect(merged).toEqual({
            a: 1,
            b: 2,
            nested: { x: 'original', y: 'added' },
            list: [1, 2, 3, 4],
        })
    })
})
