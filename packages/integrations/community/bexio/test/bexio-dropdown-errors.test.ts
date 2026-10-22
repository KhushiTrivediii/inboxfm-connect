import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Issue #185 — every Bexio dropdown swallowed its load failure and rendered the
 * placeholder "Failed to load X". That reads like the upstream returned nothing
 * useful, when the actual cause is far more often a dead token or a missing
 * scope, both of which the operator can act on.
 *
 * These lock two properties of the fix without needing a live Bexio account:
 * the placeholder tells the user what to check, and the swallowed error is still
 * surfaced somewhere instead of vanishing.
 */

const ACTION_FILE = path.resolve(__dirname, '../src/lib/actions/create-company.ts')
const PROPS_FILE = path.resolve(__dirname, '../src/lib/common/props.ts')

const FILES = [ACTION_FILE, PROPS_FILE]

function read(file: string): string {
    return readFileSync(file, 'utf-8')
}

/** Every placeholder string in the file, in source order. */
function placeholders(source: string): string[] {
    return [...source.matchAll(/placeholder: '([^']+)'/g)].map((m) => m[1])
}

/** The labels of the dropdowns that load from the Bexio API. */
function apiLoadPlaceholders(source: string): string[] {
    return placeholders(source).filter((p) => p.startsWith('Failed to load '))
}

describe('Bexio dropdown failure messaging (Issue #185)', () => {
    it('every API-load placeholder points the operator at the connection or permissions', () => {
        for (const file of FILES) {
            const source = read(file)
            const affected = apiLoadPlaceholders(source)
            expect(affected.length, `${file} should have API-load placeholders`).toBeGreaterThan(0)

            for (const placeholder of affected) {
                expect(
                    placeholder,
                    `"${placeholder}" should tell the user what to check`,
                ).toMatch(/Check your Bexio connection/)
            }
        }
    })

    it('no API-load placeholder is the bare, unactionable form', () => {
        for (const file of FILES) {
            for (const placeholder of apiLoadPlaceholders(read(file))) {
                // The old text ended at the noun with nothing after it.
                expect(placeholder).not.toMatch(/^Failed to load [a-z ]+$/)
            }
        }
    })

    it('still shows the sign-in prompt, which is a different failure and must stay distinct', () => {
        for (const file of FILES) {
            const source = read(file)
            expect(placeholders(source)).toContain('Connect your Bexio account first')
        }
    })

    it('logs every swallowed error instead of discarding it', () => {
        for (const file of FILES) {
            const source = read(file)
            const logged = [...source.matchAll(/console\.warn\('\[bexio\] Failed to load ([^']+):', error\);/g)]
                .map((m) => m[1])
            expect(logged.length, `${file} should log each swallowed failure`).toBeGreaterThan(0)

            // Each logged label must appear in some placeholder, and vice versa,
            // so a new dropdown that forgets to log (or logs a label that no
            // longer exists) is caught rather than silently swallowed.
            const placeholdersText = apiLoadPlaceholders(source).join('\n')
            for (const label of logged) {
                expect(placeholdersText, `"${label}" is logged but no placeholder mentions it`).toContain(label)
            }
            expect(logged.length, `${file}: one log per API-load placeholder`).toBe(apiLoadPlaceholders(source).length)
        }
    })

    it('does not log anything for the not-signed-in path, which is not an error', () => {
        for (const file of FILES) {
            const source = read(file)
            // The "Connect your Bexio account first" branch returns without a
            // throw, so it must not emit a scary console.warn.
            const notSignedIn = source.indexOf('Connect your Bexio account first')
            expect(notSignedIn).toBeGreaterThan(-1)
            const beforeNotSignedIn = source.slice(0, notSignedIn)
            expect(beforeNotSignedIn).not.toContain('Failed to load')
        }
    })

    it('the piece does not take a server-only dependency just to log a warning', () => {
        for (const file of FILES) {
            expect(read(file)).not.toContain('@inboxfm-connect/server-utils')
        }
    })
})
