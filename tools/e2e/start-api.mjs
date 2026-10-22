import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'inboxfm-browser-e2e-'))
process.on('exit', () => rmSync(directory, { recursive: true, force: true }))
copyFileSync('package.json', join(directory, 'package.json'))
const pieceDirectory = join(directory, 'packages/integrations/core/text-helper')
mkdirSync(pieceDirectory, { recursive: true })
copyFileSync('packages/integrations/core/text-helper/package.json', join(pieceDirectory, 'package.json'))
cpSync('packages/integrations/core/text-helper/dist', join(pieceDirectory, 'dist'), { recursive: true })
symlinkSync(resolve('packages/integrations/core/text-helper/node_modules'), join(pieceDirectory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
cpSync('dist/packages/engine', join(directory, 'dist/packages/engine'), { recursive: true })
symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

const child = spawn(process.execPath, [resolve('packages/server/api/dist/src/bootstrap.js')], {
    cwd: directory,
    stdio: 'inherit',
    env: {
        ...process.env,
        REDISMS_VERSION: '7.4.0',
        REDISMS_DOWNLOAD_DIR: process.env.REDISMS_DOWNLOAD_DIR ?? resolve('node_modules/.cache/redis-memory-server/redis-binaries'),
        AP_EDITION: 'ce',
        AP_ENVIRONMENT: 'dev',
        AP_DB_TYPE: 'PGLITE',
        AP_CONFIG_PATH: join(directory, 'config'),
        AP_CACHE_PATH: join(directory, 'cache'),
        AP_REDIS_TYPE: 'MEMORY',
        AP_QUEUE_MODE: 'MEMORY',
        AP_EXECUTION_MODE: 'UNSANDBOXED',
        AP_PIECES_SOURCE: 'FILE',
        AP_PIECES_SYNC_MODE: 'NONE',
        AP_DEV_PIECES: 'text-helper',
        AP_LOAD_TRANSLATIONS_FOR_DEV_PIECES: 'false',
        AP_PORT: '3000',
        AP_FRONTEND_URL: 'http://127.0.0.1:4200',
        AP_WEBHOOK_URL: 'http://127.0.0.1:3000',
        AP_JWT_SECRET: 'local-browser-test-secret',
        AP_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
        AP_TELEMETRY_ENABLED: 'false',
        AP_LOG_LEVEL: 'warn',
        AP_LOG_PRETTY: 'false',
        AP_QUEUE_UI_ENABLED: 'false',
    },
})

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
    console.error(error)
    rmSync(directory, { recursive: true, force: true })
    process.exitCode = 1
})
child.on('exit', (code) => {
    rmSync(directory, { recursive: true, force: true })
    process.exitCode = code ?? 1
})
