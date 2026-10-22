import { describe, expect, it } from 'vitest'

// RED test (issue #411): the paginator's non-composite cursor decode must not
// throw on attacker-controlled garbage. The composite path already returns {}
// on undecodable input; the default path must honor the same contract.

import Paginator from '../../../../../src/app/helper/pagination/paginator'
import { EntitySchema } from 'typeorm'

const TestEntity = new EntitySchema({
    name: 'test_cursor_entity',
    columns: {
        id: { type: String, primary: true },
        created: { type: 'timestamp with time zone' },
        status: { type: String, nullable: true },
    },
})

function makePaginator(): Paginator<{ id: string, created: Date, status: string | null }> {
    return new Paginator(TestEntity as EntitySchema<{ id: string, created: Date, status: string | null }>)
}

describe('paginator cursor decode resilience (issue #411)', () => {
    it('non-composite decode of a non-base64 cursor returns {} instead of throwing', () => {
        const p = makePaginator()
        p.setAfterCursor('***not-base64***')
        // @ts-expect-error: poke the private decode to assert the contract directly
        expect(() => p['decode']('***not-base64***')).not.toThrow()
        // @ts-expect-error
        expect(p['decode']('***not-base64***')).toEqual({})
    })

    it('non-composite decode of a well-formed-base64 garbage payload returns {} instead of throwing', () => {
        const garbage = Buffer.from('notacolumn:1').toString('base64')
        const p = makePaginator()
        // @ts-expect-error
        expect(p['decode'](garbage)).toEqual({})
    })

    it('non-composite decode of a valid key with a non-timestamp value returns {} instead of throwing', () => {
        const badValue = Buffer.from('created:notatimestamp').toString('base64')
        const p = makePaginator()
        // @ts-expect-error
        expect(p['decode'](badValue)).toEqual({})
    })

    it('valid cursor still decodes (created:ms epoch)', () => {
        const valid = Buffer.from(`created:${new Date('2026-09-30T00:00:00Z').getTime()}`).toString('base64')
        const p = makePaginator()
        // @ts-expect-error
        const decoded = p['decode'](valid)
        expect(Object.keys(decoded)).toEqual(['created'])
    })
})
