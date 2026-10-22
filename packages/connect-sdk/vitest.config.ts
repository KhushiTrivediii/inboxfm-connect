import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: {
            '@inboxfm-connect/sdk': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        },
    },
    test: {
        globals: true,
        environment: 'node',
    },
})
