import { formErrors } from '@inboxfm-connect/core-utils'
import { BranchExecutionType, BranchOperator, FlowActionType, RouterExecutionType } from '../../src/lib/flows/actions/action'
import { AddBranchRequest, ImportFlowRequest } from '../../src/lib/flows/operations'
import { FlowTriggerType } from '../../src/lib/flows/triggers/trigger'

const lastUpdatedDate = '2026-01-01T00:00:00.000Z'

const validCondition = {
    firstValue: "{{trigger['output'].status}}",
    secondValue: 'active',
    operator: BranchOperator.TEXT_EXACTLY_MATCHES,
}

const emptyValueCondition = {
    firstValue: '',
    secondValue: 'active',
    operator: BranchOperator.TEXT_EXACTLY_MATCHES,
}

const malformedCondition = {
    firstValue: 42,
    secondValue: 'active',
    operator: BranchOperator.TEXT_EXACTLY_MATCHES,
}

function buildConditionBranches(conditions: unknown[][]) {
    return [
        {
            branchName: 'Match',
            branchType: BranchExecutionType.CONDITION,
            conditions,
        },
        {
            branchName: 'Otherwise',
            branchType: BranchExecutionType.FALLBACK,
        },
    ]
}

function buildRouter(conditions: unknown[][], children: unknown[] = [null]) {
    return {
        name: 'router_1',
        valid: true,
        displayName: 'Router',
        lastUpdatedDate,
        type: FlowActionType.ROUTER,
        settings: {
            branches: buildConditionBranches(conditions),
            executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
        },
        children,
    }
}

function buildImportRequest(triggerNextAction: unknown) {
    return {
        displayName: 'Imported flow',
        trigger: {
            name: 'trigger',
            valid: true,
            displayName: 'Trigger',
            lastUpdatedDate,
            type: FlowTriggerType.EMPTY,
            settings: {},
            nextAction: triggerNextAction,
        },
        schemaVersion: null,
        notes: null,
    }
}

function expectFailure(result: ReturnType<typeof ImportFlowRequest.safeParse>) {
    if (result.success) {
        throw new Error('expected the request to be rejected')
    }
    return result.error
}

describe('AddBranchRequest', () => {
    it('rejects branch conditions with empty values', () => {
        const result = AddBranchRequest.safeParse({
            branchIndex: 1,
            stepName: 'router_1',
            branchName: 'Branch 2',
            conditions: [[emptyValueCondition]],
        })

        const error = expectFailure(result)
        expect(error.issues.some((issue) => issue.message === formErrors.required)).toBe(true)
    })

    it('accepts branch conditions with non-empty values', () => {
        const result = AddBranchRequest.safeParse({
            branchIndex: 1,
            stepName: 'router_1',
            branchName: 'Branch 2',
            conditions: [[validCondition]],
        })

        expect(result.success).toBe(true)
    })

    it('accepts a branch without conditions', () => {
        const result = AddBranchRequest.safeParse({
            branchIndex: 1,
            stepName: 'router_1',
            branchName: 'Branch 2',
        })

        expect(result.success).toBe(true)
    })
})

describe('ImportFlowRequest', () => {
    it('rejects an imported flow whose branch has an empty condition value', () => {
        const result = ImportFlowRequest.safeParse(buildImportRequest(buildRouter([[emptyValueCondition]])))

        const error = expectFailure(result)
        expect(error.issues.map((issue) => issue.message)).toContain(formErrors.required)
        expect(error.issues[0].path).toEqual([
            'trigger',
            'nextAction',
            'settings',
            'branches',
            0,
            'conditions',
            0,
            0,
        ])
    })

    it('rejects an imported flow whose nested branch has an empty condition value', () => {
        const result = ImportFlowRequest.safeParse(
            buildImportRequest(buildRouter([[validCondition]], [buildRouter([[emptyValueCondition]])])),
        )

        const error = expectFailure(result)
        expect(error.issues.map((issue) => issue.message)).toContain(formErrors.required)
        expect(error.issues[0].path).toEqual([
            'trigger',
            'nextAction',
            'children',
            0,
            'settings',
            'branches',
            0,
            'conditions',
            0,
            0,
        ])
    })

    it('rejects an imported flow whose condition is malformed', () => {
        const result = ImportFlowRequest.safeParse(buildImportRequest(buildRouter([[malformedCondition]])))

        const error = expectFailure(result)
        expect(error.issues.map((issue) => issue.message)).toContain(formErrors.invalidBranchCondition)
    })

    it('accepts an imported flow whose conditions have non-empty values', () => {
        const result = ImportFlowRequest.safeParse(buildImportRequest(buildRouter([[validCondition]])))

        expect(result.success).toBe(true)
    })

    it('accepts an imported flow whose router only has a fallback branch', () => {
        const router = buildRouter([])
        router.settings.branches = [router.settings.branches[1]]

        const result = ImportFlowRequest.safeParse(buildImportRequest(router))

        expect(result.success).toBe(true)
    })

    it('does not throw when the imported action tree is structurally broken', () => {
        const malformedRouter = {
            name: 'router_1',
            valid: true,
            displayName: 'Router',
            lastUpdatedDate,
            type: FlowActionType.ROUTER,
            settings: { branches: 'not-an-array' },
            children: 'not-an-array',
            nextAction: { type: FlowActionType.ROUTER, settings: null, nextAction: 'not-an-action' },
        }

        expect(() => ImportFlowRequest.safeParse(buildImportRequest(malformedRouter))).not.toThrow()
    })
})
