import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getVfxPalette, type VfxPreset } from '@/lib/vfxPalette'
import { useAppStore } from '@/store/useAppStore'

/**
 * VfxSweepTransition — the full-screen light wave that plays when the Visual
 * Overdrive preset changes.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 * A fixed, pointer-events-none overlay rendering one radial ring that expands
 * from the centre of the viewport past the corners while fading out, plus a
 * short centre bloom. It plays ONCE (~450 ms), then the component unmounts its
 * DOM entirely. It is not a transition state that lives in the tree: a
 * permanent full-screen layer is exactly the failure mode this component is
 * written to avoid.
 *
 * ── Why the teardown is promise-free and self-healing ──────────────────────
 * Removal happens on the ring's `animationend` event, which is the browser
 * telling us the animation actually finished. That event is reliable but not
 * guaranteed: a backgrounded tab, a reduced-motion OS setting toggled mid-flight
 * or a compositor hiccup can skip it. So a safety timer (duration + margin)
 * force-clears the wave state as well. Whichever fires first wins; both paths
 * only ever set state to `null`, so they cannot fight. Unmount also clears the
 * timer, so a hot reload never leaves a callback behind.
 *
 * ── prefers-reduced-motion ─────────────────────────────────────────────────
 * Checked in the effect, at the moment the preset actually changes, so the
 * overlay is never even mounted for a user who asked for reduced motion. The
 * stylesheet repeats the guard as defence in depth (the check is a one-shot
 * snapshot; an OS setting changed between the change event and paint should
 * still win).
 *
 * ── Why a CSS animation rather than a JS/or transform loop ─────────────────
 * The element is decorative and short-lived. A keyframe animation runs on the
 * compositor without a single React render or rAF callback after mount, and
 * `animationend` gives us an authoritative end signal that a timer alone cannot
 * provide. The only property touched is `transform`/`opacity`, so the sweep
 * never triggers layout.
 *
 * ── Why the component is not mounted by App ────────────────────────────────
 * It is rendered by the navbar, next to the palette control that triggers it.
 * Keeping it OUTSIDE the fixed `<header>` matters: the header paints a
 * backdrop-filter and a transform-ish condensed state, and a full-screen
 * overlay nested inside it could be clipped or re-contained by that backdrop
 * layer. As a sibling it always covers the true viewport.
 */

/** The wave's duration. Shared by the CSS keyframes and the safety timer. */
const SWEEP_DURATION_MS = 450

/**
 * How long after the animation the safety timer waits before force-removing.
 * One extra frame-budget quarter-second is plenty for a late `animationend`.
 */
const SWEEP_SAFETY_MARGIN_MS = 250

/** The one shot the overlay renders: which preset changed, and a unique id. */
interface SweepWave {
  /** Monotonic id used as the React key, so a second change restarts the CSS. */
  sequence: number
  preset: VfxPreset
}

/**
 * Stylesheet for the wave.
 *
 * Colours are injected as CSS custom properties from the live palette, so the
 * same keyframes serve all three presets and no hex value is duplicated here.
 * `color-mix()` is used exactly as `index.css` already does for its theme
 * tokens, which keeps the wave's alpha ramps tied to the palette hue.
 *
 * Geometry: the ring box is 160vmax square, so its radius is 80vmax. The bright
 * band sits at 86–100 % of that radius, i.e. ~69–80vmax (≈1320–1536 px at
 * 1920 px wide), which is beyond the viewport's half-diagonal (~1100 px): at
 * full scale the band has left the screen. Scaling from ~0 makes the band sweep
 * out of the centre and cross every edge before the fade completes.
 */
const SWEEP_STYLES = `
@keyframes vfx-sweep-ring {
  0% {
    transform: translate(-50%, -50%) scale(0.02);
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  58% {
    opacity: 0.9;
  }
  100% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 0;
  }
}

@keyframes vfx-sweep-core {
  0% {
    opacity: 0;
  }
  16% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.vfx-sweep {
  position: fixed;
  inset: 0;
  z-index: 130;
  overflow: hidden;
  pointer-events: none;
}

.vfx-sweep__ring {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 160vmax;
  height: 160vmax;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    transparent 0%,
    transparent 86%,
    color-mix(in oklab, var(--vfx-primary) 52%, transparent) 89%,
    color-mix(in oklab, var(--vfx-primary) 30%, transparent) 93%,
    color-mix(in oklab, var(--vfx-secondary) 16%, transparent) 96%,
    transparent 100%
  );
  transform: translate(-50%, -50%) scale(0.02);
  will-change: transform, opacity;
  animation: vfx-sweep-ring ${SWEEP_DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.vfx-sweep__core {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at 50% 50%,
    color-mix(in oklab, var(--vfx-primary) 18%, transparent) 0%,
    color-mix(in oklab, var(--vfx-secondary) 8%, transparent) 34%,
    transparent 62%
  );
  will-change: opacity;
  animation: vfx-sweep-core ${SWEEP_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@media (prefers-reduced-motion: reduce) {
  .vfx-sweep__ring,
  .vfx-sweep__core {
    display: none;
  }
}
`

/** Snapshot of the OS setting, read when the preset changes. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function VfxSweepTransition() {
  const vfxPreset = useAppStore((state) => state.vfxPreset)

  /** Previous preset, so the mount itself never triggers a sweep. */
  const previousPreset = useRef<VfxPreset>(vfxPreset)
  /** Monotonic counter; only ever incremented, so keys never collide. */
  const sequence = useRef(0)

  const [wave, setWave] = useState<SweepWave | null>(null)

  /* ── Trigger: fire once per preset change, never on mount ───────────────── */
  useEffect(() => {
    if (previousPreset.current === vfxPreset) return
    previousPreset.current = vfxPreset

    // Reduced motion means the swap itself is the whole feedback; skip the wave.
    // A wave already on screen is cleared so a mid-sweep preference change
    // cannot leave a frozen overlay behind.
    if (prefersReducedMotion()) {
      setWave(null)
      return
    }

    sequence.current += 1
    setWave({ sequence: sequence.current, preset: vfxPreset })
  }, [vfxPreset])

  /* ── Safety net: remove the overlay even if `animationend` never fires ──── */
  useEffect(() => {
    if (!wave) return
    const timer = window.setTimeout(() => setWave(null), SWEEP_DURATION_MS + SWEEP_SAFETY_MARGIN_MS)
    return () => window.clearTimeout(timer)
  }, [wave])

  if (!wave) return null

  const palette = getVfxPalette(wave.preset)

  return (
    <>
      <style>{SWEEP_STYLES}</style>
      <div
        key={wave.sequence}
        aria-hidden
        data-vfx-sweep={wave.preset}
        className="vfx-sweep"
        style={
          {
            '--vfx-primary': palette.primary,
            '--vfx-secondary': palette.secondary,
          } as CSSProperties
        }
      >
        {/* Centre bloom: makes the change read as a light source, not a ripple. */}
        <div className="vfx-sweep__core" />

        {/*
         * The expanding band. `animationend` is the normal teardown path; the
         * handler lives on the animated element itself so an unrelated future
         * animation in this overlay cannot clear the wave early.
         */}
        <div className="vfx-sweep__ring" onAnimationEnd={() => setWave(null)} />
      </div>
    </>
  )
}

export default VfxSweepTransition
