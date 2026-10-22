import { describe, expect, it } from 'vitest'
import {
    EngineOperationType,
    isExecuteAuthOperation,
    isExecuteExtractPieceMetadataOperation,
    isExecutePropsOptions,
    isExecuteToolOperation,
    isExecuteTriggerOperation,
    TriggerHookType,
} from '../../../src/lib/engine/engine-operation'
import type {
    EngineOperation,
    ExecuteExtractPieceMetadataOperation,
    ExecutePropsOptions,
    ExecuteToolOperation,
    ExecuteTriggerOperation,
    ExecuteValidateAuthOperation,
} from '../../../src/lib/engine/engine-operation'

/**
 * Issue #166 — the engine dispatched every operation through
 * `operation as XOperation`, which asserts a shape nothing ever checked. These
 * guards replace the casts so a misrouted payload fails at the boundary with a
 * clear error instead of surfacing as a confusing failure inside a piece.
 *
 * The shapes below are written to match the real type definitions exactly, so a
 * change to a type that invalidates a guard fails here.
 */

const base = {
    engineToken: 'engine-token',
    internalApiUrl: 'http://internal',
    publicApiUrl: 'https://public',
    timeoutInSeconds: 30,
    platformId: 'platform-1',
}

const piecePackage = {
    packageType: 'REGISTRY',
    pieceType: 'OFFICIAL',
    pieceName: '@inboxfm-connect/piece-github',
    pieceVersion: '0.3.4',
} as const

const auth = { type: 'OAUTH2' } as never

const toolOp = {
    ...base,
    projectId: 'project-1',
    pieceName: '@inboxfm-connect/piece-github',
    actionName: 'create_issue',
    input: { title: 'x' },
} as unknown as ExecuteToolOperation

// ExecuteValidateAuthOperation and ExecuteRefreshTokenAuthOperation are aliases,
// so one fixture represents both.
const authOp = {
    ...base,
    piece: piecePackage,
    auth,
} as unknown as ExecuteValidateAuthOperation

const triggerOp = {
    ...base,
    projectId: 'project-1',
    hookType: TriggerHookType.ON_ENABLE,
    webhookUrl: 'https://public/webhook',
} as unknown as ExecuteTriggerOperation<TriggerHookType>

const extractOp = {
    ...piecePackage,
    platformId: 'platform-1',
    timeoutInSeconds: 30,
} as unknown as ExecuteExtractPieceMetadataOperation

const propsOp = {
    ...base,
    piece: piecePackage,
    propertyName: 'issues',
    actionOrTriggerName: 'create_issue',
} as unknown as ExecutePropsOptions

const ALL_GUARDS = {
    tool: isExecuteToolOperation,
    auth: isExecuteAuthOperation,
    trigger: isExecuteTriggerOperation,
    extract: isExecuteExtractPieceMetadataOperation,
    props: isExecutePropsOptions,
} as const

function matchedGuards(op: EngineOperation): string[] {
    return Object.entries(ALL_GUARDS)
        .filter(([, guard]) => guard(op as never))
        .map(([name]) => name)
}

describe('EngineOperation type guards (Issue #166)', () => {
    it('accepts each operation under its own guard', () => {
        expect(isExecuteToolOperation(toolOp)).toBe(true)
        expect(isExecuteAuthOperation(authOp)).toBe(true)
        expect(isExecuteTriggerOperation(triggerOp)).toBe(true)
        expect(isExecuteExtractPieceMetadataOperation(extractOp)).toBe(true)
        expect(isExecutePropsOptions(propsOp)).toBe(true)
    })

    it('matches every operation under exactly one guard', () => {
        // The property between EXECUTE_VALIDATE_AUTH and
        // EXECUTE_REFRESH_TOKEN_AUTH is that they are the same type, so this
        // also pins that nothing overlaps ambiguously.
        for (const [label, op] of Object.entries({ toolOp, authOp, triggerOp, extractOp, propsOp })) {
            expect(matchedGuards(op as EngineOperation), `${label} matched ${matchedGuards(op as EngineOperation).join(',')}`).toHaveLength(1)
        }
    })

    describe('auth operations are not structurally distinguishable', () => {
        it('accepts a validate-auth payload (it carries timeoutInSeconds)', () => {
            // Regression: an earlier version of this guard required
            // `!('timeoutInSeconds' in op)`. But timeoutInSeconds comes from
            // BaseEngineOperation and Omit<> only drops projectId, so a real
            // validate-auth payload always has it. That guard rejected every
            // legitimate auth validation.
            expect('timeoutInSeconds' in authOp).toBe(true)
            expect(isExecuteAuthOperation(authOp)).toBe(true)
        })

        it('excludes props, which also carries piece', () => {
            expect('piece' in propsOp).toBe(true)
            expect(isExecuteAuthOperation(propsOp)).toBe(false)
        })

        it('excludes tool and extract, which carry pieceName not piece', () => {
            expect(isExecuteAuthOperation(toolOp)).toBe(false)
            expect(isExecuteAuthOperation(extractOp)).toBe(false)
        })
    })

    describe('extract vs tool are not confusable', () => {
        it('both carry pieceName, platformId and timeoutInSeconds', () => {
            for (const key of ['pieceName', 'platformId', 'timeoutInSeconds']) {
                expect(extractOp, `extract missing ${key}`).toHaveProperty(key)
                expect(toolOp, `tool missing ${key}`).toHaveProperty(key)
            }
        })

        it('separates them on actionName/input', () => {
            expect(isExecuteExtractPieceMetadataOperation(extractOp)).toBe(true)
            expect(isExecuteExtractPieceMetadataOperation(toolOp)).toBe(false)
            expect(isExecuteToolOperation(extractOp)).toBe(false)
        })
    })

    describe('trigger guard', () => {
        it('accepts any hook type when none is specified', () => {
            expect(isExecuteTriggerOperation(triggerOp)).toBe(true)
        })

        it('matches a specific hook type', () => {
            expect(isExecuteTriggerOperation(triggerOp, TriggerHookType.ON_ENABLE)).toBe(true)
            expect(isExecuteTriggerOperation(triggerOp, TriggerHookType.RUN)).toBe(false)
        })
    })

    describe('malformed input', () => {
        it('rejects undefined rather than throwing', () => {
            for (const guard of Object.values(ALL_GUARDS)) {
                expect(guard(undefined as never)).toBe(false)
            }
        })

        it('rejects a payload that is not operation-shaped', () => {
            const junk = { hello: 'world' } as unknown as EngineOperation
            expect(matchedGuards(junk)).toHaveLength(0)
        })

        it('rejects a tool operation missing its actionName', () => {
            const { actionName: _dropped, ...rest } = toolOp as unknown as Record<string, unknown>
            expect(isExecuteToolOperation(rest as EngineOperation)).toBe(false)
        })
    })

    describe('EngineOperationType values remain distinct', () => {
        it('has no duplicate enum values', () => {
            const values = Object.values(EngineOperationType)
            expect(new Set(values).size).toBe(values.length)
        })

        it('keeps the two auth operation types distinct at the discriminant', () => {
            // This is what actually tells the two auth operations apart, given
            // the payload types are identical.
            expect(EngineOperationType.EXECUTE_VALIDATE_AUTH).toBe('EXECUTE_VALIDATE_AUTH')
            expect(EngineOperationType.EXECUTE_REFRESH_TOKEN_AUTH).toBe('EXECUTE_REFRESH_TOKEN_AUTH')
            expect(EngineOperationType.EXECUTE_VALIDATE_AUTH).not.toBe(EngineOperationType.EXECUTE_REFRESH_TOKEN_AUTH)
        })
    })
})
