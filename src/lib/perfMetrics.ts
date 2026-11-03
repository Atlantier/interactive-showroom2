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

/**
 * Every canvas that can register a live particle count.
 *
 * Add a kind here when a new canvas starts reporting; `reportParticles` and
 * `getActiveParticleCount` iterate this list, so the HUD's total automatically
 * includes it without any change on the reading side.
 */
export const PARTICLE_SYSTEM_KINDS = ['nebula', 'trail'] as const

/** Identifier of one particle-producing canvas. */
export type ParticleSystemKind = (typeof PARTICLE_SYSTEM_KINDS)[number]

export interface PerformanceCounters {
  /**
   * Active GPU particles across every canvas: the running sum of
   * `particleCounts`, maintained by `reportParticles`.
   *
   * Kept as a flat field (rather than only exposing the per-kind record) so
   * existing readers — the perf audit script and older HUD code — keep working.
   */
  particles: number
  /**
   * Live count per reporting canvas. Never replaced, only mutated, so the HUD
   * can hold a reference to it without allocating.
   */
  particleCounts: Record<ParticleSystemKind, number>
  /**
   * Post-processing shader passes the renderer currently has mounted.
   *
   * Published by the renderer that owns the `EffectComposer` (SceneCanvas);
   * zero until it mounts. Deliberately a plain counter rather than a
   * tier -> count lookup: a duplicated constant is how the old DEV probe's
   * effect list drifted out of sync with the composer.
   */
  shaderPasses: number
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
}

/** The single shared instance. Import and read/mutate directly. */
export const performanceCounters: PerformanceCounters = {
  particles: 0,
  particleCounts: { nebula: 0, trail: 0 },
  shaderPasses: 0,
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

/**
 * Report the live particle count for one canvas.
 *
 * Every particle producer registers under its own `kind`, so one canvas can no
 * longer overwrite another's reading; the HUD sums the registry instead of
 * showing whichever reporter happened to run last.
 */
export function reportParticles(kind: ParticleSystemKind, count: number): void
/**
 * Legacy un-kinded form.
 *
 * The only caller that predates the kinded registry is `FlowFieldParticles`
 * (the background nebula), so `reportParticles(n)` registers as `'nebula'`.
 * Kept so an un-migrated reporter cannot silently zero the app-wide total.
 */
export function reportParticles(count: number): void
export function reportParticles(kindOrCount: ParticleSystemKind | number, count?: number): void {
  const kind: ParticleSystemKind = typeof kindOrCount === 'number' ? 'nebula' : kindOrCount
  const raw = typeof kindOrCount === 'number' ? kindOrCount : (count ?? 0)
  // A broken producer must not poison the shared sum with NaN or Infinity.
  const value = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0
  const previous = performanceCounters.particleCounts[kind]

  performanceCounters.particleCounts[kind] = value
  // Incremental total: no per-frame allocation, and cheap enough that every
  // canvas can report on mount/tier change without a second pass.
  performanceCounters.particles += value - previous
}

/**
 * Sum of every registered particle system's live count.
 *
 * Recomputed from the per-kind registry rather than trusting the cached
 * `particles` field, so the HUD stays correct even if a producer has not
 * reported yet (the trail reports 0 until its canvas mounts).
 */
export function getActiveParticleCount(): number {
  const counts = performanceCounters.particleCounts
  let total = 0
  for (const kind of PARTICLE_SYSTEM_KINDS) total += counts[kind]
  return total
}

/**
 * Publish how many post-processing passes the renderer currently mounts.
 *
 * Called by the component that owns the `EffectComposer` — the number is the
 * length of the effect stack it actually rendered, not a value duplicated in
 * this module. Zero means "no composer mounted".
 */
export function setShaderPassCount(count: number): void {
  performanceCounters.shaderPasses = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0
}

/** Number of post-processing shader passes currently mounted (0 = none). */
export function getShaderPassCount(): number {
  return performanceCounters.shaderPasses
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
