import { useEffect, useRef } from 'react'

export interface FpsSample {
  /** Frames per second, one decimal. */
  fps: number
  /** Average frame time in milliseconds. */
  frameMs: number
  /** Worst frame time observed in the sampling window. */
  worstMs: number
  /** Screen size in CSS pixels. */
  width: number
  height: number
  /** Device pixel ratio (rounded to 2 decimals). */
  dpr: number
}

/** How often the sampler emits a reading, in milliseconds. */
const SAMPLE_INTERVAL = 250

/**
 * Low-overhead FPS / viewport telemetry sampler.
 *
 * IMPORTANT (project rule #3): this hook never calls `setState` from inside a
 * rAF callback. It measures in the loop, then hands a plain object to
 * `onSample`, which the caller uses to write text straight into DOM nodes via
 * refs. That keeps the HUD completely outside React's render cycle — the same
 * discipline we apply to the transient store.
 *
 * While `enabled` is false the hook is fully inert: no rAF, no listeners.
 *
 * @param enabled  Whether sampling should run at all.
 * @param onSample Called ~4×/s with the latest reading. Keep it stable
 *                 (useCallback) and treat it as a DOM-write sink.
 */
export function useFpsMonitor(enabled: boolean, onSample: (sample: FpsSample) => void): void {
  // Keep the latest callback without restarting the loop when it changes.
  const callbackRef = useRef(onSample)
  callbackRef.current = onSample

  useEffect(() => {
    if (!enabled) return

    let rafId = 0
    let frames = 0
    let worst = 0
    let windowStart = performance.now()
    let prevFrame = windowStart
    let cancelled = false

    const emit = (now: number) => {
      const elapsed = now - windowStart
      if (elapsed < SAMPLE_INTERVAL || frames === 0) return

      callbackRef.current({
        fps: Math.round(((frames * 1000) / elapsed) * 10) / 10,
        frameMs: Math.round((elapsed / frames) * 100) / 100,
        worstMs: Math.round(worst * 100) / 100,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      })

      frames = 0
      worst = 0
      windowStart = now
    }

    const tick = (now: number) => {
      if (cancelled) return
      rafId = requestAnimationFrame(tick)

      const frameMs = now - prevFrame
      prevFrame = now
      frames += 1
      if (frameMs > worst) worst = frameMs

      emit(now)
    }

    rafId = requestAnimationFrame(tick)

    // Stop measuring while the tab is hidden: rAF is throttled there and the
    // resulting numbers would be meaningless (or wildly wrong).
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafId)
        rafId = 0
      } else if (!rafId && !cancelled) {
        frames = 0
        worst = 0
        windowStart = performance.now()
        prevFrame = windowStart
        rafId = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      if (rafId) cancelAnimationFrame(rafId)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
}
