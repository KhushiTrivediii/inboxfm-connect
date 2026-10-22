import { expect, test } from '@playwright/test'
import { z } from 'zod'

test('sign in, create an automation, and execute a real integration action', async ({ page }) => {
    const testInfo = test.info()
    await page.goto('/actions')
    await expect(page).toHaveURL(/\/login$/)
    await page.getByPlaceholder('developer@company.com').fill('dev@ap.com')
    await page.locator('input[type="password"]').fill('12345678')
    const loginResponse = page.waitForResponse((response) => response.url().endsWith('/authentication/sign-in') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const login = await loginResponse
    expect(login.ok()).toBe(true)
    const auth = z.object({ token: z.string(), projectId: z.string() }).parse(await login.json())
    // #173 preserves the deep-link return URL: the journey starts at /actions, so the
    // unauthenticated visit bounces to /login carrying state.from = /actions and the
    // post-login target resolves back to /actions - not to /.
    await expect(page).toHaveURL(/\/actions$/)
    const headers = { Authorization: `Bearer ${auth.token}` }

    await page.goto('/automations/schedules/new')
    const instruction = `Browser ${testInfo.project.name}: verify the local automation journey`
    await page.getByTestId('schedule-prompt-input').fill(instruction)
    await page.getByRole('button', { name: 'Disabled', exact: true }).click()
    const creationResponse = page.waitForResponse((response) => response.url().endsWith('/scheduled-tasks') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Create Scheduled Task', exact: true }).click()
    const creation = await creationResponse
    expect(creation.status()).toBe(201)
    const automation = z.object({ id: z.string(), status: z.literal('DISABLED'), prompt: z.string() }).parse(await creation.json())
    expect(automation.prompt).toBe(instruction)
    await expect(page).toHaveURL(new RegExp(`/automations/schedules/${automation.id}$`))
    await page.reload()
    await expect(page.getByTestId('schedule-detail-prompt')).toHaveText(instruction)

    const pieceName = '@inboxfm-connect/piece-text-helper'
    const metadataResponse = await page.request.get(`/api/v1/integrations/${encodeURIComponent(pieceName)}`, { headers })
    expect(metadataResponse.ok()).toBe(true)
    const metadata = z.object({ version: z.string() }).parse(await metadataResponse.json())
    const connectionResponse = await page.request.post('/api/v1/connections', {
        headers,
        data: {
            externalId: `browser-${testInfo.project.name}`,
            displayName: `Browser ${testInfo.project.name} Text Helper`,
            pieceName,
            pieceVersion: metadata.version,
            projectId: auth.projectId,
            type: 'NO_AUTH',
            value: { type: 'NO_AUTH' },
        },
    })
    expect(connectionResponse.status()).toBe(201)
    const connection = z.object({ id: z.string() }).parse(await connectionResponse.json())

    try {
        await page.goto(`/actions/${encodeURIComponent(pieceName)}/slugify`)
        await page.getByRole('textbox', { name: 'Text', exact: true }).fill('inboxfm connect browser journey')
        const executionResponse = page.waitForResponse((response) => response.url().endsWith('/execute') && response.request().method() === 'POST')
        await page.getByRole('button', { name: 'Execute Tool', exact: true }).click()
        const execution = await executionResponse
        expect(execution.ok()).toBe(true)
        expect(await execution.text()).toBe('inboxfm-connect-browser-journey')
        await expect(page.getByTestId('execution-success')).toBeVisible()
        await expect(page.getByTestId('execution-panel')).toContainText('inboxfm-connect-browser-journey')
    }
    finally {
        const connectionRemoval = await page.request.delete(`/api/v1/connections/${connection.id}?projectId=${auth.projectId}`, { headers })
        expect(connectionRemoval.ok()).toBe(true)
        const automationRemoval = await page.request.delete(`/api/v1/scheduled-tasks/${automation.id}?projectId=${auth.projectId}`, { headers })
        expect(automationRemoval.ok()).toBe(true)
    }
})
