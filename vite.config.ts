import { defineConfig, configDefaults } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import type { ProxyOptions } from 'vite'

// Same-origin proxies for services that do not allow browser CORS. Production
// uses the matching rewrites in vercel.json.
const proxy: Record<string, ProxyOptions> = {
  // Brickognize's internal search returns BrickLink IDs and color predictions.
  '/api/brickognize': {
    target: 'https://api.brickognize.com',
    changeOrigin: true,
    rewrite: () => '/internal/search/?external_catalogs=bricklink&predict_color=true',
    configure: (server) => server.on('proxyReq', (req) => {
      req.removeHeader('origin')
      req.removeHeader('referer')
    })
  },
  // BrickLink's color list for one part (part_color_service.py).
  '/api/bricklink-colors': {
    target: 'https://www.bricklink.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/bricklink-colors/, '/catalogColors.asp'),
    configure: (server) => server.on('proxyReq', (req) => {
      req.removeHeader('origin')
      req.setHeader('referer', 'https://www.bricklink.com/')
    })
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    svelte()
  ],
  server: { proxy },
  preview: { proxy },
  optimizeDeps: {
    // Scan only the real entry — keeps the dev server from tripping over
    // local reference HTML files (e.g. the gitignored design/ folder)
    entries: ["index.html"]
  },
  resolve: {
    conditions: ['browser', 'import', 'module', 'jsnext:main', 'jsnext']
  },
  test: {
    // e2e/ belongs to Playwright, not Vitest
    exclude: [...configDefaults.exclude, 'e2e/**']
  }
})

