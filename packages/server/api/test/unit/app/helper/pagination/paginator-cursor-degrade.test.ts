import { describe, expect, it, vi } from 'vitest'

// Issue #411 (CodeAnt follow-up): an undecodable cursor must degrade to
// first-page semantics. Pre-fix, decode() returned {} but the raw
// afterCursor/beforeCursor strings stayed set, so paginate() still reversed
// the result set for a garbage beforeCursor and emitted misleading
// next/previous links. Post-fix, appendPagingQuery nulls an undecodable
// cursor before any hasAfterCursor()/hasBeforeCursor() consumer runs.

import Paginator from '../../../../../src/app/helper/pagination/paginator'
import { EntitySchema, SelectQueryBuilder } from 'typeorm'

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

// SelectQueryBuilder's constructor consumes the passed builder through
// expressionMap.clone() (QueryBuilder.ts:116); the clone then receives the
// andWhere/take/addOrderBy calls. A chainable stub with a clone-able
// expressionMap lets us assert the appendPagingQuery contract with no DB.
const makeBuilderStub = (): unknown => {
    const expressionMap = {
        clone: () => expressionMap,
        take: undefined,
        orderBys: { created: 'DESC' },
        wheres: [] as unknown[],
    }
    const self: unknown = new Proxy({} as Record<string, unknown>, {
        get(_t, prop: string) {
            if (prop === 'expressionMap') {
                return expressionMap
            }
            return (...args: unknown[]) => {
                if (prop === 'andWhere') {
                    expressionMap.wheres.push(args[0])
                }
                if (prop === 'take') {
                    expressionMap.take = args[0]
                }
                if (prop === 'addOrderBy') {
                    ;(expressionMap.orderBys as Record<string, string>)[args[0] as string] = args[1] as string
                }
                return self
            }
        },
    })
    return self
}

describe('undecodable cursor degrades to first-page semantics (issue #411)', () => {
    it('a garbage afterCursor is nulled inside appendPagingQuery', () => {
        const p = makePaginator()
        p.setAfterCursor('***not-base64***')
        p.setLimit(10)
        p['appendPagingQuery'](makeBuilderStub() as unknown as SelectQueryBuilder<never>)
        // @ts-expect-error: private state
        expect(p['afterCursor']).toBeNull()
    })

    it('a garbage beforeCursor is nulled inside appendPagingQuery (no reversal path)', () => {
        const p = makePaginator()
        p.setBeforeCursor('***not-base64***')
        p.setLimit(10)
        p['appendPagingQuery'](makeBuilderStub() as unknown as SelectQueryBuilder<never>)
        // @ts-expect-error: private state — with beforeCursor nulled,
        // paginate()'s `!hasAfterCursor() && hasBeforeCursor()` reverse
        // branch can no longer fire for garbage input
        expect(p['beforeCursor']).toBeNull()
    })

    it('a well-formed-base64 garbage payload is nulled too (unknown column)', () => {
        const garbage = Buffer.from('notacolumn:1').toString('base64')
        const p = makePaginator()
        p.setAfterCursor(garbage)
        p['appendPagingQuery'](makeBuilderStub() as unknown as SelectQueryBuilder<never>)
        // @ts-expect-error
        expect(p['afterCursor']).toBeNull()
    })

    it('a non-timestamp value for a valid column is nulled (decode yields nothing)', () => {
        const badValue = Buffer.from('created:notatimestamp').toString('base64')
        const p = makePaginator()
        p.setBeforeCursor(badValue)
        p['appendPagingQuery'](makeBuilderStub() as unknown as SelectQueryBuilder<never>)
        // @ts-expect-error
        expect(p['beforeCursor']).toBeNull()
    })

    it('a VALID cursor survives appendPagingQuery untouched', () => {
        const valid = Buffer.from(`created:${new Date('2026-09-30T00:00:00Z').getTime()}`).toString('base64')
        const p = makePaginator()
        p.setAfterCursor(valid)
        // a valid cursor takes the andWhere(Brackets) path, which drills into
        // real typeorm internals; stub just that method on the clone
        const andWhereSpy = vi
            .spyOn(SelectQueryBuilder.prototype as unknown as { andWhere: () => unknown }, 'andWhere')
            .mockReturnValue(makeBuilderStub())
        try {
            p['appendPagingQuery'](makeBuilderStub() as unknown as SelectQueryBuilder<never>)
        }
        finally {
            andWhereSpy.mockRestore()
        }
        // @ts-expect-error
        expect(p['afterCursor']).toBe(valid)
    })

    it('no cursor at all: appendPagingQuery applies take(limit+1) and ordering (first page)', () => {
        const p = makePaginator()
        p.setLimit(10)
        const stub = makeBuilderStub() as unknown as { expressionMap: { take: number | undefined } }
        p['appendPagingQuery'](stub as unknown as SelectQueryBuilder<never>)
        expect(stub.expressionMap.take).toBe(11)
        // @ts-expect-error
        expect(p['afterCursor']).toBeNull()
        // @ts-expect-error
        expect(p['beforeCursor']).toBeNull()
    })
})
