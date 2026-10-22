import { describe, expect, it } from 'vitest'
import {
    ConnectionExpiredError,
    ConnectionLoadingError,
    ConnectionNotFoundError,
    EngineFileNotFoundError,
    EngineGenericError,
    ExecutionError,
    ExecutionErrorType,
    FetchError,
    FileSizeError,
    FileStoreError,
    FormulaEvaluationError,
    InvalidCronExpressionError,
    PausedFlowTimeoutError,
    PropsValidationError,
    SSRFBlockedError,
    StorageError,
    StorageInvalidKeyError,
    StorageLimitError,
    VariableNotFoundError,
} from '../../src/lib/engine/execution-errors'

describe('execution-errors', () => {
    describe('base ExecutionError', () => {
        it('initializes name, message, type and cause correctly', () => {
            const cause = new Error('root cause')
            const err = new ExecutionError('CustomError', 'custom message', ExecutionErrorType.ENGINE, cause)

            expect(err).toBeInstanceOf(Error)
            expect(err).toBeInstanceOf(ExecutionError)
            expect(err.name).toBe('CustomError')
            expect(err.message).toBe('custom message')
            expect(err.type).toBe(ExecutionErrorType.ENGINE)
            expect(err.cause).toBe(cause)
        })
    })

    describe('connection errors', () => {
        it('ConnectionNotFoundError is USER type and has ConnectionNotFound name', () => {
            const err = new ConnectionNotFoundError('slack_conn')
            expect(err.name).toBe('ConnectionNotFound')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('connection (slack_conn) not found')
        })

        it('ConnectionLoadingError is USER type with cause passthrough', () => {
            const cause = new Error('network down')
            const err = new ConnectionLoadingError('gmail_conn', cause)
            expect(err.name).toBe('ConnectionLoadingFailure')
            expect(err.type).toBe(ExecutionErrorType.USER)
            expect(err.cause).toBe(cause)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('Failed to load connection (gmail_conn)')
        })

        it('ConnectionExpiredError is USER type', () => {
            const err = new ConnectionExpiredError('notion_conn')
            expect(err.name).toBe('ConnectionExpired')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('connection (notion_conn) expired, reconnect again')
        })
    })

    describe('storage errors', () => {
        it('StorageLimitError records maxStorageSizeInBytes and formats KB limit', () => {
            const err = new StorageLimitError('large_payload', 1024 * 1024)
            expect(err.name).toBe('StorageLimitError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            expect(err.maxStorageSizeInBytes).toBe(1048576)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toContain('larger than 1024 KB')
        })

        it('StorageInvalidKeyError is USER type', () => {
            const err = new StorageInvalidKeyError('bad_key_name')
            expect(err.name).toBe('StorageInvalidKeyError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toContain('bad_key_name')
        })

        it('StorageError and FileStoreError are ENGINE type', () => {
            const storageErr = new StorageError('k1', { detail: 'disk full' })
            expect(storageErr.name).toBe('StorageError')
            expect(storageErr.type).toBe(ExecutionErrorType.ENGINE)

            const fileStoreErr = new FileStoreError({ reason: 's3 failed' })
            expect(fileStoreErr.name).toBe('FileStoreError')
            expect(fileStoreErr.type).toBe(ExecutionErrorType.ENGINE)
        })
    })

    describe('file and network errors', () => {
        it('FileSizeError formats MB limits in JSON message', () => {
            const err = new FileSizeError(15, 10)
            expect(err.name).toBe('FileSizeError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.currentFileSize).toBe('15 MB')
            expect(parsed.maximumSupportSize).toBe('10 MB')
        })

        it('EngineFileNotFoundError is USER type', () => {
            const err = new EngineFileNotFoundError('file-xyz-123')
            expect(err.name).toBe('EngineFileNotFound')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('File (file-xyz-123) no longer exists')
        })

        it('FetchError is ENGINE type', () => {
            const err = new FetchError('https://api.example.com/data')
            expect(err.name).toBe('FetchError')
            expect(err.type).toBe(ExecutionErrorType.ENGINE)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('Failed to fetch from https://api.example.com/data')
        })

        it('PausedFlowTimeoutError formats day limit directly', () => {
            const err = new PausedFlowTimeoutError(undefined, 7)
            expect(err.name).toBe('PausedFlowTimeoutError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            expect(err.message).toBe('The flow cannot be paused for more than 7 days')
        })
    })

    describe('runtime & evaluation errors', () => {
        it('VariableNotFoundError is USER type with formatted JSON', () => {
            const err = new VariableNotFoundError('step_1.output.id')
            expect(err.name).toBe('VariableNotFound')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('variable (step_1.output.id) not found')
        })

        it('InvalidCronExpressionError is USER type with expression string', () => {
            const err = new InvalidCronExpressionError('invalid * cron')
            expect(err.name).toBe('InvalidCronExpressionError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('Invalid cron expression: invalid * cron')
        })

        it('FormulaEvaluationError captures expression and message', () => {
            const err = new FormulaEvaluationError({
                expression: '{{ 1 / 0 }}',
                message: 'Division by zero',
            })
            expect(err.name).toBe('FormulaEvaluationError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toContain('Division by zero (expression: {{ 1 / 0 }})')
        })

        it('EngineGenericError uses provided name and is ENGINE type', () => {
            const err = new EngineGenericError('SandboxCrashError', 'Memory exhausted in isolate')
            expect(err.name).toBe('SandboxCrashError')
            expect(err.type).toBe(ExecutionErrorType.ENGINE)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toBe('Memory exhausted in isolate')
        })

        it('SSRFBlockedError is USER type and details host and resolved IP', () => {
            const err = new SSRFBlockedError({ host: 'internal.corp', ip: '127.0.0.1' })
            expect(err.name).toBe('SSRFBlockedError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            const parsed = JSON.parse(err.message)
            expect(parsed.message).toContain('refusing to connect to internal.corp (resolved 127.0.0.1)')
        })
    })

    describe('PropsValidationError', () => {
        it('formats simple flat field errors', () => {
            const err = new PropsValidationError({
                email: 'invalid email address',
                age: 'must be positive',
            })
            expect(err.name).toBe('PropsValidationError')
            expect(err.type).toBe(ExecutionErrorType.USER)
            expect(err.message).toBe('Property validation failed: email: invalid email address; age: must be positive')
            expect(err.fieldErrors).toEqual({
                email: 'invalid email address',
                age: 'must be positive',
            })
        })

        it('formats array of strings for a single field', () => {
            const err = new PropsValidationError({
                tags: ['cannot be empty', 'max 5 items allowed'],
            })
            expect(err.message).toBe('Property validation failed: tags: cannot be empty, max 5 items allowed')
        })

        it('formats nested object errors recursively', () => {
            const err = new PropsValidationError({
                auth: {
                    apiKey: 'missing required api key',
                },
            })
            expect(err.message).toBe('Property validation failed: auth: apiKey: missing required api key')
        })

        it('formats array of object errors with item indices', () => {
            const err = new PropsValidationError({
                contacts: [
                    { name: 'required' },
                    { phone: 'invalid format' },
                ],
            })
            expect(err.message).toBe('Property validation failed: contacts: item 1: name: required; item 2: phone: invalid format')
        })

        it('handles empty field errors gracefully', () => {
            const err = new PropsValidationError({})
            expect(err.message).toBe('Property validation failed')
        })

        it('ignores undefined values in field errors', () => {
            const err = new PropsValidationError({
                validField: undefined,
                failingField: 'error occurred',
            })
            expect(err.message).toBe('Property validation failed: failingField: error occurred')
        })
    })
})
