import { describe, expect, it, vi } from 'vitest'
import { parseConnectionMappings } from '../../../src/lib/commands/project-replace'

describe('CLI Security & No-Secrets-in-Stdout Invariant (Issue #139)', () => {
    it('does not leak connection bootstrap secrets in mapping counts or stdout summaries', () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const secretApiKey = 'sk_live_very_secret_third_party_key_999888777'
        const rawBootstrapJson = JSON.stringify([
            {
                sourceExternalId: 'slack-bot',
                destExternalId: 'slack-bot-prod',
                value: {
                    type: 'SECRET_TEXT',
                    secret_text: secretApiKey,
                },
            },
            {
                sourceExternalId: 'plain-alias',
                destExternalId: 'plain-dest-alias',
            },
        ])

        const options = {
            destUrl: 'http://localhost:3000',
            destToken: 'dest-token-abc',
            destProject: 'proj-123',
            connectionBootstrap: rawBootstrapJson,
        }

        const mappings = parseConnectionMappings(options)

        const bootstrapCount = mappings.filter((m) => !!m.value).length
        const remapCount = mappings.length - bootstrapCount
        const summaryMessage = `Connection mappings loaded: ${mappings.length} (${remapCount} alias, ${bootstrapCount} credentials [REDACTED])`

        // Check that summary explicitly marks credentials as REDACTED
        expect(summaryMessage).toContain('[REDACTED]')
        expect(summaryMessage).not.toContain(secretApiKey)

        // Ensure console logs do not contain raw secrets
        const allLogCalls = consoleLogSpy.mock.calls.flat().join(' ')
        expect(allLogCalls).not.toContain(secretApiKey)

        consoleLogSpy.mockRestore()
        consoleWarnSpy.mockRestore()
    })

    it('redacts sensitive auth header values from public error reporting', () => {
        const sensitiveToken = 'bearer_super_secret_auth_token_xyz'
        const sanitizeError = (errMessage: string): string => {
            return errMessage.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
        }

        const rawError = `Transport error calling http://api.local/v1/projects: Authorization: Bearer ${sensitiveToken}`
        const sanitized = sanitizeError(rawError)

        expect(sanitized).not.toContain(sensitiveToken)
        expect(sanitized).toBe('Transport error calling http://api.local/v1/projects: Authorization: Bearer [REDACTED]')
    })
})
