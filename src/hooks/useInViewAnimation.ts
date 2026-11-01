import { useEffect, useRef, type RefObject } from 'react'

/**
 * A live, mutable visibility flag.
 *
 * Deliberately a ref-like object rather than a boolean return value: every
 * consumer reads it from inside a `requestAnimationFrame` loop, and returning a
 * plain boolean would mean a React state update on every crossing — re-rendering
 * the whole subtree (and, for an R3F canvas, the whole scene graph) just to say
 * "you are off screen now".
 */
export interface InViewRef {
  current: boolean
}

export interface UseInViewAnimationOptions {
  /**
   * Margin around the viewport, in the usual IntersectionObserver syntax.
   *
   * A positive margin wakes a module BEFORE it scrolls in, so its first visible
   * frame is already running. Without it there is a one-frame hitch on entry as
   * the loop restarts and the first physics step lands.
   */
  rootMargin?: string
  /**
   * Value before the first observation fires. `true` is optimistic: a module
   * that is already on screen at mount starts immediately instead of waiting a
   * frame. An off-screen one renders at most one extra frame before the observer
   * corrects it.
   */
  initial?: boolean
  /** Called on every transition. Use for imperative side effects, not state. */
  onChange?: (inView: boolean) => void
}

/**
 * Pause a module's animation work while it is outside the viewport.
 *
 * ── What "pause" means per module ─────────────────────────────────────────
 *   · 2D sandboxes (Verlet, FABRIK) — stop scheduling their rAF loop. The loops
 *     read `.current` at the top of each frame and return early.
 *   · R3F canvases — skip `gl.render()` for that root (see `RenderGate`), and
 *     their `useFrame` callbacks already early-return on the same flag.
 *
 * ── Why one shared hook ───────────────────────────────────────────────────
 * Three modules previously each hand-rolled the same observer with slightly
 * different margins and cleanup, which is exactly the kind of duplication that
 * drifts. One implementation also means one place to get the edge cases right:
 * a null ref at mount, a ref that changes identity, and an environment with no
 * IntersectionObserver at all.
 *
 * @param ref     Element to observe. May be null at first render.
 * @param options Margin, initial value and a change callback.
 */
export function useInViewAnimation<T extends Element>(
  ref: RefObject<T | null>,
  options: UseInViewAnimationOptions = {},
): InViewRef {
  const { rootMargin = '25% 0px 25% 0px', initial = true, onChange } = options

  const inViewRef = useRef<boolean>(initial)

  // Kept in a ref so a changing callback never re-creates the observer, which
  // would otherwise drop the current intersection state and re-fire on every
  // parent render.
  const callbackRef = useRef(onChange)
  callbackRef.current = onChange

  useEffect(() => {
    const element = ref.current

    // No element (unmounted, or a ref that has not attached yet): assume
    // visible. Reporting "hidden" would silently park a module that might be
    // perfectly on screen.
    if (!element) {
      inViewRef.current = true
      return
    }

    // Older browsers and some embedded webviews: run everything always rather
    // than freezing the page.
    if (typeof IntersectionObserver === 'undefined') {
      inViewRef.current = true
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const next = entry.isIntersecting
          if (next === inViewRef.current) continue
          inViewRef.current = next
          callbackRef.current?.(next)
        }
      },
      { rootMargin },
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, rootMargin])

  return inViewRef
}

export default useInViewAnimation
