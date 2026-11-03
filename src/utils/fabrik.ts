/**
 * FABRIK — Forward And Backward Reaching Inverse Kinematics.
 *
 * ── The algorithm ─────────────────────────────────────────────────────────
 * FABRIK solves a joint chain by alternating two passes:
 *
 *   BACKWARD  place the end effector ON the target, then walk back toward the
 *             root, restoring each bone to its rest length.
 *   FORWARD   pin the root back down and walk outward, restoring lengths again.
 *
 * It converges because each pass is a projection onto the constraint set, and the
 * result is geometrically smooth without any Jacobian or matrix inverse — which
 * is why it is fast enough to run in a 60Hz frame loop for dozens of chains.
 *
 * ── Why not CCD or Jacobian transpose ─────────────────────────────────────
 * CCD produces the characteristic "curled tip" because it optimises joints one at
 * a time from the tip inward. Jacobian methods need a pseudo-inverse per frame.
 * FABRIK needs only normalisation, and its whole-chain passes keep the limb
 * evenly curved — the thing that makes an IK arm look mechanical rather than
 * rubbery.
 *
 * ── Angle cone constraints ────────────────────────────────────────────────
 * Plain FABRIK happily produces a joint folded back on itself (a 180° "elbow
 * inversion"), which no real linkage can do. After each pair of passes every
 * interior joint's bend is clamped, and the entire downstream sub-chain is
 * rotated to satisfy it. See `applyAngleConstraints`.
 */

/** A plain mutable 2D vector. Structural, so anything with x/y works. */
export interface Vec2 {
  x: number
  y: number
}

/** One joint in a chain. The chain is the array, so joints carry no indices. */
export type IKJoint = Vec2

/** Outcome of one `solveFABRIK` call. */
export interface FABRIKResult {
  /** True when the end effector reached the target within `tolerance`. */
  converged: boolean
  /** Sweeps actually performed. */
  iterations: number
  /** Final distance from the end effector to the target, in pixels. */
  error: number
  /**
   * True when the target is farther than the chain can reach. The chain is laid
   * out straight toward it and no sweeps are run — iterating would not help and
   * would only burn cycles.
   */
  unreachable: boolean
}

export interface FABRIKOptions {
  /** Maximum backward/forward sweeps. Default 12. */
  maxIterations?: number
  /**
   * Maximum bend allowed at each interior joint, in radians.
   *
   * A bend of 0 is perfectly straight; π is fully folded back. Default is 100°,
   * which permits a natural elbow but forbids the 180° inversion that makes an
   * arm look broken. Pass 0 or a negative value to disable the clamp entirely.
   */
  maxBend?: number
  /**
   * Reusable result object. Supply this from a frame loop to keep the solver
   * allocation-free.
   */
  result?: FABRIKResult
}

/** 100° — enough for a human-like elbow, far short of a fold-back. */
export const DEFAULT_MAX_BEND = (Math.PI * 100) / 180

/** Twelve sweeps is the standard FABRIK figure and settles to sub-pixel. */
export const DEFAULT_MAX_ITERATIONS = 12

/** Allocate a result object. */
export function createFABRIKResult(): FABRIKResult {
  return { converged: false, iterations: 0, error: 0, unreachable: false }
}

/** Total reach of a chain, i.e. the sum of its bone lengths. */
/**
 * True when every joint of a chain is finite (PB-17).
 *
 * The FABRIK solver is a fixed-point iteration: one non-finite coordinate feeds back into the next
 * sweep and the whole chain is poisoned within a frame or two. The arm then points at nothing and
 * never recovers, which reads as a frozen toy rather than as an error -- so the sandbox checks its
 * rigs each step and rebuilds them instead.
 */
export function jointsAreFinite(joints: readonly IKJoint[]): boolean {
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i]
    if (!Number.isFinite(j.x) || !Number.isFinite(j.y)) return false
  }
  return true
}

export function chainLength(lengths: readonly number[]): number {
  let total = 0
  for (let i = 0; i < lengths.length; i++) total += lengths[i]
  return total
}

/**
 * Clamp the bend at every interior joint, rotating the downstream sub-chain.
 *
 * ── How the clamp works ───────────────────────────────────────────────────
 * At joint `i`, let `a` be the incoming direction (i−1 → i) and `b` the outgoing
 * direction (i → i+1). The signed angle between them is `atan2(a × b, a · b)`,
 * which is exactly the rotation needed to bring `b` onto `a`.
 *
 * Clamping that angle to ±`maxBend` gives a signed delta, and rotating the whole
 * subtree (joints i+1 … n−1) about joint `i` by that delta applies the correction.
 * Rotating the subtree rather than just the next joint is what keeps the bone
 * lengths intact — a rigid rotation preserves every distance within the subtree.
 *
 * Joints are processed root-outward, so an earlier clamp is not disturbed by a
 * later one (the later rotation happens strictly downstream of it).
 */
export function applyAngleConstraints(joints: IKJoint[], maxBend: number): void {
  const n = joints.length
  if (n < 3 || maxBend <= 0) return

  for (let i = 1; i < n - 1; i++) {
    const prev = joints[i - 1]
    const cur = joints[i]
    const next = joints[i + 1]
    if (!prev || !cur || !next) continue

    let ax = cur.x - prev.x
    let ay = cur.y - prev.y
    let bx = next.x - cur.x
    let by = next.y - cur.y

    const al = Math.sqrt(ax * ax + ay * ay)
    const bl = Math.sqrt(bx * bx + by * by)
    if (al < 1e-9 || bl < 1e-9) continue

    ax /= al
    ay /= al
    bx /= bl
    by /= bl

    // Signed angle from `a` to `b`, in (−π, π].
    const cross = ax * by - ay * bx
    const dot = ax * bx + ay * by
    const bend = Math.atan2(cross, dot)

    const clamped = bend > maxBend ? maxBend : bend < -maxBend ? -maxBend : bend
    const delta = clamped - bend
    if (delta === 0) continue

    const cos = Math.cos(delta)
    const sin = Math.sin(delta)
    for (let k = i + 1; k < n; k++) {
      const p = joints[k]
      const px = p.x - cur.x
      const py = p.y - cur.y
      p.x = cur.x + px * cos - py * sin
      p.y = cur.y + px * sin + py * cos
    }
  }
}

/**
 * Solve a joint chain so its end effector reaches `target`.
 *
 * The chain is mutated in place. `joints[0]` is the root and stays pinned;
 * `lengths[i]` is the rest length of the bone from `joints[i]` to `joints[i+1]`,
 * so `lengths` is always one shorter than `joints`.
 *
 * @param joints    Chain to solve, root first. Mutated.
 * @param target    Where the end effector should go.
 * @param lengths   Bone rest lengths; `lengths.length === joints.length - 1`.
 * @param tolerance Convergence threshold in pixels.
 * @param options   Iteration cap, angle clamp and an optional reusable result.
 */
export function solveFABRIK(
  joints: IKJoint[],
  target: Vec2,
  lengths: readonly number[],
  tolerance: number,
  options: FABRIKOptions = {},
): FABRIKResult {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const maxBend = options.maxBend ?? DEFAULT_MAX_BEND
  const out = options.result ?? createFABRIKResult()

  const n = joints.length

  // Degenerate input: nothing to solve. Report honestly rather than silently
  // returning a stale success.
  if (n < 2 || lengths.length < n - 1) {
    out.converged = false
    out.iterations = 0
    out.unreachable = false
    out.error = Number.POSITIVE_INFINITY
    return out
  }

  const rootX = joints[0].x
  const rootY = joints[0].y

  let reach = 0
  for (let i = 0; i < n - 1; i++) reach += lengths[i]

  const toTargetX = target.x - rootX
  const toTargetY = target.y - rootY
  const targetDist = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY)

  /* ── Unreachable: stretch straight at the target ───────────────────────── */
  if (targetDist > reach) {
    const inv = 1 / (targetDist || 1)
    const ux = toTargetX * inv
    const uy = toTargetY * inv
    let px = rootX
    let py = rootY
    joints[0].x = px
    joints[0].y = py
    for (let i = 1; i < n; i++) {
      px += ux * lengths[i - 1]
      py += uy * lengths[i - 1]
      joints[i].x = px
      joints[i].y = py
    }
    out.unreachable = true
    out.converged = false
    out.iterations = 0
    // Report how far short the arm falls, which is a useful HUD number.
    out.error = targetDist - reach
    return out
  }

  /* ── Reachable: alternate sweeps until converged ───────────────────────── */
  let error = Math.sqrt(
    (joints[n - 1].x - target.x) * (joints[n - 1].x - target.x) +
      (joints[n - 1].y - target.y) * (joints[n - 1].y - target.y),
  )

  let iterations = 0
  for (; iterations < maxIterations; iterations++) {
    /* BACKWARD pass: snap the tip to the target, then walk back to the root. */
    joints[n - 1].x = target.x
    joints[n - 1].y = target.y
    for (let i = n - 2; i >= 0; i--) {
      const a = joints[i]
      const b = joints[i + 1]
      const len = lengths[i]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < 1e-9) {
        // Coincident joints have no direction to project along. Nudge them apart
        // so the next pass has something to work with instead of producing NaN.
        a.x = b.x - len
        a.y = b.y
        continue
      }
      const r = len / d
      a.x = b.x + dx * r
      a.y = b.y + dy * r
    }

    /* FORWARD pass: pin the root, rebuild outward at rest lengths. */
    joints[0].x = rootX
    joints[0].y = rootY
    for (let i = 1; i < n; i++) {
      const a = joints[i - 1]
      const b = joints[i]
      const len = lengths[i - 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < 1e-9) {
        b.x = a.x + len
        b.y = a.y
        continue
      }
      const r = len / d
      b.x = a.x + dx * r
      b.y = a.y + dy * r
    }

    /* Angle cones: applied after the passes, so the next sweep re-converges. */
    if (maxBend > 0) applyAngleConstraints(joints, maxBend)

    const ex = joints[n - 1].x - target.x
    const ey = joints[n - 1].y - target.y
    error = Math.sqrt(ex * ex + ey * ey)

    if (error <= tolerance) {
      iterations++
      break
    }
  }

  out.iterations = iterations
  out.error = error
  out.converged = error <= tolerance
  out.unreachable = false
  return out
}
