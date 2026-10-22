import { ApEdition } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F44 regression: smtpEmailSender.send used to log the entire templateData
// object at INFO before sendMail. For verify-email / reset-password mails
// templateData.vars.setupLink embeds the one-time credential
// (?otpcode=...&identityId=...), so every password-reset request wrote a
// complete, usable account-takeover URL into the application log.
//
// The fix logs the template NAME only.

const { sendMailMock } = vi.hoisted(() => ({
    sendMailMock: vi.fn(async () => true),
}))

vi.mock('nodemailer', () => ({
    default: {
        createTransport: () => ({
            sendMail: sendMailMock,
            verify: vi.fn(async () => true),
        }),
    },
    createTransport: () => ({
        sendMail: sendMailMock,
        verify: vi.fn(async () => true),
    }),
}))

vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(async (path: string) => path.endsWith('footer.html') ? '<footer/>' : '<html>{{setupLink}}</html>'),
}))

vi.mock('../../../../../../src/app/platform/platform.service', () => ({
    platformService: () => ({ getOne: vi.fn(async () => null) }),
}))

vi.mock('../../../../../../src/app/helper/system/system', () => ({
    system: {
        get: vi.fn((prop: string) => {
            const table: Record<string, string> = {
                ENVIRONMENT: 'prod',
                SMTP_HOST: 'smtp.example.com',
                SMTP_PORT: '587',
                SMTP_USERNAME: 'user',
                SMTP_PASSWORD: 'pass',
                SMTP_SENDER_NAME: 'Sender',
                SMTP_SENDER_EMAIL: 'sender@example.com',
            }
            return table[prop]
        }),
        getEdition: () => ApEdition.CLOUD,
        getOrThrow: vi.fn((prop: string) => {
            const table: Record<string, string> = {
                SMTP_HOST: 'smtp.example.com',
                SMTP_PORT: '587',
                SMTP_USERNAME: 'user',
                SMTP_PASSWORD: 'pass',
                ENVIRONMENT: 'prod',
            }
            return table[prop]
        }),
        globalLogger: vi.fn(),
        getNumber: vi.fn(() => null),
        getNumberOrThrow: vi.fn(() => 0),
        getBoolean: vi.fn(() => undefined),
        getBooleanOrThrow: vi.fn(() => true),
        getList: vi.fn(() => []),
        isWorker: vi.fn(() => false),
        isApp: vi.fn(() => true),
    },
}))

import { smtpEmailSender } from '../../../../../../src/app/ee/helper/email/email-sender/smtp-email-sender'

const OTP = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'
const SETUP_LINK = `https://app.example.com/reset-password?otpcode=${OTP}&identityId=identity-1`

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

describe('SMTP email sender logging hygiene', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('does not log templateData (setup link embeds the OTP)', async () => {
        const { log, infos } = buildLog()
        await smtpEmailSender(log).send({
            emails: ['victim@example.com'],
            platformId: 'platform-1',
            templateData: {
                name: 'reset-password',
                vars: { setupLink: SETUP_LINK },
            },
        })

        const serialized = JSON.stringify(infos)
        expect(serialized).not.toContain('otpcode')
        expect(serialized).not.toContain(OTP)

        // intent preserved: template name logged instead
        const sendLog = infos.find(entry => String(entry.__msg ?? '').includes('smtpEmailSender#send'))
        expect(sendLog).toBeDefined()
        expect(sendLog).toMatchObject({ template: 'reset-password' })
    })

    it('still sends the rendered mail with the setup link intact', async () => {
        sendMailMock.mockClear()
        const { log } = buildLog()
        await smtpEmailSender(log).send({
            emails: ['victim@example.com'],
            platformId: 'platform-1',
            templateData: {
                name: 'reset-password',
                vars: { setupLink: SETUP_LINK },
            },
        })

        expect(sendMailMock).toHaveBeenCalledTimes(1)
        const mail = sendMailMock.mock.calls[0][0] as { to: string, html: string }
        expect(mail.to).toBe('victim@example.com')
        // Mustache HTML-escapes the URL, so assert on the embedded OTP value
        // rather than the raw link.
        expect(mail.html).toContain(OTP)
    })
})
