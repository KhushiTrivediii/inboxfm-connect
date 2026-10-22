import { sentryVitePlugin } from '@sentry/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig, type PluginOption } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

function getSentrySourcemapPlugin(): PluginOption | null {
  const authToken = process.env.SENTRY_AUTH_TOKEN
  const org = process.env.SENTRY_ORG
  const project = process.env.SENTRY_PROJECT

  if (!authToken || !org || !project) {
    console.log(
      '[sentry] SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT not set — skipping source map upload (self-hosted / local build)',
    )
    return null
  }

  const release = process.env.SENTRY_RELEASE || process.env.npm_package_version

  return sentryVitePlugin({
    authToken,
    org,
    project,
    url: process.env.SENTRY_URL,
    release: {
      name: release,
      ...(process.env.SENTRY_ENVIRONMENT
        ? { deploy: { env: process.env.SENTRY_ENVIRONMENT } }
        : {}),
    },
    telemetry: false,
  })
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths({
      root: __dirname,
    }),
    getSentrySourcemapPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4200,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
      '/redirect': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
      '/mcp': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        bypass: (req) => {
          if (req.headers.accept?.includes('text/html')) {
            return '/index.html'
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@inboxfm-connect/shared'],
  },
  build: {
    outDir: '../../dist/packages/web',
    emptyOutDir: true,
    commonjsOptions: {
      include: [/packages[\\/]core[\\/]shared/, /node_modules/],
    },
    // 'hidden': maps are still emitted for the Sentry upload above, but the
    // bundled JS carries no //# sourceMappingURL comment — the Dockerfile always
    // strips the .map files before shipping, so a comment pointing at them would
    // just 404 in a user's browser devtools.
    sourcemap: 'hidden',
  },
})
