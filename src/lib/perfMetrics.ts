/**
 * A mutable, allocation-free performance counter registry.
 *
 * ── Why a module-scope object and not React state ─────────────────────────
 * Everything here changes up to 60 times a second. Putting it in the store would
 * re-render the app continuously for numbers only a debug overlay reads. This is
 * the same discipline as the transient scroll store: producers write, the HUD
 * reads from its own frame loop, and React never hears about it.
 *
 * ── Cost of reporting ─────────────────────────────────────────────────────
 * Every setter is a plain field assignment. `performance.now()` is called by the
 * producers, not here, so a module that is not being measured pays nothing.
 */

/** Number of samples in the memory sparkline ring buffer. */
export const HEAP_HISTORY_SIZE = 96

export interface PerformanceCounters {
  /** Active GPU particles across every canvas. */
  particles: number
  /** Duration of the last physics constraint solve, in milliseconds. */
  physicsSolveMs: number
  /** Exponential average of the physics solve, in milliseconds. */
  physicsSolveAvgMs: number
  /** Number of constraint iterations performed in the last solve batch. */
  constraintIterations: number
  /** Duration of the last IK solve batch, in milliseconds. */
  ikSolveMs: number
  /** Number of IK chains solved in the last batch. */
  ikChains: number
  /** JS heap in megabytes, or 0 when the browser does not expose it. */
  heapMB: number
  /** True when `performance.memory` is available. */
  heapAvailable: boolean
  /** Ring buffer of recent heap readings, oldest first. Never reallocated. */
  heapHistory: Float32Array
  /** Write cursor into `heapHistory`. */
  heapCursor: number
  /** How many entries in `heapHistory` are populated. */
  heapCount: number
  /** Canvases currently asleep because they are outside the viewport. */
  sleepingCanvases: number
}

/** The single shared instance. Import and read/mutate directly. */
export const performanceCounters: PerformanceCounters = {
  particles: 0,
  physicsSolveMs: 0,
  physicsSolveAvgMs: 0,
  constraintIterations: 0,
  ikSolveMs: 0,
  ikChains: 0,
  heapMB: 0,
  heapAvailable: false,
  heapHistory: new Float32Array(HEAP_HISTORY_SIZE),
  heapCursor: 0,
  heapCount: 0,
  sleepingCanvases: 0,
}

/** Smoothing factor for the physics-solve moving average (per sample). */
const SOLVE_SMOOTHING = 0.12

/**
 * Report a physics constraint-solve duration.
 *
 * Keeps both the instantaneous value and a smoothed one: the instantaneous
 * number is what a developer wants when hunting a spike, the average is what
 * tells them whether the solver is generally affordable.
 */
export function reportPhysicsSolve(milliseconds: number, iterations: number): void {
  performanceCounters.physicsSolveMs = milliseconds
  performanceCounters.constraintIterations = iterations
  const prev = performanceCounters.physicsSolveAvgMs
  performanceCounters.physicsSolveAvgMs =
    prev === 0 ? milliseconds : prev + (milliseconds - prev) * SOLVE_SMOOTHING
}

/** Report an IK solve batch. */
export function reportIkSolve(milliseconds: number, chains: number): void {
  performanceCounters.ikSolveMs = milliseconds
  performanceCounters.ikChains = chains
}

/** Report the live GPU particle count. */
export function reportParticles(count: number): void {
  performanceCounters.particles = count
}

/**
 * Read the JS heap if the browser exposes it.
 *
 * `performance.memory` is a non-standard Chrome API. It is absent in Safari and
 * Firefox, so the HUD must degrade to "n/a" rather than showing a fake zero —
 * hence the `heapAvailable` flag rather than treating 0 as a real reading.
 */
export function sampleHeap(): void {
  const perf = performance as unknown as {
    memory?: { usedJSHeapSize: number }
  }
  const memory = perf.memory
  if (!memory || typeof memory.usedJSHeapSize !== 'number') {
    performanceCounters.heapAvailable = false
    return
  }
  const mb = memory.usedJSHeapSize / (1024 * 1024)
  performanceCounters.heapMB = mb
  performanceCounters.heapAvailable = true

  const history = performanceCounters.heapHistory
  history[performanceCounters.heapCursor] = mb
  performanceCounters.heapCursor = (performanceCounters.heapCursor + 1) % HEAP_HISTORY_SIZE
  if (performanceCounters.heapCount < HEAP_HISTORY_SIZE) {
    performanceCounters.heapCount++
  }
}

/**
 * Copy the heap history into `out` in chronological order.
 *
 * @returns How many samples were written (0 when the API is unavailable).
 */
export function readHeapHistory(out: Float32Array): number {
  const count = performanceCounters.heapCount
  if (count === 0) return 0
  const history = performanceCounters.heapHistory
  const start = count === HEAP_HISTORY_SIZE ? performanceCounters.heapCursor : 0
  for (let i = 0; i < count; i++) {
    out[i] = history[(start + i) % HEAP_HISTORY_SIZE]
  }
  return count
}

/** Register a canvas that has gone to sleep, or woken up. */
export function setCanvasSleeping(sleeping: boolean): void {
  if (sleeping) {
    performanceCounters.sleepingCanvases++
  } else {
    performanceCounters.sleepingCanvases = Math.max(
      0,
      performanceCounters.sleepingCanvases - 1,
    )
  }
}
