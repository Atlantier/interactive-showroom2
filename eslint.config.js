import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * ESLint 10 flat config.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The review's UI-03 found zero lint, zero formatting and zero tests, and two
 * `eslint-disable` comments in code from a linter that was never installed — the worst
 * kind of annotation, because it looks like a decision and is actually noise.
 *
 * ── Scope, deliberately narrow ─────────────────────────────────────────────
 * `tseslint.configs.recommended` and NOT the type-aware variant. Type-aware linting is
 * genuinely better (it can see through `any`), but it needs a full program build and
 * turns a 3-second check into a minute — which is how a lint step ends up being removed
 * "just for now". `tsc -b` already runs with `noUnusedLocals` and `strict`, and it is the
 * gate that actually blocks deploys; ESLint's job here is the things types cannot see:
 * hook rules, dangling promises, accidental globals, and a `console` that shipped.
 */

/** Files that are not ours to lint: build output, generated reports, screenshots. */
const IGNORED = ['dist/**', 'node_modules/**', 'screenshots/**', '.review/**', 'coverage/**']

export default tseslint.config(
  { ignores: IGNORED },

  /* ── Application source ───────────────────────────────────────────────── */
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        matchMedia: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        WebSocket: 'readonly',
        HTMLElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        SVGSVGElement: 'readonly',
        SVGElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        PointerEvent: 'readonly',
        TouchEvent: 'readonly',
        WheelEvent: 'readonly',
        CustomEvent: 'readonly',
        DOMException: 'readonly',
        Image: 'readonly',
        AudioContext: 'readonly',
        OffscreenCanvas: 'readonly',
        WebGLRenderingContext: 'readonly',
        WebGL2RenderingContext: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        devicePixelRatio: 'readonly',
        getComputedStyle: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        CSS: 'readonly',
        ...Object.fromEntries(
          // Node globals that leak into type-only positions in a Vite app.
          ['process', 'global'].map((name) => [name, 'readonly']),
        ),
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      /*
       * `no-undef` is switched off for TypeScript on purpose.
       *
       * typescript-eslint's own guidance says the same: the compiler already resolves
       * every identifier, and the linter's version only produces noise around DOM types
       * it does not know about. Keeping it would mean maintaining a globals allowlist
       * that duplicates lib.dom.
       */
      'no-undef': 'off',

      /*
       * The React Compiler rules (`immutability`, `refs`, `set-state-in-effect`) are
       * switched off, not because the findings are wrong but because this app does not
       * run the compiler, and its whole performance story depends on the thing those
       * rules forbid: mutable simulation state living OUTSIDE React and being advanced
       * 60 times a second. `modeRef.current = mode` during render, a rope's point array
       * mutated in place, a canvas rig rebuilt in an effect -- all deliberate, all
       * documented at the call site.
       *
       * The two rules that do not depend on that trade-off stay on: `rules-of-hooks`
       * and `exhaustive-deps`.
       */
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',

      /*
       * `any` is banned by the repo's own contract (.dsh/AGENTS.md) and by `tsc`; making
       * the linter agree means an escape hatch has to be visible in review, not silent.
       */
      '@typescript-eslint/no-explicit-any': 'error',

      /*
       * Unused variables are already a type error (`noUnusedLocals`), so the linter only
       * needs the part types cannot express: leaving a variable behind on purpose.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      /*
       * A shipped `console.log` is a debugging aid that forgot to leave. The app has a
       * telemetry panel for anything that needs to be observable at runtime.
       */
      'no-console': ['error', { allow: ['warn', 'error'] }],

      /*
       * `debugger` reaching production is the same class of accident.
       */
      'no-debugger': 'error',

      /*
       * Un-awaited promises are how a canvas resize ends up racing a frame loop. Allowed
       * inside `void` / event handlers by the `void` operator, which is what the code
       * already uses.
       */
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  /* ── Test files: `describe`/`it` are imported, so nothing extra to allow ── */
  {
    files: ['src/**/*.test.ts'],
    rules: {
      // Tests assert on intentionally odd values and partial objects.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  /* ── Node-side tooling (verify scripts, config) ───────────────────────── */
  {
    files: ['*.config.ts', 'vite.config.ts', 'vitest.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: false } },
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        document: 'readonly',
        window: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        /*
         * These files are half Node, half page.
         *
         * Every probe function in them is serialised by `Runtime.evaluate` and runs in
         * the browser, where these globals exist. Node never executes them, so the lint
         * environment has to know both worlds -- without these the linter reports ~35
         * "is not defined" errors for code that works.
         */
        getComputedStyle: 'readonly',
        KeyboardEvent: 'readonly',
        PointerEvent: 'readonly',
        MouseEvent: 'readonly',
        WheelEvent: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        localStorage: 'readonly',
        devicePixelRatio: 'readonly',
        Image: 'readonly',
        OfflineAudioContext: 'readonly',
        scrollX: 'readonly',
        scrollY: 'readonly',
      },
    },
    rules: {
      // These scripts exist to print measurements; that is their output channel.
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
