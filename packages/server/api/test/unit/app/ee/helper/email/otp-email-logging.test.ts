import { OtpType, UserIdentity } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F44 regression: emailService.sendOtp used to log the raw OTP value at INFO.
// The OTP is a single-use bearer credential for password reset / email
// verification, minted by a public, unauthenticated endpoint — writing it to
// the application log hands a working takeover URL to anyone with log access.
//
// The fix logs the intent (email/identityId/type) without the value.

const { sendMock, internalUrlMock } = vi.hoisted(() => ({
    sendMock: vi.fn(),
    internalUrlMock: vi.fn(async ({ path }: { path: string }) => `https://app.example.com/${path}`),
}))

vi.mock('../../../../../../src/app/ee/helper/email/email-sender/email-sender', () => ({
    emailSender: (_log: FastifyBaseLogger) => ({
        send: sendMock,
    }),
}))

vi.mock('../../../../../../src/app/helper/domain-helper', () => ({
    domainHelper: {
        getInternalUrl: internalUrlMock,
        getPublicUrl: internalUrlMock,
    },
}))

vi.mock('../../../../../../src/app/platform/platform.service', () => ({
    platformService: () => ({ getOneOrThrow: vi.fn(), getOne: vi.fn() }),
}))
vi.mock('../../../../../../src/app/project/project-service', () => ({
    projectService: () => ({ getOneOrThrow: vi.fn() }),
}))
vi.mock('../../../../../../src/app/ee/projects/project-role/project-role.service', () => ({
    projectRoleService: { getOneOrThrowById: vi.fn() },
}))

// The module resolves the edition at import time; a paid edition keeps sendOtp live.
vi.mock('../../../../../../src/app/helper/system/system', () => ({
    system: {
        getEdition: () => 'cloud',
        get: vi.fn(),
    },
}))

import { emailService } from '../../../../../../src/app/ee/helper/email/email-service'

const OTP = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'

const buildIdentity = (): UserIdentity => ({
    id: 'identity-1',
    email: 'victim@example.com',
    platformId: 'platform-1',
    verified: false,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
} as UserIdentity)

const buildLog = (): { log: FastifyBaseLogger, infos: Array<Record<string, unknown>> } => {
    const infos: Array<Record<string, unknown>> = []
    const log = {
        info: (obj: Record<string, unknown>, msg?: string) => {
            infos.push({ ...obj, __msg: msg })
        },
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: () => log,
    } as unknown as FastifyBaseLogger
    return { log, infos }
}

describe('OTP email logging hygiene', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('does not log the raw OTP value when sending a password-reset mail', async () => {
        const { log, infos } = buildLog()
        await emailService(log).sendOtp({
            platformId: 'platform-1',
            userIdentity: buildIdentity(),
            otp: OTP,
            type: OtpType.PASSWORD_RESET,
        })

        expect(JSON.stringify(infos)).not.toContain(OTP)

        const otpLog = infos.find(entry => String(entry.__msg ?? '').includes('sendOtp'))
        expect(otpLog).toBeDefined()
        expect(otpLog).toMatchObject({ email: 'victim@example.com', type: OtpType.PASSWORD_RESET })
    })

    it('does not log the raw OTP value when sending a verify-email mail', async () => {
        const { log, infos } = buildLog()
        await emailService(log).sendOtp({
            platformId: 'platform-1',
            userIdentity: buildIdentity(),
            otp: OTP,
            type: OtpType.EMAIL_VERIFICATION,
        })

        expect(JSON.stringify(infos)).not.toContain(OTP)
    })

    it('never logs the otpcode query fragment on any log call the service makes', async () => {
        const { log, infos } = buildLog()
        await emailService(log).sendOtp({
            platformId: 'platform-1',
            userIdentity: buildIdentity(),
            otp: OTP,
            type: OtpType.PASSWORD_RESET,
        })

        const serialized = JSON.stringify(infos)
        expect(serialized).not.toContain('otpcode')
        expect(serialized).not.toContain(OTP)
    })

    it('still renders the setup link into the template for the actual email', async () => {
        sendMock.mockClear()
        const { log } = buildLog()
        await emailService(log).sendOtp({
            platformId: 'platform-1',
            userIdentity: buildIdentity(),
            otp: OTP,
            type: OtpType.PASSWORD_RESET,
        })

        expect(sendMock).toHaveBeenCalledTimes(1)
        const template = sendMock.mock.calls[0][0].templateData
        expect(template.name).toBe('reset-password')
        expect(template.vars.setupLink).toContain(`otpcode=${OTP}`)
    })

    it('skips sending when identity is already verified and type is EMAIL_VERIFICATION', async () => {
        sendMock.mockClear()
        const { log } = buildLog()
        const identity = buildIdentity()
        identity.verified = true
        await emailService(log).sendOtp({
            platformId: 'platform-1',
            userIdentity: identity,
            otp: OTP,
            type: OtpType.EMAIL_VERIFICATION,
        })

        expect(sendMock).not.toHaveBeenCalled()
    })
})
