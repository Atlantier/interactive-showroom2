import Lenis from 'lenis'
import { clamp, createSpring, resetSpring, safeNumber, stepSpring } from '@/lib/math'
import { advanceR3F } from '@/lib/frameBridge'
import { invalidatePointerBox, transient, writeScroll } from '@/store/useAppStore'
import { resolveProgress } from '@/lib/scrollProgress'

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

/** Mirrors the scroll-busy state onto <html class="is-scrolling">. */
let scrollBusy = false

/**
 * Spring that carries the scroll velocity signal, allocated ONCE at module
 * scope and mutated in place, so the scroll path allocates nothing per frame.
 */
const velocitySpring = createSpring(0)

/**
 * Scroll feel.
 *
 * ── Why `lerp` is 0.2 and not 0.09 ────────────────────────────────────────
 * `lerp` is the fraction of the remaining distance Lenis closes each frame, so
 * 0.09 needs ~25 frames to settle: a wheel notch produced a visible lag between
 * the input and the page actually moving, which reads as "heavy" rather than
 * "smooth". 0.2 settles in roughly half that time and still leaves a glide, so the
 * page keeps the inertial character the camera choreography depends on while the
 * input feels immediate.
 *
 * Dropping `smoothWheel` entirely was the alternative, and it was rejected: the
 * scroll-driven camera, the layer separation and the progress rails are all
 * authored against a continuous scroll signal, and a raw per-notch jump makes the
 * 3D chapters visibly step.
 *
 * `wheelMultiplier` goes to 1.0 so one notch travels the distance the user expects;
 * 0.92 made every gesture feel like it under-responded.
 */
const LENIS_OPTIONS = {
  /*
   * `duration` (with `easing`) WINS over `lerp`: lenis' Animate.advance does
   * `if (this.duration && this.easing) {...} else if (this.lerp) {...}`. The `lerp`
   * that used to sit here was therefore dead configuration -- tuning it changed
   * nothing, and the real feel was a 1.15s fixed tween, noticeably more sluggish
   * than the comment claimed. Deleted rather than left as a decoy.
   *
   * 0.7s keeps the glide the camera choreography is authored against while cutting
   * roughly 40% of the perceived lag between a wheel notch and the page moving.
   */
  duration: 0.7,
  easing: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  smoothWheel: true,
  wheelMultiplier: 1.0,
  touchMultiplier: 1.4,
  syncTouch: false,
  autoRaf: false,
  anchors: false,
  allowNestedScroll: true,
  /*
   * Reduced motion: Lenis falls back to native scrolling.
   *
   * The comment that used to sit here claimed WebGL "switches to a calm camera".
   * It did not -- nothing on the WebGL side ever read the preference, so the
   * parallax, particles and lights ran at full speed regardless. The claim is gone
   * rather than left as a comfort; wiring the preference through the 3D scenes is
   * tracked as CR-07, not asserted here.
   */
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

/**
 * True while the inertial scroll is still settling.
 *
 * Consumers use this to stand down decorative per-frame work: the spotlight sweep
 * across the bento grid, for instance, is invisible while the page is moving but
 * writes a CSS custom property on every card each frame.
 */
export const isScrollBusy = (): boolean => scrollBusy

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

    /*
     * 2. Lenis already smooths its animatedScroll; just read the result.
     *
     * Through `resolveProgress` rather than straight off the instance: Lenis reports
     * `progress === 1` for a document with no scrollable distance, and this app reads progress as
     * "how far through the narrative" -- so a short page, or a long one measured before its
     * content laid out (the first frame or two), started with the camera at the end of its path
     * and eased backwards from there. Zero scrollable distance means zero progress.
     */
    const lenisLimit = (lenis as unknown as { limit?: number }).limit ?? 0
    const progress = resolveProgress(safeNumber(lenis.progress), lenisLimit)

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

    /*
     * 3b. Ease the pointer influence.
     *
     * `active` is a hard boolean, so leaving the window used to collapse every
     * cursor-driven effect in one frame -- the "teleport" the brief reports.
     * Driving an exponential ease here rather than in each consumer keeps the
     * single-clock rule and fixes all of them at once. The rate is expressed as
     * a time constant (7/s), not a per-frame fraction, so it behaves the same at
     * any frame rate.
     */
    const mouseTarget = transient.mouse.active ? 1 : 0
    const mouseEase = 1 - Math.exp(-dt * 7)
    transient.mouse.strength += (mouseTarget - transient.mouse.strength) * mouseEase
    if (Math.abs(mouseTarget - transient.mouse.strength) < 1e-4) {
      transient.mouse.strength = mouseTarget
    }

    /*
     * Advance the eased position toward its target.
     *
     * Small deltas are applied exactly, so ordinary tracking has zero lag. A
     * large delta only happens on re-entry after the pointer left -- the stored
     * position was eased back to the centre in the meantime -- and is eased
     * instead, which is what removes the "teleport on enter" the brief reports.
     */
    const targetX = transient.mouse.active ? transient.mouse.tx : 0
    const targetY = transient.mouse.active ? transient.mouse.ty : 0
    const dx = targetX - transient.mouse.x
    const dy = targetY - transient.mouse.y
    if (transient.mouse.active && Math.abs(dx) < 0.35 && Math.abs(dy) < 0.35) {
      transient.mouse.x = targetX
      transient.mouse.y = targetY
    } else {
      transient.mouse.x += dx * mouseEase
      transient.mouse.y += dy * mouseEase
    }

    /*
     * 3c. Scroll-busy signal.
     *
     * CSS cannot read the spring, so the state is mirrored onto the root element
     * as a class. Decorative infinite animations (comet beams, data pulses) are
     * paused while it is set: during a scroll those loops do no visible work --
     * the page is moving past them -- but they still rasterise every frame.
     *
     * Written only on transition, never per frame: a classList toggle is a style
     * invalidation, and doing it 120 times a second would cost more than the
     * animations it saves.
     */
    const busy = Math.abs(smoothedVelocity) > 0.035
    if (busy !== scrollBusy) {
      scrollBusy = busy
      document.documentElement.classList.toggle('is-scrolling', busy)
    }

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

  /*
   * Global side effects must not outlive the engine.
   *
   * `is-scrolling` lives on <html> and pauses every decorative CSS animation. If
   * it survived teardown (HMR, or StrictMode remount) those animations stayed
   * paused forever with no engine left to clear the class.
   */
  scrollBusy = false
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('is-scrolling')
  }
  // Publish a neutral frame so DOM consumers do not keep drawing the last velocity.
  writeScroll(0, 0)
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
  // The canvas box may have changed with the viewport; drop the cached projection.
  invalidatePointerBox()
}
