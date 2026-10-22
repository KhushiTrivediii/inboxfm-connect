import { FastifyBaseLogger } from 'fastify'
import { EmailSender } from './email-sender'

/**
 * Logs sent emails to the console
 */
export const logEmailSender = (log: FastifyBaseLogger): EmailSender => {
    return {
        async send({ emails, platformId, templateData, replyTo }) {
            // templateData.vars carries setup links that embed one-time
            // credentials (e.g. ?otpcode=...) for verify-email /
            // reset-password mails. Log the template name only, mirroring
            // smtpEmailSender#send.
            log.debug({
                name: 'LogEmailSender#send',
                emails,
                platform: { id: platformId },
                template: templateData.name,
                ...(replyTo ? { replyTo } : {}),
            })
        },
    }
}
