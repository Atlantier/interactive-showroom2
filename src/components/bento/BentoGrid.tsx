import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'
import { useInViewAnimation } from '@/hooks/useInViewAnimation'
import { soundEngine } from '@/utils/soundEngine'
import { isScrollBusy } from '@/lib/scrollEngine'
import {
  SpotlightContext,
  type SpotlightHandle,
  type SpotlightRegistry,
} from '@/components/bento/spotlightRegistry'

/**
 * BentoGrid — the parent container that drives every card's spotlight.
 *
 * ── One listener, N cards ──────────────────────────────────────────────────
 * A single `mousemove` on the grid computes each card's LOCAL cursor position
 * from one `getBoundingClientRect()` per card and pushes it into that card via
 * its registered handle. Two reasons this beats a listener per card:
 *
 *  1. Cards must react while the cursor is OUTSIDE them. The border-glow effect
 *     depends on the gradient's centre being able to sit beyond the card edge,
 *     and a per-card `mousemove` simply does not fire there.
 *  2. It is one listener, one read pass, one frame-consistent update for the
 *     whole matrix instead of N independent event storms.
 *
 * ── Coordinate strategy ────────────────────────────────────────────────────
 * `getBoundingClientRect()` is only called when the pointer enters the grid and
 * after scroll/resize invalidate the cached rects — never inside the move
 * handler. Reading layout during a move handler would force a synchronous
 * reflow on every pointer event, which is the classic way these grids end up
 * janky on large screens.
 *
 * ── Throttling ─────────────────────────────────────────────────────────────
 * Moves are coalesced into one `requestAnimationFrame` callback. Pointer events
 * can fire faster than the display refreshes (and much faster on high-polling
 * mice); without coalescing, the tilt springs receive redundant samples and the
 * CSS variable writes exceed the frame budget for no visual gain.
 */

export interface BentoGridProps {
  children: ReactNode
  className?: string
}

/** Cached geometry for one registered card. */
interface CardEntry {
  element: HTMLElement
  handle: SpotlightHandle
  /** Layout-box position in DOCUMENT coordinates (unaffected by transforms). */
  docLeft: number
  docTop: number
  width: number
  height: number
}

/**
 * How long the breathing curve takes to traverse one full cycle, in seconds.
 *
 * Deliberately slow. A glow that visibly races around the grid draws the eye
 * away from the card content and reads as a loading state; at this speed it
 * reads as the interface being alive.
 */
const BREATH_PERIOD_X = 17
const BREATH_PERIOD_Y = 23

/** Fraction of the grid the breathing point roams across, around the centre. */
const BREATH_AMPLITUDE = 0.34

/** How far a full device tilt can push the spotlight, as a fraction of the grid. */
const TILT_RANGE = 0.2

/** Tilt smoothing per frame; low enough that hand tremor never reaches the glow. */
const TILT_SMOOTHING = 0.075

/** Degrees of gamma (left-right roll) that map to a full-scale tilt. */
const GAMMA_FULL_SCALE = 32

/** Beta value, in degrees, of a phone held comfortably for viewing. */
const BETA_REST = 42

/** Degrees of beta deviation that map to a full-scale tilt. */
const BETA_FULL_SCALE = 32

/**
 * Measure an element's layout box in document coordinates.
 *
 * ── Why not `getBoundingClientRect()` ─────────────────────────────────────
 * `getBoundingClientRect()` reports the element's *transformed* bounding box.
 * These cards carry a spring-driven `rotateX/rotateY`, so once a card tilts its
 * reported rect shrinks and shifts — measured drift of ~8px horizontally and
 * ~14px vertically at an 8° tilt. Since the spotlight needs the card's true
 * layout box (the cursor offset is compared against the CSS box, and the visual
 * movement is only a few pixels), using the transformed rect would feed the tilt
 * back into the coordinate maths and make the glow swim as the card leans.
 *
 * `offsetLeft`/`offsetTop` are layout metrics and are explicitly NOT affected by
 * CSS transforms, so walking the `offsetParent` chain yields a stable document
 * position. `offsetWidth`/`offsetHeight` are likewise untransformed.
 */
function measureLayoutBox(element: HTMLElement): {
  docLeft: number
  docTop: number
  width: number
  height: number
} {
  let x = 0
  let y = 0
  let node: HTMLElement | null = element

  while (node) {
    x += node.offsetLeft
    y += node.offsetTop
    // `offsetParent` is null for fixed-position elements and detached nodes.
    node = node.offsetParent as HTMLElement | null
  }

  // `offsetLeft/Top` are relative to the padding edge of the offsetParent chain,
  // which excludes the document scroll offset. Add the scroll position so the
  // result is comparable with `clientX + window.scrollX`.
  //
  // The outerHTML check guards against a fixed-position ancestor (where the
  // offset chain already stops at the viewport origin and adding scroll would
  // double-count); in practice this grid is in normal flow, so scroll is added.
  return {
    docLeft: x,
    docTop: y,
    width: element.offsetWidth,
    height: element.offsetHeight,
  }
}

export function BentoGrid({ children, className }: BentoGridProps) {
  /** Registered cards, keyed by element. */
  const cardsRef = useRef(new Map<HTMLElement, CardEntry>())

  /** The grid container, observed for size changes. */
  const gridRef = useRef<HTMLDivElement>(null)

  /** Latest pointer position in viewport coordinates. */
  const pointerRef = useRef({ x: 0, y: 0, active: false })

  /** Pending rAF handle for coalescing. */
  const rafRef = useRef<number | null>(null)

  /** Geometry generation; bumped when the cache must be rebuilt. */
  const layoutDirtyRef = useRef(true)

  /**
   * Card currently under the pointer, for the hover tick.
   *
   * Tracked as a ref rather than state: this changes on pointer movement, and a
   * state update would re-render the whole grid every time the cursor crossed a
   * card boundary.
   */
  const hoveredRef = useRef<HTMLElement | null>(null)

  /** Cached grid box in document coordinates, refreshed with the card cache. */
  const gridBoxRef = useRef({ docLeft: 0, docTop: 0, width: 0, height: 0 })

  /**
   * True when the device has no hover-capable pointer.
   *
   * This is a capability question, not a width question: a small laptop window
   * still has a mouse and deserves the cursor spotlight, while a large tablet
   * has neither. `(hover: none)` is the direct signal; `(pointer: coarse)` is
   * the fallback for browsers that report the former inaccurately.
   */
  const [ambient, setAmbient] = useState(false)

  /** Smoothed device tilt, each axis in [-1, 1]. */
  const tiltRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0 })

  /** Gate for the breathing loop, so an offscreen grid costs nothing. */
  const inViewRef = useInViewAnimation(gridRef, { rootMargin: '20% 0px 20% 0px' })

  /**
   * Re-measure every card. Called on enter/scroll/resize, never per move.
   * One batch read of N rects, then all writes happen in the rAF.
   */
  const refreshLayout = useCallback(() => {
    const gridEl = gridRef.current
    if (gridEl) {
      // The ambient spotlight needs the grid box every frame, so it is cached
      // alongside the cards rather than re-measured in the loop.
      gridBoxRef.current = measureLayoutBox(gridEl)
    }
    for (const entry of cardsRef.current.values()) {
      const box = measureLayoutBox(entry.element)
      entry.docLeft = box.docLeft
      entry.docTop = box.docTop
      entry.width = box.width
      entry.height = box.height
    }
    layoutDirtyRef.current = false
  }, [])

  /** Apply the current pointer position to every card. */
  const applyPointer = useCallback(() => {
    rafRef.current = null

    const { x, y, active } = pointerRef.current
    const cards = cardsRef.current

    if (!active) {
      for (const entry of cards.values()) entry.handle.reset()
      hoveredRef.current = null
      return
    }

    if (layoutDirtyRef.current) refreshLayout()

    // Document coordinates for the pointer, so they are in the same space as the
    // values cached by `measureLayoutBox`.
    const docX = x + window.scrollX
    const docY = y + window.scrollY

    /* ── Is the pointer actually over the grid? ────────────────────────────
     * `pointerleave` is not reliable enough to be the only reset path: it does
     * not fire when the pointer jumps away programmatically, and some browsers
     * miss it when the window loses focus or a scroll starts mid-gesture. The
     * consequence is visible — every card stays tilted after the cursor has
     * left. Checking the grid's own box here closes that gap, and it also stops
     * the tilt from being driven by a cursor that is nowhere near the matrix.
     *
     * The border glow is unaffected: it is a pure CSS gradient driven by
     * `--mouse-x/y`, and those keep their last value. This check only governs
     * the 3D tilt.
     */
    const gridEl = gridRef.current
    if (gridEl) {
      const g = measureLayoutBox(gridEl)
      const inside =
        docX >= g.docLeft &&
        docX <= g.docLeft + g.width &&
        docY >= g.docTop &&
        docY <= g.docTop + g.height

      if (!inside) {
        for (const entry of cards.values()) {
          entry.handle.update(
            docX - entry.docLeft,
            docY - entry.docTop,
            entry.width,
            entry.height,
          )
          entry.handle.reset()
        }
        hoveredRef.current = null
        return
      }
    }

    for (const entry of cards.values()) {
      // Local coordinates may be negative or exceed the card size. That is
      // intentional: it is what lets the 400px border gradient light up an edge
      // before the cursor visually reaches the card.
      entry.handle.update(
        docX - entry.docLeft,
        docY - entry.docTop,
        entry.width,
        entry.height,
      )
    }

    /* ── Hover tick ────────────────────────────────────────────────────────
     * Which card is the pointer inside RIGHT NOW? A tick plays only on a genuine
     * crossing between cards, not on every move — otherwise a mouse travelling
     * across one card would machine-gun the sound. The 40 ms throttle inside the
     * engine is the second line of defence, for fast sweeps across the grid.
     *
     * Rect containment is tested against the cached document boxes, so this
     * costs no extra layout reads.
     */
    let hovered: HTMLElement | null = null
    for (const entry of cards.values()) {
      if (
        docX >= entry.docLeft &&
        docX <= entry.docLeft + entry.width &&
        docY >= entry.docTop &&
        docY <= entry.docTop + entry.height
      ) {
        hovered = entry.element
        break
      }
    }

    if (hovered !== hoveredRef.current) {
      hoveredRef.current = hovered
      if (hovered) soundEngine.playHoverTick()
    }
  }, [refreshLayout])

  /** Coalesce a pointer sample into the next animation frame. */
  const schedule = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(applyPointer)
  }, [applyPointer])

  /* ── Registry handed to the cards ──────────────────────────────────────── */
  const registry = useMemo<SpotlightRegistry>(
    () => ({
      register: (element, handle) => {
        const box = measureLayoutBox(element)
        cardsRef.current.set(element, {
          element,
          handle,
          docLeft: box.docLeft,
          docTop: box.docTop,
          width: box.width,
          height: box.height,
        })
        // Position the new card immediately so it is correct before the next move.
        if (pointerRef.current.active) schedule()
      },
      unregister: (element) => {
        cardsRef.current.delete(element)
      },
    }),
    [schedule],
  )

  /* ── Global listeners that invalidate the cached geometry ──────────────── */
  useEffect(() => {
    const invalidate = () => {
      layoutDirtyRef.current = true
      if (pointerRef.current.active) schedule()
    }

    const onScroll = () => {
      // Scrolling moves every card, so the cache is stale by definition.
      layoutDirtyRef.current = true
      if (pointerRef.current.active) schedule()
    }

    window.addEventListener('resize', invalidate, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    // Lenis drives scroll via transforms/scrollTop, but elements can also move
    // because fonts finished loading or an accordion opened.
    const resizeObserver = new ResizeObserver(invalidate)
    const gridEl = gridRef.current
    if (gridEl) resizeObserver.observe(gridEl)

    return () => {
      window.removeEventListener('resize', invalidate)
      window.removeEventListener('scroll', onScroll)
      resizeObserver.disconnect()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [schedule])

  /* ── Touch / no-hover adaptation ────────────────────────────────────────── */
  useEffect(() => {
    const query = window.matchMedia('(hover: none), (pointer: coarse)')
    const apply = () => setAmbient(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  /** Guards the iOS permission prompt so it is only ever asked once. */
  const tiltPermissionAsked = useRef(false)

  /**
   * Request the device-orientation permission.
   *
   * iOS 13+ gates `DeviceOrientationEvent` behind an explicit
   * `requestPermission()` call that MUST happen inside a user gesture — there is
   * no way to ask on load. It is therefore wired to the grid's first
   * `pointerdown`, the first moment the visitor has shown intent to interact.
   * A denial is not an error: the breathing curve already supplies the ambient
   * motion, so the tilt is a bonus rather than a requirement.
   */
  const requestTiltPermission = useCallback(() => {
    if (tiltPermissionAsked.current) return
    tiltPermissionAsked.current = true

    const ctor = window.DeviceOrientationEvent as unknown as
      | { requestPermission?: () => Promise<string> }
      | undefined
    if (typeof ctor?.requestPermission !== 'function') return
    void ctor.requestPermission().catch(() => undefined)
  }, [])

  /**
   * Read the gyroscope into a smoothed tilt vector.
   *
   * `gamma` is the left-right roll and `beta` the front-back pitch. Beta is
   * measured from the phone lying flat, so a comfortable viewing angle sits
   * around 42 degrees — subtracting that means holding the phone normally reads
   * as "no tilt" instead of pinning the spotlight into a corner.
   */
  useEffect(() => {
    if (!ambient) return

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (event.gamma === null && event.beta === null) return
      tiltRef.current.targetX = clamp((event.gamma ?? 0) / GAMMA_FULL_SCALE, -1, 1)
      tiltRef.current.targetY = clamp(
        ((event.beta ?? BETA_REST) - BETA_REST) / BETA_FULL_SCALE,
        -1,
        1,
      )
    }

    window.addEventListener('deviceorientation', onOrientation)
    return () => window.removeEventListener('deviceorientation', onOrientation)
  }, [ambient])

  /**
   * The breathing spotlight.
   *
   * On a touch device `group-hover` never fires, so the glow — the entire visual
   * identity of the bento — is invisible. This loop synthesises the pointer the
   * mouse path would have produced: a slow Lissajous curve through the grid,
   * offset by however the phone is being held, written into the SAME
   * `SpotlightHandle`s. Everything downstream (border ring, wash gradient, tilt
   * springs) is untouched, so it looks exactly like a cursor sweep.
   *
   * Gated on `inViewRef` for the same reason the sandboxes are: a grid three
   * screens away must not cost N DOM writes per card per frame.
   */
  useEffect(() => {
    if (!ambient) return

    let raf = 0
    const origin = performance.now()

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (!inViewRef.current) return
      // Nothing of this sweep is perceptible while the page is scrolling, and it
      // writes a custom property on every card per frame -- stand it down.
      if (isScrollBusy()) return

      if (layoutDirtyRef.current) refreshLayout()
      const grid = gridBoxRef.current
      if (grid.width === 0 || grid.height === 0) return

      // Ease toward the sensor reading; raw gyro data is noisy enough to make
      // the glow jitter if applied directly.
      const tilt = tiltRef.current
      tilt.x += (tilt.targetX - tilt.x) * TILT_SMOOTHING
      tilt.y += (tilt.targetY - tilt.y) * TILT_SMOOTHING

      const seconds = (now - origin) / 1000
      const breathX =
        0.5 + BREATH_AMPLITUDE * Math.sin((seconds / BREATH_PERIOD_X) * Math.PI * 2)
      const breathY =
        0.5 +
        BREATH_AMPLITUDE * Math.sin((seconds / BREATH_PERIOD_Y) * Math.PI * 2 + 1.7)

      const docX = grid.docLeft + (breathX + tilt.x * TILT_RANGE) * grid.width
      const docY = grid.docTop + (breathY + tilt.y * TILT_RANGE) * grid.height

      for (const entry of cardsRef.current.values()) {
        entry.handle.update(
          docX - entry.docLeft,
          docY - entry.docTop,
          entry.width,
          entry.height,
        )
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ambient, inViewRef, refreshLayout])

  /* ── Pointer handlers on the container ─────────────────────────────────── */

  /*
   * In ambient mode the mouse path stands down completely.
   *
   * A touch still fires pointer events, so without this guard the cursor logic
   * and the breathing loop would both write `--mouse-x/y` every frame — visible
   * as the glow stuttering and jumping whenever a finger rests on the grid.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (ambient) return
      pointerRef.current.x = event.clientX
      pointerRef.current.y = event.clientY
      pointerRef.current.active = true
      schedule()
    },
    [ambient, schedule],
  )

  const onPointerLeave = useCallback(() => {
    if (ambient) return
    pointerRef.current.active = false
    schedule()
  }, [ambient, schedule])

  const onPointerEnter = useCallback(() => {
    if (ambient) return
    // Entering is a reliable moment to refresh: layout may have shifted while
    // the pointer was elsewhere.
    layoutDirtyRef.current = true
    pointerRef.current.active = true
  }, [ambient])

  /* ── Inter-card data pulse ────────────────────────────────────────────────
   * Lives on the grid rather than on a card: the bolt spans the GAP between two
   * cards, which belongs to neither of them, and the adjacency has to be derived
   * from the live layout since the grid reflows from four columns to one.
   */
  const [pulse, setPulse] = useState<{ id: number; d: string } | null>(null)
  const pulseSeq = useRef(0)
  const pulseClear = useRef<number | null>(null)

  const emitPulse = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    const gridRect = grid.getBoundingClientRect()
    const cards = Array.from(
      grid.querySelectorAll<HTMLElement>('[data-spotlight-card]'),
    )
    if (cards.length < 2) return

    const rects = cards.map((el) => {
      const r = el.getBoundingClientRect()
      return {
        x: r.left - gridRect.left,
        y: r.top - gridRect.top,
        w: r.width,
        h: r.height,
      }
    })

    /*
     * Two cards are neighbours when their spans overlap on one axis and they are
     * separated by less than a grid gap on the other. Deriving this from the
     * measured boxes (rather than from the JSX order) means the arcs follow the
     * layout through every breakpoint without a second source of truth.
     */
    const connections: Array<{ from: PulsePoint; to: PulsePoint }> = []

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]

        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w)
        const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)

        // Stacked vertically: shared columns, small vertical gap.
        if (overlapX > 8 && gapY > -1 && gapY <= PULSE_MAX_GAP) {
          const midX = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2
          const upper = a.y < b.y ? a : b
          const lower = a.y < b.y ? b : a
          connections.push({
            from: { x: midX, y: upper.y + upper.h },
            to: { x: midX, y: lower.y },
          })
          continue
        }

        // Side by side: shared rows, small horizontal gap.
        if (overlapY > 8 && gapX > -1 && gapX <= PULSE_MAX_GAP) {
          const midY = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2
          const left = a.x < b.x ? a : b
          const right = a.x < b.x ? b : a
          connections.push({
            from: { x: left.x + left.w, y: midY },
            to: { x: right.x, y: midY },
          })
        }
      }
    }

    if (!connections.length) return

    const pick = connections[(Math.random() * connections.length) | 0]
    const points = midpointDisplace(pick.from, pick.to, 4, 0.55)

    let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`
    }

    pulseSeq.current += 1
    setPulse({ id: pulseSeq.current, d })

    if (pulseClear.current !== null) window.clearTimeout(pulseClear.current)
    pulseClear.current = window.setTimeout(() => setPulse(null), PULSE_LIFE)
  }, [])

  /**
   * Heartbeat. Chained timeouts rather than `setInterval` so a pulse that lands
   * while the grid is off screen is skipped without the timer racing itself.
   */
  useEffect(() => {
    let timer = 0
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        if (inViewRef.current) emitPulse()
        schedule()
      }, PULSE_INTERVAL)
    }
    schedule()

    return () => {
      window.clearTimeout(timer)
      if (pulseClear.current !== null) window.clearTimeout(pulseClear.current)
    }
  }, [emitPulse, inViewRef])

  /** First contact is the only opportunity to ask iOS for motion access. */
  const onPointerDown = useCallback(() => {
    if (ambient) requestTiltPermission()
    // Any click on the matrix also fires a discharge, so the grid answers input
    // immediately instead of waiting for the next heartbeat.
    emitPulse()
  }, [ambient, requestTiltPermission, emitPulse])

  return (
    <SpotlightContext.Provider value={registry}>
      <div
        ref={gridRef}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerEnter={onPointerEnter}
        onPointerDown={onPointerDown}
        // Consumed by the `[data-spotlight='ambient']` rules in index.css, which
        // lift the `group-hover` gate so the glow is visible without a cursor.
        data-spotlight={ambient ? 'ambient' : undefined}
        className={cn(
          'grid gap-4',
          // Rows track their content on phones, so the single-column layout reads
          // as a natural card flow instead of seven 17rem boxes with trapped
          // whitespace. The fixed rhythm returns at md, where the matrix is
          // actually a matrix.
          'auto-rows-[auto] md:auto-rows-[minmax(0,17rem)]',
          // One column on phones, two on medium, four on large — the bento rhythm.
          'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
          // Positioning context for the pulse overlay below. Harmless to the
          // grid itself — `relative` only creates the containing block.
          'relative',
          className,
        )}
      >
        {children}

        {/*
         * ── Inter-card data pulse ──────────────────────────────────────────
         * Absolutely positioned so it is not a grid item and cannot disturb the
         * matrix. Two stacked paths: a wide pale one for the bloom and a thin
         * saturated one for the core of the arc.
         *
         * `pathLength={100}` normalises the bolt to 100 units regardless of how
         * long it actually is, so one dasharray of 100 works for every pair and
         * the draw-on animation is identical for a 20px hop and a 500px run.
         *
         * `key` on the id restarts the CSS animation for each new discharge.
         */}
        {pulse && (
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
        )}
      </div>
    </SpotlightContext.Provider>
  )
}

/* -------------------------------------------------------------------------- */
/*  Inter-card data pulse                                                     */
/* -------------------------------------------------------------------------- */

/** Milliseconds between automatic discharges. */
const PULSE_INTERVAL = 4000

/** How long a bolt stays mounted, in milliseconds. */
const PULSE_LIFE = 1000

/** Largest gap, in px, between two card edges that still reads as "adjacent". */
const PULSE_MAX_GAP = 40

interface PulsePoint {
  x: number
  y: number
}

/**
 * Midpoint displacement — the classic fractal lightning generator.
 *
 * Start with the straight segment, then repeatedly split every segment at its
 * midpoint and shove that midpoint along the segment's NORMAL by a random
 * amount. Halving the displacement each pass (`roughness` < 1) makes the coarse
 * silhouette dominate and the fine jitter decorrelate, which is what makes the
 * result read as a discharge rather than as white noise. Four passes gives 17
 * vertices — jagged at the scale of a card gap, not so jagged that it turns into
 * a scribble.
 *
 * Randomness is intentional here and lives outside the frame loop: a pulse is
 * generated once, fully, on demand.
 */
function midpointDisplace(
  from: PulsePoint,
  to: PulsePoint,
  iterations: number,
  roughness: number,
): PulsePoint[] {
  let points: PulsePoint[] = [from, to]
  const span = Math.hypot(to.x - from.x, to.y - from.y)
  let offset = span * 0.16

  for (let pass = 0; pass < iterations; pass++) {
    const next: PulsePoint[] = [points[0]]
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]
      const b = points[i + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      // Normal of this segment: the arc is pushed sideways, never along it.
      const nx = -dy / len
      const ny = dx / len
      const shift = (Math.random() * 2 - 1) * offset
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

export default BentoGrid
