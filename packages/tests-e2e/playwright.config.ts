import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const workspaceRoot = resolve(__dirname, '../..')

export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: 1,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    outputDir: './test-results',
    reporter: [['list'], ['html', { outputFolder: resolve(__dirname, 'playwright-report'), open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:4200',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
    webServer: [
        {
            cwd: workspaceRoot,
            command: 'node tools/e2e/start-api.mjs',
            url: 'http://127.0.0.1:3000/api/v1/health',
            timeout: 300_000,
            reuseExistingServer: false,
        },
        {
            cwd: workspaceRoot,
            command: 'bun x vite --config packages/web/vite.config.ts packages/web --mode test --host 127.0.0.1 --port 4200 --strictPort',
            url: 'http://127.0.0.1:4200/login',
            timeout: 120_000,
            reuseExistingServer: false,
            env: { VITE_API_TARGET: 'http://127.0.0.1:3000' },
        },
    ],
})
