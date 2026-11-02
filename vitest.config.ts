import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest runs the pure modules, not the DOM.
 *
 * Everything worth asserting in this project's logic layer — the spring, the Verlet
 * solver, FABRIK, the fuzzy matcher, the palette tables — is a plain function with no
 * browser in sight. Keeping the default `node` environment means the suite starts in
 * milliseconds and cannot silently depend on a layout that is not there.
 *
 * The browser-facing assertions live where they belong: `scripts/verify-*.mjs` drives a
 * real Chromium against the BUILT output. Those catch what a jsdom test cannot (focus
 * behaviour, computed styles, an actual WebGL context); this catches what they are too
 * slow to pin down.
 */
export default defineConfig({
  resolve: {
    // Mirrors the `@/*` alias from tsconfig/vite so test imports look like source imports.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // No globals: `describe`/`it`/`expect` are imported from 'vitest' in each file, so the
    // test files typecheck under the same `tsc -b` the app uses, with no ambient types.
    globals: false,
    reporters: 'default',
  },
})
