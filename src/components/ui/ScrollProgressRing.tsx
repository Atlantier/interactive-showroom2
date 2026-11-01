import { useEffect, useId, useRef } from 'react'
import { onScrollFrame, scrollToTarget } from '@/lib/scrollEngine'
import { getTransient } from '@/store/useAppStore'
import { cn } from '@/lib/cn'

/**
 * ScrollProgressRing — a precise SVG ring that mirrors the global scroll
 * progress `p ∈ [0,1]`, rendered in the navbar's right-hand cluster.
 *
 * ── How it stays at display-refresh rate with ZERO React renders ─────────────
 * The arc is a single `<circle>` whose `stroke-dashoffset` is written
 * imperatively from a per-frame callback. React renders this component exactly
 * once, at mount; afterwards the DOM node is mutated directly. No state, no
 * context, no subscribers — so scrolling cannot schedule a single render.
 *
 * The per-frame source is the app's single master clock (the Lenis RAF loop in
 * `lib/scrollEngine.ts`, exposed as `onScrollFrame`). That callback runs on
 * every `requestAnimationFrame`, i.e. at the display's refresh rate — 120 Hz on
 * a 120 Hz panel — and it is the very same tick that advanced the page, so the
 * ring can never lag the scroll position by a frame. Spinning up a second,
 * independent rAF here would double the scheduling work and reintroduce exactly
 * the one-frame skew the single-clock architecture exists to prevent.
 *
 * The value itself is read from the transient store (`getTransient()`), which is
 * the authoritative record of the current progress.
 *
 * Cost per frame: one property read, one float compare, and (only when the
 * value actually moved) one string assignment to `style.strokeDashoffset` plus a
 * repaint of a 36 px vector element. The percentage label is throttled to whole
 * numbers, so it touches the DOM at most 100 times for an entire page scroll.
 */

/** Outer box of the ring, in CSS pixels (matches the navbar's 36px buttons). */
const SIZE = 36
/** Arc thickness. */
const STROKE = 2
/** Radius measured to the stroke centre line. */
const RADIUS = (SIZE - STROKE) / 2
/** Full circumference — the dash length that represents p = 1. */
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Below this delta the stroke is not worth repainting. */
const PROGRESS_EPSILON = 0.0002

interface ScrollProgressRingProps {
  className?: string
}

export function ScrollProgressRing({ className }: ScrollProgressRingProps) {
  // Unique gradient id: prevents collisions if the ring is ever rendered twice.
  const gradientId = useId()
  const arcRef = useRef<SVGCircleElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let lastProgress = -1
    let lastPercent = -1

    // `onScrollFrame` fires inside the master requestAnimationFrame callback.
    const unsubscribe = onScrollFrame(() => {
      // Authoritative transient value, already clamped to [0,1] by writeScroll.
      const progress = getTransient().scroll.progress

      // Skip redundant style writes when the scroll has not actually moved.
      if (Math.abs(progress - lastProgress) < PROGRESS_EPSILON) return
      lastProgress = progress

      const arc = arcRef.current
      if (arc) {
        // Empty ring at p=0 → full ring at p=1.
        arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress))
      }

      // The numeric readout is updated at 1% granularity only.
      const percent = Math.round(progress * 100)
      if (percent !== lastPercent) {
        lastPercent = percent
        const label = labelRef.current
        if (label) label.textContent = String(percent)
      }
    })

    return unsubscribe
  }, [])

  return (
    <button
      type="button"
      onClick={() => scrollToTarget(0)}
      aria-label="回到顶部"
      title="滚动进度 · 点击回到顶部"
      className={cn(
        'group relative grid size-9 shrink-0 place-items-center rounded-full',
        'transition-colors duration-200',
        'hover:[&>svg_.ring-arc]:opacity-100',
        'focus-visible:outline-signal-cyan',
        className,
      )}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden
        className="pointer-events-none -rotate-90"
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--color-signal-cyan)" />
            <stop offset="55%" stopColor="var(--color-signal-teal)" />
            <stop offset="100%" stopColor="var(--color-signal-violet)" />
          </linearGradient>
        </defs>

        {/* Track */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--color-void-600)"
          strokeWidth={STROKE}
          opacity={0.85}
        />

        {/* Progress arc — its dash offset is mutated every frame via a ref. */}
        <circle
          ref={arcRef}
          className="ring-arc opacity-80 transition-opacity duration-200"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE}
        />
      </svg>

      {/* Percentage readout, also ref-driven (no React state). */}
      <span
        ref={labelRef}
        aria-hidden
        className="pointer-events-none absolute font-mono text-[0.5rem] leading-none tracking-tighter text-ink-500 tabular-nums transition-colors duration-200 group-hover:text-signal-cyan"
      >
        0
      </span>
    </button>
  )
}

export default ScrollProgressRing
