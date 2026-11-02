import { useEffect, useMemo, useRef } from 'react'

import { onScrollFrame } from '@/lib/scrollEngine'
/**
 * Tracks an element's LOCAL scroll progress in `[0, 1]`.
 *
 * ── What "local progress" means ────────────────────────────────────────────
 * For a section that is `height: 300vh` with a `position: sticky` inner panel,
 * the meaningful interval starts when the section's top touches the viewport top
 * and ends when its bottom reaches the viewport bottom. That interval is exactly
 * `sectionHeight - viewportHeight` tall, which is the distance the sticky panel
 * can travel while pinned.
 *
 *     p = clamp(-rect.top / (sectionHeight - viewportHeight), 0, 1)
 *
 * ── Why it reads layout directly instead of using the scroll store ─────────
 * The global scroll progress describes the whole ~7000px document; a 300vh
 * narrative needs its own 0→1 range. Deriving it from `getBoundingClientRect()`
 * is 2 numbers per frame and needs no measurement of the document, so it stays
 * correct across resize, font load and content changes above the section.
 *
 * The measured value is written to a `MotionValue`, never to React state: the
 * only consumers are a `useFrame` callback and a few CSS transforms, and a
 * state update at scroll frequency would re-render the whole chapter.
 */

/** A minimal numeric store that notifies subscribers without re-rendering. */
export interface ProgressStore {
  get: () => number
  set: (next: number) => void
  subscribe: (listener: (value: number) => void) => () => void
}

/** Create a standalone progress store (plain object, no React dependency). */
export function createProgressStore(initial = 0): ProgressStore {
  let value = initial
  const listeners = new Set<(v: number) => void>()
  return {
    get: () => value,
    set: (next: number) => {
      // Only notify on a meaningful change. A pixel of scroll in a 2000px track
      // is 0.0005, so 1e-4 filters float noise without visible stepping.
      if (Math.abs(next - value) < 1e-4) return
      value = next
      for (const fn of listeners) fn(value)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export interface UseSectionProgressOptions {
  /** Called whenever the local progress changes (by more than 1e-4). */
  onProgress?: (p: number) => void
  /** Disable the rAF loop while the section is offscreen. */
  enabled?: boolean
}

/**
 * Track a section's local `[0,1]` progress and report it imperatively.
 *
 * Returns the element ref to attach to the tall section wrapper, plus a live
 * getter for the current value (for consumers that poll rather than subscribe).
 *
 * Updates run in the same `requestAnimationFrame` loop as the rest of the app,
 * and are skipped entirely while the section is outside the viewport.
 */
export function useSectionProgress(options: UseSectionProgressOptions = {}) {
  const { onProgress, enabled = true } = options
  const sectionRef = useRef<HTMLDivElement>(null)
  /*
   * Created once. `useRef(createProgressStore(0))` evaluates its argument on EVERY
   * render and throws the result away, building (and abandoning) a store object per
   * pass for a value that must be stable for the component's lifetime.
   */
  const store = useMemo(() => createProgressStore(0), [])
  const callbackRef = useRef(onProgress)
  callbackRef.current = onProgress

  useEffect(() => {
    if (!enabled) return
    const el = sectionRef.current
    if (!el) return

    let visible = false

    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      const viewportH = window.innerHeight || 1
      // The pinned travel distance. Guard against a section shorter than the
      // viewport, which would divide by zero (or a negative).
      const travel = Math.max(1, rect.height - viewportH)
      // rect.top is the distance from the viewport top to the section top, so
      // negating it gives how far the section has been scrolled into the pin.
      const raw = -rect.top / travel
      const p = raw < 0 ? 0 : raw > 1 ? 1 : raw
      if (Math.abs(p - store.get()) > 1e-4) {
        store.set(p)
        callbackRef.current?.(p)
      }
    }

    // Only measure while the section is on screen. A 300vh section offscreen
    // still reports a clamped 0 or 1, so skipping is safe and saves work.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting
        }
        if (visible) measure()
      },
      // Generous margin so the first frame of the pin is already correct.
      { rootMargin: '20% 0px 20% 0px' },
    )
    observer.observe(el)

    /*
     * Read on the MASTER clock, not a private rAF.
     *
     * This hook used to start its own requestAnimationFrame from a passive effect.
     * React runs child effects before parent effects, so this loop was always
     * registered BEFORE the scroll engine's loop -- it measured `rect.top` from the
     * previous frame's scroll position, which left every DOM overlay in the chapter
     * (headline, layer labels, metric cards) exactly one frame behind the 3D scene it
     * annotates. That mismatch is the visible "the text lags the model" wobble.
     */
    const unsubscribe = onScrollFrame(() => {
      if (!visible) return
      measure()
    })

    return () => {
      observer.disconnect()
      unsubscribe()
    }
  }, [enabled])

  return { sectionRef, store }
}
