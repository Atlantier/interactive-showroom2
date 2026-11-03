import { Suspense, lazy, useEffect, useState } from 'react'
import { SmoothScroll } from '@/components/layout/SmoothScroll'
import { Navbar } from '@/components/layout/Navbar'
import { ClickRipple } from '@/components/layout/ClickRipple'
import { BootSequence } from '@/components/layout/BootSequence'
import { installContextWatcher } from '@/lib/contextWatcher'
import { ScrollTelemetryHud } from '@/components/layout/ScrollTelemetryHud'
import { PerfNoticeToast, PerfTelemetryHud } from '@/components/layout/PerfTelemetryHud'
import {
  ArchiveSection,
  ContactSection,
  GallerySection,
  HeroSection,
  PlaygroundSection,
} from '@/components/sections/Sections'
import { ArchitectureNarrative } from '@/components/sections/ArchitectureNarrative'
import { CommandPalette } from '@/components/command/CommandPalette'
import { useSectionObserver } from '@/hooks/useSectionObserver'
import { SECTION_IDS } from '@/config/sections'
import { onReducedMotionChange, supportsWebGL } from '@/lib/device'
import { useAppStore } from '@/store/useAppStore'
import { soundEngine } from '@/utils/soundEngine'

import { useI18n } from '@/i18n/useI18n'
/**
 * The WebGL scene is code-split: the DOM shell must be interactive long before
 * three.js is parsed. `Scene` is a fixed, pointer-events-none layer that sits
 * behind all content.
 */
const Scene = lazy(() => import('@/components/canvas/Scene'))

function App() {
  useSectionObserver(SECTION_IDS)
  /*
   * Probed once, in a state initialiser.
   *
   * This used to run during render, which meant every re-render of the shell
   * created a fresh <canvas> and a real GL context. With browsers capping live
   * contexts at 8-16, the probe was competing with the two contexts this page
   * actually needs. `supportsWebGL` also caches internally now.
   */
  const [webgl] = useState(supportsWebGL)

  const setReducedMotion = useAppStore((state) => state.setReducedMotion)

  /*
   * While the command palette is open, everything it covers is `inert`.
   *
   * The panel already traps Tab and restores focus, but those only stop the KEYBOARD.
   * `inert` is what makes the rest of the page properly unavailable: assistive tech
   * stops seeing it as reachable, pointer events are swallowed, and the browser's own
   * sequential focus navigation refuses to enter the subtree -- so it can no longer
   * disagree with our hand-written trap.
   *
   * React 19 supports `inert` as a plain boolean prop, so no attribute juggling.
   */
  const paletteOpen = useAppStore((state) => state.commandPaletteOpen)
  const webglContextLost = useAppStore((state) => state.webglContextLost)

  // The skip link is the first focusable thing on the page, so it needs the copy here.
  const { t } = useI18n()

  /*
   * Keep the store in step with the OS setting.
   *
   * macOS exposes this in the menu bar and it can change while the page is open; the
   * CSS media query in index.css handles the DOM, but nothing told the 3D scenes.
   */
  useEffect(() => onReducedMotionChange(setReducedMotion), [setReducedMotion])
  const soundEnabled = useAppStore((state) => state.soundEnabled)
  const accentTheme = useAppStore((state) => state.accentTheme)

  /**
   * Publish the accent theme on `<html>`.
   *
   * The themes are pure CSS variable overrides keyed off `[data-accent]`, so the
   * only thing React has to do is keep that attribute in sync. Every component
   * using `text-signal-cyan` and friends re-tints through the cascade without
   * subscribing to the store at all — which is why switching themes costs one
   * attribute write rather than a re-render of the tree.
   */
  useEffect(() => {
    document.documentElement.dataset.accent = accentTheme
  }, [accentTheme])

  // Lock the page to the document height Lenis measured, so the browser's own
  // scroll restoration cannot fight the engine on refresh.
  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual'
    }
  }, [])

  /**
   * Bridge the persisted preference to the audio engine.
   *
   * The engine is a plain singleton rather than a store subscriber, because the
   * hot path — a hover tick fired from inside a pointer handler — must not go
   * through React at all. This effect is the single place the two are joined, so
   * the Navbar toggle, the persisted value restored on load, and any future
   * programmatic change all take the same route.
   */
  useEffect(() => {
    soundEngine.setEnabled(soundEnabled)
  }, [soundEnabled])

  // Release the AudioContext on teardown so a hot reload does not leak contexts.
  useEffect(() => () => soundEngine.dispose(), [])

  /**
   * Shift+D toggles the developer telemetry overlay.
   *
   * Registered on `window` rather than on a focused element so it works from
   * anywhere on the page. The guard against typing targets matters: the terminal
   * sandbox contains a real `<input>`, and hijacking Shift+D while someone is
   * typing a command would be a genuine bug rather than a shortcut.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey) return
      // Leave browser and OS combinations alone.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'D' && event.key !== 'd') return

      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }

      event.preventDefault()
      useAppStore.getState().togglePerfHud()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // WebGL context loss has to be caught centrally: canvases are created by R3F at arbitrary
  // depths, and the events do not bubble (see lib/contextWatcher.ts).
  useEffect(() => installContextWatcher(), [])

  return (
    <SmoothScroll>
      <div className="relative min-h-dvh bg-void-950 text-ink-100">
        {/* ── Ambient background layers ───────────────────────────────── */}
        <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
          {/* deep-space radial wash */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-10%,#0b1424_0%,#04060b_58%,#020308_100%)]" />
          {/* engineering grid */}
          <div className="absolute inset-0 grid-backdrop opacity-[0.55]" />
          {/* vignette */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_38%,rgba(2,3,8,0.85)_100%)]" />
          {/* CRT scanlines */}
          <div className="absolute inset-0 scanlines opacity-[0.35] mix-blend-overlay" />
        </div>

        {/* ── WebGL layer (fixed, non-interactive) ────────────────────── */}
        {webgl && (
          <div aria-hidden className="pointer-events-none fixed inset-0 z-10">
            <Suspense fallback={null}>
              <Scene />
            </Suspense>
          </div>
        )}

        {/* ── Scrim ───────────────────────────────────────────────────────
            A vertical wash between the nebula and the content. Without it the
            dense particle field competes with body copy and the bento cards,
            and text contrast falls below a readable level wherever the dust
            happens to be bright. It fades in below the hero so the opening
            screen keeps its full atmospheric effect. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-15 bg-gradient-to-b from-transparent via-void-950/55 to-void-950/85"
        />

        {/*
         * Bypass block (WCAG 2.4.1). Without it a keyboard user has to Tab through the
         * whole navbar -- nine controls plus six chapter links -- before reaching the
         * content on every single page load.
         */}
        <a
          href="#main"
          className="sr-only rounded bg-void-900 px-3 py-2 text-sm text-signal-cyan focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[300] focus:outline focus:outline-2 focus:outline-signal-cyan"
        >
          {t.nav.skipToContent}
        </a>

        <div inert={paletteOpen}>
          {/* ── Navigation ──────────────────────────────────────────────── */}
          <Navbar />

          {/* Global click feedback: a single thin ripple, nothing else. */}
          <ClickRipple />

          {/*
           * Entrance veil. Sits above every other layer (z-200 clears the command
           * palette at z-120) and unmounts itself completely when the boot is
           * done, so it costs nothing once the page is up.
           */}
          <BootSequence />

          {/* ── Content ─────────────────────────────────────────────────── */}
          {/* `tabIndex={-1}` so the skip link can actually move focus here: an <a href="#id">
            only scrolls, it does not focus a non-interactive element. */}
          <main id="main" tabIndex={-1} className="relative z-20 focus:outline-none">
            <HeroSection />
            <GallerySection />
            <ArchitectureNarrative />
            <PlaygroundSection />
            <ArchiveSection />
            <ContactSection />
          </main>
        </div>

        {/* ── HUD ─────────────────────────────────────────────────────── */}
        <ScrollTelemetryHud />
        <PerfTelemetryHud />
        <PerfNoticeToast />

        {/* three attempts recovery; the visitor receives one visible explanation. The singleton
            announcer speaks it, so the banner has no second live-region role. Keep it outside
            the command palette's inert subtree. */}
        {webglContextLost && (
          <div
            data-webgl-context-status
            className="pointer-events-none fixed inset-x-4 top-[calc(var(--nav-height)+0.75rem)] z-[130] mx-auto max-w-lg rounded-panel border border-signal-amber/60 bg-void-950/95 px-4 py-3 text-center text-sm text-ink-100 shadow-lg"
          >
            {t.hud.contextLost}
          </div>
        )}

        {/* Cmd/Ctrl+K. Always mounted so the shortcut works while it is closed. */}
        <CommandPalette />
      </div>
    </SmoothScroll>
  )
}

export default App
