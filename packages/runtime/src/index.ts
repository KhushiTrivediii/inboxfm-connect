import { PieceMetadata } from '@inboxfm-connect/pieces-framework'
import { createSandboxRuntime } from '@inboxfm-connect/sandbox'
import { AppConnection, EngineOperationType, PackageType, PiecePackage, PieceType } from '@inboxfm-connect/shared'

export class HeadlessRuntime<TConnection extends RuntimeConnection> {
    private sandboxRuntime: ReturnType<typeof createSandboxRuntime>
    private executionTail: Promise<void> = Promise.resolve()

    constructor(private config: RuntimeConfig<TConnection>) {
        this.sandboxRuntime = createSandboxRuntime({
            concurrency: 1,
            basePath: config.basePath,
            getSettings: config.getSettings,
        })
    }

    async execute(params: ExecuteParams): Promise<unknown> {
        const connection = await this.config.database.getConnection({ connectionId: params.connectionId })
        if (!connection) {
            throw new Error(`Connection not found: ${params.connectionId}`)
        }

        const decryptedConnection = await this.config.decryptAndRefresh({ connection })
        if (!decryptedConnection) {
            throw new Error(`Connection refresh failed: ${params.connectionId}`)
        }
        const decryptedValue = decryptedConnection.value

        const piecePackage: PiecePackage = {
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
            pieceName: params.integration,
            pieceVersion: connection.pieceVersion,
        }

        const result = await this.executeSandbox({
            workerIndex: 0,
            log: this.config.log,
            operationType: EngineOperationType.EXECUTE_TOOL,
            operation: {
                projectId: params.projectId,
                platformId: params.platformId,
                engineToken: 'headless',
                internalApiUrl: params.internalApiUrl || 'http://localhost:3000',
                publicApiUrl: params.publicApiUrl || 'http://localhost:3000',
                timeoutInSeconds: 60,
                pieceName: params.integration,
                pieceVersion: connection.pieceVersion,
                actionName: params.tool,
                input: params.input,
                auth: decryptedValue,
            },
            timeoutInSeconds: 60,
            provision: {
                platformId: params.platformId,
                pieces: [piecePackage],
                codes: [],
                publicApiUrl: params.publicApiUrl || 'http://localhost:3000',
                engineToken: 'headless',
            },
        })

        if (result.status !== 'OK') {
            throw new Error(result.error || `Execution failed with status: ${result.status}`)
        }

        return result.response
    }

    async connect(params: ConnectParams<TConnection>): Promise<unknown> {
        return this.config.database.saveConnection({ connection: params })
    }

    async disconnect(params: DisconnectParams): Promise<void> {
        await this.config.database.deleteConnection({ connectionId: params.connectionId })
    }

    async refreshToken(params: RefreshParams): Promise<unknown> {
        const connection = await this.config.database.getConnection({ connectionId: params.connectionId })
        if (!connection) {
            throw new Error(`Connection not found: ${params.connectionId}`)
        }
        return this.config.decryptAndRefresh({ connection })
    }

    async listTools(params: ListParams): Promise<unknown[]> {
        const piecePackage: PiecePackage = {
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
            pieceName: params.integration,
            pieceVersion: params.version || 'latest',
        }

        const result = await this.executeSandbox({
            workerIndex: 0,
            log: this.config.log,
            operationType: EngineOperationType.EXTRACT_PIECE_METADATA,
            operation: {
                ...piecePackage,
                platformId: params.platformId,
                timeoutInSeconds: 60,
            },
            timeoutInSeconds: 60,
            provision: {
                platformId: params.platformId,
                pieces: [piecePackage],
                codes: [],
                publicApiUrl: params.publicApiUrl || 'http://localhost:3000',
                engineToken: 'headless',
            },
        })

        if (result.status !== 'OK') {
            throw new Error(result.error || `Failed to extract metadata: ${result.status}`)
        }

        const metadata = PieceMetadata.parse(result.response)
        return Object.values(metadata.actions).map((action) => ({
            name: action.name,
            displayName: action.displayName,
            description: action.description,
            inputSchema: action.props,
        }))
    }

    async getConnection(params: GetConnectionParams): Promise<unknown> {
        const connection = await this.config.database.getConnection({ connectionId: params.connectionId })
        if (!connection) {
            throw new Error(`Connection not found: ${params.connectionId}`)
        }
        return this.config.decryptAndRefresh({ connection })
    }

    private executeSandbox(params: Parameters<ReturnType<typeof createSandboxRuntime>['execute']>[0]): ReturnType<ReturnType<typeof createSandboxRuntime>['execute']> {
        const execution = this.executionTail.then(() => this.sandboxRuntime.execute(params))
        this.executionTail = execution.then(() => undefined, () => undefined)
        return execution
    }
}

type RuntimeConnection = Omit<AppConnection, 'value'> & { value: unknown }

export type RuntimeConfig<TConnection extends RuntimeConnection = AppConnection> = {
    basePath: string
    log: Parameters<ReturnType<typeof createSandboxRuntime>['execute']>[0]['log']
    getSettings: Parameters<typeof createSandboxRuntime>[0]['getSettings']
    database: {
        getConnection(params: { connectionId: string }): Promise<TConnection | null>
        saveConnection(params: { connection: TConnection }): Promise<unknown>
        deleteConnection(params: { connectionId: string }): Promise<void>
    }
    decryptAndRefresh(params: { connection: TConnection }): Promise<AppConnection | null>
}

export type ConnectParams<TConnection extends RuntimeConnection = AppConnection> = TConnection

export type DisconnectParams = {
    connectionId: string
}

export type ExecuteParams = {
    integration: string
    tool: string
    connectionId: string
    input: Record<string, unknown>
    projectId: string
    platformId: string
    internalApiUrl?: string
    publicApiUrl?: string
}

export type RefreshParams = {
    connectionId: string
}

export type ListParams = {
    integration: string
    platformId: string
    version?: string
    publicApiUrl?: string
}

export type GetConnectionParams = {
    connectionId: string
}
