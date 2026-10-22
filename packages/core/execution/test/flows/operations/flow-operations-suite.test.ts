import { describe, expect, it } from 'vitest'
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
import { _duplicateBranch, _duplicateStep } from '../../../src/lib/flows/operations/duplicate-step'
import { _moveBranch } from '../../../src/lib/flows/operations/move-branch'
import { _addBranch } from '../../../src/lib/flows/operations/add-branch'
import { _deleteBranch } from '../../../src/lib/flows/operations/delete-branch'
import { _updateAction } from '../../../src/lib/flows/operations/update-action'
import { _updateTrigger } from '../../../src/lib/flows/operations/update-trigger'
import { _updateSampleDataInfo } from '../../../src/lib/flows/operations/update-sample-data-info'
import { _getOperationsForPaste } from '../../../src/lib/flows/operations/paste-operations'
import { notesOperations } from '../../../src/lib/flows/operations/notes-operations'
import { FlowOperationType, StepLocationRelativeToParent } from '../../../src/lib/flows/operations'
import { EmptyTrigger, FlowTrigger, FlowTriggerType, PieceTrigger } from '../../../src/lib/flows/triggers/trigger'
import { Note } from '../../../src/lib/flows/note'

const createMockEmptyTrigger = (name = 'trigger', nextAction?: FlowAction): EmptyTrigger => ({
    name,
    valid: true,
    displayName: 'Empty Trigger',
    type: FlowTriggerType.EMPTY,
    settings: {},
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockPieceTrigger = (name = 'trigger', nextAction?: FlowAction): PieceTrigger => ({
    name,
    valid: true,
    displayName: 'Piece Trigger',
    type: FlowTriggerType.PIECE,
    settings: {
        pieceName: '@inboxfm-connect/piece-schedule',
        pieceVersion: '0.1.0',
        triggerName: 'cron',
        input: { cron: '0 0 * * *' },
        sampleData: { testKey: 'existing_data' },
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockCodeAction = (name: string, nextAction?: FlowAction): CodeAction => ({
    name,
    valid: true,
    displayName: `Action ${name}`,
    type: FlowActionType.CODE,
    settings: {
        sourceCode: { code: 'return 1;', packageJson: '{}' },
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

const createMockRouterAction = (name: string, branches = ['Branch 1', 'Branch 2'], children: (FlowAction | null)[] = [null, null]): RouterAction => ({
    name,
    valid: true,
    displayName: `Router ${name}`,
    type: FlowActionType.ROUTER,
    settings: {
        branches: branches.map((b, i) => ({
            branchName: b,
            branchType: i === branches.length - 1 && b === 'Fallback' ? BranchExecutionType.FALLBACK : BranchExecutionType.CONDITION,
            conditions: [[emptyCondition]],
        })),
    },
    children,
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
})

const createMockFlowVersion = (trigger: FlowTrigger = createMockEmptyTrigger(), notes: Note[] = []): FlowVersion => ({
    id: 'ver-123',
    flowId: 'flow-123',
    displayName: 'Test Flow',
    trigger,
    valid: true,
    state: FlowVersionState.DRAFT,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    notes,
})

describe('flow-operations-suite', () => {
    describe('_duplicateStep', () => {
        it('duplicates a simple step and emits ADD_ACTION after original', () => {
            const step1 = createMockCodeAction('step_1')
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const operations = _duplicateStep('step_1', flow)

            expect(operations.length).toBeGreaterThanOrEqual(1)
            const firstOp = operations[0]
            expect(firstOp.type).toBe(FlowOperationType.ADD_ACTION)
            expect(firstOp.request.parentStep).toBe('step_1')
            expect(firstOp.request.stepLocationRelativeToParent).toBe(StepLocationRelativeToParent.AFTER)
            expect(firstOp.request.action.name).not.toBe('step_1')
            expect(firstOp.request.action.type).toBe(FlowActionType.CODE)
        })

        it('clears nextAction on cloned root when duplicating a chained step', () => {
            const step2 = createMockCodeAction('step_2')
            const step1 = createMockCodeAction('step_1', step2)
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step1))

            const operations = _duplicateStep('step_1', flow)
            expect(operations[0].request.action.nextAction).toBeUndefined()
        })
    })

    describe('_duplicateBranch', () => {
        it('duplicates an empty branch on a router with updated name and conditions', () => {
            const router = createMockRouterAction('router_1', ['Alpha', 'Beta'], [null, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const operations = _duplicateBranch('router_1', 0, flow)

            expect(operations).toHaveLength(1)
            expect(operations[0].type).toBe(FlowOperationType.ADD_BRANCH)
            expect(operations[0].request).toEqual({
                branchName: 'Alpha Copy',
                branchIndex: 1,
                stepName: 'router_1',
                conditions: [[emptyCondition]],
            })
        })

        it('duplicates branch with child action and emits both ADD_BRANCH and ADD_ACTION inside branch', () => {
            const childAction = createMockCodeAction('step_in_branch')
            const router = createMockRouterAction('router_1', ['Branch A', 'Branch B'], [childAction, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const operations = _duplicateBranch('router_1', 0, flow)

            expect(operations.length).toBeGreaterThanOrEqual(2)
            expect(operations[0].type).toBe(FlowOperationType.ADD_BRANCH)
            expect(operations[0].request.branchIndex).toBe(1)
            expect(operations[0].request.branchName).toBe('Branch A Copy')

            expect(operations[1].type).toBe(FlowOperationType.ADD_ACTION)
            expect(operations[1].request.stepLocationRelativeToParent).toBe(StepLocationRelativeToParent.INSIDE_BRANCH)
            expect(operations[1].request.parentStep).toBe('router_1')
            expect(operations[1].request.branchIndex).toBe(1)
            expect(operations[1].request.action.name).not.toBe('step_in_branch')
        })

        it('omits conditions when duplicating a fallback branch', () => {
            const router = createMockRouterAction('router_1', ['Branch A', 'Fallback'], [null, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const operations = _duplicateBranch('router_1', 1, flow)

            expect(operations[0].type).toBe(FlowOperationType.ADD_BRANCH)
            expect(operations[0].request.conditions).toBeUndefined()
            expect(operations[0].request.branchName).toBe('Fallback Copy')
        })
    })

    describe('_moveBranch', () => {
        it('swaps branches and their child subflows in router settings and children', () => {
            const child1 = createMockCodeAction('child_1')
            const child2 = createMockCodeAction('child_2')
            const router = createMockRouterAction('router_1', ['First', 'Second', 'Third'], [child1, child2, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const updated = _moveBranch(flow, {
                stepName: 'router_1',
                sourceBranchIndex: 0,
                targetBranchIndex: 1,
            })

            const updatedRouter = updated.trigger.nextAction as RouterAction
            expect(updatedRouter.settings.branches.map(b => b.branchName)).toEqual(['Second', 'First', 'Third'])
            expect(updatedRouter.children.map(c => c?.name ?? null)).toEqual(['child_2', 'child_1', null])
        })

        it('returns unchanged flow when source and target indices are identical', () => {
            const router = createMockRouterAction('router_1', ['One', 'Two'], [null, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const updated = _moveBranch(flow, {
                stepName: 'router_1',
                sourceBranchIndex: 0,
                targetBranchIndex: 0,
            })

            expect(updated).toEqual(flow)
        })

        it('returns unchanged flow when indices are out of bounds or negative', () => {
            const router = createMockRouterAction('router_1', ['One', 'Two'], [null, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const updatedOut = _moveBranch(flow, {
                stepName: 'router_1',
                sourceBranchIndex: -1,
                targetBranchIndex: 1,
            })
            expect(updatedOut).toEqual(flow)

            const updatedTooHigh = _moveBranch(flow, {
                stepName: 'router_1',
                sourceBranchIndex: 0,
                targetBranchIndex: 5,
            })
            expect(updatedTooHigh).toEqual(flow)
        })

        it('returns unchanged flow when source or target branch is a fallback branch', () => {
            const router = createMockRouterAction('router_1', ['Normal', 'Fallback'], [null, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const updated = _moveBranch(flow, {
                stepName: 'router_1',
                sourceBranchIndex: 0,
                targetBranchIndex: 1,
            })

            expect(updated).toEqual(flow)
        })
    })

    describe('_addBranch & _deleteBranch', () => {
        it('_addBranch inserts branch and null child at specified index', () => {
            const router = createMockRouterAction('router_1', ['Branch 1', 'Branch 2'], [null, null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const updated = _addBranch(flow, {
                stepName: 'router_1',
                branchName: 'Inserted Branch',
                branchIndex: 1,
                conditions: [[emptyCondition]],
            })

            const updatedRouter = updated.trigger.nextAction as RouterAction
            expect(updatedRouter.settings.branches).toHaveLength(3)
            expect(updatedRouter.settings.branches[1].branchName).toBe('Inserted Branch')
            expect(updatedRouter.children).toHaveLength(3)
            expect(updatedRouter.children[1]).toBeNull()
        })

        it('_deleteBranch removes branch and child at specified index', () => {
            const child0 = createMockCodeAction('c0')
            const child1 = createMockCodeAction('c1')
            const router = createMockRouterAction('router_1', ['Branch 0', 'Branch 1'], [child0, child1])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const updated = _deleteBranch(flow, {
                stepName: 'router_1',
                branchIndex: 0,
            })

            const updatedRouter = updated.trigger.nextAction as RouterAction
            expect(updatedRouter.settings.branches).toHaveLength(1)
            expect(updatedRouter.settings.branches[0].branchName).toBe('Branch 1')
            expect(updatedRouter.children).toHaveLength(1)
            expect(updatedRouter.children[0]?.name).toBe('c1')
        })
    })

    describe('_updateAction', () => {
        it('updates code action properties and preserves sampleData & continueOnFailureBranches', () => {
            const action = createMockCodeAction('step_code')
            action.settings.sampleData = { test: 123 }
            action.continueOnFailureBranches = {
                onSuccess: createMockCodeAction('succ'),
            }
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', action))

            const updated = _updateAction(flow, {
                name: 'step_code',
                displayName: 'Updated Code Action',
                type: FlowActionType.CODE,
                settings: {
                    sourceCode: { code: 'return 42;', packageJson: '{}' },
                    input: { param: 'value' },
                },
                skip: true,
                valid: true,
            })

            const updatedAction = updated.trigger.nextAction as CodeAction
            expect(updatedAction.displayName).toBe('Updated Code Action')
            expect(updatedAction.skip).toBe(true)
            expect(updatedAction.settings.sourceCode.code).toBe('return 42;')
            expect(updatedAction.settings.sampleData).toEqual({ test: 123 })
            expect(updatedAction.continueOnFailureBranches?.onSuccess?.name).toBe('succ')
        })

        it('updates loop on items action and preserves firstLoopAction', () => {
            const loopAction: LoopOnItemsAction = {
                name: 'loop_step',
                displayName: 'Old Loop',
                type: FlowActionType.LOOP_ON_ITEMS,
                valid: true,
                settings: {
                    items: '[]',
                    sampleData: { currentItem: 'a' },
                },
                firstLoopAction: createMockCodeAction('inside_loop'),
                lastUpdatedDate: '2026-01-01T00:00:00.000Z',
            }
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', loopAction))

            const updated = _updateAction(flow, {
                name: 'loop_step',
                displayName: 'New Loop Display',
                type: FlowActionType.LOOP_ON_ITEMS,
                settings: {
                    items: '["item1", "item2"]',
                },
                valid: true,
            })

            const updatedLoop = updated.trigger.nextAction as LoopOnItemsAction
            expect(updatedLoop.displayName).toBe('New Loop Display')
            expect(updatedLoop.firstLoopAction?.name).toBe('inside_loop')
            expect(updatedLoop.settings.sampleData).toEqual({ currentItem: 'a' })
        })

        it('updates router action and preserves existing children', () => {
            const router = createMockRouterAction('router_1', ['Branch A', 'Branch B'], [createMockCodeAction('sub_1'), null])
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const updated = _updateAction(flow, {
                name: 'router_1',
                displayName: 'Updated Router',
                type: FlowActionType.ROUTER,
                settings: {
                    branches: [
                        { branchName: 'New Branch', branchType: BranchExecutionType.CONDITION, conditions: [[emptyCondition]] },
                    ],
                },
                valid: true,
            })

            const updatedRouter = updated.trigger.nextAction as RouterAction
            expect(updatedRouter.displayName).toBe('Updated Router')
            expect(updatedRouter.children[0]?.name).toBe('sub_1')
        })
    })

    describe('_updateTrigger', () => {
        it('updates empty trigger with new display name and preserves nextAction', () => {
            const nextAction = createMockCodeAction('after_trigger')
            const trigger = createMockEmptyTrigger('trigger', nextAction)
            const flow = createMockFlowVersion(trigger)

            const updated = _updateTrigger(flow, {
                name: 'trigger',
                displayName: 'Brand New Trigger Name',
                type: FlowTriggerType.EMPTY,
                settings: {},
                valid: true,
            })

            expect(updated.trigger.displayName).toBe('Brand New Trigger Name')
            expect(updated.trigger.nextAction?.name).toBe('after_trigger')
            expect(updated.trigger.valid).toBe(true)
        })

        it('updates piece trigger and preserves existing sampleData', () => {
            const trigger = createMockPieceTrigger('piece_trigger')
            const flow = createMockFlowVersion(trigger)

            const updated = _updateTrigger(flow, {
                name: 'piece_trigger',
                displayName: 'Updated Piece Trigger',
                type: FlowTriggerType.PIECE,
                settings: {
                    pieceName: '@inboxfm-connect/piece-schedule',
                    pieceVersion: '0.2.0',
                    triggerName: 'cron',
                    input: { cron: '*/5 * * * *' },
                },
                valid: true,
            })

            const updatedPieceTrigger = updated.trigger as PieceTrigger
            expect(updatedPieceTrigger.settings.pieceVersion).toBe('0.2.0')
            expect(updatedPieceTrigger.settings.sampleData).toEqual({ testKey: 'existing_data' })
        })
    })

    describe('_updateSampleDataInfo', () => {
        it('updates step sampleDataSettings and sets lastTestDate', () => {
            const step = createMockCodeAction('step_code')
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step))

            const updated = _updateSampleDataInfo(flow, {
                stepName: 'step_code',
                sampleDataSettings: {
                    currentSelectedData: { result: 'ok' },
                },
            })

            const updatedStep = updated.trigger.nextAction as CodeAction
            expect(updatedStep.settings.sampleData?.currentSelectedData).toEqual({ result: 'ok' })
            expect(updatedStep.settings.sampleData?.lastTestDate).toBeDefined()
        })

        it('clears sampleData when sampleDataSettings is undefined', () => {
            const step = createMockCodeAction('step_code')
            step.settings.sampleData = { currentSelectedData: { old: 'data' } }
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', step))

            const updated = _updateSampleDataInfo(flow, {
                stepName: 'step_code',
                sampleDataSettings: undefined,
            })

            const updatedStep = updated.trigger.nextAction as CodeAction
            expect(updatedStep.settings.sampleData).toBeUndefined()
        })
    })

    describe('_getOperationsForPaste', () => {
        it('chains operations correctly when pasting multiple actions outside branch', () => {
            const act1 = createMockCodeAction('copy_1')
            const act2 = createMockPieceAction('copy_2')
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger'))

            const ops = _getOperationsForPaste([act1, act2], flow, {
                parentStepName: 'trigger',
                stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER,
            })

            expect(ops.length).toBeGreaterThanOrEqual(2)
            expect(ops[0].type).toBe(FlowOperationType.ADD_ACTION)
            expect(ops[0].request.parentStep).toBe('trigger')
            expect(ops[0].request.stepLocationRelativeToParent).toBe(StepLocationRelativeToParent.AFTER)

            expect(ops[1].type).toBe(FlowOperationType.ADD_ACTION)
            expect(ops[1].request.parentStep).toBe(ops[0].request.action.name)
            expect(ops[1].request.stepLocationRelativeToParent).toBe(StepLocationRelativeToParent.AFTER)
        })

        it('sets INSIDE_BRANCH and branchIndex when pasting into a branch', () => {
            const act = createMockCodeAction('copy_branch')
            const router = createMockRouterAction('router_1')
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger', router))

            const ops = _getOperationsForPaste([act], flow, {
                parentStepName: 'router_1',
                stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_BRANCH,
                branchIndex: 0,
            })

            expect(ops[0].type).toBe(FlowOperationType.ADD_ACTION)
            expect(ops[0].request.parentStep).toBe('router_1')
            expect(ops[0].request.stepLocationRelativeToParent).toBe(StepLocationRelativeToParent.INSIDE_BRANCH)
            expect(ops[0].request.branchIndex).toBe(0)
        })
    })

    describe('notesOperations', () => {
        it('adds a note with createdAt and updatedAt timestamps', () => {
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger'), [])

            const updated = notesOperations.addNote(flow, {
                id: 'note-1',
                content: 'Important documentation note',
                x: 100,
                y: 200,
                height: 150,
                width: 250,
                color: '#fff',
            })

            expect(updated.notes).toHaveLength(1)
            expect(updated.notes[0].id).toBe('note-1')
            expect(updated.notes[0].content).toBe('Important documentation note')
            expect(updated.notes[0].createdAt).toBeDefined()
            expect(updated.notes[0].updatedAt).toBeDefined()
        })

        it('updates an existing note and refreshes its updatedAt timestamp', () => {
            const existingNote: Note = {
                id: 'note-1',
                content: 'Old content',
                x: 10,
                y: 20,
                height: 50,
                width: 50,
                color: '#aaa',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger'), [existingNote])

            const updated = notesOperations.updateNote(flow, {
                id: 'note-1',
                content: 'Refreshed content',
            })

            expect(updated.notes[0].content).toBe('Refreshed content')
            expect(updated.notes[0].x).toBe(10)
            expect(updated.notes[0].updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
        })

        it('deletes an existing note by id', () => {
            const note1: Note = {
                id: 'n1',
                content: 'first',
                x: 0,
                y: 0,
                height: 10,
                width: 10,
                color: '#111',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }
            const note2: Note = {
                id: 'n2',
                content: 'second',
                x: 0,
                y: 0,
                height: 10,
                width: 10,
                color: '#222',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }
            const flow = createMockFlowVersion(createMockEmptyTrigger('trigger'), [note1, note2])

            const updated = notesOperations.deleteNote(flow, { id: 'n1' })

            expect(updated.notes).toHaveLength(1)
            expect(updated.notes[0].id).toBe('n2')
        })
    })
})
