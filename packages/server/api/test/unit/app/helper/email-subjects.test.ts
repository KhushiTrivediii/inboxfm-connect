import { describe, expect, it } from 'vitest'
import { defaultTheme } from '../../../../src/app/flags/theme'
import { getEmailSubject } from '../../../../src/app/ee/helper/email/email-sender/smtp-email-sender'
import { buildEmailSubject } from '../../../../src/app/helper/email/smtp-email-sender'

describe('Email subject formatting (Issue #355)', () => {
    describe('CE buildEmailSubject', () => {
        it('includes the article "the" in invitation-email subject', () => {
            const subject = buildEmailSubject({
                template: 'invitation-email',
                vars: { projectName: 'Acme Automations' },
            })
            expect(subject).toBe('You have been invited to the "Acme Automations" project ✉️')
        })

        it('formats project-member-added subject correctly', () => {
            const subject = buildEmailSubject({
                template: 'project-member-added',
                vars: { projectName: 'Acme Automations' },
            })
            expect(subject).toBe('Welcome to Acme Automations 🎉')
        })
    })

    describe('EE getEmailSubject', () => {
        it('includes the article "the" in invitation-email subject', () => {
            const subject = getEmailSubject({
                templateName: 'invitation-email',
                vars: { projectName: 'Acme Automations' },
            })
            expect(subject).toBe('You have been invited to the "Acme Automations" project ✉️')
        })

        it('includes platform name in scim-user-welcome subject', () => {
            const subject = getEmailSubject({
                templateName: 'scim-user-welcome',
                vars: { loginLink: 'https://example.com/login' },
                platformName: 'Custom Platform',
            })
            expect(subject).toBe('Welcome to Custom Platform 🎉')
        })

        it('falls back to defaultTheme.websiteName in scim-user-welcome when platformName is omitted', () => {
            const subject = getEmailSubject({
                templateName: 'scim-user-welcome',
                vars: { loginLink: 'https://example.com/login' },
            })
            expect(subject).toBe(`Welcome to ${defaultTheme.websiteName} 🎉`)
        })

        it('formats remaining email subjects accurately', () => {
            expect(getEmailSubject({
                templateName: 'project-member-added',
                vars: { projectName: 'Acme Automations' },
            })).toBe('Welcome to Acme Automations 🎉')

            expect(getEmailSubject({
                templateName: 'verify-email',
                vars: { setupLink: 'https://example.com/verify' },
            })).toBe('Verify your email address ✅')

            expect(getEmailSubject({
                templateName: 'reset-password',
                vars: { link: 'https://example.com/reset' },
            })).toBe('Reset your password 🔑')

            expect(getEmailSubject({
                templateName: 'issue-created',
                vars: { projectName: 'Acme', flowName: 'Sync Contacts' },
            })).toBe('[Acme] Flow has an issue "Sync Contacts" ⚠️')

            expect(getEmailSubject({
                templateName: 'chat-notification',
                vars: { subject: 'New message from support' },
            })).toBe('New message from support')
        })
    })
})
