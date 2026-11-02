import { useEffect, useRef, useState } from 'react'
import { resizeScroll, startScroll, stopScroll } from '@/lib/scrollEngine'
import { useAppStore } from '@/store/useAppStore'
import { useI18n } from '@/i18n/useI18n'

/**
 * BootSequence — the entrance veil, and the reason it exists.
 *
 * ── What it hides ───────────────────────────────────────────────────────────
 * A material's shader program is compiled and linked the first time it is drawn,
 * and the driver blocks the main thread while that happens. On a cold driver
 * cache that is ~2.7s of blocked main thread spread over a few tasks, which the
 * visitor experiences as the page freezing for no reason a second after load.
 *
 * Prewarming moved that work off the scroll path (see ScrollArchitecture3D) but
 * it still has to happen somewhere. This overlay makes it deliberate: a boot
 * sequence is something the visitor expects to wait for.
 *
 * ── Why it is CSS-driven and not JS ─────────────────────────────────────────
 * The one property that matters is that the veil keeps moving WHILE the main
 * thread is blocked. `transform` and `opacity` animations are handed to the
 * compositor and keep playing through a blocked main thread; a rAF loop or a
 * JS spring would freeze at precisely the moment it is supposed to be covering.
 * Everything in the stylesheet side of this component is therefore limited to
 * those two properties.
 *
 * ── Timing model ────────────────────────────────────────────────────────────
 *   release when   elapsed >= HOLD_MIN_MS  AND  prewarmDone
 *   release anyway at                        HOLD_MAX_MS
 *
 * The minimum matters on a warm driver cache, where prewarming takes ~120ms and
 * a veil that vanished after four frames would read as a glitch rather than an
 * entrance. The maximum matters because the veil must never become a trap: no
 * WebGL, a failed chunk load, or a scene that grows past its budget all end with
 * the visitor being released rather than held forever.
 *
 * ── Teardown ────────────────────────────────────────────────────────────────
 * Exit is a 420ms CSS lift. Removal happens on `animationend`, which is the
 * browser telling us the animation genuinely finished; a safety timer
 * (EXIT_MS + margin) force-clears if that event is skipped — a backgrounded tab,
 * a reduced-motion OS setting toggled mid-flight, or the global reduced-motion
 * rule in index.css turning the animation off entirely, which means no event is
 * ever dispatched. Unmount clears every timer, so a hot reload leaves nothing
 * behind.
 *
 * ── Scroll ──────────────────────────────────────────────────────────────────
 * The page must not move underneath the veil, but this component is a CHILD of
 * SmoothScroll: React runs child effects before parent effects, so Lenis does not
 * exist yet when this mounts and `stopScroll()` would silently do nothing. Hence
 * the deferred stop on the next frame, plus capture-phase wheel/touch blocking
 * that does not depend on the engine having been created at all. The lock is
 * released when the lift STARTS rather than when the node is removed, so the
 * visitor is never left looking at content they cannot scroll.
 */

/** The veil holds for at least this long, so a warm cache still shows an intro. */
const HOLD_MIN_MS = 900

/**
 * Hard ceiling. Past this the veil lifts regardless of the prewarm signal.
 * Sized off the measured cold prewarm (~2.7s) plus slack.
 */
const HOLD_MAX_MS = 3600

/** Length of the exit lift. Mirrors `.boot-veil--out` in index.css. */
const EXIT_MS = 420

/** How long after the exit starts to force removal if `animationend` is skipped. */
const EXIT_SAFETY_MS = EXIT_MS + 250

/**
 * Page start, not component start.
 *
 * Module load happens as the app graph is evaluated, which is the closest thing
 * to "when this page began booting" that a component can observe. It also keeps
 * the timing stable under React StrictMode's double mount: both mounts measure
 * from the same origin.
 */
const PAGE_START = typeof performance !== 'undefined' ? performance.now() : 0

type Phase = 'hold' | 'leaving' | 'gone'

export function BootSequence() {
  const { t } = useI18n()
  const prewarmDone = useAppStore((state) => state.prewarmDone)
  const [phase, setPhase] = useState<Phase>('hold')
  const veilRef = useRef<HTMLDivElement>(null)

  /* ── Release scheduling ────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'hold') return

    const elapsed = performance.now() - PAGE_START
    const waitForMin = Math.max(0, HOLD_MIN_MS - elapsed)

    if (prewarmDone) {
      // Warm already: serve out the minimum so the intro still reads as one.
      const timer = window.setTimeout(() => setPhase('leaving'), waitForMin)
      return () => window.clearTimeout(timer)
    }

    /*
     * Not warm yet. This is the common cold path: wait for the signal, but never
     * past the ceiling. The effect re-runs when `prewarmDone` flips and installs
     * the short minimum-wait timer in its place.
     */
    const remaining = Math.max(0, HOLD_MAX_MS - elapsed)
    const timer = window.setTimeout(() => setPhase('leaving'), remaining)
    return () => window.clearTimeout(timer)
  }, [phase, prewarmDone])

  /* ── Escape hatch ──────────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'hold') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Only once the sequence has had a moment; skipping a 200ms flash is not
      // a feature, skipping a stall the visitor is impatient with is.
      if (performance.now() - PAGE_START < HOLD_MIN_MS) return
      setPhase('leaving')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase])

  /* ── Backgrounded tab ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'hold') return
    /*
     * Timers are throttled in a hidden tab, so the ceiling can be reached long
     * after it was scheduled. Release the moment the tab comes back rather than
     * showing a veil over an already-loaded page.
     */
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      if (performance.now() - PAGE_START >= HOLD_MAX_MS) setPhase('leaving')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [phase])

  /* ── Scroll lock, held only while the veil actually covers the page ────── */
  useEffect(() => {
    if (phase !== 'hold') return

    const block = (event: Event): void => event.preventDefault()
    const options: AddEventListenerOptions = { passive: false, capture: true }
    window.addEventListener('wheel', block, options)
    window.addEventListener('touchmove', block, options)

    // Deferred: see the note in the component docblock about child/parent
    // effect ordering.
    const raf = requestAnimationFrame(() => stopScroll())

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('wheel', block, options)
      window.removeEventListener('touchmove', block, options)
      startScroll()
      // Fonts have usually landed by now and Lenis measures the document, so
      // re-measure or the first scroll after the intro can be one screen short.
      resizeScroll()
    }
  }, [phase])

  /* ── Removal watchdog for the exit ─────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'leaving') return
    const timer = window.setTimeout(() => setPhase('gone'), EXIT_SAFETY_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (phase === 'gone') return null

  return (
    <>
      {/*
        `animationend` bubbles, and the scanning highlight inside this element is
        an infinite child animation — so the handler has to check that the event
        is the veil's own lift and not something from a descendant.
      */}
      <div
        ref={veilRef}
        data-boot
        aria-hidden
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.animationName !== 'veil-lift') return
          setPhase('gone')
        }}
        className={[
          'boot-veil fixed inset-0 z-[200] flex flex-col items-center justify-center',
          phase === 'leaving' ? 'boot-veil--out' : '',
        ].join(' ')}
      >
        {/*
         * Paint order matters: the radial wash is opaque in the middle, so it has
         * to come FIRST and the engineering grid sit on top of it. The other way
         * round the grid is invisible.
         */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_45%,#0b1424_0%,#04060b_62%,#020308_100%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 grid-backdrop opacity-[0.35]"
        />

        <div className="relative flex flex-col items-center gap-5">
          {/* ink-300 / ink-500 rather than the dimmer pair: a boot status the
              visitor cannot read is decoration, not information. */}
          <span className="font-mono text-[0.62rem] tracking-[0.42em] text-ink-300 uppercase">
            Showroom
          </span>

          <div className="relative h-px w-40 overflow-hidden bg-void-600/60">
            <div className="boot-scan h-full w-1/3 bg-signal-cyan/70" />
          </div>

          <span className="font-mono text-[0.58rem] tracking-[0.3em] text-ink-500">
            {t.boot.status}
          </span>
        </div>
      </div>

      {/*
        The veil is decorative and `aria-hidden`; the announcement is separate so
        assistive technology is told the page is loading without reading the
        wordmark. Removed with the veil, so nothing lingers.
      */}
      <span role="status" className="sr-only">
        {t.boot.announce}
      </span>
    </>
  )
}

export default BootSequence
