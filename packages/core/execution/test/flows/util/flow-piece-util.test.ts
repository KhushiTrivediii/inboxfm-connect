import { describe, expect, it } from 'vitest'
import { FlowActionType, PieceAction } from '../../../src/lib/flows/actions/action'
import { EmptyTrigger, FlowTriggerType, PieceTrigger } from '../../../src/lib/flows/triggers/trigger'
import { flowPieceUtil } from '../../../src/lib/flows/util/flow-piece-util'

const createMockEmptyTrigger = (name: string): EmptyTrigger => ({
    name,
    valid: true,
    displayName: 'Empty Trigger',
    type: FlowTriggerType.EMPTY,
    settings: {},
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
})

const createMockPieceTrigger = (name: string, pieceName: string): PieceTrigger => ({
    name,
    valid: true,
    displayName: 'Piece Trigger',
    type: FlowTriggerType.PIECE,
    settings: {
        pieceName,
        pieceVersion: '1.2.3',
        propertySettings: {},
        input: {},
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
})

const createMockPieceAction = (name: string, pieceName: string, nextAction?: any): PieceAction => ({
    name,
    valid: true,
    displayName: 'Piece Action',
    type: FlowActionType.PIECE,
    settings: {
        pieceName,
        pieceVersion: '0.5.0',
        propertySettings: {},
        input: {},
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

describe('flowPieceUtil', () => {
    describe('getExactVersion', () => {
        it('strips caret prefix from version', () => {
            expect(flowPieceUtil.getExactVersion('^1.2.3')).toBe('1.2.3')
            expect(flowPieceUtil.getExactVersion('^0.0.1')).toBe('0.0.1')
        })

        it('strips tilde prefix from version', () => {
            expect(flowPieceUtil.getExactVersion('~2.4.0')).toBe('2.4.0')
            expect(flowPieceUtil.getExactVersion('~0.1.0-alpha')).toBe('0.1.0-alpha')
        })

        it('returns exact version unchanged when no prefix exists', () => {
            expect(flowPieceUtil.getExactVersion('1.0.0')).toBe('1.0.0')
            expect(flowPieceUtil.getExactVersion('3.14.159')).toBe('3.14.159')
        })
    })

    describe('getUsedPieces', () => {
        it('returns empty array when trigger is EMPTY and has no actions', () => {
            const trigger = createMockEmptyTrigger('empty_trig')
            expect(flowPieceUtil.getUsedPieces(trigger)).toEqual([])
        })

        it('returns piece from PieceTrigger', () => {
            const trigger = createMockPieceTrigger('webhook_trig', '@inboxfm-connect/piece-webhook')
            expect(flowPieceUtil.getUsedPieces(trigger)).toEqual(['@inboxfm-connect/piece-webhook'])
        })

        it('collects all piece names from trigger and chained piece actions', () => {
            const action2 = createMockPieceAction('step_2', '@inboxfm-connect/piece-slack')
            const action1 = createMockPieceAction('step_1', '@inboxfm-connect/piece-gmail', action2)
            const trigger = createMockPieceTrigger('trig', '@inboxfm-connect/piece-schedule')
            trigger.nextAction = action1

            const usedPieces = flowPieceUtil.getUsedPieces(trigger)
            expect(usedPieces).toEqual([
                '@inboxfm-connect/piece-schedule',
                '@inboxfm-connect/piece-gmail',
                '@inboxfm-connect/piece-slack',
            ])
        })
    })
})
