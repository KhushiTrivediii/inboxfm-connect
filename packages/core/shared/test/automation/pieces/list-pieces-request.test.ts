import {
    ListPiecesRequestQuery,
    PieceOrderBy,
    PieceSortBy,
} from '../../../src/lib/automation/pieces/dto/piece-requests'
import { PieceCategory } from '../../../src/lib/automation/pieces/piece'
import { ApEdition } from '../../../src/lib/core/flag/flag'

/**
 * Contract suite for GET /v1/integrations (issue #130).
 *
 * These params arrive as query strings, so the two things most likely to break
 * silently are (a) a query-string "false" being coerced to boolean true - which
 * would leak hidden/official pieces to a caller that asked to exclude them - and
 * (b) a limit boundary that quietly becomes an unbounded scan. Both are pinned
 * here against the parsed output rather than the raw string.
 */

type QueryInput = Record<string, string | string[] | undefined>

const parse = (query: QueryInput): ReturnType<typeof ListPiecesRequestQuery.safeParse> => ListPiecesRequestQuery.safeParse(query)

const parsed = (query: QueryInput): Record<string, unknown> => {
    const result = parse(query)
    if (!result.success) {
        throw new Error(`expected query to parse: ${JSON.stringify(query)}`)
    }
    return result.data
}

describe('ListPiecesRequestQuery — boolean flag coercion', () => {
    // The trap: Boolean('false') === true. A query-string "false" must stay false.
    it('treats the string "false" as false, not truthy', () => {
        expect(parsed({ includeHidden: 'false' }).includeHidden).toBe(false)
        expect(parsed({ includeTags: 'false' }).includeTags).toBe(false)
    })

    it('treats the string "true" as true', () => {
        expect(parsed({ includeHidden: 'true' }).includeHidden).toBe(true)
        expect(parsed({ includeTags: 'true' }).includeTags).toBe(true)
    })

    it('leaves an omitted flag undefined so the service default applies', () => {
        const result = parsed({})
        expect(result.includeHidden).toBeUndefined()
        expect(result.includeTags).toBeUndefined()
    })

    // Omitted and explicit-false are NOT the same request; conflating them is the bug.
    it('distinguishes omitted from an explicit false for both flags', () => {
        expect(parsed({}).includeHidden).not.toBe(parsed({ includeHidden: 'false' }).includeHidden)
        expect(parsed({}).includeTags).not.toBe(parsed({ includeTags: 'false' }).includeTags)
    })

    // Documents real behaviour rather than the ideal: an unrecognised value maps to
    // undefined, so the request behaves as if the flag were omitted instead of 400ing.
    // Worth pinning - a future change to reject these would alter the public contract.
    it('treats an unrecognised flag value as omitted rather than truthy or fatal', () => {
        expect(parsed({ includeHidden: 'yes' }).includeHidden).toBeUndefined()
        expect(parsed({ includeHidden: '0' }).includeHidden).toBeUndefined()
        expect(parsed({ includeTags: 'TRUE' }).includeTags).toBeUndefined()
    })

    it('keeps the two flags independent', () => {
        const result = parsed({ includeHidden: 'true', includeTags: 'false' })
        expect(result.includeHidden).toBe(true)
        expect(result.includeTags).toBe(false)
    })
})

describe('ListPiecesRequestQuery — limit boundaries', () => {
    it('accepts the documented lower and upper bounds', () => {
        expect(parsed({ limit: '1' }).limit).toBe(1)
        expect(parsed({ limit: '500' }).limit).toBe(500)
    })

    it('coerces a numeric query string to a number', () => {
        expect(typeof parsed({ limit: '25' }).limit).toBe('number')
    })

    it('rejects a limit below the minimum', () => {
        expect(parse({ limit: '0' }).success).toBe(false)
        expect(parse({ limit: '-5' }).success).toBe(false)
    })

    it('rejects a limit above the maximum', () => {
        expect(parse({ limit: '501' }).success).toBe(false)
    })

    it('rejects a non-integer limit', () => {
        expect(parse({ limit: '10.5' }).success).toBe(false)
    })

    it('rejects a non-numeric limit rather than falling back to unbounded', () => {
        expect(parse({ limit: 'many' }).success).toBe(false)
        expect(parse({ limit: '' }).success).toBe(false)
    })

    it('leaves an omitted limit undefined', () => {
        expect(parsed({}).limit).toBeUndefined()
    })
})

describe('ListPiecesRequestQuery — sort contract', () => {
    it('accepts every declared sort field', () => {
        for (const sortBy of Object.values(PieceSortBy)) {
            expect(parse({ sortBy }).success).toBe(true)
        }
    })

    it('accepts both order directions', () => {
        expect(parse({ orderBy: PieceOrderBy.ASC }).success).toBe(true)
        expect(parse({ orderBy: PieceOrderBy.DESC }).success).toBe(true)
    })

    it('rejects an unknown sort field or order', () => {
        expect(parse({ sortBy: 'NOT_A_FIELD' }).success).toBe(false)
        expect(parse({ orderBy: 'sideways' }).success).toBe(false)
    })

    it('is case-sensitive on the enum values, matching the API contract', () => {
        expect(parse({ sortBy: 'name' }).success).toBe(false)
        expect(parse({ sortBy: PieceSortBy.NAME }).success).toBe(true)
    })
})

describe('ListPiecesRequestQuery — cursor and filters', () => {
    it('accepts an opaque cursor string', () => {
        expect(parsed({ cursor: 'eyJpZCI6MX0=' }).cursor).toBe('eyJpZCI6MX0=')
    })

    // The cursor is an opaque string: no numeric or empty-string rejection happens.
    // Pinned so a future validation change is a deliberate decision, not a drift.
    it('treats numeric-looking and empty cursors as opaque strings', () => {
        expect(parsed({ cursor: '123' }).cursor).toBe('123')
        expect(parsed({ cursor: '' }).cursor).toBe('')
    })

    it('accepts a release version and rejects a malformed one', () => {
        expect(parse({ release: '1.2.3' }).success).toBe(true)
        expect(parse({ release: '^1.0.0' }).success).toBe(false)
        expect(parse({ release: 'latest' }).success).toBe(false)
    })

    it('accepts a known edition and rejects an unknown one', () => {
        expect(parse({ edition: ApEdition.CLOUD }).success).toBe(true)
        expect(parse({ edition: 'ULTIMATE_EDITION' }).success).toBe(false)
    })

    it('normalises a single categories value into an array', () => {
        expect(parsed({ categories: PieceCategory.ARTIFICIAL_INTELLIGENCE }).categories).toEqual([PieceCategory.ARTIFICIAL_INTELLIGENCE])
    })

    it('keeps a repeated categories value as an array', () => {
        expect(parsed({ categories: [PieceCategory.ARTIFICIAL_INTELLIGENCE, PieceCategory.SALES_AND_CRM] }).categories)
            .toEqual([PieceCategory.ARTIFICIAL_INTELLIGENCE, PieceCategory.SALES_AND_CRM])
    })
})