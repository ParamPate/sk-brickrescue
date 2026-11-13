import { defineConfig, configDefaults } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    svelte()
  ],
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

