import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  /**
   * Public base path.
   *
   * A GitHub Pages *project* site is served from `https://<user>.github.io/<repo>/`,
   * so every asset URL must be prefixed or all JS/CSS requests 404. The deploy
   * workflow injects the correct value (and uses `/` for `<user>.github.io`
   * repositories, which are served from the root). Local dev and any root-domain
   * deploy fall back to `/`.
   */
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    host: true,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Keep the heavy WebGL stack in its own chunk so the shell paints first.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('three')) return 'three'
          if (id.includes('@react-three')) return 'r3f'
          if (id.includes('framer-motion') || id.includes('motion-dom')) return 'motion'
          if (id.includes('react-dom') || id.includes('react/')) return 'react'
          return undefined
        },
      },
    },
  },
})

