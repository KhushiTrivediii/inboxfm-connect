import { describe, expect, it } from 'vitest'
import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import {
    BranchExecutionType,
    CodeAction,
    emptyCondition,
    FlowAction,
    FlowActionType,
    LoopOnItemsAction,
    PieceAction,
    RouterAction,
} from '../../../src/lib/flows/actions/action'
import { FlowVersion, FlowVersionState } from '../../../src/lib/flows/flow-version'
import { _deleteAction } from '../../../src/lib/flows/operations/delete-action'
import { _moveAction } from '../../../src/lib/flows/operations/move-action'
import { _skipAction } from '../../../src/lib/flows/operations/skip-action'
import { FlowOperationType, StepLocationRelativeToParent } from '../../../src/lib/flows/operations'
import { EmptyTrigger, FlowTriggerType } from '../../../src/lib/flows/triggers/trigger'
import { flowStructureUtil } from '../../../src/lib/flows/util/flow-structure-util'

const createMockEmptyTrigger = (name = 'trigger', nextAction?: FlowAction): EmptyTrigger => ({
    name,
    valid: true,
    displayName: 'Empty Trigger',
    type: FlowTriggerType.EMPTY,
    settings: {},
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockCodeAction = (name: string, nextAction?: FlowAction): CodeAction => ({
    name,
    valid: true,
    displayName: `Action ${name}`,
    type: FlowActionType.CODE,
    settings: {
        sourceCode: { code: '', packageJson: '{}' },
        input: {},
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockPieceAction = (name: string, nextAction?: FlowAction): PieceAction => ({
    name,
    valid: true,
    displayName: `Piece ${name}`,
    type: FlowActionType.PIECE,
    settings: {
        pieceName: 'test-piece',
        pieceVersion: '1.0.0',
        propertySettings: {},
        input: {},
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockLoopAction = (name: string, firstLoopAction?: FlowAction, nextAction?: FlowAction): LoopOnItemsAction => ({
    name,
    valid: true,
    displayName: `Loop ${name}`,
    type: FlowActionType.LOOP_ON_ITEMS,
    settings: {
        items: '{{ [1, 2] }}',
    },
    firstLoopAction,
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockRouterAction = (name: string, children: (FlowAction | null)[], nextAction?: FlowAction): RouterAction => ({
    name,
    valid: true,
    displayName: `Router ${name}`,
    type: FlowActionType.ROUTER,
    settings: {
        branches: children.map((_, i) => ({
            branchName: `Branch ${i + 1}`,
            branchType: BranchExecutionType.CONDITION,
            conditions: [[emptyCondition]],
        })),
    },
    children,
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockFlowVersion = (trigger: EmptyTrigger): FlowVersion => ({
    id: 'fv_test',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    flowId: 'flow_test',
    displayName: 'Test Flow',
    trigger,
    valid: true,
    state: FlowVersionState.DRAFT,
    updatedBy: null,
    schemaVersion: '22',
    agentIds: [],
    connectionIds: [],
    backupFiles: null,
    notes: [],
})

describe('flow operations: delete, skip, and move', () => {
    describe('_deleteAction', () => {
        it('deletes an action from a linear chain and re-links neighbors', () => {
            const step3 = createMockCodeAction('step_3')
            const step2 = createMockCodeAction('step_2', step3)
            const step1 = createMockCodeAction('step_1', step2)
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const updated = _deleteAction(flow, { names: ['step_2'] })
            const allStepNames = flowStructureUtil.getAllSteps(updated.trigger).map((s) => s.name)

            expect(allStepNames).toEqual(['trigger', 'step_1', 'step_3'])
            expect(updated.trigger.nextAction?.name).toBe('step_1')
            expect(updated.trigger.nextAction?.nextAction?.name).toBe('step_3')
        })

        it('deletes the first action after the trigger and points trigger to next step', () => {
            const step2 = createMockCodeAction('step_2')
            const step1 = createMockCodeAction('step_1', step2)
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const updated = _deleteAction(flow, { names: ['step_1'] })
            const allStepNames = flowStructureUtil.getAllSteps(updated.trigger).map((s) => s.name)

            expect(allStepNames).toEqual(['trigger', 'step_2'])
            expect(updated.trigger.nextAction?.name).toBe('step_2')
        })

        it('deletes firstLoopAction inside a loop and re-links to its nextAction', () => {
            const loopChild2 = createMockCodeAction('loop_child_2')
            const loopChild1 = createMockCodeAction('loop_child_1', loopChild2)
            const loop = createMockLoopAction('loop', loopChild1)
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', loop))

            const updated = _deleteAction(flow, { names: ['loop_child_1'] })
            const updatedLoop = updated.trigger.nextAction as LoopOnItemsAction

            expect(updatedLoop.firstLoopAction?.name).toBe('loop_child_2')
        })

        it('deletes a router branch child and sets branch to its nextAction or null', () => {
            const branchChildWithNext = createMockCodeAction('branch_1_child_1', createMockCodeAction('branch_1_child_2'))
            const branchChildSolo = createMockCodeAction('branch_2_child')
            const router = createMockRouterAction('router', [branchChildWithNext, branchChildSolo])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            // Delete branch_1_child_1 -> branch 1 should now start with branch_1_child_2
            // Delete branch_2_child -> branch 2 should now be null
            const updated = _deleteAction(flow, { names: ['branch_1_child_1', 'branch_2_child'] })
            const updatedRouter = updated.trigger.nextAction as RouterAction

            expect(updatedRouter.children[0]?.name).toBe('branch_1_child_2')
            expect(updatedRouter.children[1]).toBeNull()
        })

        it('deletes continueOnFailure branches on piece actions', () => {
            const onSuccessAction = createMockCodeAction('success_step', createMockCodeAction('success_step_2'))
            const onFailureAction = createMockCodeAction('failure_step')
            const piece = createMockPieceAction('piece_1')
            piece.continueOnFailureBranches = {
                onSuccess: onSuccessAction,
                onFailure: onFailureAction,
            }
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', piece))

            const updated = _deleteAction(flow, { names: ['success_step', 'failure_step'] })
            const updatedPiece = updated.trigger.nextAction as PieceAction

            expect(updatedPiece.continueOnFailureBranches?.onSuccess?.name).toBe('success_step_2')
            expect(updatedPiece.continueOnFailureBranches?.onFailure).toBeUndefined()
        })

        it('silently ignores names that do not exist in the flow', () => {
            const step1 = createMockCodeAction('step_1')
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const updated = _deleteAction(flow, { names: ['non_existent'] })
            const allStepNames = flowStructureUtil.getAllSteps(updated.trigger).map((s) => s.name)
            expect(allStepNames).toEqual(['trigger', 'step_1'])
        })
    })

    describe('_skipAction', () => {
        it('sets skip property on targeted actions', () => {
            const step2 = createMockCodeAction('step_2')
            const step1 = createMockCodeAction('step_1', step2)
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const updated = _skipAction(flow, { names: ['step_1'], skip: true })
            expect((updated.trigger.nextAction as FlowAction).skip).toBe(true)
            expect((updated.trigger.nextAction?.nextAction as FlowAction).skip).toBeUndefined()

            const unskipped = _skipAction(updated, { names: ['step_1'], skip: false })
            expect((unskipped.trigger.nextAction as FlowAction).skip).toBe(false)
        })

        it('applies skip across multiple specified action names', () => {
            const step2 = createMockCodeAction('step_2')
            const step1 = createMockCodeAction('step_1', step2)
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const updated = _skipAction(flow, { names: ['step_1', 'step_2'], skip: true })
            expect((updated.trigger.nextAction as FlowAction).skip).toBe(true)
            expect((updated.trigger.nextAction?.nextAction as FlowAction).skip).toBe(true)
        })
    })

    describe('_moveAction', () => {
        it('generates DELETE_ACTION followed by ADD_ACTION with correct placement parameters', () => {
            const step2 = createMockCodeAction('step_2')
            const step1 = createMockCodeAction('step_1', step2)
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const ops = _moveAction(flow, {
                name: 'step_2',
                newParentStep: 'trigger',
                stepLocationRelativeToNewParent: StepLocationRelativeToParent.AFTER,
            })

            expect(ops).toHaveLength(2)
            expect(ops[0].type).toBe(FlowOperationType.DELETE_ACTION)
            expect(ops[0].request).toEqual({ names: ['step_2'] })

            expect(ops[1].type).toBe(FlowOperationType.ADD_ACTION)
            expect(ops[1].request).toMatchObject({
                parentStep: 'trigger',
                stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER,
                action: expect.objectContaining({ name: 'step_2' }),
            })
        })

        it('throws ENTITY_NOT_FOUND when source action does not exist', () => {
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger'))
            expect(() => _moveAction(flow, {
                name: 'non_existent',
                newParentStep: 'trigger',
                stepLocationRelativeToNewParent: StepLocationRelativeToParent.AFTER,
            })).toThrow(ActivepiecesError)
        })

        it('throws ENTITY_NOT_FOUND when newParentStep does not exist', () => {
            const step1 = createMockCodeAction('step_1')
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))
            expect(() => _moveAction(flow, {
                name: 'step_1',
                newParentStep: 'missing_parent',
                stepLocationRelativeToNewParent: StepLocationRelativeToParent.AFTER,
            })).toThrow(ActivepiecesError)
        })
    })
})
