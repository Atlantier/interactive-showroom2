import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { clamp } from '@/lib/math'
import { isScrollBusy } from '@/lib/scrollEngine'
import { soundEngine } from '@/utils/soundEngine'
import { useInViewAnimation, type InViewRef } from '@/hooks/useInViewAnimation'
import type { SpotlightHandle, SpotlightRegistry } from '@/components/bento/spotlightRegistry'

/**
 * useSpotlightPointer — the cursor/gyroscope spotlight that drives the bento cards.
 *
 * ── Why this is a hook and not part of the grid ─────────────────────────────
 * The review's UI-19 called `BentoGrid` a 769-line file carrying three unrelated systems. It
 * is down to the two that actually interact: this one and the render tree. Everything here is
 * a self-contained input pipeline — it measures cards, caches their geometry, coalesces
 * pointer samples into one animation frame, synthesises a breathing cursor for devices without
 * hover, and folds the gyroscope into that same value. The grid's only role is to mount it and
 * put the returned handlers on the container.
 *
 * ── Why refs, not state ─────────────────────────────────────────────────────
 * Every value below changes on pointer movement or per frame. Routing any of it through React
 * state would re-render the whole grid on each cursor move or each animation frame, for data
 * that only a custom property needs.
 */

/** Breath period on X, in seconds. Deliberately not a divisor of the Y period. */
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

/** Cached geometry for one registered card. */
interface CardEntry {
  element: HTMLElement
  handle: SpotlightHandle
  docLeft: number
  docTop: number
  width: number
  height: number
}

/**
 * One layout read for one element, in DOCUMENT coordinates.
 *
 * Document rather than viewport coordinates on purpose: the cached boxes are compared against
 * the pointer position across frames, and scrolling moves both together. Measuring in document
 * space means a scroll only invalidates the cache (which it must, since cards move relative to
 * each other when the layout reflows) rather than silently shifting every comparison.
 */
function measureLayoutBox(element: HTMLElement): {
  docLeft: number
  docTop: number
  width: number
  height: number
} {
  const rect = element.getBoundingClientRect()
  return {
    docLeft: rect.left + window.scrollX,
    docTop: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
  }
}

export interface SpotlightPointer {
  /** Attach to the grid container. */
  gridRef: RefObject<HTMLDivElement | null>
  /** Hand to `SpotlightContext.Provider`; cards register themselves through it. */
  registry: SpotlightRegistry
  /** True on touch-first devices, where the synthetic breathing cursor takes over. */
  ambient: boolean
  /** Visibility gate, shared with whatever else the grid needs to run per frame. */
  inViewRef: InViewRef
  handlers: {
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
    onPointerLeave: () => void
    onPointerEnter: () => void
    onPointerDown: () => void
  }
}

/** React's synthetic pointer event, imported structurally to avoid a runtime import. */
type PointerEvent<T> = React.PointerEvent<T>

interface Options {
  /** Called on the first press, after the tilt permission has been requested. */
  onPress?: () => void
}

export function useSpotlightPointer({ onPress }: Options = {}): SpotlightPointer {
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
   * Tracked as a ref rather than state: this changes on pointer movement, and a state update
   * would re-render the whole grid every time the cursor crossed a card boundary.
   */
  const hoveredRef = useRef<HTMLElement | null>(null)

  /** Cached grid box in document coordinates, refreshed with the card cache. */
  const gridBoxRef = useRef({ docLeft: 0, docTop: 0, width: 0, height: 0 })

  /**
   * True when the device has no hover-capable pointer.
   *
   * This is a capability question, not a width question: a small laptop window still has a
   * mouse and deserves the cursor spotlight, while a large tablet has neither. `(hover: none)`
   * is the direct signal; `(pointer: coarse)` is the fallback for browsers that report the
   * former inaccurately.
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
      // The ambient spotlight needs the grid box every frame, so it is cached alongside the
      // cards rather than re-measured in the loop.
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

    // Document coordinates for the pointer, so they are in the same space as the values
    // cached by `measureLayoutBox`.
    const docX = x + window.scrollX
    const docY = y + window.scrollY

    /* ── Is the pointer actually over the grid? ────────────────────────────
     * `pointerleave` is not reliable enough to be the only reset path: it does not fire when
     * the pointer jumps away programmatically, and some browsers miss it when the window loses
     * focus or a scroll starts mid-gesture. The consequence is visible — every card stays
     * tilted after the cursor has left. Checking the grid's own box here closes that gap.
     *
     * The border glow is unaffected: it is a pure CSS gradient driven by `--mouse-x/y`, and
     * those keep their last value. This check only governs the 3D tilt.
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
          entry.handle.update(docX - entry.docLeft, docY - entry.docTop, entry.width, entry.height)
          entry.handle.reset()
        }
        hoveredRef.current = null
        return
      }
    }

    for (const entry of cards.values()) {
      // Local coordinates may be negative or exceed the card size. That is intentional: it is
      // what lets the 400px border gradient light up an edge before the cursor visually reaches
      // the card.
      entry.handle.update(docX - entry.docLeft, docY - entry.docTop, entry.width, entry.height)
    }

    /* ── Hover tick ────────────────────────────────────────────────────────
     * Which card is the pointer inside RIGHT NOW? A tick plays only on a genuine crossing
     * between cards, not on every move — otherwise a mouse travelling across one card would
     * machine-gun the sound. The 40 ms throttle inside the engine is the second line of
     * defence, for fast sweeps across the grid.
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
    const invalidate = (): void => {
      layoutDirtyRef.current = true
      if (pointerRef.current.active) schedule()
    }

    const onScroll = (): void => {
      // Scrolling moves every card, so the cache is stale by definition.
      layoutDirtyRef.current = true
      if (pointerRef.current.active) schedule()
    }

    window.addEventListener('resize', invalidate, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    // Lenis drives scroll via transforms/scrollTop, but elements can also move because fonts
    // finished loading or an accordion opened.
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
    const apply = (): void => setAmbient(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  /** Guards the iOS permission prompt so it is only ever asked once. */
  const tiltPermissionAsked = useRef(false)

  /**
   * Request the device-orientation permission.
   *
   * iOS 13+ gates `DeviceOrientationEvent` behind an explicit `requestPermission()` call that
   * MUST happen inside a user gesture — there is no way to ask on load. It is therefore wired
   * to the grid's first `pointerdown`, the first moment the visitor has shown intent to
   * interact. A denial is not an error: the breathing curve already supplies the ambient
   * motion, so the tilt is a bonus rather than a requirement.
   */
  const requestTiltPermission = useCallback(() => {
    if (tiltPermissionAsked.current) return
    tiltPermissionAsked.current = true

    const ctor = window.DeviceOrientationEvent as unknown as
      { requestPermission?: () => Promise<string> } | undefined
    if (typeof ctor?.requestPermission !== 'function') return
    void ctor.requestPermission().catch(() => undefined)
  }, [])

  /**
   * Read the gyroscope into a smoothed tilt vector.
   *
   * `gamma` is the left-right roll and `beta` the front-back pitch. Beta is measured from the
   * phone lying flat, so a comfortable viewing angle sits around 42 degrees — subtracting that
   * means holding the phone normally reads as "no tilt" instead of pinning the spotlight into a
   * corner.
   */
  useEffect(() => {
    if (!ambient) return

    const onOrientation = (event: DeviceOrientationEvent): void => {
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
   * On a touch device `group-hover` never fires, so the glow — the entire visual identity of
   * the bento — is invisible. This loop synthesises the pointer the mouse path would have
   * produced: a slow Lissajous curve through the grid, offset by however the phone is being
   * held, written into the SAME `SpotlightHandle`s. Everything downstream (border ring, wash
   * gradient, tilt springs) is untouched, so it looks exactly like a cursor sweep.
   *
   * Gated on `inViewRef` for the same reason the sandboxes are: a grid three screens away must
   * not cost N DOM writes per card per frame.
   */
  useEffect(() => {
    if (!ambient) return

    let raf = 0
    const origin = performance.now()

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (!inViewRef.current) return
      // Nothing of this sweep is perceptible while the page is scrolling, and it writes a
      // custom property on every card per frame — stand it down.
      if (isScrollBusy()) return

      if (layoutDirtyRef.current) refreshLayout()
      const grid = gridBoxRef.current
      if (grid.width === 0 || grid.height === 0) return

      // Ease toward the sensor reading; raw gyro data is noisy enough to make the glow jitter
      // if applied directly.
      const tilt = tiltRef.current
      tilt.x += (tilt.targetX - tilt.x) * TILT_SMOOTHING
      tilt.y += (tilt.targetY - tilt.y) * TILT_SMOOTHING

      const seconds = (now - origin) / 1000
      const breathX = 0.5 + BREATH_AMPLITUDE * Math.sin((seconds / BREATH_PERIOD_X) * Math.PI * 2)
      const breathY =
        0.5 + BREATH_AMPLITUDE * Math.sin((seconds / BREATH_PERIOD_Y) * Math.PI * 2 + 1.7)

      const docX = grid.docLeft + (breathX + tilt.x * TILT_RANGE) * grid.width
      const docY = grid.docTop + (breathY + tilt.y * TILT_RANGE) * grid.height

      for (const entry of cardsRef.current.values()) {
        entry.handle.update(docX - entry.docLeft, docY - entry.docTop, entry.width, entry.height)
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ambient, inViewRef, refreshLayout])

  /* ── Pointer handlers on the container ─────────────────────────────────── */

  /*
   * In ambient mode the mouse path stands down completely.
   *
   * A touch still fires pointer events, so without this guard the cursor logic and the
   * breathing loop would both write `--mouse-x/y` every frame — visible as the glow stuttering
   * and jumping whenever a finger rests on the grid.
   */
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
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
    // Entering is a reliable moment to refresh: layout may have shifted while the pointer was
    // elsewhere.
    layoutDirtyRef.current = true
    pointerRef.current.active = true
  }, [ambient])

  /** First contact is the only opportunity to ask iOS for motion access. */
  const onPointerDown = useCallback(() => {
    if (ambient) requestTiltPermission()
    onPress?.()
  }, [ambient, requestTiltPermission, onPress])

  return {
    gridRef,
    registry,
    ambient,
    inViewRef,
    handlers: { onPointerMove, onPointerLeave, onPointerEnter, onPointerDown },
  }
}

export default useSpotlightPointer
