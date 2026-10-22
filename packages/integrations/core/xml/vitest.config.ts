import path from 'path'
import { defineConfig } from 'vitest/config'

const repoRoot = path.resolve(__dirname, '../../../..')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@inboxfm-connect/shared': path.resolve(repoRoot, 'packages/core/shared/src/index.ts'),
      '@inboxfm-connect/pieces-framework': path.resolve(repoRoot, 'packages/integrations/framework/src/index.ts'),
      '@inboxfm-connect/pieces-common': path.resolve(repoRoot, 'packages/integrations/common/src/index.ts'),
    },
  },
})
