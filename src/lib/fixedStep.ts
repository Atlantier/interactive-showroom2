/**
 * Fixed-timestep clock for the 2D physics sandboxes.
 *
 * ── Why this is shared ──────────────────────────────────────────────────────
 * `VerletLanyard` and `FabrikCreature` each carried their own copy of the same
 * bookkeeping: a `lastTime`, a delta clamp, an accumulator, a max-steps guard, a debt
 * cap and the two gate branches that rebase the clock. That duplication is how the
 * same three bugs existed in both files at once (unbounded debt, no rebase on wake, and
 * a slider's worth of subtle differences between the copies).
 *
 * ── Contract ───────────────────────────────────────────────────────────────
 *   const clock = createFixedStepClock({ fixedDt: 1 / 60, maxSteps: 4 })
 *   ...
 *   if (paused) { clock.skip(now); return }   // rebases, so waking does not replay
 *   clock.begin(now)                          // adds this frame's delta
 *   while (clock.pending()) { step(fixedDt); clock.consume() }
 *   clock.end()                               // caps the debt
 *   const alpha = clock.alpha()               // for render interpolation
 *
 * Every method mutates one plain object: no allocation per frame, which matters
 * because this runs inside a requestAnimationFrame callback.
 *
 * ── Why the debt is capped ─────────────────────────────────────────────────
 * A loop can only run `maxSteps` per frame. Whatever the accumulator cannot spend stays
 * behind, so below roughly `maxSteps * fixedDt` of real frame time the debt grows
 * without bound and the simulation's clock falls permanently behind wall-clock time --
 * motion becomes slow motion, and the gap widens for the rest of the session. Capping
 * to one frame's worth of steps makes the sim lag under load and then keep the correct
 * RATE, which is the behaviour a fixed-step integrator is supposed to have.
 */

export interface FixedStepClock {
  /** Rebase the clock without spending time (off screen, scroll-busy, paused). */
  skip: (nowMs: number) => void
  /** Add this frame's delta to the accumulator; returns the accepted delta. */
  begin: (nowMs: number) => number
  /** Zero the accumulator and rebase (used by a sandbox reset). */
  reset: (nowMs: number) => void
  /** Whether another step fits in this frame's budget. */
  pending: () => boolean
  /** Spend one step. Call once per executed step. */
  consume: () => void
  /** Cap the leftover debt. Call after the step loop. */
  end: () => void
  /** Fraction of a step already accumulated, in [0, 1). For render interpolation. */
  alpha: () => number
  /** Steps executed since the last `begin`. */
  steps: () => number
}

export interface FixedStepOptions {
  /** Length of one physics step, in seconds. */
  fixedDt: number
  /** Upper bound on steps per frame. */
  maxSteps: number
  /**
   * Largest frame delta the clock will accept, in seconds.
   *
   * A backgrounded tab or a blocked main thread produces a delta of seconds; feeding
   * that to the accumulator would run the whole budget at once and teleport the
   * simulation.
   */
  maxDelta?: number
}

export function createFixedStepClock({
  fixedDt,
  maxSteps,
  maxDelta = 0.1,
}: FixedStepOptions): FixedStepClock {
  let lastMs = 0
  let acc = 0
  let steps = 0

  return {
    skip(nowMs) {
      // Rebasing is the whole point: without it the first frame back treats the entire
      // absence as one delta (clamped to `maxDelta`, still a visible hop).
      lastMs = nowMs
      steps = 0
    },

    begin(nowMs) {
      const dt = lastMs === 0 ? fixedDt : Math.min((nowMs - lastMs) / 1000, maxDelta)
      lastMs = nowMs
      acc += dt
      steps = 0
      return dt
    },

    reset(nowMs) {
      acc = 0
      steps = 0
      lastMs = nowMs
    },

    pending: () => acc >= fixedDt && steps < maxSteps,

    consume() {
      acc -= fixedDt
      steps += 1
    },

    end() {
      acc = Math.min(acc, fixedDt * maxSteps)
    },

    alpha: () => (fixedDt > 0 ? acc / fixedDt : 0),

    steps: () => steps,
  }
}
