import { describe, expect, it } from 'vitest'
import { _getActionsForCopy } from '../../../src/lib/flows/operations/copy-action-operations'
import {
    CodeAction,
    FlowActionType,
    LoopOnItemsAction,
    RouterAction,
    RouterExecutionType,
} from '../../../src/lib/flows/actions/action'
import { FlowVersion, FlowVersionState } from '../../../src/lib/flows/flow-version'
import { EmptyTrigger, FlowTriggerType } from '../../../src/lib/flows/triggers/trigger'

const createMockVersion = (trigger: any): FlowVersion => ({
    id: 'flow_version_123',
    flowId: 'flow_123',
    displayName: 'Test Version',
    trigger,
    valid: true,
    state: FlowVersionState.DRAFT,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
})

describe('copy-action-operations: _getActionsForCopy', () => {
    it('returns empty array when no steps are selected', () => {
        const trigger: EmptyTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            valid: true,
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2026-01-01T00:00:00.000Z',
        }
        const version = createMockVersion(trigger)
        const result = _getActionsForCopy([], version)
        expect(result).toEqual([])
    })

    it('ignores trigger even if included in selectedSteps', () => {
        const action1: CodeAction = {
            name: 'step_1',
            displayName: 'Step 1',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 1;', packageJson: '{}' }, input: {} },
        }
        const trigger: EmptyTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            valid: true,
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2026-01-01T00:00:00.000Z',
            nextAction: action1,
        }
        const version = createMockVersion(trigger)
        const result = _getActionsForCopy(['trigger', 'step_1'], version)
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe('step_1')
    })

    it('clones action and strips nextAction property', () => {
        const action2: CodeAction = {
            name: 'step_2',
            displayName: 'Step 2',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 2;', packageJson: '{}' }, input: {} },
        }
        const action1: CodeAction = {
            name: 'step_1',
            displayName: 'Step 1',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 1;', packageJson: '{}' }, input: {} },
            nextAction: action2,
        }
        const trigger: EmptyTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            valid: true,
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2026-01-01T00:00:00.000Z',
            nextAction: action1,
        }
        const version = createMockVersion(trigger)
        const result = _getActionsForCopy(['step_1'], version)

        expect(result).toHaveLength(1)
        expect(result[0].name).toBe('step_1')
        expect(result[0].nextAction).toBeUndefined()
        // Original action remains intact
        expect(action1.nextAction).toBe(action2)
    })

    it('deduplicates child actions when a parent router action is selected', () => {
        const nestedAction: CodeAction = {
            name: 'nested_step',
            displayName: 'Nested Step',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 3;', packageJson: '{}' }, input: {} },
        }
        const routerAction: RouterAction = {
            name: 'router_step',
            displayName: 'Router',
            valid: true,
            type: FlowActionType.ROUTER,
            settings: {
                branches: [],
                executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
            },
            children: [nestedAction],
        }
        const trigger: EmptyTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            valid: true,
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2026-01-01T00:00:00.000Z',
            nextAction: routerAction,
        }
        const version = createMockVersion(trigger)

        // Selecting both router and nested action should only copy the router
        const result = _getActionsForCopy(['router_step', 'nested_step'], version)
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe('router_step')
    })

    it('deduplicates child actions when parent is a loop', () => {
        const loopChildAction: CodeAction = {
            name: 'loop_child',
            displayName: 'Loop Child',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 4;', packageJson: '{}' }, input: {} },
        }
        const loopAction: LoopOnItemsAction = {
            name: 'loop_step',
            displayName: 'Loop Step',
            valid: true,
            type: FlowActionType.LOOP_ON_ITEMS,
            settings: {
                items: '[1, 2, 3]',
            },
            firstLoopAction: loopChildAction,
        }
        const trigger: EmptyTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            valid: true,
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2026-01-01T00:00:00.000Z',
            nextAction: loopAction,
        }
        const version = createMockVersion(trigger)

        const result = _getActionsForCopy(['loop_step', 'loop_child'], version)
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe('loop_step')
    })

    it('preserves linear execution order regardless of selectedSteps array order', () => {
        const action3: CodeAction = {
            name: 'step_3',
            displayName: 'Step 3',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 3;', packageJson: '{}' }, input: {} },
        }
        const action2: CodeAction = {
            name: 'step_2',
            displayName: 'Step 2',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 2;', packageJson: '{}' }, input: {} },
            nextAction: action3,
        }
        const action1: CodeAction = {
            name: 'step_1',
            displayName: 'Step 1',
            valid: true,
            type: FlowActionType.CODE,
            settings: { sourceCode: { code: 'return 1;', packageJson: '{}' }, input: {} },
            nextAction: action2,
        }
        const trigger: EmptyTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            valid: true,
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2026-01-01T00:00:00.000Z',
            nextAction: action1,
        }
        const version = createMockVersion(trigger)

        // Pass out of order: step_3, step_1, step_2
        const result = _getActionsForCopy(['step_3', 'step_1', 'step_2'], version)
        expect(result.map(a => a.name)).toEqual(['step_1', 'step_2', 'step_3'])
    })

    it('throws when stepName does not exist in flow version', () => {
        const trigger: EmptyTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            valid: true,
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2026-01-01T00:00:00.000Z',
        }
        const version = createMockVersion(trigger)
        expect(() => _getActionsForCopy(['non_existent_step'], version)).toThrow()
    })
})
