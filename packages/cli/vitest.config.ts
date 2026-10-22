import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: [
      path.resolve(__dirname, 'test/**/*.test.ts').replaceAll('\\', '/'),
      path.resolve(__dirname, 'src/**/*.test.ts').replaceAll('\\', '/'),
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
