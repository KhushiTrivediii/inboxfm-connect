import { readFile } from 'node:fs/promises'
import { isNil, spreadIfDefined, tryCatch } from '@inboxfm-connect/core-utils'
import { ApEdition, ApEnvironment, PlatformWithoutFederatedAuth } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import Mustache from 'mustache'
import nodemailer, { Transporter } from 'nodemailer'
import tinycolor from 'tinycolor2'
import { defaultTheme } from '../../flags/theme'
import { platformService } from '../../platform/platform.service'
import { system } from '../system/system'
import { AppSystemProp } from '../system/system-props'

const EMAIL_ASSETS_DIRECTORY = 'packages/server/api/src/assets/emails'
const FOOTER_PARTIAL_NAME = 'footer'
const SMTP_SECURE_PORT = 465
// The mailing address is only rendered on the Cloud edition, mirroring the
// footer partial contract used by the existing templates.
const CLOUD_FOOTER_ADDRESS = 'Activepieces, Inc. 398 11th Street, 2nd floor, San Francisco, CA 94103'
const REQUIRED_SMTP_SYSTEM_PROPS = [
    AppSystemProp.SMTP_HOST,
    AppSystemProp.SMTP_PORT,
    AppSystemProp.SMTP_USERNAME,
    AppSystemProp.SMTP_PASSWORD,
    AppSystemProp.SMTP_SENDER_NAME,
    AppSystemProp.SMTP_SENDER_EMAIL,
]

export const smtpEmailSender = (log: FastifyBaseLogger): SMTPEmailSender => ({
    isSmtpConfigured: () => isSmtpSystemConfigured(),

    async send({ platformId, recipients, replyTo, template, vars }: SendEmailParams): Promise<void> {
        if (system.get(AppSystemProp.ENVIRONMENT) === ApEnvironment.TESTING) {
            // The automated test suite must never deliver real mail, even when
            // SMTP credentials happen to be present in the test environment.
            log.debug({ template, recipients }, '[smtpEmailSender#send] skipping email in testing environment')
            return
        }
        if (!isSmtpSystemConfigured()) {
            log.error({ template }, '[smtpEmailSender#send] SMTP is not configured, skipping email')
            return
        }
        const { error } = await tryCatch(async () => {
            const platform = platformId ? await platformService(log).getOne(platformId) : null
            const html = await renderEmailBody({ platform, template, vars })
            await createSmtpTransport().sendMail({
                from: buildFromHeader(),
                to: recipients.join(','),
                subject: buildEmailSubject({ template, vars }),
                html,
                ...spreadIfDefined('replyTo', replyTo),
            })
            log.info({
                template,
                platform: { id: platformId },
                recipientCount: recipients.length,
            }, '[smtpEmailSender#send] email sent')
        })
        if (!isNil(error)) {
            log.error({
                error,
                template,
                platform: { id: platformId },
                recipientCount: recipients.length,
            }, '[smtpEmailSender#send] failed to send email')
            throw error
        }
    },
})

function isSmtpSystemConfigured(): boolean {
    return REQUIRED_SMTP_SYSTEM_PROPS.every((prop) => !isNil(system.get(prop)))
}

function buildFromHeader(): string {
    const senderName = system.getOrThrow(AppSystemProp.SMTP_SENDER_NAME)
    const senderEmail = system.getOrThrow(AppSystemProp.SMTP_SENDER_EMAIL)
    return `${senderName} <${senderEmail}>`
}

function createSmtpTransport(): Transporter {
    const port = Number.parseInt(system.getOrThrow(AppSystemProp.SMTP_PORT))
    return nodemailer.createTransport({
        host: system.getOrThrow(AppSystemProp.SMTP_HOST),
        port,
        secure: port === SMTP_SECURE_PORT,
        auth: {
            user: system.getOrThrow(AppSystemProp.SMTP_USERNAME),
            pass: system.getOrThrow(AppSystemProp.SMTP_PASSWORD),
        },
    })
}

export function buildEmailSubject({ template, vars }: BuildEmailSubjectParams): string {
    switch (template) {
        case 'invitation-email':
            return `You have been invited to the "${vars.projectName}" project ✉️`
        case 'project-member-added':
            return `Welcome to ${vars.projectName} 🎉`
    }
}

async function renderEmailBody({ platform, template, vars }: RenderEmailBodyParams): Promise<string> {
    const [templateHtml, footerHtml] = await Promise.all([
        readFile(`${EMAIL_ASSETS_DIRECTORY}/${template}.html`, 'utf-8'),
        readFile(`${EMAIL_ASSETS_DIRECTORY}/${FOOTER_PARTIAL_NAME}.html`, 'utf-8'),
    ])
    const primaryColor = platform?.primaryColor ?? defaultTheme.colors.primary.default
    return Mustache.render(templateHtml, {
        ...vars,
        primaryColor,
        // Match the light tint the web theme derives from the platform's
        // primary color, so emails and dashboard agree on the brand palette.
        primaryColorLight: tinycolor.mix('#ffffff', primaryColor, 12).toHexString(),
        fullLogoUrl: platform?.fullLogoUrl ?? defaultTheme.logos.fullLogoUrl,
        platformName: platform?.name ?? defaultTheme.websiteName,
        footerContent: system.getEdition() === ApEdition.CLOUD ? CLOUD_FOOTER_ADDRESS : '',
    }, {
        [FOOTER_PARTIAL_NAME]: footerHtml,
    })
}

export type SMTPEmailSender = {
    isSmtpConfigured: () => boolean
    send: (params: SendEmailParams) => Promise<void>
}

export type EmailTemplateName = 'invitation-email' | 'project-member-added'

export type SendEmailParams = {
    recipients: string[]
    platformId: string | undefined
    template: EmailTemplateName
    vars: Record<string, string>
    replyTo?: string
}

type RenderEmailBodyParams = {
    platform: PlatformWithoutFederatedAuth | null
    template: EmailTemplateName
    vars: Record<string, string>
}

type BuildEmailSubjectParams = {
    template: EmailTemplateName
    vars: Record<string, string>
}
