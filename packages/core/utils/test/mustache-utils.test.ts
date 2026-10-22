import { describe, expect, it } from 'vitest'
import { extractMustacheTokens } from '../src/lib/mustache-utils'

describe('extractMustacheTokens', () => {
    it('extracts simple tokens with token, inner, and index contract', () => {
        const input = 'Hello {{ user.name }} from {{ place }}!'
        const tokens = extractMustacheTokens(input)
        expect(tokens).toEqual([
            {
                token: '{{ user.name }}',
                inner: ' user.name ',
                index: 6,
            },
            {
                token: '{{ place }}',
                inner: ' place ',
                index: 27,
            },
        ])
    })

    it('handles backtick template literals containing }} without premature token closure', () => {
        const input = '{{ `a}}b` + steps.step_1.x }}'
        const tokens = extractMustacheTokens(input)
        expect(tokens).toHaveLength(1)
        expect(tokens[0]).toEqual({
            token: '{{ `a}}b` + steps.step_1.x }}',
            inner: ' `a}}b` + steps.step_1.x ',
            index: 0,
        })
    })

    it('handles single and double quoted string literals containing }}', () => {
        const singleQuote = "{{ 'test}}val' + steps.step_1.x }}"
        const doubleQuote = '{{ "prefix}}suffix" + steps.step_1.x }}'

        const singleTokens = extractMustacheTokens(singleQuote)
        expect(singleTokens).toHaveLength(1)
        expect(singleTokens[0].token).toBe("{{ 'test}}val' + steps.step_1.x }}")
        expect(singleTokens[0].inner).toBe(" 'test}}val' + steps.step_1.x ")

        const doubleTokens = extractMustacheTokens(doubleQuote)
        expect(doubleTokens).toHaveLength(1)
        expect(doubleTokens[0].token).toBe('{{ "prefix}}suffix" + steps.step_1.x }}')
        expect(doubleTokens[0].inner).toBe(' "prefix}}suffix" + steps.step_1.x ')
    })

    it('handles escaped quotes inside string literals without prematurely exiting quote state', () => {
        const escapedSingle = "{{ steps['It\\'s'].x }}"
        const singleTokens = extractMustacheTokens(escapedSingle)
        expect(singleTokens).toHaveLength(1)
        expect(singleTokens[0].token).toBe("{{ steps['It\\'s'].x }}")
        expect(singleTokens[0].inner).toBe(" steps['It\\'s'].x ")

        const escapedDouble = '{{ steps["a\\"b"].x }}'
        const doubleTokens = extractMustacheTokens(escapedDouble)
        expect(doubleTokens).toHaveLength(1)
        expect(doubleTokens[0].token).toBe('{{ steps["a\\"b"].x }}')
        expect(doubleTokens[0].inner).toBe(' steps["a\\"b"].x ')

        const escapedBacktick = '{{ steps[`a\\`b`].x }}'
        const backtickTokens = extractMustacheTokens(escapedBacktick)
        expect(backtickTokens).toHaveLength(1)
        expect(backtickTokens[0].token).toBe('{{ steps[`a\\`b`].x }}')
        expect(backtickTokens[0].inner).toBe(' steps[`a\\`b`].x ')
    })

    it('handles nested braces such as object literals inside tokens', () => {
        const input = '{{ { a: { b: 1 }, c: "}}" } }}'
        const tokens = extractMustacheTokens(input)
        expect(tokens).toHaveLength(1)
        expect(tokens[0].token).toBe('{{ { a: { b: 1 }, c: "}}" } }}')
        expect(tokens[0].inner).toBe(' { a: { b: 1 }, c: "}}" } ')
    })

    it('returns empty array when mustache token is unterminated (depth > 0)', () => {
        const input = 'Hello {{ user.name'
        expect(extractMustacheTokens(input)).toEqual([])

        const quoteUnclosed = "Hello {{ 'quote never closes"
        expect(extractMustacheTokens(quoteUnclosed)).toEqual([])
    })

    it('returns empty array when input contains no mustache braces', () => {
        const input = 'plain string without any mustache tokens'
        expect(extractMustacheTokens(input)).toEqual([])
    })

    it('documents {{{key: 1}}} edge case where token closes at the first }}', () => {
        // Known edge: adjacent triple brace without space parses outer {{...}} and leaves trailing '}'
        const input = '{{{key: 1}}}'
        const tokens = extractMustacheTokens(input)
        expect(tokens).toHaveLength(1)
        expect(tokens[0].token).toBe('{{{key: 1}}')
        expect(tokens[0].inner).toBe('{key: 1')
    })
})
