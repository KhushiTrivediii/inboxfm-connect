import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

type RawFetchAllowance = {
    file: string
    expectedMatches: number
    reason: string
    owner: string
}

const SCAN_ROOTS = [
    'api/src',
    'engine/src',
    'sandbox/src',
    'utils/src',
]

const ALLOWANCES: RawFetchAllowance[] = [
    {
        file: 'utils/src/safe-http.ts',
        expectedMatches: 1,
        reason: 'The SSRF wrapper itself constructs the filtered axios instance',
        owner: 'safeHttp owner',
    },
    {
        file: 'engine/src/lib/handler/context/engine-constants.ts',
        expectedMatches: 1,
        reason: 'Engine-to-platform internal API call against operator-configured apiUrl',
        owner: 'Engine SSRF follow-up, do not extend',
    },
    {
        file: 'engine/src/lib/piece-context/connection-resolver.ts',
        expectedMatches: 1,
        reason: 'Engine-to-platform internal API call against operator-configured apiUrl',
        owner: 'Engine SSRF follow-up, do not extend',
    },
    {
        file: 'engine/src/lib/piece-context/flows.ts',
        expectedMatches: 1,
        reason: 'Engine-to-platform internal API call against operator-configured apiUrl',
        owner: 'Engine SSRF follow-up, do not extend',
    },
    {
        file: 'engine/src/lib/piece-context/variable-resolver.ts',
        expectedMatches: 1,
        reason: 'Engine-to-platform internal API call against operator-configured apiUrl',
        owner: 'Engine SSRF follow-up, do not extend',
    },
    {
        file: 'engine/src/lib/piece-context/waitpoint-client.ts',
        expectedMatches: 1,
        reason: 'Engine-to-platform internal API call against operator-configured apiUrl',
        owner: 'Engine SSRF follow-up, do not extend',
    },
    {
        file: 'engine/src/lib/piece-context/store.ts',
        expectedMatches: 3,
        reason: 'Engine-to-platform internal API calls against operator-configured apiUrl',
        owner: 'Engine SSRF follow-up, do not extend',
    },
    {
        file: 'engine/src/lib/variables/processors/file.ts',
        expectedMatches: 1,
        reason: 'Known risk: fetches flow-data file URLs, needs safeHttp migration with redirect handling',
        owner: 'Engine SSRF follow-up, do not extend',
    },
    {
        file: 'sandbox/src/lib/cache/pieces/piece-installer.ts',
        expectedMatches: 1,
        reason: 'Authenticated engine-token call against operator-configured apiUrl',
        owner: 'Sandbox SSRF follow-up, do not extend',
    },
    {
        file: 'sandbox/src/lib/utils/bundle-http.ts',
        expectedMatches: 2,
        reason: 'Deliberately raw: app-generated S3 pre-signed links, same trust as the S3 SDK client',
        owner: 'Sandbox owner, do not extend',
    },
]

function listSourceFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(full))
            continue
        }
        if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
            files.push(full)
        }
    }
    return files
}

function findRawOutboundCalls({ serverDir }: { serverDir: string }): { file: string, line: number, text: string }[] {
    const fetchPattern = new RegExp('(?<![\\w$.])' + 'fetch' + '\\s*\\(')
    const axiosPattern = new RegExp('axios' + '\\s*\\.\\s*' + 'create' + '\\s*\\(')
    const matches: { file: string, line: number, text: string }[] = []
    for (const root of SCAN_ROOTS) {
        const dir = path.join(serverDir, root)
        if (!fs.existsSync(dir)) {
            continue
        }
        for (const file of listSourceFiles(dir)) {
            const relative = path.relative(serverDir, file).replace(/\\/g, '/')
            const lines = fs.readFileSync(file, 'utf-8').split('\n')
            lines.forEach((line, index) => {
                const code = line.split('//')[0]
                if (fetchPattern.test(code) || axiosPattern.test(code)) {
                    matches.push({ file: relative, line: index + 1, text: line.trim() })
                }
            })
        }
    }
    return matches
}

describe('SSRF guard enforcement (issue #143)', () => {
    const serverDir = path.resolve(__dirname, '../../../../..')

    it('fails when a raw fetch or axios.create appears outside the audited allowlist', () => {
        const matches = findRawOutboundCalls({ serverDir })
        const allowancesByFile = new Map(ALLOWANCES.map((allowance) => [allowance.file, allowance]))
        const unexpected = matches.filter((match) => !allowancesByFile.has(match.file))
        if (unexpected.length > 0) {
            const details = unexpected.map((match) => `  - ${match.file}:${match.line}: ${match.text}`).join('\n')
            expect.fail(
                `Found ${unexpected.length} raw outbound call(s) outside the SSRF allowlist. Route them through safeHttp.axios / safeHttp.createAxios from @inboxfm-connect/server-utils, or document them in ALLOWANCES with maintainer review:\n${details}`,
            )
        }
    })

    it('keeps the allowlist exact so audited sites cannot drift silently', () => {
        const matches = findRawOutboundCalls({ serverDir })
        const counts = new Map<string, number>()
        for (const match of matches) {
            counts.set(match.file, (counts.get(match.file) ?? 0) + 1)
        }
        const stale = ALLOWANCES.filter((allowance) => counts.get(allowance.file) !== allowance.expectedMatches)
        if (stale.length > 0) {
            const details = stale.map((allowance) => `  - ${allowance.file}: expected ${allowance.expectedMatches}, found ${counts.get(allowance.file) ?? 0} (${allowance.reason})`).join('\n')
            expect.fail(
                `SSRF allowlist is stale. If a site was migrated to safeHttp, remove its entry. If a raw call was added, migrate it instead:\n${details}`,
            )
        }
    })
})
