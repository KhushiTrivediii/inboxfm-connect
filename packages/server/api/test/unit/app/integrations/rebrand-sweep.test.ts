import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Issue #178 — the fork rebranded Activepieces -> Inboxfm Connect, but the sweep
 * was done file-by-file and pieces kept being added afterwards. Several strings
 * that users actually see survived: the webhook names created inside a customer's
 * Zendesk project ("Activepieces New Ticket Webhook - 1712..."), the app name
 * shown in Zoho CRM, and the setup instructions in the YouTrack and
 * YouCanBookMe piece docs.
 *
 * This scans the integration packages and fails if a user-visible "Activepieces"
 * string reappears, so the rebrand cannot silently rot as pieces are added.
 */

function findRepoRoot(startDir: string): string {
    let current = startDir
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'packages'))) {
            return current
        }
        current = path.dirname(current)
    }
    throw new Error('Could not find repo root')
}

const REPO_ROOT = findRepoRoot(__dirname)

/**
 * Scoped to the packages this sweep actually covers. A repo-wide scan currently
 * finds ~521 further occurrences in other community pieces, which is a separate
 * change: widening the scope here would just land a permanently red gate.
 * Widening SCAN_ROOTS is the intended way to extend this as those land.
 */
const SCAN_ROOTS = [
    'packages/integrations/community/zendesk',
    'packages/integrations/community/youtrack',
    'packages/integrations/community/youcanbookme',
    'packages/integrations/community/zoho-crm',
]

/**
 * Occurrences that must keep the old name, each with the reason.
 * Currently empty: all 4 packages have been fully rebranded with zero exceptions.
 */
const ALLOWED: ReadonlyArray<{ file: string, contains: string, reason: string }> = []

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        return out
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') {
                continue
            }
            walk(full, out)
        }
        else if (/\.(ts|tsx|json|md)$/.test(entry.name)) {
            out.push(full)
        }
    }
    return out
}

type Offence = { file: string, line: number, text: string }

function findOffences(): Offence[] {
    const offences: Offence[] = []

    for (const root of SCAN_ROOTS) {
        for (const file of walk(path.join(REPO_ROOT, root))) {
            const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/')
            const lines = fs.readFileSync(file, 'utf-8').split('\n')

            lines.forEach((text, index) => {
                if (!text.includes('Activepieces')) {
                    return
                }
                const allowed = ALLOWED.find((a) => relative.includes(a.file) && text.includes(a.contains))
                if (allowed) {
                    return
                }
                offences.push({ file: relative, line: index + 1, text: text.trim() })
            })
        }
    }

    return offences
}

describe('Activepieces -> Inboxfm Connect rebrand sweep (Issue #178)', () => {
    it('no user-visible "Activepieces" string remains in the integration packages', () => {
        const offences = findOffences()

        if (offences.length > 0) {
            const detail = offences
                .slice(0, 25)
                .map((o) => `  ${o.file}:${o.line}  ${o.text.slice(0, 110)}`)
                .join('\n')

            expect.fail(
                `Found ${offences.length} user-visible "Activepieces" string(s) under ${SCAN_ROOTS.join(', ')}.\n`
                + `${detail}\n`
                + (offences.length > 25 ? `  ... and ${offences.length - 25} more\n` : '')
                + '\nThese are shown to end users (webhook names, app labels, setup docs). '
                + 'Rename them to "Inboxfm Connect". If an occurrence genuinely must keep the old '
                + 'name, add it to ALLOWED in this file with a reason.',
            )
        }

        expect(offences).toHaveLength(0)
    })

    it('actually scans files, so the guard cannot pass vacuously', () => {
        // If SCAN_ROOTS were wrong or the walk broke, findOffences would return
        // [] and the test above would pass without checking anything.
        const files = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)))
        expect(files.length).toBeGreaterThan(20)
    })

    it('the scanner detects the string it is looking for', () => {
        // Prove the matcher works, using a temporary file under a scanned root.
        const probe = path.join(REPO_ROOT, SCAN_ROOTS[0], '__rebrand-probe.ts')
        fs.writeFileSync(probe, 'export const webhookName = \'Activepieces Probe\'\n', 'utf-8')
        try {
            const offences = findOffences()
            expect(offences.some((o) => o.file.includes('__rebrand-probe'))).toBe(true)
        }
        finally {
            fs.rmSync(probe, { force: true })
        }
    })

    it('every allowlisted occurrence still exists and still has a reason', () => {
        // Guards against an ALLOWED entry outliving the string it excused.
        for (const entry of ALLOWED) {
            expect(entry.reason.trim().length, `${entry.file} needs a reason`).toBeGreaterThan(10)
            const absolute = path.join(REPO_ROOT, entry.file)
            expect(fs.existsSync(absolute), `${entry.file} no longer exists`).toBe(true)
            expect(fs.readFileSync(absolute, 'utf-8')).toContain(entry.contains)
        }
    })
})
