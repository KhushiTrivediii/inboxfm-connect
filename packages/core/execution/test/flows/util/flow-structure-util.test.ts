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
import { EmptyTrigger, FlowTrigger, FlowTriggerType, PieceTrigger } from '../../../src/lib/flows/triggers/trigger'
import { AI_PIECE_NAME, flowStructureUtil } from '../../../src/lib/flows/util/flow-structure-util'

const createMockEmptyTrigger = (name = 'trigger', nextAction?: FlowAction): EmptyTrigger => ({
    name,
    valid: true,
    displayName: 'Empty Trigger',
    type: FlowTriggerType.EMPTY,
    settings: {},
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockPieceTrigger = (name: string, pieceName: string, auth?: string, nextAction?: FlowAction): PieceTrigger => ({
    name,
    valid: true,
    displayName: 'Piece Trigger',
    type: FlowTriggerType.PIECE,
    settings: {
        pieceName,
        pieceVersion: '1.0.0',
        propertySettings: {},
        input: auth ? { auth } : {},
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockCodeAction = (name: string, nextAction?: FlowAction): CodeAction => ({
    name,
    valid: true,
    displayName: 'Code Action',
    type: FlowActionType.CODE,
    settings: {
        sourceCode: { code: 'console.log()', packageJson: '{}' },
        input: {},
        errorHandlingOptions: {
            continueOnFailure: { value: false },
        },
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockPieceAction = (name: string, pieceName: string, input: Record<string, any> = {}, nextAction?: FlowAction): PieceAction => ({
    name,
    valid: true,
    displayName: 'Piece Action',
    type: FlowActionType.PIECE,
    settings: {
        pieceName,
        pieceVersion: '1.0.0',
        propertySettings: {},
        input,
        errorHandlingOptions: {
            continueOnFailure: { value: false },
        },
    },
    lastUpdatedDate: '2026-01-01T00:00:00.000Z',
    nextAction,
})

const createMockLoopAction = (name: string, firstLoopAction?: FlowAction, nextAction?: FlowAction): LoopOnItemsAction => ({
    name,
    valid: true,
    displayName: 'Loop Action',
    type: FlowActionType.LOOP_ON_ITEMS,
    settings: {
        items: '{{ [1, 2, 3] }}',
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

describe('flowStructureUtil', () => {
    describe('isTrigger and isAction guards', () => {
        it('correctly identifies trigger types', () => {
            expect(flowStructureUtil.isTrigger(FlowTriggerType.EMPTY)).toBe(true)
            expect(flowStructureUtil.isTrigger(FlowTriggerType.PIECE)).toBe(true)
            expect(flowStructureUtil.isTrigger(FlowActionType.CODE as any)).toBe(false)
            expect(flowStructureUtil.isTrigger(undefined)).toBe(false)
            expect(flowStructureUtil.isTrigger('UNKNOWN' as any)).toBe(false)
        })

        it('correctly identifies action types', () => {
            expect(flowStructureUtil.isAction(FlowActionType.CODE)).toBe(true)
            expect(flowStructureUtil.isAction(FlowActionType.PIECE)).toBe(true)
            expect(flowStructureUtil.isAction(FlowActionType.LOOP_ON_ITEMS)).toBe(true)
            expect(flowStructureUtil.isAction(FlowActionType.ROUTER)).toBe(true)
            expect(flowStructureUtil.isAction(FlowTriggerType.EMPTY as any)).toBe(false)
            expect(flowStructureUtil.isAction(undefined)).toBe(false)
            expect(flowStructureUtil.isAction('INVALID' as any)).toBe(false)
        })
    })

    describe('getAllSteps', () => {
        it('returns only the trigger when flow has no actions', () => {
            const trigger = createMockEmptyTrigger('trigger_1')
            const steps = flowStructureUtil.getAllSteps(trigger)
            expect(steps.map((s) => s.name)).toEqual(['trigger_1'])
        })

        it('traverses linear sequence of steps in order', () => {
            const action2 = createMockCodeAction('step_2')
            const action1 = createMockCodeAction('step_1', action2)
            const trigger = createMockEmptyTrigger('trigger', action1)

            const steps = flowStructureUtil.getAllSteps(trigger)
            expect(steps.map((s) => s.name)).toEqual(['trigger', 'step_1', 'step_2'])
        })

        it('traverses loop step children and then continues to nextAction', () => {
            const loopChild = createMockCodeAction('loop_child')
            const postLoop = createMockCodeAction('post_loop')
            const loopAction = createMockLoopAction('loop_step', loopChild, postLoop)
            const trigger = createMockEmptyTrigger('trigger', loopAction)

            const steps = flowStructureUtil.getAllSteps(trigger)
            expect(steps.map((s) => s.name)).toEqual(['trigger', 'loop_step', 'loop_child', 'post_loop'])
        })

        it('traverses router branches, ignores null branches, and visits nextAction', () => {
            const branch1Child = createMockCodeAction('branch_1_action')
            const branch2Child = createMockCodeAction('branch_2_action')
            const postRouter = createMockCodeAction('post_router')
            const router = createMockRouterAction('router_step', [branch1Child, null, branch2Child], postRouter)
            const trigger = createMockEmptyTrigger('trigger', router)

            const steps = flowStructureUtil.getAllSteps(trigger)
            expect(steps.map((s) => s.name)).toEqual([
                'trigger',
                'router_step',
                'branch_1_action',
                'branch_2_action',
                'post_router',
            ])
        })

        it('traverses continueOnFailure branches on code/piece actions', () => {
            const onSuccessAction = createMockCodeAction('on_success')
            const onFailureAction = createMockCodeAction('on_failure')
            const pieceAction = createMockPieceAction('piece_action', 'test-piece')
            pieceAction.continueOnFailureBranches = {
                onSuccess: onSuccessAction,
                onFailure: onFailureAction,
            }
            const postPiece = createMockCodeAction('post_piece')
            pieceAction.nextAction = postPiece
            const trigger = createMockEmptyTrigger('trigger', pieceAction)

            const steps = flowStructureUtil.getAllSteps(trigger)
            expect(steps.map((s) => s.name)).toEqual([
                'trigger',
                'piece_action',
                'on_success',
                'on_failure',
                'post_piece',
            ])
        })
    })

    describe('getStepNumber', () => {
        it('returns 1-based index matching DFS position in flow', () => {
            const step2 = createMockCodeAction('step_2')
            const step1 = createMockCodeAction('step_1', step2)
            const trigger = createMockEmptyTrigger('trigger', step1)

            expect(flowStructureUtil.getStepNumber(trigger, 'trigger')).toBe(1)
            expect(flowStructureUtil.getStepNumber(trigger, 'step_1')).toBe(2)
            expect(flowStructureUtil.getStepNumber(trigger, 'step_2')).toBe(3)
        })

        it('returns 0 when step is not present in flow', () => {
            const trigger = createMockEmptyTrigger('trigger')
            expect(flowStructureUtil.getStepNumber(trigger, 'missing_step')).toBe(0)
        })
    })

    describe('getStep and getStepOrThrow', () => {
        it('getStep returns the matching step or undefined', () => {
            const action = createMockCodeAction('action_1')
            const trigger = createMockEmptyTrigger('trigger', action)

            expect(flowStructureUtil.getStep('action_1', trigger)?.name).toBe('action_1')
            expect(flowStructureUtil.getStep('missing', trigger)).toBeUndefined()
        })

        it('getStepOrThrow returns matching step', () => {
            const action = createMockCodeAction('action_1')
            const trigger = createMockEmptyTrigger('trigger', action)

            const found = flowStructureUtil.getStepOrThrow('action_1', trigger)
            expect(found.name).toBe('action_1')
        })

        it('getStepOrThrow throws ENTITY_NOT_FOUND when step is missing', () => {
            const trigger = createMockEmptyTrigger('trigger')
            expect(() => flowStructureUtil.getStepOrThrow('nonexistent', trigger)).toThrow(ActivepiecesError)
            try {
                flowStructureUtil.getStepOrThrow('nonexistent', trigger)
            }
            catch (e: any) {
                expect(e.error?.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
                expect(e.error?.params?.entityId).toBe('nonexistent')
            }
        })
    })

    describe('getActionOrThrow and getTriggerOrThrow', () => {
        it('getActionOrThrow returns the action step', () => {
            const action = createMockCodeAction('action_1')
            const trigger = createMockEmptyTrigger('trigger', action)
            expect(flowStructureUtil.getActionOrThrow('action_1', trigger).name).toBe('action_1')
        })

        it('getActionOrThrow throws if step is a trigger instead of action', () => {
            const trigger = createMockEmptyTrigger('trigger')
            expect(() => flowStructureUtil.getActionOrThrow('trigger', trigger)).toThrow(ActivepiecesError)
            try {
                flowStructureUtil.getActionOrThrow('trigger', trigger)
            }
            catch (e: any) {
                expect(e.error?.params?.message).toBe('Step is not an action')
            }
        })

        it('getTriggerOrThrow returns trigger when step is a trigger', () => {
            const trigger = createMockEmptyTrigger('trigger')
            expect(flowStructureUtil.getTriggerOrThrow('trigger', trigger).name).toBe('trigger')
        })

        it('getTriggerOrThrow throws if step is an action', () => {
            const action = createMockCodeAction('action_1')
            const trigger = createMockEmptyTrigger('trigger', action)
            expect(() => flowStructureUtil.getTriggerOrThrow('action_1', trigger)).toThrow(ActivepiecesError)
            try {
                flowStructureUtil.getTriggerOrThrow('action_1', trigger)
            }
            catch (e: any) {
                expect(e.error?.params?.message).toBe('Step is not a trigger')
            }
        })
    })

    describe('transferStep and transferFlow', () => {
        it('deeply applies transformation to all steps', () => {
            const action2 = createMockCodeAction('step_2')
            const action1 = createMockCodeAction('step_1', action2)
            const trigger = createMockEmptyTrigger('trigger', action1)

            const updatedTrigger = flowStructureUtil.transferStep(trigger, (step) => ({
                ...step,
                displayName: `${step.displayName} (Modified)`,
            }))

            const steps = flowStructureUtil.getAllSteps(updatedTrigger)
            expect(steps.every((s) => s.displayName.endsWith('(Modified)'))).toBe(true)
        })

        it('transferFlow clones and transforms without mutating the input flowVersion', () => {
            const trigger = createMockEmptyTrigger('trigger', createMockCodeAction('step_1'))
            const flowVersion: FlowVersion = {
                id: 'fv_1',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                flowId: 'flow_1',
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
            }

            const transformed = flowStructureUtil.transferFlow(flowVersion, (step) => ({
                ...step,
                displayName: 'Renamed',
            }))

            expect(flowVersion.trigger.displayName).toBe('Empty Trigger')
            expect(transformed.trigger.displayName).toBe('Renamed')
            expect(transformed.trigger.nextAction?.displayName).toBe('Renamed')
        })
    })

    describe('createBranch', () => {
        it('creates a condition branch with given conditions', () => {
            const branch = flowStructureUtil.createBranch('Success Branch', [[emptyCondition]])
            expect(branch.branchName).toBe('Success Branch')
            expect(branch.branchType).toBe(BranchExecutionType.CONDITION)
            expect(branch.conditions).toEqual([[emptyCondition]])
        })

        it('populates default emptyCondition when conditions are undefined', () => {
            const branch = flowStructureUtil.createBranch('Default Branch', undefined)
            expect(branch.conditions).toEqual([[emptyCondition]])
        })
    })

    describe('findPathToStep', () => {
        it('finds ancestor path from trigger to a nested step', () => {
            const childAction = createMockCodeAction('nested_action')
            const loopAction = createMockLoopAction('loop_action', childAction)
            const trigger = createMockEmptyTrigger('trigger', loopAction)

            const path = flowStructureUtil.findPathToStep(trigger, 'nested_action')
            expect(path.map((p) => p.name)).toEqual(['trigger', 'loop_action'])
        })

        it('returns empty array when target step is the root trigger', () => {
            const trigger = createMockEmptyTrigger('trigger')
            const path = flowStructureUtil.findPathToStep(trigger, 'trigger')
            expect(path).toEqual([])
        })
    })

    describe('getAllChildSteps and isChildOf', () => {
        it('returns only internal child steps without nextAction', () => {
            const loopChild1 = createMockCodeAction('loop_child_1')
            const loopChild2 = createMockCodeAction('loop_child_2')
            loopChild1.nextAction = loopChild2
            const postLoop = createMockCodeAction('post_loop')
            const loop = createMockLoopAction('loop', loopChild1, postLoop)

            const childSteps = flowStructureUtil.getAllChildSteps(loop)
            expect(childSteps.map((c) => c.name)).toEqual(['loop', 'loop_child_1', 'loop_child_2'])
            expect(childSteps.some((c) => c.name === 'post_loop')).toBe(false)
        })

        it('isChildOf detects direct and nested descendants', () => {
            const branchAction = createMockCodeAction('branch_action')
            const router = createMockRouterAction('router', [branchAction])
            const postRouter = createMockCodeAction('post_router')
            router.nextAction = postRouter

            expect(flowStructureUtil.isChildOf(router, 'branch_action')).toBe(true)
            expect(flowStructureUtil.isChildOf(router, 'post_router')).toBe(false)
            expect(flowStructureUtil.isChildOf(router, 'router')).toBe(false)
            expect(flowStructureUtil.isChildOf(router, 'non_existent')).toBe(false)
        })
    })

    describe('findUnusedName and findUnusedNames', () => {
        it('generates the next available step name sequentially', () => {
            expect(flowStructureUtil.findUnusedName([])).toBe('step_1')
            expect(flowStructureUtil.findUnusedName(['step_1'])).toBe('step_2')
            expect(flowStructureUtil.findUnusedName(['step_1', 'step_2', 'step_4'])).toBe('step_3')
        })

        it('finds unused name from a FlowTrigger object', () => {
            const step1 = createMockCodeAction('step_1')
            const trigger = createMockEmptyTrigger('trigger', step1)
            expect(flowStructureUtil.findUnusedName(trigger)).toBe('step_2')
        })

        it('generates multiple unique unused names with findUnusedNames', () => {
            const names = flowStructureUtil.findUnusedNames(['step_1', 'step_2'], 3)
            expect(names).toEqual(['step_3', 'step_4', 'step_5'])
        })
    })

    describe('getAllNextActionsWithoutChildren', () => {
        it('traverses linear nextAction sequence ignoring children', () => {
            const loopChild = createMockCodeAction('loop_child')
            const postLoop = createMockCodeAction('post_loop')
            const loop = createMockLoopAction('loop', loopChild, postLoop)

            const nextActions = flowStructureUtil.getAllNextActionsWithoutChildren(loop)
            expect(nextActions.map((a) => a.name)).toEqual(['post_loop'])
        })

        it('returns empty array when start step has no nextAction', () => {
            const singleAction = createMockCodeAction('single')
            expect(flowStructureUtil.getAllNextActionsWithoutChildren(singleAction)).toEqual([])
        })
    })

    describe('extractConnectionIdsFromAuth and extractConnectionIds', () => {
        it('extracts single and multiple connection ids from auth mustache templates', () => {
            const flowVersion: FlowVersion = {
                id: 'fv_1',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                flowId: 'flow_1',
                displayName: 'Connections Flow',
                trigger: createMockPieceTrigger('trigger', 'gmail', "{{connections['gmail_conn']}}",
                    createMockPieceAction('step_1', 'slack', {
                        auth: "{{connections['slack_conn_1', 'slack_conn_2']}}",
                    },
                    createMockPieceAction('step_2', 'gmail', {
                        auth: "{{connections['gmail_conn']}}", // duplicate
                    })),
                ),
                valid: true,
                state: FlowVersionState.DRAFT,
                updatedBy: null,
                schemaVersion: '22',
                agentIds: [],
                connectionIds: [],
                backupFiles: null,
                notes: [],
            }

            const connectionIds = flowStructureUtil.extractConnectionIds(flowVersion)
            expect(connectionIds).toEqual(['gmail_conn', 'slack_conn_1', 'slack_conn_2'])
        })

        it('returns empty array when no auth connections exist in flow', () => {
            const flowVersion: FlowVersion = {
                id: 'fv_2',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                flowId: 'flow_2',
                displayName: 'No Connections Flow',
                trigger: createMockEmptyTrigger('trigger', createMockCodeAction('step_1')),
                valid: true,
                state: FlowVersionState.DRAFT,
                updatedBy: null,
                schemaVersion: '22',
                agentIds: [],
                connectionIds: [],
                backupFiles: null,
                notes: [],
            }

            expect(flowStructureUtil.extractConnectionIds(flowVersion)).toEqual([])
        })
    })

    describe('isAgentPiece and extractAgentIds', () => {
        it('identifies AI agent piece and extracts agentIds from flow', () => {
            const aiAction = createMockPieceAction('ai_step', AI_PIECE_NAME, {
                agentId: 'agent_abc123',
            })
            const standardPieceAction = createMockPieceAction('normal_step', 'regular-piece', {
                agentId: 'not_an_ai_piece',
            })
            const trigger = createMockEmptyTrigger('trigger', aiAction)
            aiAction.nextAction = standardPieceAction

            expect(flowStructureUtil.isAgentPiece(aiAction)).toBe(true)
            expect(flowStructureUtil.isAgentPiece(standardPieceAction)).toBe(false)

            const flowVersion: FlowVersion = {
                id: 'fv_3',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                flowId: 'flow_3',
                displayName: 'AI Agent Flow',
                trigger,
                valid: true,
                state: FlowVersionState.DRAFT,
                updatedBy: null,
                schemaVersion: '22',
                agentIds: [],
                connectionIds: [],
                backupFiles: null,
                notes: [],
            }

            const agentIds = flowStructureUtil.extractAgentIds(flowVersion)
            expect(agentIds).toEqual(['agent_abc123'])
        })

        it('returns empty array when flow has no agent pieces or empty agentId', () => {
            const aiActionEmpty = createMockPieceAction('ai_step_empty', AI_PIECE_NAME, {
                agentId: '',
            })
            const trigger = createMockEmptyTrigger('trigger', aiActionEmpty)
            const flowVersion: FlowVersion = {
                id: 'fv_4',
                created: '2026-01-01T00:00:00.000Z',
                updated: '2026-01-01T00:00:00.000Z',
                flowId: 'flow_4',
                displayName: 'Empty Agent Flow',
                trigger,
                valid: true,
                state: FlowVersionState.DRAFT,
                updatedBy: null,
                schemaVersion: '22',
                agentIds: [],
                connectionIds: [],
                backupFiles: null,
                notes: [],
            }

            expect(flowStructureUtil.extractAgentIds(flowVersion)).toEqual([])
        })
    })
})
