import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import { wideEvent } from '@inboxfm-connect/server-utils'
import { parseError } from 'evlog'
import { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { exceptionHandler } from './exception-handler'


export const errorHandler = async (
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> => {
    if (error instanceof ActivepiecesError) {
        const statusCode = statusCodeMap[error.error.code] ?? StatusCodes.BAD_REQUEST

        if (error.error.code === ErrorCode.PROJECT_EXECUTION_CONCURRENCY_LIMIT_EXCEEDED) {
            void reply.header('Retry-After', String(error.error.params.retryAfterSeconds))
        }
        else if (error.error.code === ErrorCode.PROJECT_RATE_LIMIT_EXCEEDED || error.error.code === ErrorCode.API_KEY_RATE_LIMIT_EXCEEDED) {
            void reply.header('Retry-After', String(error.error.params.windowSeconds))
        }

        // The public-ingress limiter returns the remaining seconds of its fixed
        // window so the caller (and any well-behaved proxy) can back off exactly
        // as long as needed instead of retrying into the same window (#351).
        if (error.error.code === ErrorCode.PUBLIC_INGRESS_RATE_LIMIT_EXCEEDED) {
            void reply.header('Retry-After', String(error.error.params.windowSeconds))
        }

        await reply.status(statusCode).send({
            code: error.error.code,
            params: error.error.params,
        })
    }
    else {
        if (
            !error.statusCode ||
      error.statusCode === StatusCodes.INTERNAL_SERVER_ERROR.valueOf()
        ) {
            exceptionHandler.handle(error, request.log)
        }
        await reply
            .status(error.statusCode ?? StatusCodes.INTERNAL_SERVER_ERROR)
            .send(error)
    }
}

// Runs from an onError hook registered BEFORE the evlog fastify plugin, so the
// fields land on the wide event before the plugin's own onError hook emits it.
export const enrichWideEventWithError = (error: unknown): void => {
    if (error instanceof ActivepiecesError) {
        const statusCode = statusCodeMap[error.error.code] ?? StatusCodes.BAD_REQUEST
        const wideErrorFields: WideErrorFields = {
            code: error.error.code,
            status: statusCode,
            params: error.error.params,
        }
        if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
            wideErrorFields.stack = error.stack
        }
        wideEvent.set({ error: wideErrorFields })
        return
    }
    const parsed = parseError(error)
    const fastifyStatusCode = hasStatusCode(error) ? error.statusCode : undefined
    const statusCode = parsed.status !== StatusCodes.INTERNAL_SERVER_ERROR.valueOf() && fastifyStatusCode
        ? fastifyStatusCode
        : parsed.status
    const wideErrorFields: WideErrorFields = {
        code: parsed.code ?? 'UNKNOWN',
        status: statusCode,
    }
    if (parsed.why !== undefined) {
        wideErrorFields.why = parsed.why
    }
    if (parsed.fix !== undefined) {
        wideErrorFields.fix = parsed.fix
    }
    if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR.valueOf() && error instanceof Error) {
        wideErrorFields.stack = error.stack
    }
    wideEvent.set({ error: wideErrorFields })
}

function hasStatusCode(error: unknown): error is { statusCode: number } {
    if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
        return false
    }
    return typeof error.statusCode === 'number'
}

const statusCodeMap: Partial<Record<ErrorCode, StatusCodes>> = {
    [ErrorCode.INVALID_API_KEY]: StatusCodes.UNAUTHORIZED,
    [ErrorCode.INVALID_BEARER_TOKEN]: StatusCodes.UNAUTHORIZED,
    [ErrorCode.QUOTA_EXCEEDED]: StatusCodes.PAYMENT_REQUIRED,
    [ErrorCode.PIECE_SYNC_NOT_SUPPORTED]: StatusCodes.BAD_REQUEST,
    [ErrorCode.FEATURE_DISABLED]: StatusCodes.PAYMENT_REQUIRED,
    [ErrorCode.AI_CREDIT_LIMIT_EXCEEDED]: StatusCodes.PAYMENT_REQUIRED,
    [ErrorCode.PERMISSION_DENIED]: StatusCodes.FORBIDDEN,
    [ErrorCode.ENTITY_NOT_FOUND]: StatusCodes.NOT_FOUND,
    [ErrorCode.EXISTING_USER]: StatusCodes.CONFLICT,
    [ErrorCode.EXISTING_ALERT_CHANNEL]: StatusCodes.CONFLICT,
    [ErrorCode.FLOW_OPERATION_IN_PROGRESS]: StatusCodes.CONFLICT,
    [ErrorCode.AUTHORIZATION]: StatusCodes.FORBIDDEN,
    [ErrorCode.SIGN_UP_DISABLED]: StatusCodes.FORBIDDEN,
    [ErrorCode.PROJECT_EXTERNAL_ID_ALREADY_EXISTS]: StatusCodes.CONFLICT,
    [ErrorCode.INVALID_CREDENTIALS]: StatusCodes.UNAUTHORIZED,
    [ErrorCode.SESSION_EXPIRED]: StatusCodes.FORBIDDEN,
    [ErrorCode.EMAIL_IS_NOT_VERIFIED]: StatusCodes.FORBIDDEN,
    [ErrorCode.USER_IS_INACTIVE]: StatusCodes.FORBIDDEN,
    [ErrorCode.DOMAIN_NOT_ALLOWED]: StatusCodes.FORBIDDEN,
    [ErrorCode.EMAIL_AUTH_DISABLED]: StatusCodes.FORBIDDEN,
    [ErrorCode.INVALID_SMTP_CREDENTIALS]: StatusCodes.BAD_REQUEST,
    [ErrorCode.INVALID_GIT_CREDENTIALS]: StatusCodes.BAD_REQUEST,
    [ErrorCode.INVALID_OTP]: StatusCodes.GONE,
    [ErrorCode.VALIDATION]: StatusCodes.CONFLICT,
    [ErrorCode.INVITATION_ONLY_SIGN_UP]: StatusCodes.FORBIDDEN,
    [ErrorCode.AUTHENTICATION]: StatusCodes.UNAUTHORIZED,
    [ErrorCode.INVALID_LICENSE_KEY]: StatusCodes.BAD_REQUEST,
    [ErrorCode.EMAIL_ALREADY_HAS_ACTIVATION_KEY]: StatusCodes.CONFLICT,
    [ErrorCode.MCP_PIECE_REQUIRES_CONNECTION]: StatusCodes.BAD_REQUEST,
    [ErrorCode.MCP_PIECE_CONNECTION_MISMATCH]: StatusCodes.BAD_REQUEST,
    [ErrorCode.DOES_NOT_MEET_BUSINESS_REQUIREMENTS]: StatusCodes.UNPROCESSABLE_ENTITY,
    [ErrorCode.FLOW_RUN_RETRY_OUTSIDE_RETENTION]: StatusCodes.GONE,
    [ErrorCode.SANDBOX_CAPACITY_EXCEEDED]: StatusCodes.TOO_MANY_REQUESTS,
    [ErrorCode.CHAT_CONTEXT_LIMIT_EXCEEDED]: StatusCodes.BAD_REQUEST,
    [ErrorCode.PROJECT_RATE_LIMIT_EXCEEDED]: StatusCodes.TOO_MANY_REQUESTS,
    [ErrorCode.SIGN_IN_ATTEMPTS_EXCEEDED]: StatusCodes.TOO_MANY_REQUESTS,
    [ErrorCode.CAPTCHA_VERIFICATION_FAILED]: StatusCodes.BAD_REQUEST,
    [ErrorCode.API_KEY_RATE_LIMIT_EXCEEDED]: StatusCodes.TOO_MANY_REQUESTS,
    [ErrorCode.PUBLIC_INGRESS_RATE_LIMIT_EXCEEDED]: StatusCodes.TOO_MANY_REQUESTS,
    [ErrorCode.PROJECT_EXECUTION_CONCURRENCY_LIMIT_EXCEEDED]: StatusCodes.TOO_MANY_REQUESTS,
}

type WideErrorFields = {
    code: string
    status: number
    params?: unknown
    why?: string
    fix?: string
    stack?: string
}
