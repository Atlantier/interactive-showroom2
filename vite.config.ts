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
        /*
         * Split by PACKAGE, not by substring.
         *
         * The previous version tested `id.includes('three')` before
         * `id.includes('@react-three')`, so the r3f branch below it was dead: every
         * @react-three/* id contains "three", and drei/postprocessing/maath all
         * landed in the same group. Worse, the shell's own zustand modules were
         * folded into that group too, so the ENTRY chunk statically imported it and
         * the browser had to download and parse 1.07 MB of WebGL code before App
         * could run -- the exact opposite of what the lazy Scene import was for.
         *
         * Resolving the package name first makes the grouping predictable: the
         * WebGL body ends up in `webgl`, referenced only from the lazy chunks, and
         * the shell gets a small `vendor` (zustand / lenis / clsx / tailwind-merge).
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined

          /*
           * Classify by PATH SEGMENT, not by package name.
           *
           * Two attempts at package-name parsing failed on real inputs: rollup hands
           * ids with the platform separator (so `split('node_modules/')` missed
           * everything on Windows and three.js fell back into `vendor`), and even
           * after normalising, `three.core.js` -- 1.4 MB on its own in r186 -- did
           * not get grouped. A path-segment test is separator-independent and does
           * not care how a package is laid out inside its build directory.
           */
          const path = id.replace(/\\/g, '/')

          // WebGL body: referenced only from the lazy Scene / architecture chunks.
          if (
            path.includes('/node_modules/three/') ||
            path.includes('/node_modules/three-stdlib/') ||
            path.includes('/node_modules/maath/') ||
            path.includes('/node_modules/postprocessing/') ||
            path.includes('/node_modules/n8ao/') ||
            path.includes('/node_modules/@react-three/')
          ) {
            return 'webgl'
          }

          /*
           * Shared state layer.
           *
           * zustand is used by the shell AND by @react-three/fiber internally, so
           * rollup hoists it into whichever chunk looks like their common ancestor --
           * which was `webgl`. The entry then statically imported that chunk for one
           * symbol, dragging 1 MB of three.js back onto the critical path even though
           * every actual three.js module sits behind a lazy boundary. Naming the
           * state deps explicitly keeps that shared module in a ~20 KB `shell` chunk.
           */
          if (
            path.includes('/node_modules/zustand/') ||
            path.includes('/node_modules/use-sync-external-store/') ||
            path.includes('/node_modules/suspend-react/')
          ) {
            return 'shell'
          }

          if (
            path.includes('/node_modules/motion/') ||
            path.includes('/node_modules/framer-motion/')
          ) {
            return 'motion'
          }
          if (
            path.includes('/node_modules/react/') ||
            path.includes('/node_modules/react-dom/') ||
            path.includes('/node_modules/scheduler/')
          ) {
            return 'react'
          }

          /*
           * Everything else: let rollup decide.
           *
           * An earlier revision returned a catch-all 'vendor' here. That was worse
           * than doing nothing: forcing every unmatched module into one chunk
           * defeated tree-shaking for barrel packages -- lucide-react alone became
           * an 807 KB chunk (its barrel re-exports ~1500 icons, and grouping them
           * together kept the unused ones alive). Returning `undefined` lets the
           * default chunking keep the shell's own deps (zustand, lenis, clsx) in the
           * entry, which is where shell code belongs anyway.
           */
          return undefined
        },
      },
    },
  },
})
