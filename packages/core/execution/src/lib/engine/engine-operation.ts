import { PlatformId, ProjectId } from '@inboxfm-connect/core-utils'
import { z } from 'zod'
import { ExecutionToolStatus } from '../agents'
import { AppConnectionValue } from '@inboxfm-connect/core-piece-types'

import { PiecePackage } from '@inboxfm-connect/core-piece-types'
import { ScheduleOptions } from '@inboxfm-connect/core-piece-types'
import { JobPayload } from '../workers/job-data'

export enum EngineOperationType {
    EXTRACT_PIECE_METADATA = 'EXTRACT_PIECE_METADATA',
    EXECUTE_PROPERTY = 'EXECUTE_PROPERTY',
    EXECUTE_TRIGGER_HOOK = 'EXECUTE_TRIGGER_HOOK',
    EXECUTE_VALIDATE_AUTH = 'EXECUTE_VALIDATE_AUTH',
    EXECUTE_REFRESH_TOKEN_AUTH = 'EXECUTE_REFRESH_TOKEN_AUTH',
    EXECUTE_TOOL = 'EXECUTE_TOOL',
}

export enum TriggerHookType {
    ON_ENABLE = 'ON_ENABLE',
    ON_DISABLE = 'ON_DISABLE',
    HANDSHAKE = 'HANDSHAKE',
    RENEW = 'RENEW',
    RUN = 'RUN',
    TEST = 'TEST',
}

export type EngineOperation =
    | ExecuteToolOperation
    | ExecutePropsOptions
    | ExecuteTriggerOperation<TriggerHookType>
    | ExecuteExtractPieceMetadataOperation
    | ExecuteValidateAuthOperation
    | ExecuteRefreshTokenAuthOperation


export const EngineStdout = z.object({
    message: z.string(),
})

export const EngineStderr = z.object({
    message: z.string(),
})


export type EngineStdout = z.infer<typeof EngineStdout>
export type EngineStderr = z.infer<typeof EngineStderr>


export type BaseEngineOperation = {
    projectId: ProjectId
    engineToken: string
    internalApiUrl: string
    publicApiUrl: string
    timeoutInSeconds: number
    platformId: PlatformId
}

export type ExecuteValidateAuthOperation = Omit<BaseEngineOperation, 'projectId'> & {
    piece: PiecePackage
    auth: AppConnectionValue
}

export type ExecuteRefreshTokenAuthOperation = ExecuteValidateAuthOperation

export type ExecuteRefreshTokenAuthResponse =
    | { skipped: true }
    | { skipped: false, access_token: string, expires_in: number }

export type ExecuteExtractPieceMetadata = PiecePackage & { platformId: PlatformId }

export type ExecuteExtractPieceMetadataOperation = ExecuteExtractPieceMetadata & { timeoutInSeconds: number, platformId: PlatformId }

export type ExecuteToolOperation = BaseEngineOperation & {
    pieceName: string
    pieceVersion: string
    actionName: string
    input: Record<string, unknown>
    auth?: AppConnectionValue
}

export type ExecutePropsOptions = BaseEngineOperation & {
    piece: PiecePackage
    propertyName: string
    actionOrTriggerName: string
    flowVersion?: unknown
    input: Record<string, unknown>
    sampleData: Record<string, unknown>
    searchValue?: string
}

export enum StreamStepProgress {
    WEBSOCKET = 'WEBSOCKET',
    NONE = 'NONE',
}

export enum ResumeReason {
    WAITPOINT = 'WAITPOINT',
    RETRY = 'RETRY',
}


export type TriggerBindingInfo = {
    id: string
    projectId: string
    platformId: string
    pieceName: string
    pieceVersion: string
    triggerName: string
    connectionId?: string | null
    promptTemplate?: string
    settings: Record<string, unknown>
    propertySettings?: Record<string, unknown>
    status?: 'ENABLED' | 'DISABLED'
}

export type ExecuteTriggerOperation<HT extends TriggerHookType> = BaseEngineOperation & {
    hookType: HT
    test: boolean
    triggerBinding?: TriggerBindingInfo
    flowVersion?: unknown
    webhookUrl: string
    triggerPayload?: JobPayload
    appWebhookUrl?: string
    webhookSecret?: string | Record<string, string>
}



export const TriggerPayload = z.object({
    body: z.unknown(),
    rawBody: z.unknown().optional(),
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()),
    queryParams: z.record(z.string(), z.string()),
})

export type TriggerPayload<T = unknown> = {
    body: T
    rawBody?: unknown
    method?: string
    headers: Record<string, string>
    queryParams: Record<string, string>
}

export type EventPayload<B = unknown> = {
    body: B
    rawBody?: unknown
    method: string
    headers: Record<string, string>
    queryParams: Record<string, string>
}

export type ParseEventResponse = {
    event?: string
    identifierValue?: string
    reply?: {
        headers: Record<string, string>
        body: unknown
    }
}

export type AppEventListener = {
    events: string[]
    identifierValue: string
}


type ExecuteTestOrRunTriggerResponse = {
    message?: string
    output: unknown[]
}

type ExecuteHandshakeTriggerResponse = {
    message?: string
    response?: {
        status: number
        body?: unknown
        headers?: Record<string, string>
    }
}

type ExecuteOnEnableTriggerResponse = {
    listeners: AppEventListener[]
    scheduleOptions?: ScheduleOptions
}

export const EngineHttpResponse = z.object({
    status: z.number(),
    body: z.unknown(),
    headers: z.record(z.string(), z.string()),
})

export type EngineHttpResponse = z.infer<typeof EngineHttpResponse>

export type ExecuteTriggerResponse<H extends TriggerHookType> = H extends TriggerHookType.RUN ? ExecuteTestOrRunTriggerResponse :
    H extends TriggerHookType.HANDSHAKE ? ExecuteHandshakeTriggerResponse :
        H extends TriggerHookType.TEST ? ExecuteTestOrRunTriggerResponse :
            H extends TriggerHookType.RENEW ? Record<string, never> :
                H extends TriggerHookType.ON_DISABLE ? Record<string, never> :
                    ExecuteOnEnableTriggerResponse

export type ExecuteToolResponse = {
    status: ExecutionToolStatus
    output?: unknown
    resolvedInput: Record<string, unknown>
    errorMessage?: unknown
}

export function normalizeToolOutputToExecuteResponse(
    raw: unknown,
): ExecuteToolResponse {
    if (raw === null || typeof raw !== 'object') {
        return {
            status: ExecutionToolStatus.FAILED,
            output: raw,
            resolvedInput: {},
            errorMessage: 'Invalid tool output',
        }
    }
    const o = raw as Record<string, unknown>
    if (
        o['status'] === ExecutionToolStatus.SUCCESS ||
        o['status'] === ExecutionToolStatus.FAILED
    ) {
        return {
            status: o['status'] as ExecutionToolStatus,
            output: o['output'],
            resolvedInput: (o['resolvedInput'] as Record<string, unknown>) ?? {},
            errorMessage: o['errorMessage'],
        }
    }
    const isError = o['isError'] === true
    let output: unknown = o['structuredContent']
    if (output === undefined && Array.isArray(o['content'])) {
        const parts = (o['content'] as { text?: string }[])
            .map((c) => c?.text)
            .filter(Boolean)
        output =
            parts.length === 1
                ? parts[0]
                : parts.length
                    ? { text: parts.join('') }
                    : o['content']
    }
    if (output === undefined) {
        output = o
    }
    return {
        status: isError ? ExecutionToolStatus.FAILED : ExecutionToolStatus.SUCCESS,
        output,
        resolvedInput: {},
        errorMessage: isError
            ? ((o['content'] as { text?: string }[])?.[0]?.text as string) ??
              (o['message'] as string) ??
              'Tool failed'
            : undefined,
    }
}

export type ExecuteActionResponse = {
    success: boolean
    input: unknown
    output: unknown
    message?: string
}

type BaseExecuteValidateAuthResponseOutput<Valid extends boolean> = {
    valid: Valid
}

type ValidExecuteValidateAuthResponseOutput = BaseExecuteValidateAuthResponseOutput<true>

type InvalidExecuteValidateAuthResponseOutput = BaseExecuteValidateAuthResponseOutput<false> & {
    error: string
}
export type ExecuteValidateAuthResponse =
    | ValidExecuteValidateAuthResponseOutput
    | InvalidExecuteValidateAuthResponseOutput


export type EngineResponse<T = unknown> = {
    status: EngineResponseStatus
    response: T
    error?: string
}

export enum EngineResponseStatus {
    OK = 'OK',
    USER_FAILURE = 'USER_FAILURE',
    INTERNAL_ERROR = 'INTERNAL_ERROR',
    TIMEOUT = 'TIMEOUT',
    MEMORY_ISSUE = 'MEMORY_ISSUE',
    LOG_SIZE_EXCEEDED = 'LOG_SIZE_EXCEEDED',
}

// Runtime rebranded aliases
export type RuntimeOperationType = EngineOperationType
export const RuntimeOperationType = EngineOperationType

export type RuntimeResponse<T = unknown> = EngineResponse<T>
export type RuntimeResponseStatus = EngineResponseStatus
export const RuntimeResponseStatus = EngineResponseStatus

export type RuntimeOperation = EngineOperation
export type BaseRuntimeOperation = BaseEngineOperation

export const RuntimeStdout = EngineStdout
export type RuntimeStdout = EngineStdout

export const RuntimeStderr = EngineStderr
export type RuntimeStderr = EngineStderr

export const RuntimeHttpResponse = EngineHttpResponse
export type RuntimeHttpResponse = EngineHttpResponse

/**
 * Runtime type guards for EngineOperation.
 *
 * These exist to replace the `operation as XOperation` casts that previously
 * silenced the compiler at every dispatch site. A cast asserts a shape the
 * engine never checked, so a malformed or misrouted operation surfaced as a
 * confusing failure deep inside a piece instead of a clear error at the
 * boundary.
 *
 * IMPORTANT - the two auth operations are the SAME TYPE:
 *   export type ExecuteRefreshTokenAuthOperation = ExecuteValidateAuthOperation
 * They are told apart by `operationType` (the switch discriminant), never by
 * shape. Any guard that tries to separate them structurally is wrong: both carry
 * `piece`, `auth` and `timeoutInSeconds` (it comes from BaseEngineOperation and
 * Omit<> only drops `projectId`). So there is deliberately one combined
 * `isExecuteAuthOperation` rather than two mutually exclusive guards.
 */
export function isExecuteToolOperation(op: EngineOperation): op is ExecuteToolOperation {
    return op !== undefined
        && 'pieceName' in op
        && 'actionName' in op
        && 'input' in op
}

/**
 * Covers both EXECUTE_VALIDATE_AUTH and EXECUTE_REFRESH_TOKEN_AUTH - see the
 * note above on why they cannot be told apart by shape.
 */
export function isExecuteAuthOperation(op: EngineOperation): op is ExecuteValidateAuthOperation {
    return op !== undefined
        && 'piece' in op
        && 'auth' in op
        // PropsOptions also carries `piece`, so exclude it explicitly.
        && !('propertyName' in op)
        && !('actionName' in op)
}

export function isExecuteTriggerOperation<H extends TriggerHookType>(op: EngineOperation, hookType?: H): op is ExecuteTriggerOperation<H> {
    return op !== undefined
        && 'hookType' in op
        && (hookType === undefined || op.hookType === hookType)
}

/**
 * ExecuteExtractPieceMetadataOperation and ExecuteToolOperation both carry
 * pieceName, platformId and timeoutInSeconds, so those keys cannot discriminate
 * them. The tool variant always has actionName + input; the extract variant
 * never does.
 */
export function isExecuteExtractPieceMetadataOperation(op: EngineOperation): op is ExecuteExtractPieceMetadataOperation {
    return op !== undefined
        && 'pieceName' in op
        && 'platformId' in op
        && 'timeoutInSeconds' in op
        && !('actionName' in op)
        && !('input' in op)
}

export function isExecutePropsOptions(op: EngineOperation): op is ExecutePropsOptions {
    return op !== undefined
        && 'piece' in op
        && 'propertyName' in op
        && 'actionOrTriggerName' in op
}
