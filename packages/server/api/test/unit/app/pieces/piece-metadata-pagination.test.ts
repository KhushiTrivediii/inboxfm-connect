import { PieceMetadataModelSummary } from '@inboxfm-connect/pieces-framework'
import { describe, expect, it } from 'vitest'
import { pieceMetadataTesting } from '../../../../src/app/pieces/metadata/piece-metadata-controller'
import { createMockPieceMetadata } from '../../../helpers/mocks'

const {
    computeQueryFingerprint,
    paginatePieces,
    encodePieceCursor,
    decodePieceCursor,
    normalizeBooleanFlag,
} = pieceMetadataTesting

function createSummaryList(count: number, prefix = 'piece'): PieceMetadataModelSummary[] {
    return Array.from({ length: count }, (_, i) => {
        const mock = createMockPieceMetadata({
            name: `${prefix}-${String(i).padStart(3, '0')}`,
            displayName: `Piece ${i}`,
        })
        return {
            ...mock,
            i18n: undefined,
        }
    })
}

describe('normalizeBooleanFlag', () => {
    it('returns false for undefined, null, empty string, false, and the string "false"', () => {
        expect(normalizeBooleanFlag(undefined)).toBe(false)
        expect(normalizeBooleanFlag(null)).toBe(false)
        expect(normalizeBooleanFlag('')).toBe(false)
        expect(normalizeBooleanFlag(false)).toBe(false)
        expect(normalizeBooleanFlag('false')).toBe(false)
        expect(normalizeBooleanFlag('0')).toBe(false)
    })

    it('returns true for boolean true and the string "true"', () => {
        expect(normalizeBooleanFlag(true)).toBe(true)
        expect(normalizeBooleanFlag('true')).toBe(true)
    })
})

describe('computeQueryFingerprint — Boolean("false") fix and normalization matrix', () => {
    it('treats "false" identically to false and omitted flags, fixing the Boolean("false") bug', () => {
        const hashOmitted = computeQueryFingerprint({})
        const hashExplicitFalse = computeQueryFingerprint({ includeHidden: false, includeTags: false })
        const hashStringFalse = computeQueryFingerprint({ includeHidden: 'false', includeTags: 'false' })

        expect(hashExplicitFalse).toBe(hashOmitted)
        expect(hashStringFalse).toBe(hashOmitted)
    })

    it('distinguishes "false" from "true" for includeHidden and includeTags', () => {
        const hashHiddenFalse = computeQueryFingerprint({ includeHidden: 'false' })
        const hashHiddenTrue = computeQueryFingerprint({ includeHidden: 'true' })
        const hashTagsFalse = computeQueryFingerprint({ includeTags: 'false' })
        const hashTagsTrue = computeQueryFingerprint({ includeTags: 'true' })

        expect(hashHiddenFalse).not.toBe(hashHiddenTrue)
        expect(hashTagsFalse).not.toBe(hashTagsTrue)
    })

    it('produces identical fingerprints across the full 3x3 matrix of omitted vs false vs "false"', () => {
        const falseyValues = [undefined, false, 'false']
        const baseHash = computeQueryFingerprint({})

        for (const hiddenVal of falseyValues) {
            for (const tagsVal of falseyValues) {
                const query: Record<string, unknown> = {}
                if (hiddenVal !== undefined) query.includeHidden = hiddenVal
                if (tagsVal !== undefined) query.includeTags = tagsVal

                const hash = computeQueryFingerprint(query)
                expect(hash).toBe(baseHash)
            }
        }
    })

    it('normalizes boolean true and string "true" to the identical fingerprint', () => {
        const hashBoolTrue = computeQueryFingerprint({ includeHidden: true, includeTags: false })
        const hashStringTrue = computeQueryFingerprint({ includeHidden: 'true', includeTags: 'false' })

        expect(hashBoolTrue).toBe(hashStringTrue)

        const hashBothBool = computeQueryFingerprint({ includeHidden: true, includeTags: true })
        const hashBothString = computeQueryFingerprint({ includeHidden: 'true', includeTags: 'true' })

        expect(hashBothBool).toBe(hashBothString)
    })

    it('returns empty string when query is undefined', () => {
        expect(computeQueryFingerprint(undefined)).toBe('')
    })

    it('differentiates fingerprints when query parameters change', () => {
        const base = computeQueryFingerprint({ sortBy: 'NAME', orderBy: 'ASC' })
        const descSort = computeQueryFingerprint({ sortBy: 'NAME', orderBy: 'DESC' })
        const otherSort = computeQueryFingerprint({ sortBy: 'CREATED', orderBy: 'ASC' })
        const withSearch = computeQueryFingerprint({ sortBy: 'NAME', orderBy: 'ASC', searchQuery: 'slack' })

        expect(descSort).not.toBe(base)
        expect(otherSort).not.toBe(base)
        expect(withSearch).not.toBe(base)
    })

    it('produces identical fingerprints regardless of categories array ordering', () => {
        const hash1 = computeQueryFingerprint({ categories: ['COMMUNICATION', 'MARKETING'] })
        const hash2 = computeQueryFingerprint({ categories: ['MARKETING', 'COMMUNICATION'] })

        expect(hash1).toBe(hash2)
    })
})

describe('decodePieceCursor / encodePieceCursor', () => {
    it('encodes and decodes valid cursor payload correctly', () => {
        const payload = { name: 'piece-005', index: 5, queryHash: 'someHash123' }
        const encoded = encodePieceCursor(payload)
        const decoded = decodePieceCursor(encoded)

        expect(decoded).toEqual(payload)
    })

    it('returns null for invalid base64 or non-JSON payloads', () => {
        expect(decodePieceCursor('not-valid-base64-!@#$')).toBeNull()
        expect(decodePieceCursor(Buffer.from('plain-text-not-json').toString('base64'))).toBeNull()
        expect(decodePieceCursor(Buffer.from(JSON.stringify({ notName: 123 })).toString('base64'))).toBeNull()
    })
})

describe('paginatePieces — cursor replay, sort changes, and catalog mutation', () => {
    it('restarts at first page if cursor queryHash differs from current query (e.g. ASC to DESC)', () => {
        const piecesAsc = createSummaryList(10, 'asc')
        const piecesDesc = [...piecesAsc].reverse()

        const queryAsc = { sortBy: 'NAME', orderBy: 'ASC' }
        const queryDesc = { sortBy: 'NAME', orderBy: 'DESC' }

        // Fetch page 1 of ASC
        const page1Asc = paginatePieces(piecesAsc, undefined, 3, queryAsc)
        expect(page1Asc.next).not.toBeNull()

        // Replay ASC cursor on DESC query -> queryHash mismatch -> restarts at page 1 of DESC
        const restartedPage = paginatePieces(piecesDesc, page1Asc.next!, 3, queryDesc)
        expect(restartedPage.data[0].name).toBe(piecesDesc[0].name)
        expect(restartedPage.previous).toBeNull()
    })

    it('stably continues pagination when catalog mutates and anchor piece shifts index (Scenario A)', () => {
        // Original catalog: piece-000, piece-001, piece-002, piece-003, piece-004
        const originalPieces = createSummaryList(5, 'orig')

        // Page 1: returns piece-000, piece-001. Next cursor is anchored to piece-001 (index 1)
        const page1 = paginatePieces(originalPieces, undefined, 2, {})
        expect(page1.data.map((p) => p.name)).toEqual(['orig-000', 'orig-001'])
        expect(page1.next).not.toBeNull()

        // Catalog mutates: 2 new pieces inserted at the beginning
        const newPieces = createSummaryList(2, 'new')
        const mutatedCatalog = [...newPieces, ...originalPieces]
        // In mutatedCatalog, orig-001 is now at index 3 instead of index 1

        // Calling with page 1's cursor locates orig-001 by name and returns subsequent items
        const page2 = paginatePieces(mutatedCatalog, page1.next!, 2, {})
        expect(page2.data.map((p) => p.name)).toEqual(['orig-002', 'orig-003'])
        expect(page2.data[0].name).toBe('orig-002')
    })

    it('falls back safely to first page when anchor piece was deleted from catalog (Scenario B)', () => {
        const pieces = createSummaryList(5, 'item')

        // Fabricate a cursor anchored to a deleted piece
        const currentHash = computeQueryFingerprint({})
        const deletedCursor = encodePieceCursor({
            name: 'deleted-piece-that-no-longer-exists',
            index: 2,
            queryHash: currentHash,
        })
        const afterCursorString = Buffer.from(JSON.stringify({ after: deletedCursor })).toString('base64')

        // Does not crash or return empty; gracefully falls back to page 1
        const fallbackPage = paginatePieces(pieces, afterCursorString, 2, {})
        expect(fallbackPage.data.map((p) => p.name)).toEqual(['item-000', 'item-001'])
    })

    it('clamps limit to maximum 500 and minimum 1 when raw limit is given', () => {
        const pieces = createSummaryList(10, 'clamp')

        const pageMin = paginatePieces(pieces, undefined, -10, {})
        expect(pageMin.data.length).toBe(1)

        const pageMax = paginatePieces(pieces, undefined, 9999, {})
        expect(pageMax.data.length).toBe(10)
    })
})
