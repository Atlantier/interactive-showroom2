import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { InViewRef } from '@/hooks/useInViewAnimation'
import { isStill, onStillChange } from '@/lib/testHooks'

/**
 * InterCardPulse — the discharge that hops between two adjacent bento cards.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * The review's UI-19 found `BentoGrid` carrying three unrelated systems in one file:
 * pointer/spotlight tracking, the card registry, and this bolt. The registry had already been
 * extracted; this one is completely separable — it owns its own timers, its own geometry
 * derivation and its own overlay, and the grid only needs to say "discharge now" and "here is
 * the container". Splitting it leaves the grid with the pointer system, which is the part that
 * genuinely belongs to the grid.
 *
 * It also makes the fractal generator a plain exported function, which is the kind of thing
 * that should have a test rather than a screenshot.
 */

/** Milliseconds between automatic discharges. */
const PULSE_INTERVAL = 4000

/** How long a bolt stays mounted, in milliseconds. */
const PULSE_LIFE = 1000

/** Largest gap, in px, between two card edges that still reads as "adjacent". */
const PULSE_MAX_GAP = 40

/** Cards closer than this on the shared axis count as overlapping. */
const MIN_OVERLAP = 8

export interface PulsePoint {
  x: number
  y: number
}

/** What the grid can ask the pulse to do. */
export interface InterCardPulseHandle {
  /** Fire a discharge immediately (used when the visitor clicks the grid). */
  emit: () => void
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Midpoint displacement — the classic fractal lightning generator.
 *
 * Start with the straight segment, then repeatedly split every segment at its midpoint and
 * shove that midpoint along the segment's NORMAL by a random amount. Halving the displacement
 * each pass (`roughness` < 1) makes the coarse silhouette dominate and the fine jitter
 * decorrelate, which is what makes the result read as a discharge rather than as white noise.
 * Four passes gives 17 vertices — jagged at the scale of a card gap, not so jagged that it
 * turns into a scribble.
 *
 * Randomness is intentional and lives outside any frame loop: a pulse is generated once,
 * fully, on demand.
 */
export function midpointDisplace(
  from: PulsePoint,
  to: PulsePoint,
  iterations: number,
  roughness: number,
  /** Injectable for tests; defaults to `Math.random`. */
  random: () => number = Math.random,
): PulsePoint[] {
  let points: PulsePoint[] = [from, to]
  const span = Math.hypot(to.x - from.x, to.y - from.y)
  let offset = span * 0.16

  for (let pass = 0; pass < iterations; pass++) {
    const next: PulsePoint[] = [points[0] as PulsePoint]
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i] as PulsePoint
      const b = points[i + 1] as PulsePoint
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      // Normal of this segment: the arc is pushed sideways, never along it.
      const nx = -dy / len
      const ny = dx / len
      const shift = (random() * 2 - 1) * offset
      next.push({
        x: (a.x + b.x) / 2 + nx * shift,
        y: (a.y + b.y) / 2 + ny * shift,
      })
      next.push(b)
    }
    points = next
    offset *= roughness
  }

  return points
}

/**
 * Which pairs of cards are neighbours, in grid-local coordinates.
 *
 * Derived from the measured boxes rather than from the JSX order, so the arcs follow the
 * layout through every breakpoint (four columns down to one) without a second source of truth.
 */
export function findConnections(rects: Rect[]): Array<{ from: PulsePoint; to: PulsePoint }> {
  const connections: Array<{ from: PulsePoint; to: PulsePoint }> = []

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i] as Rect
      const b = rects[j] as Rect

      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w)
      const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)

      // Stacked vertically: shared columns, small vertical gap.
      if (overlapX > MIN_OVERLAP && gapY > -1 && gapY <= PULSE_MAX_GAP) {
        const midX = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2
        const upper = a.y < b.y ? a : b
        const lower = a.y < b.y ? b : a
        connections.push({ from: { x: midX, y: upper.y + upper.h }, to: { x: midX, y: lower.y } })
        continue
      }

      // Side by side: shared rows, small horizontal gap.
      if (overlapY > MIN_OVERLAP && gapX > -1 && gapX <= PULSE_MAX_GAP) {
        const midY = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2
        const left = a.x < b.x ? a : b
        const right = a.x < b.x ? b : a
        connections.push({ from: { x: left.x + left.w, y: midY }, to: { x: right.x, y: midY } })
      }
    }
  }

  return connections
}

interface InterCardPulseProps {
  /** The grid container the bolt is drawn over, and whose cards it measures. */
  targetRef: RefObject<HTMLElement | null>
  /** When false the heartbeat skips a beat instead of measuring an offscreen grid. */
  inViewRef: InViewRef
  /** React 19 passes refs as a normal prop. */
  ref?: RefObject<InterCardPulseHandle | null>
}

export function InterCardPulse({ targetRef, inViewRef, ref }: InterCardPulseProps) {
  const [pulse, setPulse] = useState<{ id: number; d: string } | null>(null)
  const sequence = useRef(0)
  const clearTimer = useRef<number | null>(null)

  const emit = useCallback(() => {
    const grid = targetRef.current
    if (!grid) return

    const gridRect = grid.getBoundingClientRect()
    const cards = Array.from(grid.querySelectorAll<HTMLElement>('[data-spotlight-card]'))
    if (cards.length < 2) return

    const rects = cards.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left - gridRect.left, y: r.top - gridRect.top, w: r.width, h: r.height }
    })

    const connections = findConnections(rects)
    if (!connections.length) return

    const pick = connections[(Math.random() * connections.length) | 0]
    if (!pick) return
    const points = midpointDisplace(pick.from, pick.to, 4, 0.55)

    let d = `M ${(points[0] as PulsePoint).x.toFixed(1)} ${(points[0] as PulsePoint).y.toFixed(1)}`
    for (let i = 1; i < points.length; i++) {
      const p = points[i] as PulsePoint
      d += ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`
    }

    sequence.current += 1
    setPulse({ id: sequence.current, d })

    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
    clearTimer.current = window.setTimeout(() => setPulse(null), PULSE_LIFE)
  }, [targetRef])

  useImperativeHandle(ref, () => ({ emit }), [emit])

  /**
   * Heartbeat. Chained timeouts rather than `setInterval` so a beat that lands while the grid
   * is off screen is skipped without the timer racing itself.
   */
  useEffect(() => {
    /*
     * The visual gate freezes the page to compare screenshots; a bolt arriving in one run and
     * not the other would show up as a 100-level diff across the gallery. Freezing therefore
     * also clears any bolt and stops the heartbeat.
     */
    const stopForStill = onStillChange(() => setPulse(null))
    if (isStill()) return stopForStill

    let timer = 0
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        if (inViewRef.current) emit()
        schedule()
      }, PULSE_INTERVAL)
    }
    schedule()

    return () => {
      stopForStill()
      window.clearTimeout(timer)
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
    }
  }, [emit, inViewRef])

  if (!pulse) return null

  /*
   * Absolutely positioned so it is not a grid item and cannot disturb the matrix. Two stacked
   * paths: a wide pale one for the bloom and a thin saturated one for the core of the arc.
   *
   * `pathLength={100}` normalises the bolt to 100 units regardless of how long it actually is,
   * so one dasharray of 100 works for every pair and the draw-on animation is identical for a
   * 20px hop and a 500px run. `key` on the id restarts the CSS animation for each discharge.
   */
  return (
    <svg
      key={pulse.id}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible"
    >
      <path
        className="data-pulse data-pulse--glow"
        d={pulse.d}
        pathLength={100}
        fill="none"
        stroke="#a5f3fc"
        strokeWidth={3.5}
        strokeLinecap="round"
      />
      <path
        className="data-pulse"
        d={pulse.d}
        pathLength={100}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </svg>
  )
}

export default InterCardPulse
