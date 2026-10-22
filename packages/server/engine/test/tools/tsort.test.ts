import { PiecePropertyMap } from '@inboxfm-connect/pieces-framework'
import { tsort } from '../../src/lib/tools/tsort'

const buildProps = (props: Record<string, { refreshers?: string[] }>): PiecePropertyMap => props as unknown as PiecePropertyMap

describe('tsort', () => {
    it('orders properties by refresher depth', () => {
        const result = tsort.sortPropertiesByDependencies(buildProps({
            a: { refreshers: ['d'] },
            d: {},
        }))

        expect(result).toEqual({
            0: ['d'],
            1: ['a'],
        })
    })

    it('keeps properties that are part of a refresher cycle instead of dropping them', () => {
        const result = tsort.sortPropertiesByDependencies(buildProps({
            a: { refreshers: ['b'] },
            b: { refreshers: ['a'] },
            c: {},
        }))

        // The cycle (a <-> b) previously vanished from the output entirely, so
        // neither property was ever extracted for the tool input.
        const names = Object.values(result).flat().sort()
        expect(names).toEqual(['a', 'b', 'c'])

        // Cycle members must come after every acyclic depth.
        const depths = Object.keys(result).map(Number)
        const cycleDepth = Math.max(...depths)
        expect(result[cycleDepth].sort()).toEqual(['a', 'b'])
    })

    it('keeps properties downstream of a refresher cycle', () => {
        const result = tsort.sortPropertiesByDependencies(buildProps({
            a: { refreshers: ['b'] },
            b: { refreshers: ['a'] },
            c: { refreshers: ['b'] },
            d: {},
        }))

        const names = Object.values(result).flat().sort()
        expect(names).toEqual(['a', 'b', 'c', 'd'])
    })

    it('keeps a property that refreshes itself', () => {
        const result = tsort.sortPropertiesByDependencies(buildProps({
            a: { refreshers: ['a'] },
        }))

        expect(Object.values(result).flat()).toEqual(['a'])
    })
})
