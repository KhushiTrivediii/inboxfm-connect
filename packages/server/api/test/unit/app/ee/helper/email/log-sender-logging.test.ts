import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F44 regression (issue #461, codeant follow-up): the email-sender factory
// falls back to logEmailSender in TESTING environments and whenever SMTP is
// not configured. It used to log the whole templateData object at debug —
// for verify-email / reset-password mails that leaked the OTP-bearing setup
// link into the log. The fix logs the template NAME only.

const { systemGetMock } = vi.hoisted(() => ({
    systemGetMock: vi.fn(),
}))

vi.mock('../../../../../../src/app/helper/system/system', () => ({
    system: {
        get: systemGetMock,
        getOrThrow: vi.fn(() => 'DEFAULT'),
        getEdition: vi.fn(() => 'cloud'),
        getNumber: vi.fn(() => null),
        getBoolean: vi.fn(() => undefined),
        getList: vi.fn(() => []),
        isWorker: vi.fn(() => false),
        isApp: vi.fn(() => true),
        globalLogger: vi.fn(),
    },
}))

import { emailSender } from '../../../../../../src/app/ee/helper/email/email-sender/email-sender'
import { logEmailSender } from '../../../../../../src/app/ee/helper/email/email-sender/log-email-sender'

const OTP = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'
const SETUP_LINK = `https://app.example.com/reset-password?otpcode=${OTP}&identityId=identity-1`

const buildLog = (): { log: FastifyBaseLogger, debugs: Array<Record<string, unknown>> } => {
    const debugs: Array<Record<string, unknown>> = []
    const log = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: (obj: Record<string, unknown>) => {
            debugs.push({ ...obj })
        },
        fatal: vi.fn(),
        trace: vi.fn(),
        child: () => log,
    } as unknown as FastifyBaseLogger
    return { log, debugs }
}

describe('log email sender logging hygiene', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('does not log templateData (setup link embeds the OTP)', async () => {
        const { log, debugs } = buildLog()
        await logEmailSender(log).send({
            emails: ['victim@example.com'],
            platformId: 'platform-1',
            templateData: {
                name: 'reset-password',
                vars: { setupLink: SETUP_LINK },
            },
        })

        const serialized = JSON.stringify(debugs)
        expect(serialized).not.toContain('otpcode')
        expect(serialized).not.toContain(OTP)

        const sendLog = debugs.find(entry => entry.name === 'LogEmailSender#send')
        expect(sendLog).toBeDefined()
        expect(sendLog).toMatchObject({ template: 'reset-password' })
    })

    it('factory picks the log sender in TESTING and it stays credential-free', async () => {
        systemGetMock.mockImplementation((prop: string) => (prop === 'ENVIRONMENT' ? 'testing' : undefined))
        const { log, debugs } = buildLog()
        await emailSender(log).send({
            emails: ['victim@example.com'],
            platformId: 'platform-1',
            templateData: {
                name: 'reset-password',
                vars: { setupLink: SETUP_LINK },
            },
        })

        const serialized = JSON.stringify(debugs)
        expect(serialized).not.toContain('otpcode')
        expect(serialized).not.toContain(OTP)
    })
})
