import * as THREE from 'three'

/**
 * Camera path for the architecture narrative.
 *
 * ── Why a Catmull-Rom curve and not keyframed lerps ────────────────────────
 * A curve gives C1 continuity, so the camera's velocity is continuous across the
 * whole 0→1 range. Chaining `lerp`s between waypoints produces a visible
 * direction snap at every join, which reads as a camera operator bumping the
 * dolly — exactly the artefact an "Apple keynote" sequence cannot have.
 *
 * The path is built once at module load from fixed control points, then sampled
 * with `getPointAt(p)` (arc-length parameterised, so speed is even regardless of
 * waypoint spacing).
 *
 * ── Shape ─────────────────────────────────────────────────────────────────
 *   p=0.00  wide, slightly high  — establish the closed stack
 *   p=0.30  begin pushing in     — separation starts
 *   p=0.50  lateral orbit        — the exploded view, seen from the side
 *   p=0.70  low, close to middle — focus on the orchestration nodes
 *   p=1.00  pull back and up     — the reassembled object, then fade
 */

/** Camera positions along the route. */
const CAMERA_POINTS: THREE.Vector3Tuple[] = [
  [0, 1.1, 11.5],
  [1.9, 1.6, 10.2],
  [-2.6, 1.2, 8.8],
  [-4.4, 0.6, 5.4],
  [-3.1, 0.15, 2.1],
  [0.2, 0.35, 1.25],
  [2.9, 0.9, 2.6],
  [3.6, 2.4, 6.4],
  [0, 3.2, 10.8],
]

/** The point the camera aims at along the route. */
const TARGET_POINTS: THREE.Vector3Tuple[] = [
  /*
   * The opening waypoints look HIGH.
   *
   * The closed stack now runs from the grid at y = -0.33 up to the crystal's top
   * vertex at y = 4.25, because the crystal is 1.5x larger than the path was
   * originally framed for. Aiming at y = 0.1 put the crystal's centre ~9.5 degrees
   * above the frame centre while its own angular radius is ~11.2 degrees -- right
   * on the 21-degree half-FOV, so its top was clipped.
   *
   * Centring the closed stack instead lifts that to ~2.5 + 11.1 degrees, which
   * leaves real headroom. The value then eases back down before the explode so the
   * camera tilt into the exploded view stays continuous.
   */
  [0, 1.55, 0],
  [0, 1.5, 0],
  [0, 1.1, 0],
  [0, 0.1, 0],
  [0, -0.25, 0],
  [0, 0.35, 0],
  [0, 0.55, 0],
  [0, 0.2, 0],
  [0, 0, 0],
]

export interface CameraPath {
  /** Sample the camera position at `p ∈ [0,1]`. Writes into `out`. */
  samplePosition: (p: number, out: THREE.Vector3) => void
  /** Sample the look-at target at `p ∈ [0,1]`. Writes into `out`. */
  sampleTarget: (p: number, out: THREE.Vector3) => void
}

/**
 * Build the camera path. Called once; the returned samplers are allocation-free.
 */
export function createCameraPath(): CameraPath {
  const posCurve = new THREE.CatmullRomCurve3(
    CAMERA_POINTS.map((p) => new THREE.Vector3(...p)),
    false,
    // 'centripetal' avoids the cusps and self-intersections that the uniform
    // parameterisation can produce when control points are unevenly spaced —
    // exactly the case here, where the middle waypoints bunch up.
    'centripetal',
  )

  const targetCurve = new THREE.CatmullRomCurve3(
    TARGET_POINTS.map((p) => new THREE.Vector3(...p)),
    false,
    'centripetal',
  )

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

  return {
    samplePosition: (p, out) => {
      // `getPointAt` is arc-length parameterised: constant visual speed.
      posCurve.getPointAt(clamp01(p), out)
    },
    sampleTarget: (p, out) => {
      targetCurve.getPointAt(clamp01(p), out)
    },
  }
}

/* -------------------------------------------------------------------------- */
/*  Timeline                                                                  */
/* -------------------------------------------------------------------------- */

/** Sub-phase boundaries of the narrative, in local progress. */
export const PHASE = {
  /** Stacked, slowly rotating. */
  assembleEnd: 0.3,
  /** Exploded view with data streams and camera push. */
  explodeEnd: 0.7,
  /** Reassembled, then fades out while cards appear. */
  fadeStart: 0.7,
  fadeEnd: 1,
} as const

/** Smooth 0→1 ramp, used to ease every phase transition. */
export function ramp(value: number, from: number, to: number): number {
  if (to <= from) return value >= to ? 1 : 0
  const t = (value - from) / (to - from)
  if (t <= 0) return 0
  if (t >= 1) return 1
  // smootherstep: zero first AND second derivative at both ends, so layer
  // separation eases in and out instead of starting with a jerk.
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * Separation distance per layer at full explode.
 * Index 0 = bottom (infrastructure), 1 = middle, 2 = top.
 */
export const LAYER_Y = {
  /** Resting offsets: the stack is tightly interlocked. */
  rest: [-0.95, 0, 0.95] as const,
  /** Extra offset added at full explode. */
  explode: [-2.05, 0, 2.05] as const,
}
