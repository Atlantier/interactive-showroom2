import { useEffect, type ReactNode } from 'react'
import { createScrollEngine, getLenis } from '@/lib/scrollEngine'
import { preloadR3FAdvance } from '@/lib/frameBridge'
import { prefersReducedMotion } from '@/lib/device'
import { attachPointerInput } from '@/lib/pointerInput'

/**
 * SmoothScroll — mounts the inertial scroll engine for the whole app.
 *
 * Responsibilities
 * ────────────────
 * 1. Create the Lenis instance and own the single master RAF (see
 *    `lib/scrollEngine.ts`). Every frame it publishes the smoothed scroll
 *    progress `p ∈ [0,1]` and velocity `v` into the transient store AND calls
 *    `advanceR3F()` with the same timestamp, so the DOM scroll and the WebGL
 *    render are driven by one clock.
 * 2. Feed pointer/touch position into the transient store (see
 *    `lib/pointerInput.ts` — pointer events plus the touch events iOS needs
 *    while native scrolling is in progress).
 * 3. Keep Lenis' dimensions correct on resize / font load / orientation change.
 *
 * It renders no visual output of its own; it is a behaviour shell.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Start fetching the WebGL runtime now, but never block the first paint.
    preloadR3FAdvance()

    const reduced = prefersReducedMotion()
    const disposeScroll = createScrollEngine()

    // Recalculate bounds once webfonts settle (Lenis measures the document).
    void document.fonts?.ready.then(() => getLenis()?.resize())

    const onResize = () => getLenis()?.resize()
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('orientationchange', onResize, { passive: true })

    // Mouse + pen + touch → transient store (zero React re-renders).
    const detachPointer = attachPointerInput()

    // Lenis leaves the document at scrollTop 0 on hard reloads / bfcache.
    if (!reduced) {
      getLenis()?.resize()
    }

    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      detachPointer()
      disposeScroll()
    }
  }, [])

  return <>{children}</>
}

export default SmoothScroll
