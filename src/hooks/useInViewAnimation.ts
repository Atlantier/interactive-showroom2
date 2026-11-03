import { useEffect, useRef, type RefObject } from 'react'
import { createInViewBinding, type InViewBinding } from '@/lib/inViewObserver'

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
 *   · R3F canvases — the rig contents and their post-processing composer are gated
 *     on this flag. The canvas element itself may stay mounted (keeping the context
 *     alive), and measured at the top of the page it issues 0 draw calls per second
 *     while the architecture chapter is two screens away.
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

  // Read through refs: the binding owns one observer for the component's lifetime, so it must not
  // capture the margin or the element from the render that happened to create it.
  const marginRef = useRef(rootMargin)
  marginRef.current = rootMargin
  const bindingRef = useRef<InViewBinding | null>(null)

  /*
   * Deliberately no dependency array (CR-13).
   *
   * A `RefObject` never changes identity, so `[ref, rootMargin]` ran this effect once -- at the
   * first commit, where the observed element may not exist yet (conditional render, Suspense, a
   * replaced node). The observer was then never attached and the pause gate silently stopped
   * working: off-screen sandboxes kept simulating and off-screen canvases kept their rigs mounted.
   * `sync()` compares and returns when nothing moved, so running it on every render costs a
   * property read and a string comparison.
   */
  useEffect(() => {
    // Older browsers and some embedded webviews: run everything always rather
    // than freezing the page.
    if (typeof IntersectionObserver === 'undefined') {
      bindingRef.current?.disconnect()
      bindingRef.current = null
      inViewRef.current = true
      return
    }

    /*
     * No element (not attached yet, or detached): assume visible. Reporting "hidden" would
     * silently park a module that might be perfectly on screen, and the observer corrects the
     * flag on its first delivery once the node exists.
     */
    if (ref.current === null) {
      inViewRef.current = true
      bindingRef.current?.sync()
      return
    }

    const binding =
      bindingRef.current ??
      (bindingRef.current = createInViewBinding({
        getElement: () => ref.current,
        getRootMargin: () => marginRef.current,
        onIntersect: (inView) => {
          if (inView === inViewRef.current) return
          inViewRef.current = inView
          callbackRef.current?.(inView)
        },
        createObserver: (onEntries, margin) =>
          new IntersectionObserver((entries) => onEntries(entries), { rootMargin: margin }),
      }))

    binding.sync()
  })

  // Detach on unmount only. The setup effect above cleans up its own rewiring.
  useEffect(
    () => () => {
      bindingRef.current?.disconnect()
      bindingRef.current = null
    },
    [],
  )

  return inViewRef
}

export default useInViewAnimation
