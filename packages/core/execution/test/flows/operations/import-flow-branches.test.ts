import { describe, expect, it } from 'vitest'
import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import {
    BranchCondition,
    BranchExecutionType,
    BranchOperator,
    DraftBranchCondition,
    emptyCondition,
    FlowActionType,
    LoopOnItemsAction,
    RouterAction,
    RouterExecutionType,
    ValidBranchCondition,
} from '../../../src/lib/flows/actions/action'
import { FlowVersion, FlowVersionState } from '../../../src/lib/flows/flow-version'
import { AddBranchRequest, FlowOperationType, flowOperations, ImportFlowRequest } from '../../../src/lib/flows/operations'
import { FlowTriggerType } from '../../../src/lib/flows/triggers/trigger'

describe('BranchCondition and Flow Import Branch Validation (Issue #168)', () => {
    const mockFlowVersion: FlowVersion = {
        id: 'flow-version-1',
        created: '2026-09-27T00:00:00.000Z',
        updated: '2026-09-27T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'Original Flow',
        valid: true,
        state: FlowVersionState.DRAFT,
        schemaVersion: '22',
        updatedBy: null,
        agentIds: [],
        connectionIds: [],
        backupFiles: null,
        notes: [],
        trigger: {
            name: 'trigger',
            displayName: 'Select a Trigger',
            type: FlowTriggerType.EMPTY,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {},
        },
    }

    it('BranchCondition schema rejects empty condition values via ValidBranchCondition', () => {
        const empty = {
            firstValue: '',
            secondValue: 'expected_val',
            operator: BranchOperator.TEXT_CONTAINS,
        }
        const parseResult = ValidBranchCondition.safeParse(empty)
        expect(parseResult.success).toBe(false)

        const deprecatedResult = BranchCondition.safeParse(empty)
        expect(deprecatedResult.success).toBe(false)
    })

    it('ValidBranchCondition accepts valid non-empty condition values', () => {
        const validCondition = {
            firstValue: '{{ steps.trigger.body.status }}',
            secondValue: 'active',
            operator: BranchOperator.TEXT_EXACTLY_MATCHES,
        }
        const parseResult = ValidBranchCondition.safeParse(validCondition)
        expect(parseResult.success).toBe(true)
    })

    it('ValidBranchCondition accepts single-value operators without secondValue', () => {
        const singleValueCondition = {
            firstValue: '{{ steps.trigger.body.items }}',
            operator: BranchOperator.EXISTS,
        }
        const parseResult = ValidBranchCondition.safeParse(singleValueCondition)
        expect(parseResult.success).toBe(true)

        const emptyFirstVal = {
            firstValue: '',
            operator: BranchOperator.EXISTS,
        }
        expect(ValidBranchCondition.safeParse(emptyFirstVal).success).toBe(false)
    })

    it('DraftBranchCondition accepts unconfigured scaffold emptyCondition template', () => {
        const parseResult = DraftBranchCondition.safeParse(emptyCondition)
        expect(parseResult.success).toBe(true)
        expect(emptyCondition.firstValue).toBe('')
        expect(emptyCondition.secondValue).toBe('')
    })

    it('AddBranchRequest validates conditions with ValidBranchCondition or defaults to draft scaffold', () => {
        const validRequest = {
            stepName: 'step_router',
            branchIndex: 0,
            branchName: 'Branch 1',
            conditions: [
                [
                    {
                        firstValue: 'status',
                        secondValue: 'success',
                        operator: BranchOperator.TEXT_CONTAINS,
                    },
                ],
            ],
        }
        expect(AddBranchRequest.safeParse(validRequest).success).toBe(true)

        // Explicit empty conditions are rejected
        const invalidRequest = {
            stepName: 'step_router',
            branchIndex: 0,
            branchName: 'Branch 1',
            conditions: [
                [
                    {
                        firstValue: '',
                        secondValue: 'success',
                        operator: BranchOperator.TEXT_CONTAINS,
                    },
                ],
            ],
        }
        expect(AddBranchRequest.safeParse(invalidRequest).success).toBe(false)

        // Omitting conditions is allowed for draft authoring
        const draftRequest = {
            stepName: 'step_router',
            branchIndex: 0,
            branchName: 'Branch 1',
        }
        expect(AddBranchRequest.safeParse(draftRequest).success).toBe(true)
    })

    it('IMPORT_FLOW throws ActivepiecesError when an imported router contains empty conditions', () => {
        const invalidRouterAction: RouterAction = {
            name: 'step_router',
            displayName: 'Router Step',
            type: FlowActionType.ROUTER,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
                branches: [
                    {
                        branchType: BranchExecutionType.CONDITION,
                        branchName: 'Empty Condition Branch',
                        conditions: [
                            [
                                {
                                    firstValue: '',
                                    secondValue: 'test',
                                    operator: BranchOperator.TEXT_CONTAINS,
                                    caseSensitive: false,
                                },
                            ],
                        ],
                    },
                ],
            },
            children: [null],
        }

        const importRequest: ImportFlowRequest = {
            displayName: 'Imported Flow with Empty Conditions',
            schemaVersion: '22',
            notes: null,
            trigger: {
                name: 'trigger',
                displayName: 'Select a Trigger',
                type: FlowTriggerType.EMPTY,
                valid: true,
                lastUpdatedDate: '2026-09-27T00:00:00.000Z',
                settings: {},
                nextAction: invalidRouterAction,
            },
        }

        let capturedError: unknown
        try {
            flowOperations.apply(mockFlowVersion, {
                type: FlowOperationType.IMPORT_FLOW,
                request: importRequest,
            })
        }
        catch (err) {
            capturedError = err
        }
        expect(capturedError).toBeInstanceOf(ActivepiecesError)
        const apErr = capturedError as ActivepiecesError
        expect(apErr.error.code).toBe(ErrorCode.FLOW_OPERATION_INVALID)
        expect(apErr.error.params.message).toContain('condition values must not be empty')
    })

    it('IMPORT_FLOW throws ActivepiecesError when a CONDITION branch has missing or empty conditions array', () => {
        const routerWithEmptyConditionsArray: RouterAction = {
            name: 'step_router',
            displayName: 'Router Step',
            type: FlowActionType.ROUTER,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
                branches: [
                    {
                        branchType: BranchExecutionType.CONDITION,
                        branchName: 'Branch Without Conditions',
                        conditions: [],
                    },
                ],
            },
            children: [null],
        }

        const importRequest: ImportFlowRequest = {
            displayName: 'Empty Conditions Array Flow',
            schemaVersion: '22',
            notes: null,
            trigger: {
                name: 'trigger',
                displayName: 'Select a Trigger',
                type: FlowTriggerType.EMPTY,
                valid: true,
                lastUpdatedDate: '2026-09-27T00:00:00.000Z',
                settings: {},
                nextAction: routerWithEmptyConditionsArray,
            },
        }

        let capturedError: unknown
        try {
            flowOperations.apply(mockFlowVersion, {
                type: FlowOperationType.IMPORT_FLOW,
                request: importRequest,
            })
        }
        catch (err) {
            capturedError = err
        }
        expect(capturedError).toBeInstanceOf(ActivepiecesError)
        const apErr = capturedError as ActivepiecesError
        expect(apErr.error.code).toBe(ErrorCode.FLOW_OPERATION_INVALID)
        expect(apErr.error.params.message).toContain('condition values must not be empty')
    })

    it('IMPORT_FLOW throws ActivepiecesError when a nested router inside a loop has invalid conditions', () => {
        const nestedRouterAction: RouterAction = {
            name: 'nested_router',
            displayName: 'Nested Router',
            type: FlowActionType.ROUTER,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
                branches: [
                    {
                        branchType: BranchExecutionType.CONDITION,
                        branchName: 'Nested Invalid Branch',
                        conditions: [
                            [
                                {
                                    firstValue: '',
                                    secondValue: 'val',
                                    operator: BranchOperator.TEXT_CONTAINS,
                                },
                            ],
                        ],
                    },
                ],
            },
            children: [null],
        }

        const loopAction: LoopOnItemsAction = {
            name: 'step_loop',
            displayName: 'Loop Step',
            type: FlowActionType.LOOP_ON_ITEMS,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                items: '{{ steps.trigger.items }}',
            },
            firstLoopAction: nestedRouterAction,
        }

        const importRequest: ImportFlowRequest = {
            displayName: 'Nested Router Flow',
            schemaVersion: '22',
            notes: null,
            trigger: {
                name: 'trigger',
                displayName: 'Select a Trigger',
                type: FlowTriggerType.EMPTY,
                valid: true,
                lastUpdatedDate: '2026-09-27T00:00:00.000Z',
                settings: {},
                nextAction: loopAction,
            },
        }

        let capturedError: unknown
        try {
            flowOperations.apply(mockFlowVersion, {
                type: FlowOperationType.IMPORT_FLOW,
                request: importRequest,
            })
        }
        catch (err) {
            capturedError = err
        }
        expect(capturedError).toBeInstanceOf(ActivepiecesError)
        const apErr = capturedError as ActivepiecesError
        expect(apErr.error.code).toBe(ErrorCode.FLOW_OPERATION_INVALID)
        expect(apErr.error.params.message).toContain('Nested Router')
    })

    it('IMPORT_FLOW successfully imports a flow when router conditions are valid and preserves branches', () => {
        const validRouterAction: RouterAction = {
            name: 'step_router',
            displayName: 'Router Step',
            type: FlowActionType.ROUTER,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
                branches: [
                    {
                        branchType: BranchExecutionType.CONDITION,
                        branchName: 'Valid Branch',
                        conditions: [
                            [
                                {
                                    firstValue: '{{ steps.trigger.data }}',
                                    secondValue: 'expected',
                                    operator: BranchOperator.TEXT_CONTAINS,
                                    caseSensitive: false,
                                },
                            ],
                        ],
                    },
                ],
            },
            children: [null],
        }

        const importRequest: ImportFlowRequest = {
            displayName: 'Valid Imported Flow',
            schemaVersion: '22',
            notes: null,
            trigger: {
                name: 'trigger',
                displayName: 'Select a Trigger',
                type: FlowTriggerType.EMPTY,
                valid: true,
                lastUpdatedDate: '2026-09-27T00:00:00.000Z',
                settings: {},
                nextAction: validRouterAction,
            },
        }

        const updated = flowOperations.apply(mockFlowVersion, {
            type: FlowOperationType.IMPORT_FLOW,
            request: importRequest,
        })

        expect(updated.displayName).toBe('Valid Imported Flow')
        expect(updated.trigger.nextAction?.name).toBe('step_router')
        const router = updated.trigger.nextAction as RouterAction
        expect(router.settings.branches.length).toBe(1)
        expect(router.settings.branches[0].branchName).toBe('Valid Branch')
        expect(router.settings.branches[0].conditions?.[0]?.[0]?.firstValue).toBe('{{ steps.trigger.data }}')
        expect(router.settings.branches[0].conditions?.[0]?.[0]?.secondValue).toBe('expected')
    })

    it('ImportFlowRequest schema parse succeeds for draft router while import validation rejects it with ActivepiecesError', () => {
        const draftRouterAction = {
            name: 'step_router',
            displayName: 'Router Step',
            type: FlowActionType.ROUTER,
            valid: true,
            lastUpdatedDate: '2026-09-27T00:00:00.000Z',
            settings: {
                executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
                branches: [
                    {
                        branchType: BranchExecutionType.CONDITION,
                        branchName: 'Draft Branch',
                        conditions: [
                            [emptyCondition],
                        ],
                    },
                ],
            },
            children: [null],
        }

        const rawRequest: ImportFlowRequest = {
            displayName: 'Draft Router Flow',
            schemaVersion: '22',
            notes: null,
            trigger: {
                name: 'trigger',
                displayName: 'Select a Trigger',
                type: FlowTriggerType.EMPTY,
                valid: true,
                lastUpdatedDate: '2026-09-27T00:00:00.000Z',
                settings: {},
                nextAction: draftRouterAction,
            },
        }

        // Schema parsing at HTTP boundary rejects empty draft condition values
        const parseResult = ImportFlowRequest.safeParse(rawRequest)
        expect(parseResult.success).toBe(false)

        // But operations layer also rejects it with friendly ActivepiecesError
        let capturedError: unknown
        try {
            flowOperations.apply(mockFlowVersion, {
                type: FlowOperationType.IMPORT_FLOW,
                request: rawRequest,
            })
        }
        catch (err) {
            capturedError = err
        }
        expect(capturedError).toBeInstanceOf(ActivepiecesError)
        if (capturedError instanceof ActivepiecesError) {
            expect(capturedError.error.code).toBe(ErrorCode.FLOW_OPERATION_INVALID)
            expect(capturedError.error.params.message).toContain('condition values must not be empty')
        }
    })

    it('ADD_BRANCH with omitted conditions creates draft scaffold; export->import round-trip rejects unconfigured draft and accepts populated branch', () => {
        const flowWithRouter: FlowVersion = {
            ...mockFlowVersion,
            trigger: {
                ...mockFlowVersion.trigger,
                nextAction: {
                    name: 'step_router',
                    displayName: 'Router Step',
                    type: FlowActionType.ROUTER,
                    valid: true,
                    lastUpdatedDate: '2026-09-27T00:00:00.000Z',
                    settings: {
                        executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
                        branches: [],
                    },
                    children: [],
                },
            },
        }

        // 1. Add branch without conditions -> creates draft branch with emptyCondition scaffold
        const withBranch = flowOperations.apply(flowWithRouter, {
            type: FlowOperationType.ADD_BRANCH,
            request: {
                stepName: 'step_router',
                branchIndex: 0,
                branchName: 'New Branch',
            },
        })

        const routerAction = withBranch.trigger.nextAction as RouterAction
        expect(routerAction.settings.branches.length).toBe(1)
        expect(routerAction.settings.branches[0].conditions).toEqual([[emptyCondition]])

        // 2. Exporting that draft flow and attempting to import without filling conditions fails validation
        const exportDraftPayload: ImportFlowRequest = {
            displayName: withBranch.displayName,
            schemaVersion: withBranch.schemaVersion,
            notes: withBranch.notes,
            trigger: withBranch.trigger,
        }

        let importError: unknown
        try {
            flowOperations.apply(mockFlowVersion, {
                type: FlowOperationType.IMPORT_FLOW,
                request: exportDraftPayload,
            })
        }
        catch (err) {
            importError = err
        }
        expect(importError).toBeInstanceOf(ActivepiecesError)
        expect((importError as ActivepiecesError).error.code).toBe(ErrorCode.FLOW_OPERATION_INVALID)

        // 3. Once populated with valid condition values, export->import succeeds
        const populatedTrigger = JSON.parse(JSON.stringify(withBranch.trigger))
        populatedTrigger.nextAction.settings.branches[0].conditions = [
            [
                {
                    firstValue: 'status',
                    secondValue: 'active',
                    operator: BranchOperator.TEXT_EXACTLY_MATCHES,
                    caseSensitive: false,
                },
            ],
        ]

        const populatedImport = flowOperations.apply(mockFlowVersion, {
            type: FlowOperationType.IMPORT_FLOW,
            request: {
                displayName: 'Populated Flow',
                schemaVersion: '22',
                notes: null,
                trigger: populatedTrigger,
            },
        })

        const importedRouter = populatedImport.trigger.nextAction as RouterAction
        expect(importedRouter.settings.branches.length).toBe(1)
        expect(importedRouter.settings.branches[0].conditions?.[0]?.[0]?.firstValue).toBe('status')
    })
})
