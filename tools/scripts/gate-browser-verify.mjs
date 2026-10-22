/**
 * Real-browser click-through for the developer console release gate.
 *
 * Drives the locally installed Chromium against the running vite dev server
 * (:4200 -> proxied /api -> :3000) with a REAL signed-in session injected into
 * localStorage, and reports, per route: navigation status, console errors, failed
 * network requests, and whether the page rendered content or an error state.
 *
 * Not a substitute for the vitest suites — it is the "did it actually load in a
 * browser" check the release gate requires. It intentionally performs no
 * third-party action run, because that needs credentials no test may invent.
 *
 * Usage: node tools/scripts/gate-browser-verify.mjs <token> <projectId>
 */
import { chromium } from '@playwright/test'

const BASE = process.env.GATE_BASE_URL ?? 'http://127.0.0.1:4200'
const [token, projectId] = process.argv.slice(2)

if (!token || !projectId) {
    console.error('usage: node gate-browser-verify.mjs <token> <projectId>')
    process.exit(2)
}

/** Console noise that is not a defect signal. */
const IGNORED_CONSOLE = [
    'Download the React DevTools',
    '[vite] connecting',
    '[vite] connected',
]

import { readFileSync, writeFileSync } from 'node:fs'

const routesPath = process.env.GATE_ROUTES_FILE ?? 'gate-routes.json'
const routes = JSON.parse(readFileSync(routesPath, 'utf8'))

async function main() {
    const browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })

    // Seed the session before any app code runs, so the first render is authenticated.
    await context.addInitScript(([t, p]) => {
        // The client reads ap-token/ap-project-id from sessionStorage since #383;
        // seed both stores so the gate stays authenticated on either surface.
        sessionStorage.setItem('ap-token', t)
        sessionStorage.setItem('ap-project-id', p)
        localStorage.setItem('ap-token', t)
        localStorage.setItem('ap-project-id', p)
        localStorage.setItem('ap-user', JSON.stringify({
            id: 'usr_developer',
            email: 'dev@ap.com',
            firstName: 'Developer',
            lastName: 'Console',
            platformRole: 'ADMIN',
        }))
    }, [token, projectId])

    const results = []

    for (const route of routes) {
        const page = await context.newPage()
        const consoleErrors = []
        const failedRequests = []

        page.on('console', (msg) => {
            if (msg.type() !== 'error') return
            const text = msg.text()
            if (IGNORED_CONSOLE.some((i) => text.includes(i))) return
            consoleErrors.push(text.slice(0, 200))
        })
        page.on('requestfailed', (req) => {
            failedRequests.push(`${req.method()} ${req.url().replace(BASE, '')} ${req.failure()?.errorText ?? ''}`.slice(0, 160))
        })
        page.on('response', (res) => {
            const url = res.url()
            if (!url.includes('/api/')) return
            if (res.status() >= 400) {
                failedRequests.push(`HTTP ${res.status()} ${url.replace(BASE, '')}`.slice(0, 160))
            }
        })

        let navStatus = 'ERR'
        let bodyText = ''
        let title = ''
        try {
            const response = await page.goto(BASE + route.path, { waitUntil: 'domcontentloaded', timeout: 45000 })
            navStatus = response ? response.status() : 'no-response'
            // Let react-query settle; the shell renders before data arrives.
            await page.waitForTimeout(route.settleMs ?? 3500)
            bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
            title = (await page.locator('h1, [data-testid="page-title"]').first().innerText().catch(() => '')).trim()
        }
        catch (error) {
            navStatus = `NAV-ERR: ${String(error).slice(0, 120)}`
        }

        results.push({
            path: route.path,
            label: route.label,
            navStatus,
            heading: title,
            renderedChars: bodyText.length,
            sawNotFound: /page not found|404/i.test(bodyText),
            sawErrorState: /something went wrong|failed to load|unable to load|try again/i.test(bodyText),
            consoleErrors,
            failedRequests: [...new Set(failedRequests)],
            excerpt: bodyText.slice(0, 220),
        })

        await page.close()
    }

    await browser.close()

    const outPath = process.env.GATE_OUT_FILE ?? 'browser-verify-out.json'
    writeFileSync(outPath, JSON.stringify(results, null, 2))
    process.stdout.write(`WROTE ${results.length} route results to ${outPath}\n`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
