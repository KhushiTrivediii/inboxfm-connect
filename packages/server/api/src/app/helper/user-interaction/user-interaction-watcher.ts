import { ActivepiecesError, ErrorCode, PlatformId, ProjectId } from '@inboxfm-connect/core-utils'
import { createSandboxRuntime } from '@inboxfm-connect/sandbox'
import { ApLogger } from '@inboxfm-connect/server-utils'
import { EngineOperation, EngineOperationType, NetworkMode, PiecePackage, WorkerJobType } from '@inboxfm-connect/shared'
import { accessTokenManager } from '../../authentication/lib/access-token-manager'
import { domainHelper } from '../domain-helper'
import { system } from '../system/system'
import { AppSystemProp } from '../system/system-props'

const sandboxRuntime = createSandboxRuntime({
    concurrency: 10,
    basePath: process.cwd(),
    getSettings: () => ({
        EXECUTION_MODE: system.get(AppSystemProp.EXECUTION_MODE) ?? 'UNSANDBOXED',
        SANDBOX_MEMORY_LIMIT: system.get(AppSystemProp.SANDBOX_MEMORY_LIMIT) ?? '1048576',
        FLOW_TIMEOUT_SECONDS: Number(system.get(AppSystemProp.FLOW_TIMEOUT_SECONDS) ?? '60'),
        MAX_FLOW_RUN_LOG_SIZE_MB: Number(system.get(AppSystemProp.MAX_FLOW_RUN_LOG_SIZE_MB) ?? '1'),
        MAX_FILE_SIZE_MB: Number(system.get(AppSystemProp.MAX_FILE_SIZE_MB) ?? '10'),
        NETWORK_MODE: system.get(AppSystemProp.NETWORK_MODE) === NetworkMode.UNRESTRICTED ? NetworkMode.UNRESTRICTED : NetworkMode.STRICT,
        DEV_PIECES: (system.get(AppSystemProp.DEV_PIECES) ?? '').split(',').map(s => s.trim()).filter(Boolean),
        SSRF_ALLOW_LIST: [],
        SANDBOX_PROPAGATED_ENV_VARS: [],
        ENVIRONMENT: system.get(AppSystemProp.ENVIRONMENT) ?? '',
        REUSE_SANDBOX: undefined,
        WORKER_GROUP_ID: 'headless',
        PROJECT_WORKER: false,
    }),
})

let nextWorkerIndex = 0

const userInteractionWatcherImpl = {
    submitAndWaitForResponse: async <T>(request: UserInteractionRequest, log: ApLogger): Promise<T> => {
        let operationType: EngineOperationType
        switch (request.jobType) {
            case WorkerJobType.EXECUTE_PROPERTY:
                operationType = EngineOperationType.EXECUTE_PROPERTY
                break
            case WorkerJobType.EXECUTE_VALIDATION:
                operationType = EngineOperationType.EXECUTE_VALIDATE_AUTH
                break
            case WorkerJobType.EXECUTE_TRIGGER_HOOK:
                operationType = EngineOperationType.EXECUTE_TRIGGER_HOOK
                break
            case WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION:
                operationType = EngineOperationType.EXTRACT_PIECE_METADATA
                break
            case WorkerJobType.EXECUTE_TOKEN_REFRESH:
                operationType = EngineOperationType.EXECUTE_REFRESH_TOKEN_AUTH
                break
            default:
                throw new Error(`Unsupported user interaction job type: ${request.jobType}`)
        }

        const piecePackage: PiecePackage = request.piece

        log.info({ jobType: request.jobType, pieceName: piecePackage.pieceName }, '[userInteractionWatcher] Executing user interaction job synchronously in-process')

        const selectedWorkerIndex = (nextWorkerIndex++) % 10
        const rawPublicApiUrl = await domainHelper.getPublicApiUrl({ path: '' })
        const rawInternalApiUrl = await domainHelper.getInternalApiUrl({ path: '' })
        const publicApiUrl = rawPublicApiUrl.endsWith('/') ? rawPublicApiUrl : `${rawPublicApiUrl}/`
        const internalApiUrl = rawInternalApiUrl.endsWith('/') ? rawInternalApiUrl : `${rawInternalApiUrl}/`
        // The sandbox presents this token to engine API routes (e.g. piece bundle
        // download), which verify it as a real engine principal — placeholder
        // strings are rejected with 401 by those routes' auth.
        const engineToken = await accessTokenManager(log).generateEngineToken({
            projectId: request.projectId,
            platformId: request.platformId,
        })

        // operationType decides the variant, and the engine re-narrows the operation on
        // receipt (operations/index.ts). This is the single point where the per-job-type
        // payload meets the statically-typed union.
        const operation = {
            ...request,
            publicApiUrl,
            internalApiUrl,
            engineToken,
            timeoutInSeconds: 60,
        } as unknown as EngineOperation

        const result = await sandboxRuntime.execute({
            workerIndex: selectedWorkerIndex,
            log,
            operationType,
            operation,
            timeoutInSeconds: 60,
            provision: {
                platformId: request.platformId,
                pieces: [piecePackage],
                codes: [],
                publicApiUrl,
                engineToken,
            },
        })

        if (result.status !== 'OK') {
            throw new ActivepiecesError({
                code: ErrorCode.ENGINE_OPERATION_FAILURE,
                params: {
                    message: result.error || `Execution failed with status: ${result.status}`,
                    status: result.status,
                },
            })
        }

        // Contract: resolves to the operation's BARE result, not the EngineResponse
        // envelope — the envelope's status is checked here, at the single seam.
        // Callers must type the result as the inner payload (e.g.
        // ExecuteValidateAuthResponse); typing it as EngineResponse<T> re-reads a
        // status that no longer exists and misclassifies every success as a
        // failure (#548).
        return result.response as T
    },
}

export const userInteractionWatcher = userInteractionWatcherImpl

// Callers supply the operation-specific payload; the watcher resolves the engine
// context (urls, token, timeout) itself. The payload's remaining shape varies per job
// type — EXTRACT_PIECE_METADATA's operation is the piece package itself, while the
// others nest it under `piece` — so it is not one EngineOperation variant until the
// operationType is resolved below.
type UserInteractionRequest = {
    jobType: WorkerJobType
    piece: PiecePackage
    platformId: PlatformId
    projectId: ProjectId | undefined
    [key: string]: unknown
}
