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
import { EmptyTrigger, FlowTriggerType } from '../../../src/lib/flows/triggers/trigger'
import {
    FLOW_CANVAS_HSPACE,
    FLOW_CANVAS_STEP_HEIGHT,
    FLOW_CANVAS_STEP_WIDTH,
    FLOW_CANVAS_VSPACE,
    flowCanvasUtils,
} from '../../../src/lib/flows/util/flow-canvas-util'

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
    displayName: 'Code Action',
    type: FlowActionType.CODE,
    settings: {
        sourceCode: { code: '', packageJson: '{}' },
        input: {},
        errorHandlingOptions: {
            continueOnFailure: { value: false },
        },
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockPieceActionWithContinue = (
    name: string,
    continueOnFailure = true,
    branches?: { onSuccess?: FlowAction, onFailure?: FlowAction },
): PieceAction => ({
    name,
    valid: true,
    displayName: 'Piece Action',
    type: FlowActionType.PIECE,
    settings: {
        pieceName: 'piece-http',
        pieceVersion: '1.0.0',
        propertySettings: {},
        input: {},
        errorHandlingOptions: {
            continueOnFailure: { value: continueOnFailure },
        },
    },
    continueOnFailureBranches: branches,
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
})

const createMockLoopAction = (name: string, firstLoopAction?: FlowAction, nextAction?: FlowAction): LoopOnItemsAction => ({
    name,
    valid: true,
    displayName: 'Loop Action',
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
    displayName: 'Router Action',
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

describe('flowCanvasUtils', () => {
    describe('hasContinueOnFailureBranches', () => {
        it('returns true when CODE or PIECE action has continueOnFailure.value = true', () => {
            const piece = createMockPieceActionWithContinue('piece_1', true)
            expect(flowCanvasUtils.hasContinueOnFailureBranches(piece)).toBe(true)

            const code = createMockCodeAction('code_1')
            code.settings.errorHandlingOptions = { continueOnFailure: { value: true } }
            expect(flowCanvasUtils.hasContinueOnFailureBranches(code)).toBe(true)
        })

        it('returns false when continueOnFailure is false or absent', () => {
            const piece = createMockPieceActionWithContinue('piece_1', false)
            expect(flowCanvasUtils.hasContinueOnFailureBranches(piece)).toBe(false)

            const code = createMockCodeAction('code_1')
            code.settings.errorHandlingOptions = undefined
            expect(flowCanvasUtils.hasContinueOnFailureBranches(code)).toBe(false)
        })

        it('returns false for LOOP and ROUTER action types', () => {
            const loop = createMockLoopAction('loop_1')
            expect(flowCanvasUtils.hasContinueOnFailureBranches(loop)).toBe(false)

            const router = createMockRouterAction('router_1', [])
            expect(flowCanvasUtils.hasContinueOnFailureBranches(router)).toBe(false)
        })
    })

    describe('getContinueOnFailureBranchPair', () => {
        it('returns [onSuccess, onFailure] from continueOnFailureBranches', () => {
            const successAction = createMockCodeAction('success_step')
            const failureAction = createMockCodeAction('failure_step')
            const piece = createMockPieceActionWithContinue('piece_1', true, {
                onSuccess: successAction,
                onFailure: failureAction,
            })

            const [onSuccess, onFailure] = flowCanvasUtils.getContinueOnFailureBranchPair(piece)
            expect(onSuccess?.name).toBe('success_step')
            expect(onFailure?.name).toBe('failure_step')
        })

        it('returns [undefined, undefined] when continueOnFailureBranches is not set', () => {
            const piece = createMockPieceActionWithContinue('piece_1', true)
            const [onSuccess, onFailure] = flowCanvasUtils.getContinueOnFailureBranchPair(piece)
            expect(onSuccess).toBeUndefined()
            expect(onFailure).toBeUndefined()
        })
    })

    describe('getStepBranchRelativeTo', () => {
        it('returns "on-success" when target is in the onSuccess branch', () => {
            const successAction = createMockCodeAction('success_step')
            const piece = createMockPieceActionWithContinue('ancestor', true, {
                onSuccess: successAction,
            })

            expect(flowCanvasUtils.getStepBranchRelativeTo(piece, 'success_step')).toBe('on-success')
        })

        it('returns "on-failure" when target is in the onFailure branch', () => {
            const failureAction = createMockCodeAction('failure_step')
            const piece = createMockPieceActionWithContinue('ancestor', true, {
                onFailure: failureAction,
            })

            expect(flowCanvasUtils.getStepBranchRelativeTo(piece, 'failure_step')).toBe('on-failure')
        })

        it('returns null when ancestor does not have continueOnFailure enabled or target is not in branches', () => {
            const piece = createMockPieceActionWithContinue('ancestor', false)
            expect(flowCanvasUtils.getStepBranchRelativeTo(piece, 'any_step')).toBeNull()

            const pieceWithBranches = createMockPieceActionWithContinue('ancestor', true, {
                onSuccess: createMockCodeAction('other'),
            })
            expect(flowCanvasUtils.getStepBranchRelativeTo(pieceWithBranches, 'missing')).toBeNull()
        })
    })

    describe('computeRouterChildOffsets', () => {
        it('returns empty array when boundingBoxes is empty', () => {
            expect(flowCanvasUtils.computeRouterChildOffsets([])).toEqual([])
        })

        it('centers a single child at its left dimension', () => {
            const bboxes = [{ width: 232, left: 116, right: 116 }]
            const offsets = flowCanvasUtils.computeRouterChildOffsets(bboxes)
            expect(offsets).toHaveLength(1)
            expect(offsets[0]).toBe(0)
        })

        it('computes symmetric offsets for two equal-width children', () => {
            const bboxes = [
                { width: 200, left: 100, right: 100 },
                { width: 200, left: 100, right: 100 },
            ]
            const offsets = flowCanvasUtils.computeRouterChildOffsets(bboxes, 80)
            expect(offsets).toHaveLength(2)
            // Left child and right child must be symmetric around x=0 with distinct positions
            expect(offsets[0]).toBeLessThan(0)
            expect(offsets[1]).toBeGreaterThan(0)
            expect(offsets[0]).toBeCloseTo(-offsets[1], 5)
            expect(offsets[0]).toBeCloseTo(-140, 5)
            expect(offsets[1]).toBeCloseTo(140, 5)
        })
    })

    describe('computeStepPositions', () => {
        it('computes center position for a single trigger', () => {
            const trigger = createMockEmptyTrigger('trigger')
            const positions = flowCanvasUtils.computeStepPositions(trigger)

            expect(positions.has('trigger')).toBe(true)
            const trigPos = positions.get('trigger')!
            expect(trigPos.x).toBe(FLOW_CANVAS_STEP_WIDTH / 2)
            expect(trigPos.y).toBe(0)
        })

        it('positions linear sequence of steps down the Y axis', () => {
            const action1 = createMockCodeAction('step_1')
            const action2 = createMockCodeAction('step_2')
            action1.nextAction = action2
            const trigger = createMockEmptyTrigger('trigger', action1)

            const positions = flowCanvasUtils.computeStepPositions(trigger)
            expect(positions.has('trigger')).toBe(true)
            expect(positions.has('step_1')).toBe(true)
            expect(positions.has('step_2')).toBe(true)

            const trigPos = positions.get('trigger')!
            const step1Pos = positions.get('step_1')!
            const step2Pos = positions.get('step_2')!

            // X coordinates are all aligned on the center axis
            expect(step1Pos.x).toBe(trigPos.x)
            expect(step2Pos.x).toBe(trigPos.x)

            // Y coordinates increase monotonically
            expect(step1Pos.y).toBe(trigPos.y + FLOW_CANVAS_STEP_HEIGHT + FLOW_CANVAS_VSPACE)
            expect(step2Pos.y).toBe(step1Pos.y + FLOW_CANVAS_STEP_HEIGHT + FLOW_CANVAS_VSPACE)
        })

        it('positions loop items and resumes subsequent steps after loop subgraph', () => {
            const loopChild = createMockCodeAction('loop_child')
            const postLoop = createMockCodeAction('post_loop')
            const loopAction = createMockLoopAction('loop', loopChild, postLoop)
            const trigger = createMockEmptyTrigger('trigger', loopAction)

            const positions = flowCanvasUtils.computeStepPositions(trigger)
            expect(positions.has('trigger')).toBe(true)
            expect(positions.has('loop')).toBe(true)
            expect(positions.has('loop_child')).toBe(true)
            expect(positions.has('post_loop')).toBe(true)

            const loopPos = positions.get('loop')!
            const postLoopPos = positions.get('post_loop')!

            // Post-loop step is positioned below the entire loop body
            expect(postLoopPos.y).toBeGreaterThan(loopPos.y)
        })

        it('positions router branches and aligns post-router step below tallest branch', () => {
            const branch1Child = createMockCodeAction('branch_1')
            const branch2Child = createMockCodeAction('branch_2')
            const postRouter = createMockCodeAction('post_router')
            const router = createMockRouterAction('router', [branch1Child, branch2Child], postRouter)
            const trigger = createMockEmptyTrigger('trigger', router)

            const positions = flowCanvasUtils.computeStepPositions(trigger)
            expect(positions.has('router')).toBe(true)
            expect(positions.has('branch_1')).toBe(true)
            expect(positions.has('branch_2')).toBe(true)
            expect(positions.has('post_router')).toBe(true)

            const b1Pos = positions.get('branch_1')!
            const b2Pos = positions.get('branch_2')!
            const postPos = positions.get('post_router')!

            // Branches are spread horizontally
            expect(b1Pos.x).toBeLessThan(b2Pos.x)
            // Post router is below branches
            expect(postPos.y).toBeGreaterThan(b1Pos.y)
        })
    })
})
