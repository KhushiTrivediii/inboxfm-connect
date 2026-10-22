import { STORE_KEY_MAX_LENGTH } from '@inboxfm-connect/core-piece-types'

export enum ExecutionErrorType {
    ENGINE = 'ENGINE',
    USER = 'USER',
}
export class ExecutionError extends Error {

    public type: ExecutionErrorType

    constructor(name: string, message: string, type: ExecutionErrorType, public override cause?: unknown) {
        super(message)
        this.name = name
        this.type = type
    }
}

function formatMessage(message: string) {
    return JSON.stringify({
        message,
    }, null, 2)
}



export class ConnectionNotFoundError extends ExecutionError {
    constructor(connectionName: string, cause?: unknown) {
        super('ConnectionNotFound', formatMessage(`connection (${connectionName}) not found`), ExecutionErrorType.USER, cause)
    }
}

export class ConnectionLoadingError extends ExecutionError {
    constructor(connectionName: string, cause?: unknown) {
        super('ConnectionLoadingFailure', formatMessage(`Failed to load connection (${connectionName})`), ExecutionErrorType.USER, cause)
    }
}

export class ConnectionExpiredError extends ExecutionError {
    constructor(connectionName: string, cause?: unknown) {
        super('ConnectionExpired', formatMessage(`connection (${connectionName}) expired, reconnect again`), ExecutionErrorType.USER, cause)
    }
}

export class StorageLimitError extends ExecutionError {

    public maxStorageSizeInBytes: number

    constructor(key: string, maxStorageSizeInBytes: number, cause?: unknown) {
        super('StorageLimitError', formatMessage(`Failed to read/write key "${key}", the value you are trying to read/write is larger than ${Math.floor(maxStorageSizeInBytes / 1024)} KB`), ExecutionErrorType.USER, cause)
        this.maxStorageSizeInBytes = maxStorageSizeInBytes
    }
}

export class StorageInvalidKeyError extends ExecutionError {
    constructor(key: string, cause?: unknown) {
        super('StorageInvalidKeyError', formatMessage(`Failed to read/write key "${key}", the key is empty or longer than ${STORE_KEY_MAX_LENGTH} characters`), ExecutionErrorType.USER, cause)
    }
}

export class StorageError extends ExecutionError {
    constructor(key: string, cause?: unknown) {
        super('StorageError', formatMessage(`Failed to read/write key "${key}" due to ${JSON.stringify(cause)}`), ExecutionErrorType.ENGINE, cause)
    }
}

export class FileStoreError extends ExecutionError {
    constructor(cause?: unknown) {
        super('FileStoreError', formatMessage(`Failed to store file due to ${JSON.stringify(cause)}`), ExecutionErrorType.ENGINE, cause)
    }
}

export class PausedFlowTimeoutError extends ExecutionError {
    constructor(cause?: unknown, maximumPauseDurationDays?: number) {
        super('PausedFlowTimeoutError', `The flow cannot be paused for more than ${maximumPauseDurationDays} days`, ExecutionErrorType.USER, cause)
    }
}

export class FileSizeError extends ExecutionError {
    constructor(currentFileSize: number, maximumSupportSize: number, cause?: unknown) {
        super('FileSizeError', JSON.stringify({
            message: 'File size is larger than maximum supported size',
            currentFileSize: `${currentFileSize} MB`,
            maximumSupportSize: `${maximumSupportSize} MB`,
        }), ExecutionErrorType.USER, cause)
    }
}

export class FetchError extends ExecutionError {
    constructor(url: string, cause?: unknown) {
        super('FetchError', formatMessage(`Failed to fetch from ${url}`), ExecutionErrorType.ENGINE, cause)
    }
}

export class EngineFileNotFoundError extends ExecutionError {
    constructor(fileId: string, cause?: unknown) {
        super('EngineFileNotFound', formatMessage(`File (${fileId}) no longer exists`), ExecutionErrorType.USER, cause)
    }
}

export class VariableNotFoundError extends ExecutionError {
    constructor(name: string, cause?: unknown) {
        super('VariableNotFound', formatMessage(`variable (${name}) not found`), ExecutionErrorType.USER, cause)
    }
}

export class InvalidCronExpressionError extends ExecutionError {
    constructor(cronExpression: string, cause?: unknown) {
        super('InvalidCronExpressionError', formatMessage(`Invalid cron expression: ${cronExpression}`), ExecutionErrorType.USER, cause)
    }
}

export class FormulaEvaluationError extends ExecutionError {
    constructor({ expression, message, cause }: { expression: string, message: string, cause?: unknown }) {
        super('FormulaEvaluationError', formatMessage(`Formula error: ${message} (expression: ${expression})`), ExecutionErrorType.USER, cause)
    }
}

export class EngineGenericError extends ExecutionError {
    constructor(name: string, message: string, cause?: unknown) {
        super(name, formatMessage(message), ExecutionErrorType.ENGINE, cause)
    }
}

export class SSRFBlockedError extends ExecutionError {
    constructor({ host, ip, cause }: { host: string, ip: string, cause?: unknown }) {
        super(
            'SSRFBlockedError',
            formatMessage(`SSRF protection: refusing to connect to ${host} (resolved ${ip}) — private, loopback, link-local, or multicast address`),
            ExecutionErrorType.USER,
            cause,
        )
    }
}

export type PropsValidationErrors = {
    [key: string]: string[] | string | PropsValidationErrors | PropsValidationErrors[] | undefined
}

export class PropsValidationError extends ExecutionError {
    public readonly fieldErrors: PropsValidationErrors

    constructor(fieldErrors: PropsValidationErrors, cause?: unknown) {
        const readable = PropsValidationError.formatHumanReadable(fieldErrors)
        super('PropsValidationError', readable, ExecutionErrorType.USER, cause)
        this.fieldErrors = fieldErrors
    }

    private static formatFields(fieldErrors: PropsValidationErrors): string {
        const errorEntries = Object.entries(fieldErrors).filter(([, val]) => val !== undefined)
        if (errorEntries.length === 0) {
            return ''
        }
        const formattedFields = errorEntries.map(([key, val]) => {
            if (Array.isArray(val)) {
                const hasObjects = val.some(item => typeof item === 'object' && item !== null)
                if (hasObjects) {
                    const itemDescriptions = (val as Array<Record<string, unknown>>)
                        .map((item, index) => {
                            if (typeof item === 'object' && item !== null) {
                                if (Object.keys(item).length === 0) {
                                    return null
                                }
                                const inner = PropsValidationError.formatFields(item as PropsValidationErrors)
                                return inner ? `item ${index + 1}: ${inner}` : null
                            }
                            return String(item)
                        })
                        .filter(Boolean)
                    return `${key}: ${itemDescriptions.join('; ')}`
                }
                return `${key}: ${val.join(', ')}`
            }
            if (typeof val === 'object' && val !== null) {
                const inner = PropsValidationError.formatFields(val as PropsValidationErrors)
                return `${key}: ${inner}`
            }
            return `${key}: ${String(val)}`
        })
        return formattedFields.join('; ')
    }

    public static formatHumanReadable(fieldErrors: PropsValidationErrors): string {
        const formatted = PropsValidationError.formatFields(fieldErrors)
        return formatted ? `Property validation failed: ${formatted}` : 'Property validation failed'
    }
}
