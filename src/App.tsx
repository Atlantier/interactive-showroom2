import { lazy, Suspense, useEffect } from 'react'
import { SmoothScroll } from '@/components/layout/SmoothScroll'
import { Navbar } from '@/components/layout/Navbar'
import { ClickRipple } from '@/components/layout/ClickRipple'
import { ScrollTelemetryHud } from '@/components/layout/ScrollTelemetryHud'
import {
  PerfNoticeToast,
  PerfTelemetryHud,
} from '@/components/layout/PerfTelemetryHud'
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
import { supportsWebGL } from '@/lib/device'
import { useAppStore } from '@/store/useAppStore'
import { soundEngine } from '@/utils/soundEngine'

/**
 * The WebGL scene is code-split: the DOM shell must be interactive long before
 * three.js is parsed. `Scene` is a fixed, pointer-events-none layer that sits
 * behind all content.
 */
const Scene = lazy(() => import('@/components/canvas/Scene'))

function App() {
  useSectionObserver(SECTION_IDS)
  const webgl = supportsWebGL()
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
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }

      event.preventDefault()
      useAppStore.getState().togglePerfHud()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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

        {/* ── Navigation ──────────────────────────────────────────────── */}
        <Navbar />

        {/* Global click feedback: a single thin ripple, nothing else. */}
        <ClickRipple />

        {/* ── Content ─────────────────────────────────────────────────── */}
        <main className="relative z-20">
          <HeroSection />
          <GallerySection />
          <ArchitectureNarrative />
          <PlaygroundSection />
          <ArchiveSection />
          <ContactSection />
        </main>

        {/* ── HUD ─────────────────────────────────────────────────────── */}
        <ScrollTelemetryHud />
        <PerfTelemetryHud />
        <PerfNoticeToast />

        {/* Cmd/Ctrl+K. Always mounted so the shortcut works while it is closed. */}
        <CommandPalette />
      </div>
    </SmoothScroll>
  )
}

export default App
