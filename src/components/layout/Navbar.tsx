import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Command,
  Cpu,
  Gauge,
  Menu,
  Palette,
  Terminal,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useFpsMonitor } from '@/hooks/useFpsMonitor'
import { scrollToTarget } from '@/lib/scrollEngine'
import {
  DEFAULT_VFX_PRESET,
  getNextVfxPreset,
  getVfxPalette,
  vfxLabelKey,
} from '@/lib/vfxPalette'
import { cn } from '@/lib/cn'
import { IconButton, StatusDot } from '@/components/ui/primitives'
import { ScrollProgressRing } from '@/components/ui/ScrollProgressRing'
import { AudioSpectrumMeter } from '@/components/layout/AudioSpectrumMeter'
import { VfxSweepTransition } from '@/components/layout/VfxSweepTransition'
import { SHOWROOM_SECTIONS } from '@/config/sections'
import { useI18n } from '@/i18n/useI18n'
import { LanguageSwitcher } from '@/components/ui/LanguageSwitcher'
import {
  ActiveSectionBadge,
  ScrollProgressRail,
  SectionNav,
} from '@/components/layout/Navbar.parts'

/* -------------------------------------------------------------------------- */
/*  FPS telemetry readout                                                     */
/* -------------------------------------------------------------------------- */
/**
 * The panel is deliberately *not* React-state driven: `useFpsMonitor` measures
 * in rAF and we paint the numbers straight into DOM nodes through refs. The
 * only React updates happen when the user toggles the tier or the panel itself.
 */
function FpsReadout() {
  const { t } = useI18n()
  const tier = useAppStore((state) => state.performanceTier)
  const cycleTier = useAppStore((state) => state.cyclePerformanceTier)

  const fpsRef = useRef<HTMLSpanElement>(null)
  const frameMsRef = useRef<HTMLSpanElement>(null)
  const worstMsRef = useRef<HTMLSpanElement>(null)
  const viewportRef = useRef<HTMLSpanElement>(null)
  const dprRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useFpsMonitor(
    true,
    useCallback((sample) => {
      if (fpsRef.current) fpsRef.current.textContent = sample.fps.toFixed(1)
      if (frameMsRef.current) frameMsRef.current.textContent = sample.frameMs.toFixed(2)
      if (worstMsRef.current) worstMsRef.current.textContent = sample.worstMs.toFixed(2)
      if (viewportRef.current) {
        viewportRef.current.textContent = `${sample.width}×${sample.height}`
      }
      if (dprRef.current) dprRef.current.textContent = sample.dpr.toFixed(2)

      // 60fps → full bar, 30fps → half, 0 → empty.
      const bar = barRef.current
      if (bar) {
        const health = Math.max(0, Math.min(1, sample.fps / 60))
        bar.style.width = `${(health * 100).toFixed(1)}%`
        bar.style.backgroundColor =
          sample.fps === 0
            ? 'var(--color-ink-700)'
            : sample.fps >= 55
              ? 'var(--color-signal-teal)'
              : sample.fps >= 35
                ? 'var(--color-signal-amber)'
                : 'var(--color-signal-rose)'
      }
    }, []),
  )

  return (
    <div className="fixed top-[calc(var(--nav-height)+0.75rem)] right-3 z-50 w-60 max-w-[calc(100vw-1.5rem)] origin-top-right sm:absolute sm:top-full sm:right-0 sm:mt-3 sm:w-60">
      <div className="panel-glass overflow-hidden rounded-panel">
        <div className="flex items-center justify-between border-b border-void-600/60 px-3 py-2">
          <span className="hud-label flex items-center gap-1.5">
            <Activity className="size-3 text-signal-cyan" aria-hidden />
            Telemetry
          </span>
          <StatusDot tone="cyan" />
        </div>

        <div className="space-y-2.5 px-3 py-3 font-mono text-[0.7rem]">
          {/* FPS */}
          <div className="flex items-baseline justify-between">
            <span className="text-ink-500">FPS</span>
            <span className="tabular-nums text-ink-100">
              <span ref={fpsRef}>--.-</span>
              <span className="ml-1 text-[0.6rem] text-ink-700">fps</span>
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-void-700">
            <div
              ref={barRef}
              className="h-full rounded-full transition-[width] duration-200"
              style={{ width: '0%' }}
            />
          </div>

          {/* frame time */}
          <div className="flex items-baseline justify-between">
            <span className="text-ink-500">{t.nav.frame}</span>
            <span className="tabular-nums text-ink-300">
              <span ref={frameMsRef}>--.--</span>
              <span className="ml-1 text-[0.6rem] text-ink-700">ms</span>
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-ink-500">{t.nav.worst}</span>
            <span className="tabular-nums text-ink-300">
              <span ref={worstMsRef}>--.--</span>
              <span className="ml-1 text-[0.6rem] text-ink-700">ms</span>
            </span>
          </div>

          <div className="my-1 h-px bg-void-600/60" />

          {/* viewport */}
          <div className="flex items-baseline justify-between">
            <span className="text-ink-500">{t.nav.viewport}</span>
            <span className="tabular-nums text-ink-300">
              <span ref={viewportRef}>---×---</span>
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-ink-500">DPR</span>
            <span className="tabular-nums text-ink-300">
              <span ref={dprRef}>-.--</span>
            </span>
          </div>

          {/* performance tier */}
          <button
            type="button"
            onClick={cycleTier}
            className="mt-1 flex w-full items-center justify-between rounded-md border border-void-600/70 px-2 py-1.5 transition-colors hover:border-signal-cyan/50 hover:text-signal-cyan"
            title={t.nav.tierCycle}
          >
            <span className="flex items-center gap-1.5 text-ink-500">
              <Cpu className="size-3" aria-hidden />
              {t.nav.tierLabel}
            </span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[0.6rem] tracking-wider uppercase',
                tier === 'high'
                  ? 'bg-signal-cyan/15 text-signal-cyan'
                  : 'bg-signal-amber/15 text-signal-amber',
              )}
            >
              {tier}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Navbar                                                                    */
/* -------------------------------------------------------------------------- */
export function Navbar() {
  const { t } = useI18n()
  const soundEnabled = useAppStore((state) => state.soundEnabled)
  const toggleSound = useAppStore((state) => state.toggleSound)
  const fpsMonitorEnabled = useAppStore((state) => state.fpsMonitorEnabled)
  const toggleFpsMonitor = useAppStore((state) => state.toggleFpsMonitor)
  const perfHudOpen = useAppStore((state) => state.perfHudOpen)
  const togglePerfHud = useAppStore((state) => state.togglePerfHud)
  const toggleCommandPalette = useAppStore((state) => state.toggleCommandPalette)
  const activeSection = useAppStore((state) => state.activeSection)
  const vfxPreset = useAppStore((state) => state.vfxPreset)
  const setVfxPreset = useAppStore((state) => state.setVfxPreset)

  // Resolved once per preset change; both the button swatch and the sweep
  // overlay read the same palette, so the button always previews the next state
  // with the colour that is currently active.
  const vfxPalette = getVfxPalette(vfxPreset)

  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  // Toggle the condensed/blurred state after a small scroll threshold.
  // This is the one place we accept a React render during scrolling, and it
  // only fires when crossing the threshold (not on every frame).
  useEffect(() => {
    let last = false
    const onScroll = () => {
      const next = window.scrollY > 24
      if (next !== last) {
        last = next
        setScrolled(next)
      }
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Close the mobile sheet on Escape.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  const goTo = (id: string) => {
    scrollToTarget(`#${id}`, -16)
    setMobileOpen(false)
  }

  return (
    <>
      <ScrollProgressRail />

      {/*
       * Visual Overdrive sweep overlay.
       *
       * Mounted here, as a SIBLING of the fixed <header>, for a concrete reason:
       * the header applies a `backdrop-filter` in its condensed state, and that
       * property makes the header a containing block for fixed-position
       * descendants — a nested full-screen overlay would be sized and clipped
       * against the header instead of the viewport. As a sibling it covers the
       * true viewport, and the header stays free of page-wide overlays. The
       * component itself renders nothing when idle and tears its DOM down after
       * each wave, so mounting it permanently adds no permanent layer.
       */}
      <VfxSweepTransition />

      <header
        className={cn(
          /*
         * `pt-[env(safe-area-inset-top)]`: the document sets `viewport-fit=cover`, so
         * on a notched phone the bar was drawn UNDER the status bar and the dynamic
         * island. The padding extends the bar's own background into that area while
         * pushing the controls below it.
         */
        'fixed inset-x-0 top-0 z-90 pt-[env(safe-area-inset-top)] transition-all duration-500',
          scrolled
            ? 'border-b border-void-600/50 bg-void-950/95'
            : 'border-b border-transparent bg-transparent',
        )}
      >
        <div className="mx-auto flex h-(--nav-height) max-w-[104rem] items-center gap-4 px-4 sm:px-6 lg:px-10">
          {/* ── Identity ─────────────────────────────────────────────── */}
          <button
            type="button"
            onClick={() => goTo('hero')}
            className="group flex shrink-0 items-center gap-2.5"
            aria-label={t.nav.homeAria}
          >
            <span className="relative grid size-8 place-items-center rounded-md border border-signal-cyan/35 bg-signal-cyan/8 text-signal-cyan transition-colors group-hover:border-signal-cyan/70">
              <Terminal className="size-4" aria-hidden />
              <span
                aria-hidden
                className="absolute -inset-px rounded-md opacity-0 shadow-[0_0_22px_-2px_var(--color-signal-cyan)] transition-opacity group-hover:opacity-100"
              />
            </span>
            <span className="flex flex-col items-start leading-none">
              <span className="font-mono text-[0.72rem] font-medium tracking-[0.22em] text-ink-100 uppercase">
                {t.nav.brand}
              </span>
              <span className="mt-1 font-mono text-[0.55rem] tracking-[0.28em] text-ink-700 uppercase">
                {t.nav.brandSub}
              </span>
            </span>
          </button>

          <span aria-hidden className="mx-1 hidden h-5 w-px bg-void-600/70 lg:block" />

          {/* ── Section index ────────────────────────────────────────── */}
          <SectionNav sections={SHOWROOM_SECTIONS} activeSection={activeSection} />
          <ActiveSectionBadge sections={SHOWROOM_SECTIONS} />

          <div className="ml-auto flex items-center gap-2">
            {/* ── Scroll progress ring (zero-render, ref-driven) ──────── */}
            <ScrollProgressRing />

            <span aria-hidden className="hidden h-5 w-px bg-void-600/70 sm:block" />

            {/* ── Live FPS toggle + panel ────────────────────────────── */}
            <div className="relative">
              <IconButton
                label={fpsMonitorEnabled ? t.nav.fpsMonitorOn : t.nav.fpsMonitorOff}
                active={fpsMonitorEnabled}
                onClick={toggleFpsMonitor}
              >
                <Gauge className="size-4" aria-hidden />
              </IconButton>
              {fpsMonitorEnabled && <FpsReadout />}
            </div>

            {/* ── Developer telemetry overlay (Shift+D) ──────────────── */}
            <IconButton
              label={perfHudOpen ? t.nav.perfHudClose : t.nav.perfHudOpen}
              active={perfHudOpen}
              onClick={togglePerfHud}
            >
              <Cpu className="size-4" aria-hidden />
            </IconButton>

            {/* ── Command palette (Cmd/Ctrl+K) ───────────────────────── */}
            <IconButton
              label={t.nav.commandPaletteOpen}
              onClick={toggleCommandPalette}
            >
              <Command className="size-4" aria-hidden />
            </IconButton>

            {/* ── Visual Overdrive spectral palette ────────────────────
                A single cycle button rather than a three-way segmented control:
                the navbar is a fixed-height row with no spare width, and one
                IconButton keeps exactly the existing 36 px button rhythm. The
                corner dot previews the ACTIVE palette's primary hue, so the
                control reads as "the current colour" at a glance; the command
                palette exposes direct per-preset selection for anyone who does
                not want to cycle. */}
            <IconButton
              label={`${t.nav.paletteCycle} · ${t.palette[vfxLabelKey(vfxPreset)]}`}
              active={vfxPreset !== DEFAULT_VFX_PRESET}
              onClick={() => setVfxPreset(getNextVfxPreset(vfxPreset))}
            >
              <Palette className="size-4" aria-hidden />
              <span
                aria-hidden
                className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full ring-1 ring-void-950/80"
                style={{ backgroundColor: vfxPalette.primary }}
              />
            </IconButton>

            {/* ── Sound toggle + live spectrum meter ─────────────────── */}
            <div className="flex items-center gap-2">
              {/*
               * The meter sits immediately left of the mute button so the two read
               * as one control group: the bars show what the button is letting
               * through. Always mounted — when muted it dims to 40% and parks its
               * columns rather than disappearing, so the control group does not
               * change width and shove the rest of the navbar around.
               */}
              <AudioSpectrumMeter className="hidden sm:flex" />
              <IconButton
                label={soundEnabled ? t.nav.soundMute : t.nav.soundUnmute}
                active={soundEnabled}
                onClick={toggleSound}
              >
                {soundEnabled ? (
                  <Volume2 className="size-4" aria-hidden />
                ) : (
                  <VolumeX className="size-4 text-ink-500" aria-hidden />
                )}
              </IconButton>
            </div>

            <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-void-600/70 sm:block" />

            {/*
              * Language capsule. Sits with the other persistent preferences and
              * before the mobile menu, so the right-hand cluster keeps its order:
              * system state, preferences, then navigation collapse.
              */}
            <LanguageSwitcher className="mr-1 hidden sm:flex" />

            {/* ── Mobile menu ────────────────────────────────────────── */}
            <IconButton
              label={mobileOpen ? t.nav.closeMenu : t.nav.openMenu}
              active={mobileOpen}
              className="lg:hidden"
              onClick={() => setMobileOpen((open) => !open)}
            >
              {mobileOpen ? (
                <X className="size-4" aria-hidden />
              ) : (
                <Menu className="size-4" aria-hidden />
              )}
            </IconButton>
          </div>
        </div>

        {/* ── Mobile sheet ───────────────────────────────────────────── */}
        <div
          className={cn(
            'overflow-hidden border-t border-void-600/40 bg-void-950/96 transition-[max-height,opacity] duration-400 lg:hidden',
            mobileOpen ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0',
          )}
        >
          <nav aria-label={t.nav.mobileMenuAria} className="flex flex-col px-4 py-2 sm:px-6">
            {SHOWROOM_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => goTo(section.id)}
                className={cn(
                  'flex items-center gap-3 rounded-md px-2 py-3 text-left transition-colors',
                  section.id === activeSection
                    ? 'text-signal-cyan'
                    : 'text-ink-300 hover:bg-void-850/70',
                )}
              >
                <span className="font-mono text-[0.62rem] tracking-widest text-ink-700">
                  {section.index}
                </span>
                <span className="text-sm tracking-wide">{t.sections[section.id].title}</span>
                {section.id === activeSection && <StatusDot className="ml-auto" />}
              </button>
            ))}
          </nav>
        </div>
      </header>
    </>
  )
}

export default Navbar
