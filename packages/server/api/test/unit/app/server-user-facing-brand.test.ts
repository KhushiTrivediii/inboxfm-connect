import { describe, expect, it } from 'vitest'

// Pins the fork's user-facing brand contract: every surface an end user, IdP admin,
// or external MCP operator sees must say Inboxfm Connect — never the upstream brand.
// The scan checks every occurrence of the brand token per line (any quoting style),
// but only flags occurrences that can reach a user: standalone brand words inside
// string/template literals. Sanctioned, non-user-facing uses are excluded:
//   - longer identifiers (ActivepiecesError, activepiecesTools) — code, not text
//   - the AIProviderName.ACTIVEPIECES enum key (lookups key on the enum)
//   - URL hosts and the MCP resource URI scheme (docs/CDN hosts still resolve upstream)
//   - the 'activepieces-validator' log service name (security-sensitive identifier)
describe('User-facing brand residue (fork rebrand sweep)', () => {
    it('no user-facing string in the audited files still says the upstream brand', async () => {
        const { readFile } = await import('node:fs/promises')
        const { resolve } = await import('node:path')
        const auditedFiles = [
            'src/app/app.ts',
            'src/app/flags/theme.ts',
            'src/app/mcp/mcp-server-builder.ts',
            'src/app/mcp/tools/ap-setup-guide.ts',
            'src/app/mcp/tools/ap-validate-step-config.ts',
            'src/app/mcp/tools/piece-expertise.ts',
            'src/app/agents/mcp-tool-validator.ts',
            'src/app/ai/ai-provider-service.ts',
            'src/app/ai/providers/index.ts',
            'src/app/ee/authentication/saml-authn/saml-client.ts',
            'src/app/ee/scim/scim-discovery-controller.ts',
            'src/app/ee/secret-managers/secret-manager-providers/onepassword-provider.ts',
            'src/app/ee/platform/platform-plan/platform-ai-credits.service.ts',
        ]
        for (const file of auditedFiles) {
            const content = await readFile(resolve(__dirname, '../../..', file), 'utf-8')
            const violations: Array<{ line: string, no: number }> = []
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim()
                if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
                const re = /activepieces/gi
                let m: RegExpExecArray | null
                while ((m = re.exec(line)) !== null) {
                    const end = m.index + m[0].length
                    const nextChar = line[end]
                    // part of a longer identifier — code, not user-facing text
                    if (nextChar !== undefined && /[A-Za-z0-9_$]/.test(nextChar)) continue
                    // the provider enum key
                    if (m[0] === 'ACTIVEPIECES') continue
                    const occurrence = line.slice(m.index, end + 3)
                    // URL hosts and the MCP resource URI scheme
                    if (/activepieces:\/\//i.test(occurrence) || /activepieces\./i.test(occurrence)) continue
                    const prev = m.index > 0 ? line[m.index - 1] : ''
                    if (prev === '.' || prev === '/') continue
                    // log service name — deliberately retained identifier
                    if (line.includes('activepieces-validator')) continue
                    violations.push({ line, no: i + 1 })
                    break
                }
            }
            expect(violations, `${file}: ${JSON.stringify(violations)}`).toEqual([])
        }
    })

    it('the default theme carries the fork name', async () => {
        const { defaultTheme } = await import('../../../src/app/flags/theme')
        expect(defaultTheme.websiteName).toBe('Inboxfm Connect')
        expect(defaultTheme.websiteName.toLowerCase()).not.toContain('activepieces')
    })
})
