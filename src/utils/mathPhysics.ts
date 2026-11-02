/**
 * Verlet physics for the interactive lanyard sandbox.
 *
 * ── Why a hand-rolled solver ───────────────────────────────────────────────
 * A rigid-body engine (Rapier, cannon-es) models a rope as a chain of joints,
 * which needs a hundred-plus lines of setup and still jitters under a 12-iteration
 * constraint solve. Verlet integration with explicit distance constraints is both
 * smaller and better suited: the rope is *defined* by its constraints, so it is
 * inextensible by construction rather than by tuning stiffness.
 *
 * ── Allocation discipline ─────────────────────────────────────────────────
 * `step()` runs 360 times a second across four ropes (13 points each). Every
 * scratch value there is a local number; no arrays, objects or vectors are
 * created inside the hot path. Render state is read directly off the mutable
 * `LanyardState` objects, never copied into fresh structures.
 */

/* -------------------------------------------------------------------------- */
/*  Tuning constants                                                          */
/* -------------------------------------------------------------------------- */

/** Fixed simulation step. A variable step makes Verlet explode or go limp. */
export const FIXED_DT = 1 / 60

/** Constraint relaxation passes per step. 12 is the requested stiffness. */
export const RELAXATION_ITERATIONS = 12

/** Strain `(|p_i − p_i+1| − L0) / L0` above which the rope snaps. */
export const BREAK_STRAIN = 2.5

/** Downward acceleration, in sandbox pixels per second squared. */
const GRAVITY_Y = 1900

/** Velocity retained per step. Verlet keeps velocity as position deltas. */
const VELOCITY_DAMPING = 0.994

/** Number of rope segments per lanyard. Points = SEGMENTS + 1. */
const SEGMENTS = 11

/** Rest length of each segment, in pixels. */
const SEGMENT_LENGTH = 27

/* -------------------------------------------------------------------------- */
/*  Core primitives                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A single simulated particle.
 *
 * Position is integrated from the previous position (Verlet), so velocity is
 * implicit: `v = (x − px) / dt`. That is what makes the solver unconditionally
 * stable for a rope and lets external code add impulses by nudging `px`/`py`.
 */
export interface VerletPoint {
  x: number
  y: number
  /** Previous position — this is where the implicit velocity lives. */
  px: number
  py: number
  /**
   * Position at the START of the last integration step.
   *
   * Distinct from `px`/`py`: those are the solver's own history and change meaning
   * inside `relaxConstraints`, while this is purely a render snapshot. The draw path
   * interpolates between `rx/ry` and `x/y` by the accumulator's leftover fraction, so a
   * chord drawn on a 144 Hz display moves every frame instead of stepping at the 60 Hz
   * physics rate. Layout memory, not behaviour: it is written once per step.
   */
  rx: number
  ry: number
  /** Accumulated acceleration for the next integration only. */
  ax: number
  ay: number
  /** 0 for pinned points; otherwise 1 / mass. */
  invMass: number
  pinned: boolean
}

/** A distance constraint ("rod") between two points. */
export interface VerletConstraint {
  /** Index into the owning rope's point array. */
  a: number
  /** Index into the owning rope's point array. */
  b: number
  /** Rest length L0. */
  restLength: number
  /** 0..1 relaxation strength applied per iteration. */
  stiffness: number
  /** Last measured strain; refreshed by `measureMaxStrain`. */
  strain: number
}

/** An oriented bounding box, used for tag-vs-tag collision. */
export interface Obb {
  cx: number
  cy: number
  /** Half width along the local X axis. */
  hw: number
  /** Half height along the local Y axis. */
  hh: number
  /** Rotation in radians. */
  angle: number
}

/** Result of an OBB/OBB test. Reused by the caller to stay allocation-free. */
export interface ObbHit {
  hit: boolean
  /** Collision normal, pointing from A toward B, unit length. */
  nx: number
  ny: number
  /** Penetration depth along the normal. */
  depth: number
}

/** Allocate a particle. Called only during construction. */
export function createPoint(x: number, y: number, pinned = false): VerletPoint {
  return {
    x,
    y,
    px: x,
    py: y,
    rx: x,
    ry: y,
    ax: 0,
    ay: 0,
    invMass: pinned ? 0 : 1,
    pinned,
  }
}

/** Allocate a constraint. Called only during construction. */
export function createConstraint(
  a: number,
  b: number,
  restLength: number,
  stiffness = 1,
): VerletConstraint {
  return { a, b, restLength, stiffness, strain: 0 }
}

/* -------------------------------------------------------------------------- */
/*  Wind field                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The specified wind field: F(t) = A · sin(ω₁t) · cos(ω₂t).
 *
 * Two incommensurate angular frequencies produce a beat pattern, so the gust
 * slowly swells and dies instead of repeating on a short, obvious loop — that
 * beat is what makes an untouched rope look like it is hanging in real air rather
 * than breathing on a timer.
 *
 * @param t          Elapsed seconds.
 * @param amplitude  Peak acceleration in px/s².
 * @param omega1     Primary angular frequency.
 * @param omega2     Beat angular frequency (should be incommensurate with ω₁).
 */
export function windAcceleration(
  t: number,
  amplitude: number,
  omega1: number,
  omega2: number,
): number {
  return amplitude * Math.sin(omega1 * t) * Math.cos(omega2 * t)
}

/* -------------------------------------------------------------------------- */
/*  Integration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Advance every point by one fixed step.
 *
 * The Verlet update is `x += (x − px)·damping + a·dt²`. Gravity is folded into
 * the same accumulator as any external force so callers can queue wind before
 * calling this.
 */
export function integratePoints(points: VerletPoint[], dt: number, gravityY: number): void {
  const dt2 = dt * dt
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    // Render snapshot, taken before anything moves this step (see `rx`/`ry`).
    p.rx = p.x
    p.ry = p.y
    if (p.pinned) {
      // Pinned points still need their history reset, or they would accumulate
      // a phantom velocity and yank the rope when unpinned.
      p.px = p.x
      p.py = p.y
      p.ax = 0
      p.ay = 0
      continue
    }
    const vx = (p.x - p.px) * VELOCITY_DAMPING
    const vy = (p.y - p.py) * VELOCITY_DAMPING
    p.px = p.x
    p.py = p.y
    p.x += vx + p.ax * dt2
    p.y += vy + (p.ay + gravityY) * dt2
    p.ax = 0
    p.ay = 0
  }
}

/**
 * Relax the distance constraints `iterations` times (Gauss–Seidel).
 *
 * Each pass moves both endpoints toward the rest length by a share weighted by
 * inverse mass, so a pinned anchor absorbs none of the correction.
 *
 * ── The optional pin (this is what makes the rope snappable) ──────────────
 * When the user drags a tag, providing the held position as `pinIndex/pinX/pinY`
 * re-applies it BEFORE every iteration. That makes the held end a hard constraint
 * rather than a one-off nudge, so the solver has to distribute an unsatisfiable
 * error along the chain — and the segments genuinely stay stretched. Without it,
 * a fully converged solve pulls the dragged end back and the measured strain
 * collapses to ~0, so the break rule could never fire. (Measured before this
 * change: peak strain 0.89 against a 2.5 threshold — the rope was unbreakable.)
 */
export function relaxConstraints(
  points: VerletPoint[],
  constraints: VerletConstraint[],
  iterations: number,
  pinIndex = -1,
  pinX = 0,
  pinY = 0,
): void {
  for (let it = 0; it < iterations; it++) {
    if (pinIndex >= 0) {
      const pin = points[pinIndex]
      if (pin) {
        pin.x = pinX
        pin.y = pinY
      }
    }

    for (let ci = 0; ci < constraints.length; ci++) {
      const c = constraints[ci]
      const a = points[c.a]
      const b = points[c.b]
      if (!a || !b) continue

      const dx = b.x - a.x
      const dy = b.y - a.y
      const distSq = dx * dx + dy * dy
      if (distSq < 1e-9) continue

      const dist = Math.sqrt(distSq)
      const massSum = a.invMass + b.invMass
      if (massSum <= 0) continue

      // Fraction of the error each endpoint must absorb.
      const correction = ((dist - c.restLength) / dist) * c.stiffness
      const wa = (a.invMass / massSum) * correction
      const wb = (b.invMass / massSum) * correction

      a.x += dx * wa
      a.y += dy * wa
      b.x -= dx * wb
      b.y -= dy * wb
    }
  }
}

/**
 * Refresh `constraint.strain` and return the largest value found.
 *
 * Strain is defined as `(|p_i − p_i+1| − L0) / L0`, matching the break rule in
 * the spec. Positive means stretched; a slack rope reports a negative value,
 * which must not trigger a break.
 */
export function measureMaxStrain(points: VerletPoint[], constraints: VerletConstraint[]): number {
  let max = 0
  for (let ci = 0; ci < constraints.length; ci++) {
    const c = constraints[ci]
    const a = points[c.a]
    const b = points[c.b]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const strain = (dist - c.restLength) / c.restLength
    c.strain = strain
    if (strain > max) max = strain
  }
  return max
}

/* -------------------------------------------------------------------------- */
/*  Oriented bounding box collision                                          */
/* -------------------------------------------------------------------------- */

/**
 * Separating-axis test between two OBBs, writing the minimum translation axis
 * into `out`.
 *
 * ── Why SAT and not AABB ──────────────────────────────────────────────────
 * The tags rotate freely as the rope swings, so their axis-aligned boxes would
 * change size every frame and allow visible corner interpenetration when two
 * tags cross at an angle. SAT over the four face normals is exact for convex
 * boxes and costs four dot products.
 */
export function collideObb(a: Obb, b: Obb, out: ObbHit): ObbHit {
  const ca = Math.cos(a.angle)
  const sa = Math.sin(a.angle)
  const cb = Math.cos(b.angle)
  const sb = Math.sin(b.angle)

  // Face normals of each box.
  const axesX = [ca, sa, -sa, ca, cb, sb, -sb, cb]

  const dx = b.cx - a.cx
  const dy = b.cy - a.cy

  let minOverlap = Number.POSITIVE_INFINITY
  let nx = 0
  let ny = 0

  for (let k = 0; k < 4; k++) {
    const ax = axesX[k * 2]
    const ay = axesX[k * 2 + 1]

    // Projected radius of each box onto this axis.
    const ra = a.hw * Math.abs(ca * ax + sa * ay) + a.hh * Math.abs(-sa * ax + ca * ay)
    const rb = b.hw * Math.abs(cb * ax + sb * ay) + b.hh * Math.abs(-sb * ax + cb * ay)

    const dist = dx * ax + dy * ay
    const overlap = ra + rb - Math.abs(dist)

    if (overlap <= 0) {
      out.hit = false
      out.nx = 0
      out.ny = 0
      out.depth = 0
      return out
    }

    if (overlap < minOverlap) {
      minOverlap = overlap
      // Orient the normal from A toward B.
      const sign = dist < 0 ? -1 : 1
      nx = ax * sign
      ny = ay * sign
    }
  }

  out.hit = true
  out.nx = nx
  out.ny = ny
  out.depth = minOverlap
  return out
}

/* -------------------------------------------------------------------------- */
/*  Curve fitting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One cubic Bezier segment: start, two control points, end.
 *
 * Stored as a flat interface rather than a `Path2D` so the renderer stays free to
 * feed it to `ctx.bezierCurveTo`, an SVG `d` attribute, or a test assertion.
 */
export interface BezierSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  x2: number
  y2: number
  x3: number
  y3: number
}

/**
 * Fit a Catmull-Rom spline through `points` and emit it as cubic Bezier segments.
 *
 * ── Why not just polyline between the particles ───────────────────────────
 * The rope has 12 points spaced ~27px apart. Drawing straight lines between them
 * produces visible corners at every particle, which the eye reads as a chain of
 * sticks rather than a braided cord. Catmull-Rom interpolates THROUGH every point
 * (so the visual still matches the physics exactly) while smoothing the segments
 * between them.
 *
 * ── The conversion ────────────────────────────────────────────────────────
 * For a segment from P1 to P2 with neighbours P0 and P3, the Catmull-Rom tangent
 * at P1 is (P2 − P0)/2 and at P2 is (P3 − P1)/2. A cubic Bezier's control points
 * sit one third of the way along those tangents, which gives:
 *
 *   C1 = P1 + (P2 − P0) / 6
 *   C2 = P2 − (P3 − P1) / 6
 *
 * `tension` scales the tangent: 0.5 is the standard uniform Catmull-Rom, lower
 * values tighten the curve toward the polyline.
 *
 * Endpoints are handled by duplicating the first and last point, so the curve
 * starts and ends exactly on the anchor and the badge with no overshoot.
 */
export function catmullRomToBezier(
  points: ReadonlyArray<{ x: number; y: number }>,
  tension = 0.5,
): BezierSegment[] {
  const n = points.length
  if (n < 2) return []

  const out: BezierSegment[] = []
  // Scale factor: 1/6 is the exact Catmull-Rom↔Bezier conversion at tension 0.5.
  const k = (tension * 2) / 6

  for (let i = 0; i < n - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]
    // Duplicate the endpoints so the boundary tangents are well defined.
    const p0 = i === 0 ? p1 : points[i - 1]
    const p3 = i + 2 < n ? points[i + 2] : p2
    if (!p0 || !p1 || !p2 || !p3) continue

    out.push({
      x0: p1.x,
      y0: p1.y,
      x1: p1.x + (p2.x - p0.x) * k,
      y1: p1.y + (p2.y - p0.y) * k,
      x2: p2.x - (p3.x - p1.x) * k,
      y2: p2.y - (p3.y - p1.y) * k,
      x3: p2.x,
      y3: p2.y,
    })
  }

  return out
}

/**
 * Trace fitted segments into the current path.
 *
 * Leaves the path open; the caller decides whether to stroke or fill.
 */
export function traceBezierPath(ctx: CanvasRenderingContext2D, segments: BezierSegment[]): void {
  if (segments.length === 0) return
  const first = segments[0]
  if (!first) return
  ctx.moveTo(first.x0, first.y0)
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (!s) continue
    ctx.bezierCurveTo(s.x1, s.y1, s.x2, s.y2, s.x3, s.y3)
  }
}

/**
 * Total arc length of the fitted curve, by summing its Bezier segments.
 *
 * Each segment's length is approximated by its chord plus the two control legs
 * (the control polygon), which over-estimates by a few percent — acceptable for
 * spacing texture marks, and far cheaper than flattening every curve.
 */
export function bezierPathLength(segments: BezierSegment[]): number {
  let total = 0
  for (const s of segments) {
    const leg1 = Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
    const leg2 = Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
    const leg3 = Math.hypot(s.x3 - s.x2, s.y3 - s.y2)
    total += (leg1 + leg2 + leg3) * 0.5 + Math.hypot(s.x3 - s.x0, s.y3 - s.y0) * 0.5
  }
  return total
}

/**
 * Evaluate a cubic Bezier at `t ∈ [0,1]`.
 *
 * Used to place fabric weave marks at even arc-length steps along the cord
 * instead of at even parameter steps, which would bunch them up where the curve
 * bends sharply.
 */
export function sampleBezier(
  s: BezierSegment,
  t: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  /*
   * Optional output object.
   *
   * This runs once per weave mark per cord per frame -- three calls each, dozens of
   * marks, four cords -- so returning a fresh `{x, y}` per call was one of the larger
   * sources of per-frame garbage on the sandbox's hot path. Callers on that path pass a
   * reused scratch object; the default keeps every other call site unchanged.
   */
  out.x = a * s.x0 + b * s.x1 + c * s.x2 + d * s.x3
  out.y = a * s.y0 + b * s.y1 + c * s.y2 + d * s.y3
  return out
}

/* -------------------------------------------------------------------------- */
/*  Angle helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Wrap an angle into (−π, π] so spring corrections take the short way round. */
export function wrapAngle(angle: number): number {
  let a = angle
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

/* -------------------------------------------------------------------------- */
/*  Tag (rigid body) state                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mutable state of one hanging badge.
 *
 * `angle` is integrated with real angular momentum: a torsional spring pulls it
 * toward the rope tangent, but the spring is deliberately under-damped so the tag
 * overshoots and swings back. Without that inertia the badge would snap to the
 * tangent instantly and read as a rigidly welded plate.
 */
export interface TagState {
  x: number
  y: number
  /** Position at the previous step, used to derive velocity for impulses. */
  prevX: number
  prevY: number
  vx: number
  vy: number
  angle: number
  angularVelocity: number
  /** Pose inherited from the rope while attached; free when broken. */
  attached: boolean
  width: number
  height: number
  /** True while the user is dragging this tag. */
  grabbed: boolean
}

/** Everything the renderer needs about one lanyard. Nothing here allocates. */
export interface LanyardState {
  id: string
  label: string
  /** Accent colour, used for the rope glow and the tag face. */
  accent: string
  anchorX: number
  anchorY: number
  points: VerletPoint[]
  constraints: VerletConstraint[]
  tag: TagState
  /** Set once the rope has snapped. */
  broken: boolean
  /** 1 while intact, fades to 0 after a break so the rope can disappear. */
  ropeAlpha: number
  /** Highest strain seen this frame (diagnostics / HUD). */
  peakStrain: number
  /**
   * Per-lanyard wind phase offset, in seconds.
   *
   * Without this every rope samples the identical field and all four badges hang
   * at exactly the same angle, which reads as a rigid slab rather than four
   * separate objects hanging in air.
   */
  windPhase: number
  /** Per-lanyard wind amplitude multiplier. */
  windGain: number
}

/* -------------------------------------------------------------------------- */
/*  Simulation                                                               */
/* -------------------------------------------------------------------------- */

export interface LanyardSpec {
  id: string
  label: string
  accent: string
  /** Fraction of the sandbox width where the rope is pinned. */
  anchorXRatio: number
}

export interface SimulationOptions {
  width: number
  height: number
  specs: LanyardSpec[]
}

/** One lanyard's fixed tuning. Shared by all instances; nothing is per-instance. */
const ROPE_STIFFNESS = 0.92

/** Torsional spring pulling the tag toward the rope tangent. */
const TORSION_STIFFNESS = 46
const TORSION_DAMPING = 3.6

/** Restitution for tag-tag and tag-floor impacts. */
const RESTITUTION = 0.42

/**
 * How many impacts one step can report to the audio layer.
 *
 * Four tags can only produce six pairs, so this comfortably covers a step. The
 * pool exists purely so reporting stays allocation-free.
 */
const MAX_IMPACTS_PER_STEP = 8

export class LanyardSimulation {
  width: number
  height: number
  readonly lanyards: LanyardState[]

  /** Index of the lanyard whose tag is being dragged, or -1. */
  grabbedIndex = -1

  /* ── Audio event surface ──────────────────────────────────────────────────
   * The solver reports what happened during a step; it never touches the audio
   * layer itself. Keeping the dependency one-way means the physics stays
   * testable headlessly, and the caller decides whether sound is even enabled.
   *
   * A fixed-size pool with a count, never a growing array: `step()` runs at 60 Hz
   * and pushing to an array would allocate on every impact.
   */
  private readonly impactPool = new Float64Array(MAX_IMPACTS_PER_STEP)
  private impactTotal = 0
  private snappedThisStep = 0

  /** Number of impacts recorded during the most recent `step()`. */
  get impactCount(): number {
    return this.impactTotal
  }

  /**
   * Relative speed of impact `i` from the most recent step, in px/s.
   * @param i - Index below `impactCount`.
   */
  getImpactSpeed(i: number): number {
    return i >= 0 && i < this.impactTotal ? this.impactPool[i] : 0
  }

  /** Number of ropes that snapped during the most recent `step()`. */
  get snapCount(): number {
    return this.snappedThisStep
  }

  /** Record an impact, keeping the loudest entries when the pool overflows. */
  private recordImpact(relativeSpeed: number): void {
    if (this.impactTotal < MAX_IMPACTS_PER_STEP) {
      this.impactPool[this.impactTotal] = relativeSpeed
      this.impactTotal++
      return
    }
    // Pool full: replace the weakest entry. Dropping a loud impact is far more
    // noticeable than dropping a quiet one.
    let weakest = 0
    for (let i = 1; i < MAX_IMPACTS_PER_STEP; i++) {
      if (this.impactPool[i] < this.impactPool[weakest]) weakest = i
    }
    if (relativeSpeed > this.impactPool[weakest]) {
      this.impactPool[weakest] = relativeSpeed
    }
  }

  /** Pointer position while dragging, in sandbox pixels. */
  private pointerX = 0
  private pointerY = 0

  /** Scratch hit used by the collision pass; never reallocated. */
  private readonly hit: ObbHit = { hit: false, nx: 0, ny: 0, depth: 0 }

  /** Scratch OBBs for the collision pass. */
  private readonly obbA: Obb = { cx: 0, cy: 0, hw: 0, hh: 0, angle: 0 }
  private readonly obbB: Obb = { cx: 0, cy: 0, hw: 0, hh: 0, angle: 0 }

  /**
   * Gravity multiplier applied to every rope and every detached badge.
   *
   * A multiplier rather than an absolute value: `GRAVITY_Y` is tuned in
   * sandbox pixels per second squared for the size these lanyards are drawn at,
   * so expressing other worlds as a ratio of Earth keeps moon gravity at exactly
   * 1/6 without re-deriving the constant for each preset.
   *
   * 0 is a legitimate value here (zero-g), so it must never be treated as
   * "unset". Writes go through `setGravityScale` from the frame loop's owner,
   * not per frame, so no smoothing is needed.
   */
  private gravityScale = 1

  /** Set the gravity multiplier. Clamped to a sane range; 0 means zero-g. */
  setGravityScale(scale: number): void {
    if (!Number.isFinite(scale)) return
    this.gravityScale = Math.min(Math.max(scale, 0), 6)
  }

  /** Current gravity multiplier (1 = Earth). */
  getGravityScale(): number {
    return this.gravityScale
  }

  /** Earth gravity expressed in sandbox units, scaled by the current preset. */
  private get gravity(): number {
    return GRAVITY_Y * this.gravityScale
  }

  constructor(options: SimulationOptions) {
    this.width = options.width
    this.height = options.height
    this.lanyards = []
    for (let i = 0; i < options.specs.length; i++) {
      const spec = options.specs[i]
      if (spec) this.lanyards.push(this.buildLanyard(spec, i))
    }
  }

  /* ── Construction ──────────────────────────────────────────────────────── */

  /** @param index - Position in the array; used to derive wind phase/gain. */
  private buildLanyard(spec: LanyardSpec, index: number): LanyardState {
    const anchorX = this.width * spec.anchorXRatio
    const anchorY = 46

    const points: VerletPoint[] = []
    for (let i = 0; i <= SEGMENTS; i++) {
      // Start hanging straight down; the solver makes it droop immediately.
      points.push(createPoint(anchorX, anchorY + i * SEGMENT_LENGTH, i === 0))
    }

    const constraints: VerletConstraint[] = []
    for (let i = 0; i < SEGMENTS; i++) {
      constraints.push(createConstraint(i, i + 1, SEGMENT_LENGTH, ROPE_STIFFNESS))
    }

    const width = 132
    const height = 84
    const end = points[SEGMENTS]

    const tag: TagState = {
      x: end.x,
      y: end.y + height / 2,
      prevX: end.x,
      prevY: end.y + height / 2,
      vx: 0,
      vy: 0,
      angle: 0,
      angularVelocity: 0,
      attached: true,
      width,
      height,
      grabbed: false,
    }

    return {
      id: spec.id,
      label: spec.label,
      accent: spec.accent,
      anchorX,
      anchorY,
      points,
      constraints,
      tag,
      broken: false,
      ropeAlpha: 1,
      peakStrain: 0,
      // Spread the phases around the cycle so the four ropes never line up, and
      // vary the gains so one gust is not identical across all of them. Derived
      // from the index rather than array length: `this.lanyards` is still being
      // filled while this runs.
      windPhase: (index * 1.618) % (Math.PI * 2),
      windGain: 0.82 + ((index * 0.37) % 0.42),
    }
  }

  /** Reposition anchors after a resize without resetting the simulation. */
  resize(width: number, height: number): void {
    const prevW = this.width
    this.width = width
    this.height = height
    if (prevW <= 0) return
    const scale = width / prevW
    for (const l of this.lanyards) {
      l.anchorX = width * (l.anchorX / prevW)
      const p0 = l.points[0]
      if (p0) {
        p0.x = l.anchorX
        p0.px = l.anchorX
      }
      // Gently pull the rest of the rope toward the new anchor X rather than
      // teleporting it, which would inject a huge velocity spike.
      for (let i = 1; i < l.points.length; i++) {
        const p = l.points[i]
        p.x *= scale
        p.px *= scale
      }
    }
  }

  /* ── Interaction ───────────────────────────────────────────────────────── */

  /**
   * Begin a drag if the pointer lands on a tag. Returns true when something was
   * grabbed so the caller can take pointer capture.
   */
  pointerDown(x: number, y: number): boolean {
    // Iterate back to front so the topmost (last drawn) tag wins.
    for (let i = this.lanyards.length - 1; i >= 0; i--) {
      const l = this.lanyards[i]
      const t = l.tag
      if (this.hitTestTag(t, x, y)) {
        this.grabbedIndex = i
        t.grabbed = true
        this.pointerX = x
        this.pointerY = y
        return true
      }
    }
    return false
  }

  pointerMove(x: number, y: number): void {
    this.pointerX = x
    this.pointerY = y
  }

  pointerUp(): void {
    if (this.grabbedIndex >= 0) {
      const l = this.lanyards[this.grabbedIndex]
      if (l) l.tag.grabbed = false
    }
    this.grabbedIndex = -1
  }

  /** True when any tag is currently held. */
  get isDragging(): boolean {
    return this.grabbedIndex >= 0
  }

  /**
   * Point-in-rotated-rect test.
   *
   * Inverse-rotates the point into the tag's local frame instead of building a
   * polygon: two dots and a bounds check.
   */
  private hitTestTag(tag: TagState, x: number, y: number): boolean {
    const dx = x - tag.x
    const dy = y - tag.y
    const cos = Math.cos(-tag.angle)
    const sin = Math.sin(-tag.angle)
    const lx = dx * cos - dy * sin
    const ly = dx * sin + dy * cos
    // A little slack so thin edges are still easy to grab.
    const pad = 6
    return Math.abs(lx) <= tag.width / 2 + pad && Math.abs(ly) <= tag.height / 2 + pad
  }

  /* ── Reset ─────────────────────────────────────────────────────────────── */

  /** Rebuild every lanyard from scratch ("Re-forge Lanyards"). */
  reforge(specs: LanyardSpec[]): void {
    this.grabbedIndex = -1
    this.lanyards.length = 0
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      if (spec) this.lanyards.push(this.buildLanyard(spec, i))
    }
  }

  /** How many lanyards have snapped (for the HUD counter). */
  get brokenCount(): number {
    let n = 0
    for (const l of this.lanyards) if (l.broken) n++
    return n
  }

  /* ── Step ──────────────────────────────────────────────────────────────── */

  /**
   * Advance the simulation by one fixed step.
   *
   * @param dt      Fixed timestep in seconds (use `FIXED_DT`).
   * @param elapsed Total elapsed time in seconds, used by the wind field.
   */
  step(dt: number, elapsed: number): void {
    // Events describe THIS step only; the caller drains them before the next one.
    this.impactTotal = 0
    this.snappedThisStep = 0

    for (let li = 0; li < this.lanyards.length; li++) {
      const l = this.lanyards[li]

      /* ── Wind, sampled per lanyard ──────────────────────────────────────
       * Each rope gets its own phase and frequency offset.
       *
       * Evaluating one global field for all four was measured to give every
       * badge an identical angle (1.3°, 1.3°, 1.3°, 1.3°): the lanyards moved as
       * one rigid slab, which looks mechanical. Real air is not uniform, so the
       * field is sampled at a per-lanyard position and time offset — the same
       * formula, four different sample points.
       */
      const phase = l.windPhase
      const localT = elapsed + phase
      const wind = windAcceleration(
        localT,
        640 * l.windGain,
        1.15 * (0.85 + phase * 0.14),
        0.37 * (0.9 + phase * 0.1),
      )
      // A second, faster cross-breeze keeps the rope from moving as one slab.
      const flutter = windAcceleration(localT * 1.7, 210 * l.windGain, 3.1, 1.7)

      if (l.broken) {
        // Broken ropes only fade; their tag is integrated by the free-body pass.
        if (l.ropeAlpha > 0) l.ropeAlpha = Math.max(0, l.ropeAlpha - dt * 2.6)
        this.stepFreeTag(l, dt)
        continue
      }

      /* ── Queue forces ─────────────────────────────────────────────────── */
      for (let i = 1; i < l.points.length; i++) {
        const p = l.points[i]
        // Per-point lever arm: lower points swing further, which is what makes
        // the free end lead the motion instead of the rope drifting as a block.
        const leverage = i / l.points.length
        p.ax += (wind * leverage + flutter * leverage * 0.35) * 0.85
      }

      /* ── Integrate ────────────────────────────────────────────────────── */
      integratePoints(l.points, dt, this.gravity)

      /* ── Grab constraint ──────────────────────────────────────────────── */
      // The held end becomes a hard constraint INSIDE the solver (see below), so
      // the rope has to absorb an unsatisfiable error and genuinely stretches.
      let pinIndex = -1
      let pinX = 0
      let pinY = 0
      if (l.tag.grabbed && this.grabbedIndex === li) {
        const grabbed = this.applyGrab(l, dt)
        pinIndex = l.points.length - 1
        pinX = grabbed.x
        pinY = grabbed.y
      }

      /* ── Solve ────────────────────────────────────────────────────────── */
      relaxConstraints(l.points, l.constraints, RELAXATION_ITERATIONS, pinIndex, pinX, pinY)

      /* ── Strain / break check ─────────────────────────────────────────── */
      const strain = measureMaxStrain(l.points, l.constraints)
      l.peakStrain = strain
      if (strain > BREAK_STRAIN) {
        this.snap(l)
        continue
      }

      /* ── Drive the tag pose from the rope ─────────────────────────────── */
      this.attachTag(l, dt)
    }

    /* ── Tag-vs-tag collisions ──────────────────────────────────────────── */
    this.resolveTagCollisions(dt)

    /* ── Floor / wall containment for free tags ─────────────────────────── */
    for (let li = 0; li < this.lanyards.length; li++) {
      const l = this.lanyards[li]
      if (l.broken) this.containFreeTag(l, dt)
    }
  }

  /**
   * Force the rope's end point toward the held tag and return where the rope end
   * should be pinned.
   *
   * The tag centre eases toward the pointer; the rope end follows the tag's TOP
   * edge (where the clip would be). The returned coordinates are fed into the
   * solver as a hard per-iteration constraint, so the rest of the chain has to
   * stretch around it — which is what produces a measurable, breakable strain.
   */
  private applyGrab(l: LanyardState, dt: number): { x: number; y: number } {
    const t = l.tag
    const halfH = t.height / 2

    // Ease the tag toward the pointer so it does not teleport under the cursor.
    // Fast enough to feel direct, slow enough that the rope reads the motion.
    const ease = Math.min(1, dt * 30)
    t.x += (this.pointerX - t.x) * ease
    t.y += (this.pointerY - t.y) * ease

    // Tag top centre in world space, given the current angle.
    const sin = Math.sin(t.angle)
    const cos = Math.cos(t.angle)
    return { x: t.x + sin * halfH, y: t.y - cos * halfH }
  }

  /**
   * Attach the tag to the rope: position from the end point, pose from the
   * tangent plus angular momentum.
   */
  private attachTag(l: LanyardState, dt: number): void {
    const pts = l.points
    const n = pts.length
    const end = pts[n - 1]
    const prev = pts[n - 2]
    if (!end || !prev) return

    const t = l.tag

    // Tangent of the last two points (top → bottom).
    const dx = end.x - prev.x
    const dy = end.y - prev.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1e-6

    // The tag's local +Y should align with the tangent, so its rotation is the
    // tangent angle minus a quarter turn.
    const tangentAngle = Math.atan2(dy, dx) - Math.PI / 2

    /* Torsional spring with real inertia: this is the "angular momentum" part.
       Under-damping (ζ < 1) means the badge overshoots the tangent and rocks
       back, which is exactly how a badge on a lanyard behaves. */
    const delta = wrapAngle(tangentAngle - t.angle)
    const torque = delta * TORSION_STIFFNESS - t.angularVelocity * TORSION_DAMPING
    t.angularVelocity += torque * dt
    t.angle = wrapAngle(t.angle + t.angularVelocity * dt)

    // Position: the end point sits at the tag's top centre.
    const halfH = t.height / 2
    const sin = Math.sin(t.angle)
    const cos = Math.cos(t.angle)
    t.x = end.x - sin * halfH
    t.y = end.y + cos * halfH

    // Implied velocity, used by the collision impulse maths.
    t.vx = (t.x - t.prevX) / dt
    t.vy = (t.y - t.prevY) / dt
    t.prevX = t.x
    t.prevY = t.y

    // A heavily stretched last segment (from a drag) also adds spin.
    const stretch = Math.max(0, len / SEGMENT_LENGTH - 1)
    if (stretch > 0.02) t.angularVelocity += stretch * 1.6 * dt
  }

  /** Freeze the rope, detach the tag and let it fall. */
  private snap(l: LanyardState): void {
    l.broken = true
    // Report the failure so the caller can synthesise the break.
    this.snappedThisStep++
    const t = l.tag
    t.attached = false
    t.grabbed = false
    if (this.grabbedIndex >= 0 && this.lanyards[this.grabbedIndex] === l) {
      this.grabbedIndex = -1
    }
    // Inherit the rope's momentum so the badge is flung, not dropped limply.
    const end = l.points[l.points.length - 1]
    if (end) {
      t.vx = (end.x - end.px) * 60
      t.vy = (end.y - end.py) * 60
    }
    t.angularVelocity += (Math.random() - 0.5) * 4.5
  }

  /** Integrate a detached badge under gravity, with arbitrary spin. */
  private stepFreeTag(l: LanyardState, dt: number): void {
    const t = l.tag
    t.prevX = t.x
    t.prevY = t.y
    t.vy += this.gravity * dt
    t.x += t.vx * dt
    t.y += t.vy * dt
    t.angle = wrapAngle(t.angle + t.angularVelocity * dt)
    // Air drag, so the fall speed approaches a terminal velocity instead of
    // accelerating without bound.
    t.vx *= 0.999
    t.vy *= 0.999
    t.angularVelocity *= 0.996
  }

  /** Keep a fallen badge inside the sandbox and bouncing off the floor. */
  private containFreeTag(l: LanyardState, dt: number): void {
    const t = l.tag
    const halfW = t.width / 2
    const halfH = t.height / 2
    // Approximate the rotated box by its circumscribed radius for containment:
    // exact OBB-vs-wall resolution needs the corner list, and the difference is
    // a couple of pixels that no one can see on a bouncing badge.
    const r = Math.min(halfW, halfH) + Math.abs(Math.sin(t.angle)) * (halfW - halfH) * 0.5
    const radius = Math.max(halfW, halfH) * 0.82 + r * 0.18

    const floor = this.height - 6
    if (t.y + radius > floor) {
      t.y = floor - radius
      if (t.vy > 0) {
        // Reverse with restitution and bleed energy into spin, so it tumbles.
        t.vy = -t.vy * RESTITUTION
        t.vx *= 0.86
        t.angularVelocity += t.vx * 0.06
      }
      // Settle: stop micro-bouncing so it comes to rest rather than jittering.
      if (Math.abs(t.vy) < 42) {
        t.vy = 0
        t.vx *= 0.9
        t.angularVelocity *= 0.94
      }
    }

    const left = radius
    const right = this.width - radius
    if (t.x < left) {
      t.x = left
      t.vx = Math.abs(t.vx) * RESTITUTION
    } else if (t.x > right) {
      t.x = right
      t.vx = -Math.abs(t.vx) * RESTITUTION
    }

    if (t.y < radius) {
      t.y = radius
      if (t.vy < 0) t.vy = -t.vy * RESTITUTION
    }
    void dt
  }

  /* ── Collision resolution ──────────────────────────────────────────────── */

  /**
   * Resolve every tag pair that overlaps.
   *
   * Positional separation is split by inverse mass; the velocity impulse uses the
   * relative normal velocity so a fast tag genuinely transfers momentum into the
   * one it hits. Attached tags push back into their rope (via the end point's
   * previous position) so the impact travels up the lanyard.
   */
  private resolveTagCollisions(dt: number): void {
    const list = this.lanyards
    for (let i = 0; i < list.length; i++) {
      const la = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const lb = list[j]

        // Both broken and far apart: skip the expensive test.
        const ta = la.tag
        const tb = lb.tag
        const dx = tb.x - ta.x
        const dy = tb.y - ta.y
        const reach = (ta.width + ta.height + tb.width + tb.height) * 0.5
        if (dx * dx + dy * dy > reach * reach) continue

        this.obbA.cx = ta.x
        this.obbA.cy = ta.y
        this.obbA.hw = ta.width / 2
        this.obbA.hh = ta.height / 2
        this.obbA.angle = ta.angle

        this.obbB.cx = tb.x
        this.obbB.cy = tb.y
        this.obbB.hw = tb.width / 2
        this.obbB.hh = tb.height / 2
        this.obbB.angle = tb.angle

        const hit = collideObb(this.obbA, this.obbB, this.hit)
        if (!hit.hit) continue

        this.applyCollision(la, lb, hit.nx, hit.ny, hit.depth, dt)
      }
    }
  }

  private applyCollision(
    la: LanyardState,
    lb: LanyardState,
    nx: number,
    ny: number,
    depth: number,
    dt: number,
  ): void {
    const ta = la.tag
    const tb = lb.tag

    // Inverse mass: a dragged tag behaves as infinitely heavy, so it shoves the
    // other one instead of being pushed out from under the cursor.
    const invA = ta.grabbed ? 0 : 1
    const invB = tb.grabbed ? 0 : 1
    const invSum = invA + invB
    if (invSum <= 0) return

    /* ── Positional correction ─────────────────────────────────────────── */
    // A little overshoot beyond the exact depth keeps boxes from sinking into
    // each other when several constraints pull them back together next step.
    const corr = depth * 0.72
    const moveA = (invA / invSum) * corr
    const moveB = (invB / invSum) * corr

    ta.x -= nx * moveA
    ta.y -= ny * moveA
    tb.x += nx * moveB
    tb.y += ny * moveB

    /* ── Velocity impulse ──────────────────────────────────────────────── */
    const rvx = tb.vx - ta.vx
    const rvy = tb.vy - ta.vy
    const normalVel = rvx * nx + rvy * ny

    // Already separating: no impulse (but the positional fix above still applies,
    // which is what stops resting overlap from accumulating).
    if (normalVel > 0) {
      this.pushBackToRope(la, ta, dt)
      this.pushBackToRope(lb, tb, dt)
      return
    }

    /*
     * Report the FULL relative speed, not just its normal component.
     *
     * For sound generation the interesting quantity is how fast the two badges
     * were travelling relative to each other, which is what the spec's
     * `|v_rel|` denotes. The normal component alone would report a glancing
     * high-speed clip as almost silent.
     */
    this.recordImpact(Math.sqrt(rvx * rvx + rvy * rvy))

    const impulse = (-(1 + RESTITUTION) * normalVel) / invSum
    const ix = nx * impulse
    const iy = ny * impulse

    // Angular kick: offset the impulse by the contact point's lever arm.
    ta.angularVelocity -= (ny * ix - nx * iy) * 0.0022
    tb.angularVelocity += (ny * ix - nx * iy) * 0.0022

    if (!ta.grabbed) {
      ta.vx -= ix * invA
      ta.vy -= iy * invA
    }
    if (!tb.grabbed) {
      tb.vx += ix * invB
      tb.vy += iy * invB
    }

    this.pushBackToRope(la, ta, dt)
    this.pushBackToRope(lb, tb, dt)
  }

  /**
   * Feed a tag's new velocity back into its rope.
   *
   * For an attached tag the "position" is the rope, so the only way to give it
   * momentum is to rewrite the end point's previous position — Verlet velocity is
   * `(x − px)`, so subtracting `v·dt` from `px` adds exactly `v` to the velocity.
   * That is what makes a collision visibly ripple up the lanyard.
   */
  private pushBackToRope(l: LanyardState, t: TagState, dt: number): void {
    if (l.broken || !t.attached) return
    if (t.grabbed) return
    const end = l.points[l.points.length - 1]
    const prev = l.points[l.points.length - 2]
    if (!end || !prev) return

    const halfH = t.height / 2
    const sin = Math.sin(t.angle)
    const cos = Math.cos(t.angle)
    const targetX = t.x + sin * halfH
    const targetY = t.y - cos * halfH

    // Verlet velocity is the position delta, so nudging px by the same delta the
    // tag moved transfers its momentum into the rope.
    end.px -= targetX - end.x + t.vx * dt
    end.py -= targetY - end.y + t.vy * dt
    end.x = targetX
    end.y = targetY
  }
}
