import Lenis from 'lenis'
import { clamp, createSpring, resetSpring, safeNumber, stepSpring } from '@/lib/math'
import { advanceR3F } from '@/lib/frameBridge'
import { writeScroll } from '@/store/useAppStore'

/**
 * Scroll engine — the single clock of the application.
 *
 *   RAF ──┬─► lenis.raf(t)        advance inertial scroll (writes DOM transform)
 *         ├─► writeScroll(p, v)   publish transient progress/velocity
 *         ├─► advanceR3F(t)       render WebGL with the SAME timestamp
 *         └─► listeners           imperative DOM consumers (progress bar, HUD)
 *
 * Lenis runs with `autoRaf: false` on purpose: whoever owns the loop owns the
 * clock. Because the DOM scroll and the WebGL frame consume one timestamp,
 * the 3D scene can never lag one frame behind the page.
 */

type FrameListener = (state: { progress: number; velocity: number }) => void

const listeners = new Set<FrameListener>()

let instance: Lenis | null = null
let rafId: number | null = null
let lastTime = 0
let smoothedVelocity = 0
let lastProgress = 0

/**
 * Spring that carries the scroll velocity signal, allocated ONCE at module
 * scope and mutated in place — no per-frame garbage (see AGENTS.md).
 */
const velocitySpring = createSpring(0)

/** Tuning: Apple-ish inertia — long glide, soft exponential ease-out. */
const LENIS_OPTIONS = {
  duration: 1.15,
  easing: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  smoothWheel: true,
  wheelMultiplier: 0.92,
  touchMultiplier: 1.4,
  lerp: 0.09,
  syncTouch: false,
  autoRaf: false,
  anchors: false,
  allowNestedScroll: true,
  // Lenis still uses native scroll when the user asks for reduced motion,
  // while WebGL keeps rendering (it just switches to a calm camera).
  respectReducedMotion: true,
} as const

export function getLenis(): Lenis | null {
  return instance
}

/** Register an imperative per-frame scroll consumer. Returns an unsubscribe fn. */
export function onScrollFrame(listener: FrameListener): () => void {
  listeners.add(listener)
  // Push the current value immediately so late subscribers render correctly.
  listener({ progress: lastProgress, velocity: smoothedVelocity })
  return () => {
    listeners.delete(listener)
  }
}

/** Current smoothed progress, read outside React. */
export const getScrollProgress = (): number => lastProgress
export const getScrollVelocity = (): number => smoothedVelocity

const publish = (progress: number, velocity: number): void => {
  writeScroll(progress, velocity)
  for (const fn of listeners) fn({ progress, velocity })
}

/**
 * Create the Lenis instance and start the master loop.
 * Returns a disposer that tears everything down (StrictMode-safe).
 */
export function createScrollEngine(): () => void {
  if (instance) destroyScrollEngine()

  instance = new Lenis(LENIS_OPTIONS)

  // Prime state + any listener that mounted before the engine existed.
  lastProgress = clamp(safeNumber(instance.progress), 0, 1)
  lastTime = 0
  smoothedVelocity = 0
  resetSpring(velocitySpring, 0)
  publish(lastProgress, 0)

  const frame = (time: number) => {
    rafId = requestAnimationFrame(frame)

    const lenis = instance
    if (!lenis) return

    // 1. Advance the inertial scroll for this frame.
    lenis.raf(time)

    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 1 / 60
    lastTime = time

    // 2. Lenis already smooths its animatedScroll; just read the result.
    const progress = clamp(safeNumber(lenis.progress), 0, 1)

    // 3. Velocity in normalized "progress per second" units.
    //    The raw per-frame delta is noisy, so it is smoothed with a critically
    //    damped spring (Hooke's law) rather than a linear lerp — that is what
    //    makes the value usable as a shader uniform / HUD meter with real weight.
    const instantaneous = (progress - lastProgress) / (dt || 1 / 60)
    stepSpring(
      velocitySpring,
      instantaneous,
      dt,
      { stiffness: 120, damping: 1 }, // ζ = 1 → no overshoot, no jitter
    )
    smoothedVelocity = Math.abs(velocitySpring.value) < 1e-4 ? 0 : velocitySpring.value

    lastProgress = progress

    // 4. Publish to the transient store + imperative DOM consumers.
    publish(progress, smoothedVelocity)

    // 5. Hand the identical timestamp to WebGL.
    advanceR3F(time)
  }

  rafId = requestAnimationFrame(frame)

  return destroyScrollEngine
}

export function destroyScrollEngine(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  instance?.destroy()
  instance = null
  lastTime = 0
  lastProgress = 0
  smoothedVelocity = 0
  resetSpring(velocitySpring, 0)
}

/** Programmatic scroll used by the navbar. */
export function scrollToTarget(target: string | number | HTMLElement, offset = 0): void {
  const lenis = instance
  if (lenis) {
    lenis.scrollTo(target, { offset, duration: 1.4 })
    return
  }
  // Fallback for reduced-motion / engine-not-ready paths.
  if (typeof target === 'string') {
    document.querySelector(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

export function stopScroll(): void {
  instance?.stop()
}

export function startScroll(): void {
  instance?.start()
}

export function resizeScroll(): void {
  instance?.resize()
}
