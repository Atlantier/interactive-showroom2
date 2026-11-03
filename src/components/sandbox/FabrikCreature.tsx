import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { damp } from '@/lib/math'
import { announce } from '@/lib/announce'
import { soundEngine } from '@/utils/soundEngine'
import { useInViewAnimation } from '@/hooks/useInViewAnimation'
import { reportIkSolve } from '@/lib/perfMetrics'
import { useI18n } from '@/i18n/useI18n'
import { isStill } from '@/lib/testHooks'
import { isScrollBusy } from '@/lib/scrollEngine'
import { createFixedStepClock, type FixedStepClock } from '@/lib/fixedStep'
import { dprForTier } from '@/lib/device'
import { useAppStore } from '@/store/useAppStore'
import {
  applyAngleConstraints,
  chainLength,
  createFABRIKResult,
  solveFABRIK,
  type FABRIKResult,
  type IKJoint,
  type Vec2,
} from '@/utils/fabrik'
import {
  drawHexRipple,
  drawRadialFlash,
  VfxParticleEngine,
  type VfxBounds,
  type VfxBurstOptions,
  type VfxSpawnOptions,
} from '@/utils/vfxParticleEngine'

/**
 * FabrikCreature — FABRIK inverse kinematics and procedural animation.
 *
 * Two rigs share one canvas and one solver:
 *
 *   ARM       a fixed-base 6-bone industrial arm whose tip tracks the cursor,
 *             with a laser claw that fires and kicks back on click.
 *   CREATURE  a 12-node flexible spine steered by steering behaviours, walking
 *             on four 2-bone IK legs with procedural foot placement.
 *
 * ── Why the whole thing is state-in-plain-objects ─────────────────────────
 * The rigs live in mutable objects outside React, exactly like the Verlet
 * sandbox. Sixty times a second this touches ~60 joints; routing that through
 * React state would re-render the tree 60 times a second for data that only the
 * canvas reads.
 */

/* -------------------------------------------------------------------------- */
/*  Arm tuning                                                               */
/* -------------------------------------------------------------------------- */

/** Six bones, root first. Sum is the total reach. */
const ARM_BONES = [80, 76, 70, 64, 50, 42] as const

/** 95° per joint: a real elbow, never a fold-back. */
const ARM_MAX_BEND = (Math.PI * 95) / 180
const ARM_TOLERANCE = 0.5

/** Rate at which the IK target chases the cursor. */
const ARM_TARGET_LAMBDA = 9

/** Fraction of full reach the target is confined to, so the arm never locks. */
const ARM_TARGET_MIN = 0.22
/**
 * Outer clamp. Kept at 0.90 rather than 0.96 deliberately.
 *
 * A chain solving for a target near its maximum reach is ill-conditioned: the
 * tip position becomes almost independent of the joint angles, so each FABRIK
 * sweep barely improves the error. Measured at 0.96 the solver exhausted all 12
 * sweeps and still reported ~7 px of residual (the HUD showed `iter 12` in
 * amber). At 0.90 there is enough slack for the chain to stay well-conditioned
 * and it converges to sub-pixel.
 */
const ARM_TARGET_MAX = 0.9

/** A 6-bone chain needs more sweeps than a 2-bone leg to settle. */
const ARM_MAX_ITERATIONS = 18

/** Recoil spring, applied as a whole-arm screen offset. */
const RECOIL_STIFFNESS = 340
const RECOIL_DAMPING = 17
const RECOIL_IMPULSE = 210

/** Laser pulse. */
const LASER_DURATION = 0.34

/**
 * Scorch lifetime, in seconds — the brief's 3 s.
 *
 * A scorch marks the surface the beam terminated against, so it has to outlive
 * the 0.34 s pulse by an order of magnitude: long enough to read as "the last
 * shot did that", short enough that the canvas cannot fill with marks.
 */
const SCORCH_LIFE = 3
/**
 * Preallocated scorch slots.
 *
 * Clicking is unbounded — a visitor can fire dozens of times inside one 3 s
 * window — so the marks live in a ring buffer: the cursor wraps and the oldest
 * slot is overwritten. `push`/`splice` here would allocate on every shot and let
 * the array grow without bound.
 */
const SCORCH_POOL = 16
/** Radius of the white-hot core, in px. The cooling passes scale off this. */
const SCORCH_RADIUS = 13

/** Beam-turbulence particles emitted per fixed step while the pulse is live. */
const BEAM_TURBULENCE_PER_STEP = 2
/** Beam-turbulence particles in the initial burst along the path, at fire time. */
const BEAM_TURBULENCE_BURST = 14
/** Molten sparks emitted per fixed step at the impact point while live. */
const IMPACT_SPARKS_PER_STEP = 2
/** Size of the initial molten burst at the impact point. */
const IMPACT_SPARK_BURST = 18
/** Segments in each ion-braid filament; 8 reads as a discharge, not a sine wave. */
const ION_BRAID_SEGMENTS = 8

/* -------------------------------------------------------------------------- */
/*  Creature tuning                                                          */
/* -------------------------------------------------------------------------- */

const SPINE_NODES = 12
const SPINE_SPACING = 21
/** Softer than the arm: a spine should curve, not hinge. */
const SPINE_MAX_BEND = (Math.PI * 34) / 180

const LEG_UPPER = 38
const LEG_LOWER = 46
/** Lateral distance a foot rests from the body axis. */
const LEG_SPREAD = 54
/** How far below the hip the feet sit, in screen space. */
const LEG_DROP = 14
/** A foot plants this far ahead of its hip to push the body forward. */
const STRIDE_LEAD = 12
/** Distance a planted foot may fall behind before it must step. */
const STRIDE_THRESHOLD = 22
const STEP_DURATION = 0.19
const STEP_LIFT = 19

/**
 * How long both groups must stay planted between swing phases.
 *
 * This is the "locked" requirement: the incoming group has to be fully down and
 * settled before the outgoing group is allowed to lift. A short pause is what
 * makes the gait read as deliberate footfalls rather than a continuous shuffle,
 * and it guarantees a moment of four-point contact every half cycle.
 */
const GROUP_LOCK_TIME = 0.07

/** Lifetime of a landing ripple. */
const RIPPLE_DURATION = 0.55
/** Pool size. Two groups landing in quick succession must not evict each other. */
const RIPPLE_POOL = 10

/**
 * Holographic footfall: the pooled hex ripples and the motes they throw.
 *
 * The gait already spawns one ground ellipse per touchdown; this layers the
 * projected hologram on top. TWO records are taken per foot — the second starts
 * `HEX_RIPPLE_PHASE` of a cycle behind — which is what produces the brief's
 * double expanding hex ring instead of a single outline that happens to have six
 * sides. 12 slots covers both diagonal pairs landing within one ripple lifetime
 * plus the tail of the previous landing.
 */
const HEX_RIPPLE_DURATION = 0.72
const HEX_RIPPLE_POOL = 12
/** Phase delay on the trailing ring, as a fraction of one ripple life. */
const HEX_RIPPLE_PHASE = 0.4
/** Upward-drifting motes thrown from a locking mechanical foot. */
const FOOT_MOTE_COUNT = 7
/**
 * Knee limit, and it is a GEOMETRIC constraint, not a taste setting.
 *
 * With bones of 38 and 46 the reachable distance from hip to foot is bounded
 * below by the cone: a bend of θ leaves a minimum reach of
 * `sqrt(a² + b² − 2ab·cos(180° − θ))`. At the 78° this started with, that floor
 * was 65.5 px — but the natural stance sits at ~63 px, so the leg was permanently
 * asking for a pose the cone forbade and the IK error sat at 11–20 px. A real
 * mechanical knee folds to roughly 150°, which lowers the floor to ~23 px and
 * still forbids the 180° inversion the constraint exists to prevent.
 */
const LEG_MAX_BEND = (Math.PI * 150) / 180

/** Steering behaviour limits. */
const MAX_SPEED = 230
/**
 * How sharply the velocity converges on the desired velocity.
 *
 * A plain `vel += (desired − vel)·dt` converges with a 1 s time constant, which
 * measured as a distinctly sluggish creature: it closed only 79 px in 0.75 s from
 * a standing start. Multiplying the correction by this factor raises the rate
 * without introducing any overshoot, because the term is still proportional to
 * the error.
 */
const STEER_AGILITY = 2.6
/** Ceiling on the resulting acceleration, so a hard reversal stays smooth. */
const MAX_ACCEL = 1500
const ARRIVE_RADIUS = 110
/**
 * Inside this radius the steering goal is exactly zero.
 *
 * The arrival ramp alone is asymptotic: the creature keeps inching toward the
 * cursor and ends up circling it indefinitely. A hard dead zone lets it come to
 * rest, which is what "arrive" is supposed to mean.
 */
const ARRIVE_DEAD_ZONE = 16
/** Keeps the creature's body inside the canvas. */
const EDGE_MARGIN = 70

/* -------------------------------------------------------------------------- */
/*  Shared VFX tuning                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Particle pool size, per rig.
 *
 * Worst case on the arm is two overlapping pulses (0.34 s apart, ~0.7 s spark
 * tails): 18 + 14 initial slots plus ~20 fixed steps × 4 continuous slots
 * ≈ 115 per pulse, ~230 live. 640 leaves headroom for the bounce splits — every
 * bouncing spark may throw two children — without ever recycling a slot that is
 * still visibly burning. The creature's motes never need more than ~30, but one
 * shared constant keeps the two rigs' budgets comparable.
 */
const VFX_PARTICLE_CAPACITY = 640

/**
 * Holographic ring palette, inner ring first.
 *
 * Cyan / violet / teal are already the sandbox's accent trio (the arm tint and
 * the creature tint are drawn from it), so the holo layer glows in the same
 * light as the machine instead of introducing a fourth hue.
 */
const HOLO_RING_COLORS: string[] = [
  'rgba(103, 232, 249, 0.9)',
  'rgba(167, 139, 250, 0.8)',
  'rgba(94, 234, 212, 0.7)',
]
/** Concentric rings per IK node: the brief's "2–3". */
const HOLO_RING_COUNT = 3
/** A single bright bead travelling the outer ring makes the spin unmistakable. */
const HOLO_ORBIT_COLOR = 'rgba(224, 255, 255, 0.95)'

/** Energy-fluid stripe and packet colours, inside the bone shells. */
const FLUID_STRIPE_COLOR = 'rgba(103, 232, 249, 0.9)'
const FLUID_PACKET_COLOR = 'rgba(224, 255, 255, 1)'
/**
 * Dash pattern for the pumped stripe. Module-level because `setLineDash` copies
 * the array it is given; allocating `[6, 10]` per bone per frame would put a
 * garbage object inside the render loop for a purely decorative effect.
 */
const FLUID_DASH: number[] = [6, 10]

/** Cooling-scorch palette: white-hot → orange → deep red, over a char disc. */
const SCORCH_WHITE_COLOR = 'rgba(255, 246, 232, 1)'
const SCORCH_ORANGE_COLOR = 'rgba(255, 138, 58, 1)'
const SCORCH_RED_COLOR = 'rgba(190, 42, 18, 1)'
const SCORCH_CHAR_COLOR = 'rgba(16, 9, 7, 1)'

/** Hex-ripple tint, matching the ground ellipse ripples already in use. */
const HEX_RIPPLE_COLOR: [number, number, number] = [103, 232, 249]

/**
 * Reused particle descriptors.
 *
 * ── Why module scope ───────────────────────────────────────────────────────
 * `VfxParticleEngine.spawn` copies its options into a recycled pool slot, so the
 * descriptor is pure input scaffolding. A continuous emitter — the laser, every
 * fixed step — would otherwise allocate a fresh options literal 60 times a
 * second. Hoisting the descriptor means the emitter only mutates its dynamic
 * fields (x / y / angle) on an object that already exists. Each emitter owns its
 * own descriptor so a field set by one can never leak into another.
 */
const IMPACT_BURST_OPTS: VfxBurstOptions = {
  count: IMPACT_SPARK_BURST,
  x: 0,
  y: 0,
  speedMin: 60,
  speedMax: 340,
  angle: -Math.PI / 2,
  spread: 1.6,
  lifeMin: 0.28,
  lifeMax: 0.8,
  sizeMin: 0.8,
  sizeMax: 2.2,
  color: [255, 196, 120],
  gravity: 620,
  drag: 0.5,
  restitution: 0.45,
  bounce: true,
  stretch: 0.022,
  splits: 1,
}

const IMPACT_SPARK_OPTS: VfxSpawnOptions = {
  x: 0,
  y: 0,
  speedMin: 30,
  speedMax: 170,
  angle: -Math.PI / 2,
  spread: 1.5,
  lifeMin: 0.22,
  lifeMax: 0.65,
  sizeMin: 0.7,
  sizeMax: 1.7,
  color: [255, 148, 60],
  gravity: 700,
  drag: 0.55,
  restitution: 0.4,
  bounce: true,
  stretch: 0.02,
  splits: 1,
}

const BEAM_TURBULENCE_OPTS: VfxSpawnOptions = {
  x: 0,
  y: 0,
  speedMin: 24,
  speedMax: 110,
  angle: 0,
  spread: 0.5,
  lifeMin: 0.18,
  lifeMax: 0.5,
  sizeMin: 0.6,
  sizeMax: 1.5,
  color: [103, 232, 249],
  // Negative gravity: ionised gas is buoyant, so the turbulence peels UP off the
  // beam instead of falling like the molten metal at the impact point.
  gravity: -70,
  drag: 0.9,
  restitution: 0,
  bounce: false,
  stretch: 0.015,
  splits: 0,
}

const FOOT_MOTE_OPTS: VfxSpawnOptions = {
  x: 0,
  y: 0,
  speedMin: 18,
  speedMax: 64,
  angle: -Math.PI / 2,
  spread: 0.95,
  lifeMin: 0.5,
  lifeMax: 1.15,
  sizeMin: 0.7,
  sizeMax: 1.6,
  color: [167, 139, 250],
  // The brief's negative gravity: motes drift up off the projected floor like
  // dust kicked loose by the foot, rather than settling back down.
  gravity: -60,
  drag: 0.75,
  restitution: 0,
  bounce: false,
  stretch: 0.02,
  splits: 0,
}

/* -------------------------------------------------------------------------- */
/*  Rig types                                                                */
/* -------------------------------------------------------------------------- */

interface ArmRig {
  joints: IKJoint[]
  lengths: number[]
  result: FABRIKResult
  /** Smoothed cursor position — the IK goal. */
  target: Vec2
  /** Whole-arm recoil offset, in screen pixels. */
  recoil: Vec2
  recoilVel: Vec2
  /** Unit aim direction of the claw. */
  aimX: number
  aimY: number
  /** Laser progress: 1 means idle. */
  laserT: number
  laserX: number
  laserY: number
  laserDirX: number
  laserDirY: number
  shots: number
  /** Base mount position. */
  baseX: number
  baseY: number
  /**
   * Seconds elapsed in this rig, advanced by `stepArm`.
   *
   * Every holographic layer reads THIS rather than React state or
   * `performance.now()`: React state to animate a decoration would re-render the
   * whole component 60 times a second, and a wall clock would teleport every
   * rotation forward by however long the sandbox spent off screen (the loop is
   * IntersectionObserver-gated). A rig-relative clock resumes exactly where the
   * sandbox stopped.
   */
  clock: number
  /** Shared particle pool: ionised beam turbulence and molten impact sparks. */
  engine: VfxParticleEngine
  /** Reused `step` bounds for the pool; no per-step allocation. */
  bounds: VfxBounds
  /** Fixed ring-buffer of cooling scorch marks. */
  scorches: Scorch[]
  /** Ring cursor: index of the next scorch slot to overwrite. */
  scorchCursor: number
  /** Canvas-space point where the current beam terminates. */
  impactX: number
  impactY: number
  /** Canvas size, used to clip a fresh beam against the viewport. */
  viewW: number
  viewH: number
}

interface LegRig {
  /** Spine node the hip attaches to. */
  hipIndex: number
  /** −1 = one side of the body, +1 = the other. */
  side: number
  /** Diagonal gait pair (0 or 1). */
  pair: number
  lengths: number[]
  /** [hip, knee, foot] — solved by FABRIK each frame. */
  joints: IKJoint[]
  result: FABRIKResult
  /** Planted foot position. */
  anchorX: number
  anchorY: number
  stepping: boolean
  stepT: number
  fromX: number
  fromY: number
  toX: number
  toY: number
  /**
   * True for exactly the frame the foot touches down.
   *
   * The gait controller consumes this to spawn a ground ripple, and clears it
   * immediately so a single landing cannot emit more than one.
   */
  landed: boolean
}

/**
 * An expanding ground ripple, spawned where a foot lands.
 *
 * Pooled in a fixed-size array with an `alive` flag rather than pushed and
 * spliced: this runs in the 60 Hz frame loop, and allocating (or letting
 * `splice` build a new array) every landing would churn the heap for a purely
 * decorative effect.
 */
interface Ripple {
  x: number
  y: number
  /** Progress 0 → 1 over `RIPPLE_DURATION`. */
  t: number
  alive: boolean
}

/**
 * One cooling scorch mark left where the laser beam terminated.
 *
 * Pooled for the same reason as `Ripple`: firing is unbounded and the fade-out
 * is three seconds, so the pool is fixed and overwritten in a ring. `seed` is
 * captured once at spawn so each mark's heat-shimmer has its own phase instead
 * of every scorch on screen flickering in lockstep.
 */
interface Scorch {
  x: number
  y: number
  /** Seconds since the beam landed. */
  age: number
  /** 0..1 random, fixed at spawn; drives the per-mark shimmer phase. */
  seed: number
  alive: boolean
}

/**
 * One expanding hexagonal holographic ripple under a locking foot.
 *
 * Two records are taken per touchdown, with `t` starting at `0` and
 * `-HEX_RIPPLE_PHASE`. The negative start IS the phase delay: cheaper and more
 * precise than giving every record its own countdown timer, and it means the
 * draw code stays a pure function of `t`.
 */
interface HexRipple {
  x: number
  y: number
  /** Progress 0 → 1 over `HEX_RIPPLE_DURATION`; negative = waiting for its phase. */
  t: number
  alive: boolean
}

/**
 * Gait controller state.
 *
 * The two diagonal groups are exclusive: only one may be in its swing phase at a
 * time, and a group may not start until the other has fully landed AND the lock
 * timer has expired. That exclusivity is what prevents two legs on the same side
 * from lifting together.
 */
interface GaitState {
  /** Group currently swinging, or −1 when both are planted and locked. */
  activeGroup: number
  /** Seconds remaining before the other group may take over. */
  lockTimer: number
  /** True once every leg of the active group has touched down. */
  groupLanded: boolean
  /**
   * The group that most recently FINISHED a swing phase, or −1 before the first.
   *
   * Used to bias the next phase toward the other group, which is what makes the
   * gait a strict alternation rather than "whichever group happens to lag most".
   */
  lastGroup: number
}

interface CreatureRig {
  spine: IKJoint[]
  /** Scratch: last frame's spine points, for the spacing constraint. */
  head: Vec2
  vel: Vec2
  legs: LegRig[]
  comX: number
  comY: number
  comVX: number
  comVY: number
  /** Travelling-wave phase driving the spine's undulation. */
  undulation: number
  /** Diagonal trot controller. */
  gait: GaitState
  /** Pooled landing ripples. */
  ripples: Ripple[]
  /** Seconds elapsed in this rig, for the time-driven holographic layers. */
  clock: number
  /** Shared particle pool for the footfall motes. */
  engine: VfxParticleEngine
  /** Reused `step` bounds for the pool; no per-step allocation. */
  bounds: VfxBounds
  /** Fixed ring-buffer of double hex footfall ripples. */
  hexRipples: HexRipple[]
  /** Ring cursor for `hexRipples`. */
  hexCursor: number
}

/* -------------------------------------------------------------------------- */
/*  Rig construction                                                         */
/* -------------------------------------------------------------------------- */

function createArm(width: number, height: number): ArmRig {
  const baseX = width / 2
  const baseY = height - 46
  const total = chainLength(ARM_BONES)

  // Start folded upward so the first solve has a sensible pose to refine.
  const joints: IKJoint[] = []
  for (let i = 0; i <= ARM_BONES.length; i++) {
    joints.push({ x: baseX, y: baseY - (total * i) / ARM_BONES.length })
  }

  // Pre-allocated scorch slots; the ring cursor wraps, so firing forever cannot
  // grow this array. Inactive slots start aged out.
  const scorches: Scorch[] = []
  for (let i = 0; i < SCORCH_POOL; i++) {
    scorches.push({ x: 0, y: 0, age: SCORCH_LIFE, seed: 0, alive: false })
  }

  return {
    joints,
    lengths: [...ARM_BONES],
    result: createFABRIKResult(),
    target: { x: baseX, y: baseY - total * 0.7 },
    recoil: { x: 0, y: 0 },
    recoilVel: { x: 0, y: 0 },
    aimX: 0,
    aimY: -1,
    laserT: 1,
    laserX: 0,
    laserY: 0,
    laserDirX: 0,
    laserDirY: -1,
    shots: 0,
    baseX,
    baseY,
    clock: 0,
    engine: new VfxParticleEngine(VFX_PARTICLE_CAPACITY),
    bounds: { left: 0, right: width, bottom: height },
    scorches,
    scorchCursor: 0,
    // Before the first shot there is no beam; the tip's rest position is the
    // least surprising placeholder. Nothing reads it while `laserT === 1`.
    impactX: baseX,
    impactY: baseY - total * 0.9,
    viewW: width,
    viewH: height,
  }
}

function createCreature(width: number, height: number): CreatureRig {
  const cx = width / 2
  const cy = height / 2

  const spine: IKJoint[] = []
  for (let i = 0; i < SPINE_NODES; i++) {
    spine.push({ x: cx - i * SPINE_SPACING, y: cy })
  }

  /**
   * Four legs on two DIAGONAL groups.
   *
   *   group 0 = front-left  + rear-right
   *   group 1 = front-right + rear-left
   *
   * The grouping is the whole basis of the trot: because each group contains one
   * leg from each side, a group can never lift two legs on the same side, so the
   * body always keeps a diagonal support. `side` and `pair` are therefore
   * correlated on purpose — `pair === 0` iff the two legs are diagonally
   * opposite.
   */
  const legDefs: Array<{ hipIndex: number; side: number; pair: number }> = [
    { hipIndex: 2, side: -1, pair: 0 }, // front left  ┐ group 0
    { hipIndex: 3, side: 1, pair: 1 }, // front right  ┐ group 1
    { hipIndex: 8, side: -1, pair: 1 }, // rear left   ┘ group 1
    { hipIndex: 9, side: 1, pair: 0 }, // rear right  ┘ group 0
  ]

  const legs: LegRig[] = legDefs.map((def) => {
    const hip = spine[def.hipIndex] ?? spine[2] ?? { x: cx, y: cy }
    const hipX = hip.x
    const hipY = hip.y + LEG_DROP
    const footX = hipX + def.side * LEG_SPREAD
    const footY = hipY + LEG_SPREAD * 0.34
    return {
      hipIndex: def.hipIndex,
      side: def.side,
      pair: def.pair,
      lengths: [LEG_UPPER, LEG_LOWER],
      // Initialize the knee pushed outward so FABRIK converges to the natural
      // bend for this side rather than to an inverted knee.
      joints: [
        { x: hipX, y: hipY },
        { x: (hipX + footX) / 2 + def.side * 16, y: (hipY + footY) / 2 - 8 },
        { x: footX, y: footY },
      ],
      result: createFABRIKResult(),
      anchorX: footX,
      anchorY: footY,
      stepping: false,
      stepT: 1,
      fromX: footX,
      fromY: footY,
      toX: footX,
      toY: footY,
      landed: false,
    }
  })

  // Pre-allocated ripple pools; nothing here allocates at run time.
  const ripples: Ripple[] = []
  for (let i = 0; i < RIPPLE_POOL; i++) {
    ripples.push({ x: 0, y: 0, t: 1, alive: false })
  }

  const hexRipples: HexRipple[] = []
  for (let i = 0; i < HEX_RIPPLE_POOL; i++) {
    hexRipples.push({ x: 0, y: 0, t: 1, alive: false })
  }

  return {
    spine,
    head: { x: cx, y: cy },
    vel: { x: 0, y: 0 },
    legs,
    comX: cx,
    comY: cy,
    comVX: 0,
    comVY: 0,
    undulation: 0,
    // Both groups start planted and the lock timer starts expired, so the
    // controller is free to launch whichever group lags first.
    gait: { activeGroup: -1, lockTimer: 0, groupLanded: true, lastGroup: -1 },
    ripples,
    clock: 0,
    engine: new VfxParticleEngine(VFX_PARTICLE_CAPACITY),
    bounds: { left: 0, right: width, bottom: height },
    hexRipples,
    hexCursor: 0,
  }
}

/* -------------------------------------------------------------------------- */
/*  VFX emission                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Distance along a unit ray to the first viewport edge.
 *
 * The sandbox has no collision geometry beyond its own viewport, so that
 * rectangle IS the surface the laser burns: the bottom edge doubles as the floor
 * and the side edges as walls. Clipping the ray to it — instead of drawing the
 * beam off screen to a fixed nominal range — is what gives the pulse a real
 * termination point, and therefore an impact to spark and to scorch.
 *
 * Only positive crossings count: the muzzle can be pushed past a canvas edge by
 * the IK constraint, and an origin outside the rectangle must travel back INTO
 * the view before its exit crossing becomes the impact.
 */
function rayRectDistance(
  x: number,
  y: number,
  dx: number,
  dy: number,
  width: number,
  height: number,
): number {
  let nearest = Infinity

  if (dx > 1e-6) {
    const t = (width - x) / dx
    if (t > 0 && t < nearest) nearest = t
  } else if (dx < -1e-6) {
    const t = -x / dx
    if (t > 0 && t < nearest) nearest = t
  }
  if (dy > 1e-6) {
    const t = (height - y) / dy
    if (t > 0 && t < nearest) nearest = t
  } else if (dy < -1e-6) {
    const t = -y / dy
    if (t > 0 && t < nearest) nearest = t
  }

  // No edge ahead only if the origin is already outside the canvas AND aiming
  // away from it. Fall back to the origin, which yields a degenerate but
  // invisible beam rather than an `Infinity` impact coordinate.
  return nearest === Infinity ? 0 : nearest
}

/** Burn a scorch into the next slot of the ring buffer. */
function spawnScorch(rig: ArmRig, x: number, y: number): void {
  const slot = rig.scorches[rig.scorchCursor]
  rig.scorchCursor = rig.scorchCursor + 1 >= rig.scorches.length ? 0 : rig.scorchCursor + 1
  slot.x = x
  slot.y = y
  slot.age = 0
  slot.seed = Math.random()
  slot.alive = true
}

/** One-time molten burst exactly where the beam lands. */
function emitImpactBurst(rig: ArmRig): void {
  IMPACT_BURST_OPTS.x = rig.impactX
  IMPACT_BURST_OPTS.y = rig.impactY
  rig.engine.burst(IMPACT_BURST_OPTS)
}

/**
 * Continuous molten spray at the impact point.
 *
 * Called every fixed step while the beam is live. The engine randomises speed
 * and life inside the descriptor's ranges, so consecutive sparks do not read as
 * duplicates despite sharing one hoisted descriptor.
 */
function emitImpactSparks(rig: ArmRig, count: number): void {
  for (let i = 0; i < count; i++) {
    IMPACT_SPARK_OPTS.x = rig.impactX
    IMPACT_SPARK_OPTS.y = rig.impactY
    rig.engine.spawn(IMPACT_SPARK_OPTS)
  }
}

/**
 * Turbulence peeling off the beam along its length.
 *
 * Each particle is placed on the muzzle→impact chord and emitted with a
 * perpendicular velocity: `angle` is the beam heading rotated 90°, and the
 * descriptor's 0.5 rad spread gives the "slight" perpendicular jitter the brief
 * asks for. Emitting everything at the muzzle would leave the rest of the beam
 * empty, so each gets its own point ON the path.
 */
function emitBeamTurbulence(rig: ArmRig, count: number): void {
  const dx = rig.impactX - rig.laserX
  const dy = rig.impactY - rig.laserY
  const beamAngle = Math.atan2(dy, dx)

  for (let i = 0; i < count; i++) {
    const along = 0.06 + Math.random() * 0.9
    BEAM_TURBULENCE_OPTS.x = rig.laserX + dx * along
    BEAM_TURBULENCE_OPTS.y = rig.laserY + dy * along
    // Alternating sides keeps the two strands from reading as one flat spray.
    BEAM_TURBULENCE_OPTS.angle = beamAngle + (i % 2 === 0 ? Math.PI / 2 : -Math.PI / 2)
    rig.engine.spawn(BEAM_TURBULENCE_OPTS)
  }
}

/** Holographic motes thrown upward by one locking foot. */
function emitFootMotes(rig: CreatureRig, x: number, y: number): void {
  for (let i = 0; i < FOOT_MOTE_COUNT; i++) {
    FOOT_MOTE_OPTS.x = x + (Math.random() - 0.5) * 16
    FOOT_MOTE_OPTS.y = y - Math.random() * 5
    rig.engine.spawn(FOOT_MOTE_OPTS)
  }
}

/**
 * Take the next hex-ripple slot, starting it `phase` of a life behind.
 *
 * A phase of 0 is the leading ring; `HEX_RIPPLE_PHASE` is the trailing one.
 */
function spawnHexRipple(rig: CreatureRig, x: number, y: number, phase: number): void {
  const slot = rig.hexRipples[rig.hexCursor]
  rig.hexCursor = rig.hexCursor + 1 >= rig.hexRipples.length ? 0 : rig.hexCursor + 1
  slot.x = x
  slot.y = y
  slot.t = -phase
  slot.alive = true
}

/* -------------------------------------------------------------------------- */
/*  Arm simulation                                                           */
/* -------------------------------------------------------------------------- */

function stepArm(rig: ArmRig, dt: number, pointerX: number, pointerY: number): void {
  const base = rig.joints[0]
  if (!base) return

  /* ── Ease the IK goal toward the cursor ──────────────────────────────── */
  rig.target.x = damp(rig.target.x, pointerX, ARM_TARGET_LAMBDA, dt)
  rig.target.y = damp(rig.target.y, pointerY, ARM_TARGET_LAMBDA, dt)

  /* ── Confine the goal to an annulus around the base ──────────────────────
   * Two clamps, both for behaviour rather than correctness:
   *  · outer, so the arm never fully extends and snaps straight (a locked arm
   *    has a singularity where the last joints spin freely).
   *  · inner, so the cursor can sit on the base without the chain folding into
   *    an unreadable knot.
   */
  const reach = chainLength(rig.lengths)
  const minReach = reach * ARM_TARGET_MIN
  const maxReach = reach * ARM_TARGET_MAX
  const dx = rig.target.x - base.x
  const dy = rig.target.y - base.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist > maxReach) {
    const k = maxReach / dist
    rig.target.x = base.x + dx * k
    rig.target.y = base.y + dy * k
  } else if (dist < minReach && dist > 1e-6) {
    const k = minReach / dist
    rig.target.x = base.x + dx * k
    rig.target.y = base.y + dy * k
  }

  /* ── Solve ───────────────────────────────────────────────────────────── */
  solveFABRIK(rig.joints, rig.target, rig.lengths, ARM_TOLERANCE, {
    maxBend: ARM_MAX_BEND,
    maxIterations: ARM_MAX_ITERATIONS,
    result: rig.result,
  })

  /* ── Aim: the claw points along the final bone ───────────────────────── */
  const wrist = rig.joints[rig.joints.length - 2]
  const tip = rig.joints[rig.joints.length - 1]
  if (wrist && tip) {
    const ax = tip.x - wrist.x
    const ay = tip.y - wrist.y
    const al = Math.sqrt(ax * ax + ay * ay) || 1
    rig.aimX = ax / al
    rig.aimY = ay / al
  }

  /* ── Recoil spring ───────────────────────────────────────────────────── */
  rig.recoilVel.x += (-RECOIL_STIFFNESS * rig.recoil.x - RECOIL_DAMPING * rig.recoilVel.x) * dt
  rig.recoilVel.y += (-RECOIL_STIFFNESS * rig.recoil.y - RECOIL_DAMPING * rig.recoilVel.y) * dt
  rig.recoil.x += rig.recoilVel.x * dt
  rig.recoil.y += rig.recoilVel.y * dt

  /* ── Holographic clock ───────────────────────────────────────────────── */
  rig.clock += dt

  /* ── Ionised laser: continuous emission while the beam is live ─────────
   * The pulse is only 0.34 s, but turbulence and impact sparks are re-emitted
   * every fixed step, so the beam reads as a sustained ionised stream instead
   * of two discrete pops at the moment of firing.
   */
  if (rig.laserT < 1) {
    emitBeamTurbulence(rig, BEAM_TURBULENCE_PER_STEP)
    emitImpactSparks(rig, IMPACT_SPARKS_PER_STEP)
    /* ── Laser countdown ───────────────────────────────────────────────── */
    rig.laserT = Math.min(1, rig.laserT + dt / LASER_DURATION)
  }

  /* ── Scorch cooling ────────────────────────────────────────────────────
   * Ages advance here rather than in the draw call: rendering stays a pure
   * function of rig state, and `drawArm` also runs on frames where the
   * fixed-step accumulator advanced zero steps.
   */
  for (let i = 0; i < rig.scorches.length; i++) {
    const scorch = rig.scorches[i]
    if (!scorch.alive) continue
    scorch.age += dt
    if (scorch.age >= SCORCH_LIFE) scorch.alive = false
  }

  /* ── Integrate the shared particle pool ────────────────────────────────
   * Bounds are the rig's reused record, so stepping the pool allocates nothing.
   */
  rig.engine.step(dt, rig.bounds)
}

/** Fire the claw: start the pulse, kick the arm back, and synthesise the shot. */
function fireArm(rig: ArmRig): void {
  const tip = rig.joints[rig.joints.length - 1]
  if (!tip) return
  rig.laserT = 0
  rig.laserX = tip.x
  rig.laserY = tip.y
  rig.laserDirX = rig.aimX
  rig.laserDirY = rig.aimY

  /* ── Resolve the impact before the pulse starts ────────────────────────
   * The beam direction is frozen for the whole pulse, so the point it lands on
   * can be resolved once here. Everything downstream — the impact flare, the
   * continuous sparks and the scorch mark — then shares one stable coordinate
   * instead of re-deriving (and visibly drifting) it every frame.
   */
  const beamDistance = rayRectDistance(
    rig.laserX,
    rig.laserY,
    rig.laserDirX,
    rig.laserDirY,
    rig.viewW,
    rig.viewH,
  )
  rig.impactX = Math.min(rig.viewW, Math.max(0, rig.laserX + rig.laserDirX * beamDistance))
  rig.impactY = Math.min(rig.viewH, Math.max(0, rig.laserY + rig.laserDirY * beamDistance))

  // The hit itself: a scorch that cools over the next three seconds, the initial
  // molten burst, and the along-beam turbulence burst. Continuous emission is
  // handled by `stepArm` for as long as the pulse is alive.
  spawnScorch(rig, rig.impactX, rig.impactY)
  emitImpactBurst(rig)
  emitBeamTurbulence(rig, BEAM_TURBULENCE_BURST)

  // Recoil along the aim: the arm is shoved back the way it fired.
  rig.recoilVel.x -= rig.aimX * RECOIL_IMPULSE
  rig.recoilVel.y -= rig.aimY * RECOIL_IMPULSE
  rig.shots++

  // Sounded here rather than at the pointer handler so the two can never drift
  // apart: any path that fires the arm also fires the voice. The engine's 40 ms
  // throttle is what keeps a rapid click burst from turning into a drone.
  soundEngine.playLaserPulse()
}

/* -------------------------------------------------------------------------- */
/*  Creature simulation                                                      */
/* -------------------------------------------------------------------------- */

function stepCreature(
  rig: CreatureRig,
  dt: number,
  pointerX: number,
  pointerY: number,
  width: number,
  height: number,
): void {
  /* Elapsed clock for the time-driven holographic layers (never React state). */
  rig.clock += dt

  /* ── Steering behaviour: seek with arrival ───────────────────────────── */
  const toX = pointerX - rig.head.x
  const toY = pointerY - rig.head.y
  const dist = Math.sqrt(toX * toX + toY * toY)

  let desiredVX = 0
  let desiredVY = 0
  if (dist > 1) {
    // Inside the arrival radius the desired speed ramps down, so the creature
    // decelerates into the cursor instead of overshooting it...
    const speed = dist < ARRIVE_RADIUS ? MAX_SPEED * (dist / ARRIVE_RADIUS) : MAX_SPEED
    // ...and inside the dead zone the goal is zero outright. Without this the
    // ramp is asymptotic and the creature orbits the cursor forever: measured
    // 62 px/s of residual speed while circling inside a 70 px band.
    const scale = dist < ARRIVE_DEAD_ZONE ? 0 : speed
    desiredVX = (toX / dist) * scale
    desiredVY = (toY / dist) * scale
  }

  // Steering force is the correction from current velocity to desired,
  // amplified by an agility factor so the creature reaches cruising speed in
  // well under a second instead of asymptotically creeping toward it.
  let steerX = (desiredVX - rig.vel.x) * STEER_AGILITY
  let steerY = (desiredVY - rig.vel.y) * STEER_AGILITY
  const steerMag = Math.sqrt(steerX * steerX + steerY * steerY)
  if (steerMag > MAX_ACCEL) {
    const k = MAX_ACCEL / steerMag
    steerX *= k
    steerY *= k
  }
  rig.vel.x += steerX * dt
  rig.vel.y += steerY * dt

  const speed = Math.sqrt(rig.vel.x * rig.vel.x + rig.vel.y * rig.vel.y)
  if (speed > MAX_SPEED) {
    const k = MAX_SPEED / speed
    rig.vel.x *= k
    rig.vel.y *= k
  }

  rig.head.x += rig.vel.x * dt
  rig.head.y += rig.vel.y * dt

  // Keep the body on screen; the creature turns rather than leaving.
  if (rig.head.x < EDGE_MARGIN) {
    rig.head.x = EDGE_MARGIN
    rig.vel.x = Math.abs(rig.vel.x) * 0.4
  } else if (rig.head.x > width - EDGE_MARGIN) {
    rig.head.x = width - EDGE_MARGIN
    rig.vel.x = -Math.abs(rig.vel.x) * 0.4
  }
  if (rig.head.y < EDGE_MARGIN) {
    rig.head.y = EDGE_MARGIN
    rig.vel.y = Math.abs(rig.vel.y) * 0.4
  } else if (rig.head.y > height - EDGE_MARGIN) {
    rig.head.y = height - EDGE_MARGIN
    rig.vel.y = -Math.abs(rig.vel.y) * 0.4
  }

  /* ── Spine: follow-the-leader with a soft ease and an undulation ─────── */
  rig.undulation += dt * 3.4
  const head0 = rig.spine[0]
  if (head0) {
    head0.x = rig.head.x
    head0.y = rig.head.y
  }

  for (let i = 1; i < rig.spine.length; i++) {
    const prev = rig.spine[i - 1]
    const cur = rig.spine[i]
    if (!prev || !cur) continue

    let dx = cur.x - prev.x
    let dy = cur.y - prev.y
    let d = Math.sqrt(dx * dx + dy * dy)
    if (d < 1e-6) {
      // Degenerate: push straight back along the body so the chain has a
      // direction to work with.
      dx = 1
      dy = 0
      d = 1
    }
    const ux = dx / d
    const uy = dy / d

    // Target: exactly one spacing behind the previous node...
    let tx = prev.x + ux * SPINE_SPACING
    let ty = prev.y + uy * SPINE_SPACING

    // ...plus a travelling lateral wave, which is what stops the body reading
    // as a rigid stick. Amplitude grows toward the tail so it whips.
    const wave = Math.sin(rig.undulation - i * 0.5) * (i / SPINE_NODES) * 4.2
    tx += -uy * wave
    ty += ux * wave

    // A soft ease rather than a hard snap: that lag IS the flexibility.
    const ease = Math.min(1, dt * 15)
    cur.x += (tx - cur.x) * ease
    cur.y += (ty - cur.y) * ease
  }

  /**
   * Enforce exact spacing, root to tail.
   *
   * ── Why exact and not a minimum ───────────────────────────────────────────
   * The ease above is what makes the body flexible: each node lags its ideal
   * position, so hard turns produce the characteristic trailing curve. But lag
   * also lets consecutive nodes drift apart or overlap, and a "spine" whose
   * segments change length is just a rope. Pinning every segment to exactly one
   * spacing — the same distance constraint a Verlet rod uses — keeps the body
   * correctly sized while all the flexibility stays in the DIRECTION each
   * segment points, plus the undulation and the angle cones below.
   *
   * Measured before this change: spacing error reached 8.0 px on a 21 px segment
   * (38%), which is visible as the body visibly stretching under hard turns.
   */
  for (let i = 1; i < rig.spine.length; i++) {
    const prev = rig.spine[i - 1]
    const cur = rig.spine[i]
    if (!prev || !cur) continue
    let dx = cur.x - prev.x
    let dy = cur.y - prev.y
    let d = Math.sqrt(dx * dx + dy * dy)
    if (d < 1e-6) {
      // Coincident nodes give no direction; push straight back along the body.
      dx = 1
      dy = 0
      d = 1
    }
    const k = SPINE_SPACING / d
    cur.x = prev.x + dx * k
    cur.y = prev.y + dy * k
  }

  // Angle cones on the spine too. This is the same constraint the limbs use,
  // and it is what stops a hard turn from folding the body into a kink. Safe to
  // run after the spacing pass: each clamp is a RIGID rotation of the downstream
  // sub-chain about the joint, so every bone length inside it is preserved.
  applyAngleConstraints(rig.spine, SPINE_MAX_BEND)

  /* ── Body direction: velocity if moving, otherwise the body's own axis ── */
  let dirX = rig.vel.x
  let dirY = rig.vel.y
  const dirLen = Math.sqrt(dirX * dirX + dirY * dirY)
  if (dirLen > 6) {
    dirX /= dirLen
    dirY /= dirLen
  } else {
    const a = rig.spine[0]
    const b = rig.spine[1] ?? a
    const bx = (a?.x ?? 0) - (b?.x ?? 0)
    const by = (a?.y ?? 0) - (b?.y ?? 0)
    const bl = Math.sqrt(bx * bx + by * by) || 1
    dirX = bx / bl
    dirY = by / bl
  }

  /* ══ Gait controller: exclusive diagonal trot ═════════════════════════════
   *
   * ── The bug this replaces ────────────────────────────────────────────────
   * The previous controller evaluated each leg independently and only required
   * that *some* leg of the other group was planted. That permitted this
   * sequence: front-left (group 0) lifts, and because rear-left (group 1) is not
   * in the same group, rear-left may then also lift — two legs on the same side
   * in the air at once, which tips the visual centre of mass. The grouping was
   * diagonal, but nothing enforced it.
   *
   * ── The rule now ─────────────────────────────────────────────────────────
   * Exactly one group owns the swing phase. A group may only launch when:
   *   1. no group is currently swinging, AND
   *   2. the previous group has FULLY landed (every one of its legs down), AND
   *   3. the lock timer has expired, guaranteeing a moment of four-point contact.
   * Because each group spans both sides of the body, two same-side legs can
   * never leave the ground together.
   */
  const gait = rig.gait

  /* 1. Has the active group fully landed? */
  if (gait.activeGroup >= 0) {
    let stillSwinging = false
    for (const leg of rig.legs) {
      if (leg.pair === gait.activeGroup && leg.stepping) stillSwinging = true
    }
    if (!stillSwinging) {
      // Group is down and locked: release ownership and start the settle timer.
      gait.groupLanded = true
      // Remember which group just finished, so the next phase picks the OTHER.
      gait.lastGroup = gait.activeGroup
      gait.activeGroup = -1
      gait.lockTimer = GROUP_LOCK_TIME
    }
  }

  /* 2. Tick the lock timer down. */
  if (gait.lockTimer > 0) {
    gait.lockTimer -= dt
    if (gait.lockTimer < 0) gait.lockTimer = 0
  }

  /* 3. Consider handing the swing phase to a group. */
  if (gait.activeGroup < 0 && gait.lockTimer <= 0) {
    // How far has each group's worst foot fallen behind its stance?
    let lag0 = 0
    let lag1 = 0
    for (const leg of rig.legs) {
      if (leg.stepping) continue
      const hip = rig.spine[leg.hipIndex]
      if (!hip) continue
      const stance = stanceFor(hip, dirX, dirY, leg.side)
      const lag = Math.sqrt(
        (stance.x - leg.anchorX) * (stance.x - leg.anchorX) +
          (stance.y - leg.anchorY) * (stance.y - leg.anchorY),
      )
      if (leg.pair === 0) {
        if (lag > lag0) lag0 = lag
      } else if (lag > lag1) {
        lag1 = lag
      }
    }

    /**
     * STRICT ALTERNATION.
     *
     * The group that did NOT just swing is always preferred, so the sequence is
     * 0,1,0,1,… rather than "whichever group happens to lag most". Picking by lag
     * alone measured as 4 repeats in 44 phases — the body would occasionally
     * swing the same diagonal twice in a row, which reads as a limp.
     *
     * The just-swung group is only allowed to go again when the preferred group
     * has nothing to do (its feet are all within the stride threshold). Keeping
     * that fallback means a hard turn which badly misplaces one diagonal still
     * gets corrected promptly instead of waiting a full extra cycle.
     */
    const preferred = gait.lastGroup === 0 ? 1 : gait.lastGroup === 1 ? 0 : 0
    const preferredLag = preferred === 0 ? lag0 : lag1
    const otherLag = preferred === 0 ? lag1 : lag0

    let chosen = -1
    if (preferredLag > STRIDE_THRESHOLD) chosen = preferred
    else if (otherLag > STRIDE_THRESHOLD) chosen = preferred === 0 ? 1 : 0

    if (chosen >= 0) {
      // Both legs of the group lift on the SAME frame. This synchronisation is
      // what makes it a trot rather than a four-beat walk.
      for (const leg of rig.legs) {
        if (leg.pair !== chosen || leg.stepping) continue
        const hip = rig.spine[leg.hipIndex]
        if (!hip) continue
        const stance = stanceFor(hip, dirX, dirY, leg.side)
        leg.stepping = true
        leg.stepT = 0
        leg.fromX = leg.anchorX
        leg.fromY = leg.anchorY
        leg.toX = stance.x
        leg.toY = stance.y
        // The anchor becomes the landing target immediately, so the lag that
        // drove this step resets and the foot does not double-trigger on landing.
        leg.anchorX = stance.x
        leg.anchorY = stance.y
      }
      gait.activeGroup = chosen
      gait.groupLanded = false
    }
  }

  /* ── Legs: advance steps, then solve 2-bone IK to the foot ───────────── */
  for (const leg of rig.legs) {
    const hip = rig.spine[leg.hipIndex]
    if (!hip) continue
    const hipX = hip.x - dirY * leg.side * LEG_SPREAD * 0.22
    const hipY = hip.y + LEG_DROP

    let footX: number
    let footY: number

    if (leg.stepping) {
      leg.stepT += dt / STEP_DURATION
      const t = Math.min(1, leg.stepT)
      footX = leg.fromX + (leg.toX - leg.fromX) * t
      footY = leg.fromY + (leg.toY - leg.fromY) * t
      // Parabolic lift: 4t(1−t) peaks at exactly 1 when t = 0.5, so the foot
      // rises and lands smoothly with no fixed end-point correction needed.
      footY -= 4 * STEP_LIFT * t * (1 - t)
      if (leg.stepT >= 1) {
        leg.stepping = false
        footX = leg.toX
        footY = leg.toY
        // Touchdown: flag it for the ripple spawner below.
        leg.landed = true
      }
    } else {
      /**
       * Planted: the foot holds its WORLD position while the body walks over it.
       *
       * This is the core of procedural foot placement. Assigning the foot the
       * stance target here instead — which an earlier version did — makes the
       * planted foot slide along with the body, so no lag ever accumulates, no
       * leg ever crosses the stride threshold, and the creature glides along on
       * four static legs.
       */
      footX = leg.anchorX
      footY = leg.anchorY
    }

    /* ── Clamp the foot into the leg's reachable disc ──────────────────────
     * A fast body or a hard turn can demand a foot position farther than
     * upper + lower from the hip. FABRIK would then correctly report the chain
     * as unreachable and lay it out straight, which shows up as a leg visibly
     * detaching from its own foot pad. Clamping the goal to just inside full
     * extension keeps the solve converging and looks like a real limb reaching
     * its limit. Measured before this clamp: worst leg IK error was over 1 px
     * and the chain spent whole frames in the unreachable branch.
     */
    const reachMax = (LEG_UPPER + LEG_LOWER) * 0.985
    const toFootX = footX - hipX
    const toFootY = footY - hipY
    const toFootDist = Math.sqrt(toFootX * toFootX + toFootY * toFootY)
    if (toFootDist > reachMax) {
      const k = reachMax / toFootDist
      footX = hipX + toFootX * k
      footY = hipY + toFootY * k
    }

    leg.joints[0].x = hipX
    leg.joints[0].y = hipY
    // The foot joint follows the procedural animation exactly; the solver only
    // has to place the knee, which it does from the previous knee position so
    // the pose stays continuous frame to frame.
    leg.joints[2].x = footX
    leg.joints[2].y = footY

    solveFABRIK(leg.joints, { x: footX, y: footY }, leg.lengths, 0.4, {
      maxBend: LEG_MAX_BEND,
      maxIterations: 8,
      result: leg.result,
    })
  }

  /* ── Landing ripples ─────────────────────────────────────────────────────
   * A touch-down spawns a ring at the exact contact point. Spawning is
   * separated from the leg loop so the ripple sits at the CLAMPED foot position
   * — the point actually drawn — rather than at the unclamped stance target.
   */
  for (const leg of rig.legs) {
    if (!leg.landed) continue
    leg.landed = false // consume, so one landing emits exactly one ripple
    const foot = leg.joints[2]
    if (!foot) continue

    /**
     * Holographic footfall.
     *
     * Spawned from the SAME clamped foot position as the ground ellipse below,
     * so the foot pad, the shockwave, the two hex ripples and the motes all
     * agree about where the mechanical foot locked. Two hex records at opposite
     * phases give the double expanding ring; the motes are ordinary pool
     * particles with negative gravity, so they drift up and fade instead of
     * settling back onto the floor.
     */
    spawnHexRipple(rig, foot.x, foot.y, 0)
    spawnHexRipple(rig, foot.x, foot.y, HEX_RIPPLE_PHASE)
    emitFootMotes(rig, foot.x, foot.y)

    // Reuse a dead slot; if every slot is live, recycle the oldest so a burst of
    // landings degrades gracefully instead of dropping the newest ripple.
    let slot: Ripple | null = null
    let oldest: Ripple | null = null
    for (const r of rig.ripples) {
      if (!r.alive) {
        slot = r
        break
      }
      if (!oldest || r.t > oldest.t) oldest = r
    }
    const target = slot ?? oldest
    if (!target) continue
    target.x = foot.x
    target.y = foot.y
    target.t = 0
    target.alive = true
  }

  /* Advance every live ripple; retire the finished ones. */
  for (const r of rig.ripples) {
    if (!r.alive) continue
    r.t += dt / RIPPLE_DURATION
    if (r.t >= 1) {
      r.t = 1
      r.alive = false
    }
  }

  /* Advance the hex footfall ripples. A record whose `t` is still negative is
   * waiting out its phase delay and simply counts up toward zero. */
  for (const r of rig.hexRipples) {
    if (!r.alive) continue
    r.t += dt / HEX_RIPPLE_DURATION
    if (r.t >= 1) {
      r.t = 1
      r.alive = false
    }
  }

  /* Integrate the mote pool (emitted by the landing loop above). */
  rig.engine.step(dt, rig.bounds)

  /* ── Centre of mass and its velocity, for the debug vector ───────────── */
  let sumX = 0
  let sumY = 0
  for (const p of rig.spine) {
    sumX += p.x
    sumY += p.y
  }
  const comX = sumX / rig.spine.length
  const comY = sumY / rig.spine.length
  if (dt > 0) {
    rig.comVX = (comX - rig.comX) / dt
    rig.comVY = (comY - rig.comY) / dt
  }
  rig.comX = comX
  rig.comY = comY
}

/**
 * Where a foot *wants* to be for the current body pose.
 *
 * Offset perpendicular to the direction of travel (so the stance widens with
 * the body) plus a little drop toward the ground plane, plus a forward lead that
 * gives the leg something to push against.
 */
function stanceFor(hip: Vec2, dirX: number, dirY: number, side: number): { x: number; y: number } {
  const perpX = -dirY * side
  const perpY = dirX * side
  return {
    x: hip.x + perpX * LEG_SPREAD + dirX * STRIDE_LEAD,
    y: hip.y + perpY * LEG_SPREAD + dirY * STRIDE_LEAD + LEG_DROP + LEG_SPREAD * 0.34,
  }
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                */
/* -------------------------------------------------------------------------- */

type RideMode = 'arm' | 'creature'

interface DebugFlags {
  vectors: boolean
}

export function FabrikCreature({ className }: { className?: string }) {
  const { t } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const armRef = useRef<ArmRig | null>(null)
  const creatureRef = useRef<CreatureRig | null>(null)

  /** Pointer position in canvas space. */
  const pointerRef = useRef({ x: 0, y: 0 })
  /** Whether the pointer has ever moved; before that the rigs idle. */
  const pointerSeenRef = useRef(false)

  /** Viewport gating: the loop sleeps entirely while off screen. */
  const inViewRef = useInViewAnimation(wrapRef, { rootMargin: '25% 0px 25% 0px' })

  /*
   * Shared fixed-step clock (see `lib/fixedStep.ts`).
   *
   * This file had its own accumulator, step budget, debt cap and rebase logic -- the
   * same code as the lanyard sandbox, which is how the same bugs lived in both. The
   * clock is created lazily so a re-render cannot silently reset it mid-simulation.
   */
  const clockRef = useRef<FixedStepClock | null>(null)
  if (!clockRef.current) {
    clockRef.current = createFixedStepClock({ fixedDt: 1 / 60, maxSteps: 4 })
  }
  const clock = clockRef.current
  /**
   * Quality tier, read through a ref by the resize path (PB-13).
   *
   * The sandboxes size their own canvas buffers, so the tier has to reach `resize` without
   * rebuilding the frame loop: the ref is updated on render and the effect below re-applies the size
   * when it changes.
   */
  const tier = useAppStore((state) => state.performanceTier)
  const tierRef = useRef(tier)
  tierRef.current = tier

  /** The mount effect's size applier, so a tier change can re-run it. */
  const resizeRef = useRef<(() => void) | null>(null)

  // A tier change has to reach the canvas buffer: without this the downgrade only takes effect on
  // the next window resize, which on a phone may never come (PB-13).
  useEffect(() => {
    resizeRef.current?.()
  }, [tier])

  const [mode, setMode] = useState<RideMode>('arm')
  const [debug, setDebug] = useState<DebugFlags>({ vectors: false })
  const [hud, setHud] = useState({ error: 0, iterations: 0, converged: true, shots: 0 })

  // Mirrored into refs so the frame loop reads them without re-subscribing.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const debugRef = useRef(debug)
  debugRef.current = debug

  /* ── Simulation + render loop ─────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let cssW = 0
    let cssH = 0
    let dpr = 1

    const resize = (): void => {
      const rect = wrap.getBoundingClientRect()
      cssW = Math.max(1, Math.round(rect.width))
      cssH = Math.max(1, Math.round(rect.height))
      // Matches the lanyard: glow-only canvas, so 1.5 is indistinguishable from 2.
      /*
       * Fill-rate budget, keyed to the quality tier (PB-13).
       *
       * The adaptive downgrade lowers the renderer's DPR and halves the particles, but these two
       * sandboxes ignored it and kept drawing at 1.5x -- and they are the most expensive sections
       * on the page (the author's own note: 121 -> 144 fps with them unmounted). At the `low` tier
       * the canvas now matches the rest of the app at DPR 1, which is a 2.25x fill-rate cut on the
       * single heaviest canvas.
       *
       * 1.5 rather than 2 even at `high`: this canvas is pure additive glow on a near-black ground,
       * where the extra density of a 2x buffer is invisible, but the per-frame fill cost is 44%
       * higher.
       */
      dpr = Math.min(window.devicePixelRatio || 1, dprForTier(tierRef.current))
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`

      // Rebuild the rigs at the new size: their rest poses are derived from the
      // canvas dimensions, so resizing without rebuilding would leave the arm
      // base and the creature's feet outside the visible area.
      armRef.current = createArm(cssW, cssH)
      creatureRef.current = createCreature(cssW, cssH)
      pointerRef.current = { x: cssW / 2, y: cssH * 0.35 }
    }
    resizeRef.current = resize

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    /**
     * Dev-only inspection handle.
     *
     * Verification drives the rigs directly rather than synthesising pointer
     * events: the canvas' document position shifts with layout, so events aimed
     * "at the arm" landed outside it in earlier sandboxes and produced
     * misleading failures. Exposing the rigs lets a test assert on real solver
     * state — convergence, bone lengths, gait phase — instead of on pixels.
     */
    if (import.meta.env.DEV) {
      ;(window as unknown as { __fabrik?: unknown }).__fabrik = {
        arm: () => armRef.current,
        creature: () => creatureRef.current,
        mode: () => modeRef.current,
        pointer: (x: number, y: number) => {
          pointerRef.current = { x, y }
          pointerSeenRef.current = true
        },
        fire: () => {
          const a = armRef.current
          if (a) fireArm(a)
          return a ? a.shots : 0
        },
        /** Advance the active rig deterministically, bypassing the RAF. */
        step: (count: number, dt: number) => {
          const rect = wrap.getBoundingClientRect()
          for (let i = 0; i < count; i++) {
            const px = pointerRef.current.x
            const py = pointerRef.current.y
            const arm = armRef.current
            const creature = creatureRef.current
            if (arm && modeRef.current === 'arm') stepArm(arm, dt, px, py)
            if (creature && modeRef.current === 'creature') {
              stepCreature(creature, dt, px, py, rect.width, rect.height)
            }
          }
          return true
        },
      }
    }

    /* ── Loop ────────────────────────────────────────────────────────────── */
    const FIXED = 1 / 60
    let raf = 0
    let hudTimer = 0

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      // Sleep when off screen; the loop keeps its rAF handle so waking is a
      // single flag flip with no observer round-trip.
      if (!inViewRef.current) {
        // Rebase the clock: see the note in VerletLanyard. Off-screen time must not
        // be replayed as a burst of catch-up steps when the sandbox wakes.
        clock.skip(now)
        return
      }
      // Visual regression gate: hold the current frame (see lib/testHooks.ts).
      if (isStill()) return
      // Same scroll-busy stand-down as the lanyard sandbox -- see the note there.
      if (isScrollBusy()) {
        clock.skip(now)
        return
      }

      const dt = clock.begin(now)

      /**
       * Time the IK batch.
       *
       * Covers the active rig only — one 6-bone arm chain, or the spine plus four
       * 2-bone legs in creature mode — so the number tracks whichever mode the
       * visitor is actually looking at.
       */
      const ikStart = performance.now()
      let ikChains = 0

      let steps = 0
      while (clock.pending()) {
        const px = pointerRef.current.x
        const py = pointerRef.current.y
        const arm = armRef.current
        const creature = creatureRef.current
        if (arm && modeRef.current === 'arm') {
          stepArm(arm, FIXED, px, py)
          ikChains = 1
        }
        if (creature && modeRef.current === 'creature') {
          // Until the pointer moves, steer the creature to the canvas centre so
          // it wanders rather than sprinting to a stale (0,0) corner.
          const tx = pointerSeenRef.current ? px : cssW / 2
          const ty = pointerSeenRef.current ? py : cssH / 2
          stepCreature(creature, FIXED, tx, ty, cssW, cssH)
          ikChains = creature.legs.length
        }
        clock.consume()
        steps++
      }

      // See the note in VerletLanyard: an uncapped accumulator turns sustained low
      // frame rates into permanent slow motion instead of a brief lag.
      clock.end()

      if (steps > 0) {
        reportIkSolve(performance.now() - ikStart, ikChains)
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      if (modeRef.current === 'arm') {
        const arm = armRef.current
        if (arm) {
          drawArm(ctx, arm, debugRef.current.vectors)
        }
      } else {
        const creature = creatureRef.current
        if (creature) {
          drawCreature(ctx, creature, debugRef.current.vectors)
        }
      }

      hudTimer += dt
      if (hudTimer > 0.15) {
        hudTimer = 0
        if (modeRef.current === 'arm') {
          const arm = armRef.current
          if (arm) {
            setHud({
              error: arm.result.error,
              iterations: arm.result.iterations,
              converged: arm.result.converged,
              shots: arm.shots,
            })
          }
        } else {
          const creature = creatureRef.current
          if (creature) {
            let worst = 0
            let iters = 0
            let allConverged = true
            for (const leg of creature.legs) {
              if (leg.result.error > worst) worst = leg.result.error
              if (leg.result.iterations > iters) iters = leg.result.iterations
              if (!leg.result.converged) allConverged = false
            }
            setHud({ error: worst, iterations: iters, converged: allConverged, shots: 0 })
          }
        }
      }
    }

    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  /* ── Pointer ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const toLocal = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const onMove = (e: PointerEvent): void => {
      pointerRef.current = toLocal(e)
      pointerSeenRef.current = true
    }
    const onDown = (e: PointerEvent): void => {
      pointerRef.current = toLocal(e)
      pointerSeenRef.current = true
      const arm = armRef.current
      if (arm && modeRef.current === 'arm') fireArm(arm)
    }

    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerdown', onDown)
    return () => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerdown', onDown)
    }
  }, [])

  /* ── Keyboard interaction (PB-05) ─────────────────────────────────────── */
  /**
   * Keyboard parity for the two rigs.
   *
   * Both rigs read the same two inputs: one tracked point (the arm's IK target, the
   * creature's steering target) and, in arm mode only, a click that fires the laser.
   * So the keyboard mapping is exactly those two things — arrows move the point,
   * Enter/Space fires — and no solver or gait code has to know the input changed.
   *
   * Same pixel steps as the lanyard sandbox (14, or 56 with Shift) so the two toys
   * feel like one family. The point is clamped to the canvas because the creature
   * steers toward it: an unclamped target walks the body into a wall and pins it.
   */
  const onCanvasKeyDown = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (!canvas) return

    if (e.key === 'Enter' || e.key === ' ') {
      // Space would otherwise scroll the page while the sandbox holds focus.
      e.preventDefault()
      const arm = armRef.current
      if (arm && modeRef.current === 'arm') {
        fireArm(arm)
        announce(t.sandbox.kbdFire)
      }
      return
    }

    const step = e.shiftKey ? 56 : 14
    let dx = 0
    let dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = -step
    else if (e.key === 'ArrowDown') dy = step
    else return

    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    pointerRef.current = {
      x: Math.min(Math.max(pointerRef.current.x + dx, 0), rect.width),
      y: Math.min(Math.max(pointerRef.current.y + dy, 0), rect.height),
    }
    // Without this the rigs keep idling at their default target, so a keyboard user
    // would be moving a point that nothing reads.
    pointerSeenRef.current = true
  }

  /* ── Mode switching resets the rig being entered ──────────────────────── */
  const switchMode = (next: RideMode): void => {
    setMode(next)
    const wrap = wrapRef.current
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    if (next === 'creature') {
      creatureRef.current = createCreature(r.width, r.height)
    } else {
      armRef.current = createArm(r.width, r.height)
    }
  }

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative overflow-hidden rounded-panel border border-void-600/70 bg-void-950/55',
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_0%,rgba(167,139,250,0.10),transparent_70%)]"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 grid-backdrop opacity-30" />

      <canvas
        ref={canvasRef}
        className="relative block h-full w-full touch-none select-none"
        /* `pan-y` for the same reason as the lanyard sandbox: this canvas covers ~48vh,
       and `none` made it a dead zone for page scrolling on touch devices. */
        style={{ touchAction: 'pan-y', cursor: mode === 'arm' ? 'crosshair' : 'default' }}
        /* eslint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role --
           Same as the lanyard sandbox: `application` is a composite widget role, and the rig
           handles the arrow/Enter keys itself. See the note in VerletLanyard.tsx. */
        role="application"
        // Reachable and operable from the keyboard (PB-05); the ring comes from the
        // global `:focus-visible` rule in index.css.
        tabIndex={0}
        aria-label={mode === 'arm' ? t.sandbox.fabrikArmAria : t.sandbox.fabrikCreatureAria}
        aria-describedby="sandbox-fabrik-keys"
        onKeyDown={onCanvasKeyDown}
      />
      <p id="sandbox-fabrik-keys" className="sr-only">
        {mode === 'arm' ? t.sandbox.fabrikKeysArm : t.sandbox.fabrikKeysCreature}
      </p>

      {/* ── Control bar ──────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          {/* Mode switch */}
          <div className="flex overflow-hidden rounded-md border border-void-600/70 bg-void-950/92">
            {(
              [
                ['arm', t.sandbox.fabrikArmLabel],
                ['creature', t.sandbox.fabrikQuadruped],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => switchMode(value)}
                aria-pressed={mode === value}
                className={cn(
                  'px-2.5 py-1.5 font-mono text-[0.6rem] tracking-wider uppercase transition-colors',
                  mode === value
                    ? 'bg-signal-violet/25 text-signal-violet'
                    : 'text-ink-500 hover:text-ink-300',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Debug toggle */}
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-void-600/70 bg-void-950/92 px-2.5 py-1.5">
            <input
              type="checkbox"
              checked={debug.vectors}
              onChange={(e) => setDebug({ vectors: e.target.checked })}
              className="size-3 accent-[#a78bfa]"
            />
            <span className="font-mono text-[0.6rem] tracking-wider text-ink-300 uppercase">
              {t.sandbox.fabrikShowVectors}
            </span>
          </label>
        </div>

        {/* Telemetry */}
        <div className="rounded-md border border-void-600/60 bg-void-950/92 px-2.5 py-1.5">
          <p className="font-mono text-[0.55rem] tracking-[0.22em] text-ink-700 uppercase">
            {t.sandbox.fabrikLabel}
          </p>
          <div className="mt-1 flex items-center gap-2 font-mono text-[0.6rem]">
            <span className="text-ink-500">{t.sandbox.fabrikError}</span>
            <span
              className={cn(
                'tabular-nums',
                hud.converged ? 'text-signal-teal' : 'text-signal-amber',
              )}
            >
              {hud.error < 0.01 ? hud.error.toExponential(1) : hud.error.toFixed(2)}px
            </span>
            <span className="text-ink-700">·</span>
            <span className="text-ink-500">{t.sandbox.fabrikIterations}</span>
            <span className="tabular-nums text-ink-300">{hud.iterations}</span>
            {mode === 'arm' && (
              <>
                <span className="text-ink-700">·</span>
                <span className="text-ink-500">{t.sandbox.fabrikShots}</span>
                <span className="tabular-nums text-signal-rose">{hud.shots}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center font-mono text-[0.55rem] tracking-[0.2em] text-ink-700 uppercase">
        {mode === 'arm' ? t.sandbox.fabrikArmHint : t.sandbox.fabrikCreatureHint}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Drawing helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Trace a tapered capsule between two points, widest in the middle. */
function taperedBone(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  ctx.beginPath()
  ctx.moveTo(x0 + nx * w0, y0 + ny * w0)
  ctx.lineTo(x1 + nx * w1, y1 + ny * w1)
  ctx.lineTo(x1 - nx * w1, y1 - ny * w1)
  ctx.lineTo(x0 - nx * w0, y0 - ny * w0)
  ctx.closePath()
}

/** A machined metal segment with a highlight down one edge. */
function drawBoneMetal(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
  tint: string,
): void {
  const grad = ctx.createLinearGradient(x0, y0, x1, y1)
  grad.addColorStop(0, '#39445a')
  grad.addColorStop(0.42, '#6b7a94')
  grad.addColorStop(0.55, '#8d9cb8')
  grad.addColorStop(1, '#2c3546')
  taperedBone(ctx, x0, y0, x1, y1, w0, w1)
  ctx.fillStyle = grad
  ctx.fill()

  // Accent core stripe: the "powered" look.
  ctx.save()
  taperedBone(ctx, x0, y0, x1, y1, w0 * 0.34, w1 * 0.34)
  ctx.fillStyle = tint
  ctx.globalAlpha = 0.5
  ctx.fill()
  ctx.restore()

  // Specular edge.
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  ctx.beginPath()
  ctx.moveTo(x0 + nx * w0 * 0.62, y0 + ny * w0 * 0.62)
  ctx.lineTo(x1 + nx * w1 * 0.62, y1 + ny * w1 * 0.62)
  ctx.strokeStyle = 'rgba(240, 248, 255, 0.5)'
  ctx.lineWidth = 1
  ctx.stroke()
}

/** A joint pivot: dark hub, steel ring, bright pin. */
function drawJoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  tint: string,
): void {
  const hub = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r)
  hub.addColorStop(0, '#9fb0c8')
  hub.addColorStop(0.55, '#4c5a72')
  hub.addColorStop(1, '#222a38')
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = hub
  ctx.fill()

  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.strokeStyle = tint
  ctx.globalAlpha = 0.8
  ctx.lineWidth = 1.3
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.beginPath()
  ctx.arc(x, y, r * 0.3, 0, Math.PI * 2)
  ctx.fillStyle = '#0b0f18'
  ctx.fill()
}

/* -------------------------------------------------------------------------- */
/*  Holographic + impact VFX rendering                                       */
/* -------------------------------------------------------------------------- */

/**
 * Multi-layer rotating holographic rings around one IK joint.
 *
 * ── Why arcs instead of full circles ─────────────────────────────────────
 * Three concentric FULL circles read as a static reticle: perfect rotational
 * symmetry gives the eye nothing to track. Rotating ARCS at different radii,
 * speeds and phases read as a scan instead, because motion is the only cue the
 * eye can use. The gaps also keep the steel hub visible underneath.
 *
 * ── Why `time` is passed in ─────────────────────────────────────────────
 * It is the rig's accumulated clock, not `performance.now()`. The loop is gated
 * by an IntersectionObserver, so a wall clock would teleport every ring forward
 * by however long the sandbox spent off screen; the rig clock resumes exactly
 * where it stopped.
 */
function drawHoloJoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  time: number,
  seed: number,
): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'

  for (let ring = 0; ring < HOLO_RING_COUNT; ring++) {
    const ringRadius = radius * (1.35 + ring * 0.34)
    // Ring 1 counter-rotates. Co-rotating rings keep their gaps fixed relative
    // to each other, which collapses the illusion into a set of spokes.
    const direction = ring === 1 ? -1 : 1
    const spin = time * (0.9 + ring * 0.62) * direction + seed + ring * 2.1
    // Slow breathing keeps the layer reading as projected light, not paint.
    const breathe = 0.65 + 0.35 * Math.sin(time * 2.3 + ring * 1.7 + seed)
    const sweep = 2.5 - ring * 0.4

    ctx.globalAlpha = (0.5 - ring * 0.1) * breathe
    ctx.strokeStyle = HOLO_RING_COLORS[ring]
    ctx.lineWidth = ring === 0 ? 1.3 : 1

    ctx.beginPath()
    ctx.arc(x, y, ringRadius, spin, spin + sweep)
    ctx.stroke()

    // A second, shorter arc half a turn away: together the pair reads as a
    // rotating instrument bezel rather than a dashed circle.
    ctx.beginPath()
    ctx.arc(x, y, ringRadius, spin + Math.PI, spin + Math.PI + sweep * 0.55)
    ctx.stroke()
  }

  // One bright bead orbiting the outermost ring is the cheapest possible cue
  // that the whole assembly is rotating rather than merely breathing.
  const orbit = time * 1.9 + seed
  ctx.globalAlpha = 0.8
  ctx.fillStyle = HOLO_ORBIT_COLOR
  ctx.beginPath()
  ctx.arc(
    x + Math.cos(orbit) * radius * 2.03,
    y + Math.sin(orbit) * radius * 2.03,
    Math.max(0.9, radius * 0.11),
    0,
    Math.PI * 2,
  )
  ctx.fill()

  ctx.restore()
}

/**
 * Flowing "energy fluid" inside one bone segment.
 *
 * Two layers, both driven by the elapsed clock:
 *   · a dashed stripe whose dash offset advances, so the fluid appears to be
 *     pumped from the parent joint toward the child joint;
 *   · two travelling bright packets with a sine-shaped alpha envelope, which
 *     give the flow a direction even on a bone only a few frames long on screen.
 * The stripe is narrower than the metal shell, so it reads as fluid running
 * INSIDE the bone rather than as another outline drawn on top of it.
 */
function drawEnergyFluid(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  time: number,
  seed: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  if (dx === 0 && dy === 0) return

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'

  /* Pumped stripe. The negative offset makes the dashes travel parent → child. */
  ctx.globalAlpha = 0.55
  ctx.strokeStyle = FLUID_STRIPE_COLOR
  ctx.lineWidth = Math.max(1, width * 0.22)
  ctx.setLineDash(FLUID_DASH)
  ctx.lineDashOffset = -((time * 42 + seed * 160) % 18)
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()

  /* Travelling packets: born at one joint, absorbed at the other. */
  for (let packet = 0; packet < 2; packet++) {
    const phase = (time * 0.55 + seed + packet * 0.5) % 1
    const envelope = Math.sin(phase * Math.PI)
    if (envelope <= 0.02) continue
    const px = x0 + dx * phase
    const py = y0 + dy * phase
    ctx.globalAlpha = envelope * 0.75
    ctx.fillStyle = FLUID_PACKET_COLOR
    ctx.beginPath()
    ctx.arc(px, py, Math.max(1.1, width * 0.34), 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = envelope * 0.3
    ctx.beginPath()
    ctx.arc(px, py, Math.max(2.2, width * 0.7), 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

/**
 * Draw the cooling impact scorches.
 *
 * ── The cooling curve ─────────────────────────────────────────────────────
 * A fresh hit is white-hot; it then decays through orange to a dull red before
 * fading out, and the passes below are exactly those three temperatures rather
 * than one additive blob with changing alpha. The char disc is drawn in
 * `source-over` so it reads as something burned INTO the surface, while the heat
 * passes above it are `lighter`.
 *
 * Flicker comes from `rig.clock` and the mark's own seed — NOT `Math.random()` —
 * so a mark glows like cooling metal instead of strobing with noise, and the
 * draw stays a pure function of state.
 */
function drawScorches(ctx: CanvasRenderingContext2D, rig: ArmRig): void {
  for (let i = 0; i < rig.scorches.length; i++) {
    const scorch = rig.scorches[i]
    if (!scorch.alive) continue

    const t = Math.min(1, scorch.age / SCORCH_LIFE)
    const heat = 1 - t

    ctx.save()
    ctx.translate(scorch.x, scorch.y)

    // Charred disc: the burn the glow sits on top of. Drawn first, in
    // source-over, and it lingers after the glow has cooled.
    if (t > 0.12) {
      ctx.globalAlpha = Math.min(1, (t - 0.12) * 4) * heat * 0.55
      ctx.fillStyle = SCORCH_CHAR_COLOR
      ctx.beginPath()
      ctx.arc(0, 0, SCORCH_RADIUS * (0.55 + t * 0.5), 0, Math.PI * 2)
      ctx.fill()
    }

    if (heat > 0.02) {
      ctx.globalCompositeOperation = 'lighter'
      const flicker = 0.82 + 0.18 * Math.sin(rig.clock * 19 + scorch.seed * 12)

      // White-hot core: only while the mark is genuinely hot.
      const white = Math.max(0, heat - 0.55) / 0.45
      if (white > 0) {
        ctx.globalAlpha = white * 0.9 * flicker
        ctx.fillStyle = SCORCH_WHITE_COLOR
        ctx.beginPath()
        ctx.arc(0, 0, SCORCH_RADIUS * (0.22 + t * 0.16), 0, Math.PI * 2)
        ctx.fill()
      }

      // Orange body: the middle of the cool-down.
      ctx.globalAlpha = heat * 0.45 * flicker
      ctx.fillStyle = SCORCH_ORANGE_COLOR
      ctx.beginPath()
      ctx.arc(0, 0, SCORCH_RADIUS * (0.55 + t * 0.35), 0, Math.PI * 2)
      ctx.fill()

      // Deep-red halo; heat squared so the outer glow dies before the core.
      ctx.globalAlpha = heat * heat * 0.3 * flicker
      ctx.fillStyle = SCORCH_RED_COLOR
      ctx.beginPath()
      ctx.arc(0, 0, SCORCH_RADIUS * (1.05 + t * 0.7), 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }
}

/**
 * Draw the holographic footfall ripples.
 *
 * `drawHexRipple` already paints a hexagon plus a fainter inner copy, so what
 * this loop adds is the TWO-phase choreography: two pooled records per landing,
 * the trailing one starting `HEX_RIPPLE_PHASE` into the leading one's life. That
 * stagger is what reads as a projected scan propagating outward, rather than as
 * one outline that happens to have six sides.
 *
 * Like the ground ellipse below the creature, the hexagon is squashed on its
 * vertical axis so it lies on the floor plane instead of floating in front of
 * the body.
 */
function drawHexRipples(ctx: CanvasRenderingContext2D, rig: CreatureRig): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'

  for (let i = 0; i < rig.hexRipples.length; i++) {
    const ripple = rig.hexRipples[i]
    // A negative `t` is a record still waiting out its phase delay.
    if (!ripple.alive || ripple.t <= 0 || ripple.t >= 1) continue

    const t = ripple.t
    // Cubic ease-out, matching the ground ellipse: a scan wave loses energy.
    const ease = 1 - (1 - t) * (1 - t) * (1 - t)
    const radius = 8 + ease * 44
    // Alpha peaks early, then thins; squaring keeps the tail faint.
    const alpha = (1 - t) * (1 - t) * 0.85
    // Anchored to the rig clock, so both phases of one footfall keep turning in
    // the same direction instead of snapping back every frame.
    const rotation = rig.clock * 0.5 + t * 2.2

    ctx.save()
    ctx.translate(ripple.x, ripple.y)
    ctx.scale(1, 0.62)
    drawHexRipple(ctx, 0, 0, radius, alpha, HEX_RIPPLE_COLOR, rotation)
    ctx.restore()
  }

  ctx.restore()
}

/**
 * Two counter-wobbling discharge filaments braided around the beam core.
 *
 * Written as sine height fields rather than by calling `fractalLightning`: that
 * helper returns a freshly allocated point array per call, and this runs every
 * frame for the duration of the pulse. Two offset `sin` terms off the rig clock
 * give the same visual instability with zero allocation.
 */
function drawIonBraid(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  time: number,
  alpha: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len

  ctx.lineWidth = 1.1
  for (let strand = 0; strand < 2; strand++) {
    const side = strand === 0 ? 1 : -1
    ctx.strokeStyle = strand === 0 ? 'rgba(196, 181, 253, 0.55)' : 'rgba(165, 243, 252, 0.6)'
    ctx.globalAlpha = alpha
    ctx.beginPath()
    for (let i = 0; i <= ION_BRAID_SEGMENTS; i++) {
      const t = i / ION_BRAID_SEGMENTS
      // Zero displacement at both ends pins the arc to the muzzle and to the
      // impact, instead of letting it float off the beam.
      const envelope = Math.sin(t * Math.PI)
      const wobble =
        (Math.sin(t * 11 + time * 52 + strand * 2.3) + 0.5 * Math.sin(t * 23 - time * 31)) *
        envelope *
        3.2 *
        side
      const px = x0 + dx * t + nx * wobble
      const py = y0 + dy * t + ny * wobble
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
  }
}

/* -------------------------------------------------------------------------- */
/*  Arm rendering                                                            */
/* -------------------------------------------------------------------------- */

function drawArm(ctx: CanvasRenderingContext2D, rig: ArmRig, debug: boolean): void {
  const rx = rig.recoil.x
  const ry = rig.recoil.y
  const tint = '#22d3ee'

  /* ── Cooling scorches, on the surface under everything else ──────────── */
  drawScorches(ctx, rig)

  ctx.save()
  ctx.translate(rx, ry)

  /* ── Base mount ──────────────────────────────────────────────────────── */
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(rig.baseX - 52, rig.baseY + 26)
  ctx.lineTo(rig.baseX + 52, rig.baseY + 26)
  ctx.lineTo(rig.baseX + 34, rig.baseY - 6)
  ctx.lineTo(rig.baseX - 34, rig.baseY - 6)
  ctx.closePath()
  const baseGrad = ctx.createLinearGradient(rig.baseX - 52, 0, rig.baseX + 52, 0)
  baseGrad.addColorStop(0, '#1b2230')
  baseGrad.addColorStop(0.45, '#3d4a60')
  baseGrad.addColorStop(0.6, '#55647e')
  baseGrad.addColorStop(1, '#161c27')
  ctx.fillStyle = baseGrad
  ctx.fill()
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.4)'
  ctx.lineWidth = 1.2
  ctx.stroke()
  // Hazard stripes on the mount.
  ctx.save()
  ctx.clip()
  ctx.globalAlpha = 0.18
  ctx.strokeStyle = tint
  ctx.lineWidth = 3
  for (let i = -90; i < 90; i += 12) {
    ctx.beginPath()
    ctx.moveTo(rig.baseX + i, rig.baseY + 28)
    ctx.lineTo(rig.baseX + i + 20, rig.baseY - 8)
    ctx.stroke()
  }
  ctx.restore()
  ctx.restore()

  /* ── Bones ───────────────────────────────────────────────────────────── */
  const n = rig.joints.length
  for (let i = 0; i < n - 1; i++) {
    const a = rig.joints[i]
    const b = rig.joints[i + 1]
    // Taper from thick at the base to slim at the tip.
    const w0 = 13 - (i / (n - 1)) * 5
    const w1 = 13 - ((i + 1) / (n - 1)) * 5
    drawBoneMetal(ctx, a.x, a.y, b.x, b.y, w0, w1, tint)
    // Energy fluid pumped through the bone shell. The seed staggers each
    // segment's packet phase so the six bones do not pulse in lockstep.
    drawEnergyFluid(ctx, a.x, a.y, b.x, b.y, (w0 + w1) * 0.5, rig.clock, i * 0.37)
  }

  /* ── Joints ──────────────────────────────────────────────────────────── */
  for (let i = 0; i < n - 1; i++) {
    const p = rig.joints[i]
    const jointRadius = i === 0 ? 11 : 8.5 - i * 0.5
    drawJoint(ctx, p.x, p.y, jointRadius, tint)
    // Holographic scan rings around every solved pivot, spinning on the rig
    // clock. The final chain node is drawn as the claw flange below, so its
    // rings are added there instead.
    drawHoloJoint(ctx, p.x, p.y, jointRadius, rig.clock, i * 0.63)
  }

  // The tool flange is an IK joint too — tighter rings make the emitter read as
  // a charged pivot rather than a plain block.
  const flange = rig.joints[n - 1]
  if (flange) drawHoloJoint(ctx, flange.x, flange.y, 5.2, rig.clock, n * 0.63)

  /* ── Claw ────────────────────────────────────────────────────────────── */
  const tip = rig.joints[n - 1]
  const wrist = rig.joints[n - 2]
  if (tip && wrist) {
    const ang = Math.atan2(rig.aimY, rig.aimX)
    // Open wider right after a shot, as if the claw discharged.
    const open = 0.34 + (1 - rig.laserT) * 0.3

    ctx.save()
    ctx.translate(tip.x, tip.y)
    ctx.rotate(ang)

    // Palm block.
    ctx.beginPath()
    ctx.moveTo(-9, -7)
    ctx.lineTo(4, -9)
    ctx.lineTo(6, 9)
    ctx.lineTo(-9, 7)
    ctx.closePath()
    ctx.fillStyle = '#2f3949'
    ctx.fill()
    ctx.strokeStyle = tint
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.globalAlpha = 1

    // Two prongs that open along the aim axis.
    for (const s of [-1, 1]) {
      ctx.save()
      ctx.rotate(s * open)
      ctx.beginPath()
      ctx.moveTo(4, s * 3)
      ctx.lineTo(24, s * 2.4)
      ctx.lineTo(24, s * 6.4)
      ctx.lineTo(4, s * 7.4)
      ctx.closePath()
      const prongGrad = ctx.createLinearGradient(4, 0, 24, 0)
      prongGrad.addColorStop(0, '#616f88')
      prongGrad.addColorStop(0.6, '#c3d0e4')
      prongGrad.addColorStop(1, '#7c8aa2')
      ctx.fillStyle = prongGrad
      ctx.fill()
      ctx.restore()
    }

    // Emitter lens between the prongs.
    const lensGlow = ctx.createRadialGradient(10, 0, 0, 10, 0, 9)
    const charge = 1 - rig.laserT
    lensGlow.addColorStop(0, `rgba(255, 255, 255, ${0.5 + charge * 0.5})`)
    lensGlow.addColorStop(0.4, `rgba(34, 211, 238, ${0.5 + charge * 0.5})`)
    lensGlow.addColorStop(1, 'rgba(34, 211, 238, 0)')
    ctx.beginPath()
    ctx.arc(10, 0, 9, 0, Math.PI * 2)
    ctx.fillStyle = lensGlow
    ctx.fill()

    ctx.restore()
  }

  /* ── Ionised laser pulse ─────────────────────────────────────────────── */
  if (rig.laserT < 1 && tip) {
    // Quadratic decay: bright flash, fast fade. Reads as a pulse, not a beam.
    const fade = (1 - rig.laserT) * (1 - rig.laserT)
    /*
     * The beam is pinned to the WORLD impact point (`stepArm`/`fireArm` own it)
     * while the muzzle rides the recoil spring. Because this whole layer is
     * drawn inside the recoil translate, the impact has to be transformed back
     * out of that space — otherwise the flare, the sparks and the scorch mark
     * would slide apart under recoil.
     */
    const ex = rig.impactX - rx
    const ey = rig.impactY - ry

    ctx.save()
    ctx.lineCap = 'round'
    ctx.globalCompositeOperation = 'lighter'

    /* ── b) Outer ionised glow ──────────────────────────────────────────
     * Two wide, low-alpha passes instead of one: the violet pass is the
     * ionised air around the beam, the cyan pass the charge sheath hugging it.
     * Both are additive, so they BRIGHTEN the scene underneath rather than
     * painting over it.
     */
    ctx.globalAlpha = 0.12 * fade
    ctx.strokeStyle = '#7c3aed'
    ctx.lineWidth = 30
    ctx.beginPath()
    ctx.moveTo(rig.laserX, rig.laserY)
    ctx.lineTo(ex, ey)
    ctx.stroke()

    ctx.globalAlpha = 0.2 * fade
    ctx.strokeStyle = '#22d3ee'
    ctx.lineWidth = 15
    ctx.beginPath()
    ctx.moveTo(rig.laserX, rig.laserY)
    ctx.lineTo(ex, ey)
    ctx.stroke()

    // Mid beam.
    ctx.globalAlpha = 0.45 * fade
    ctx.lineWidth = 7
    ctx.strokeStyle = '#67e8f9'
    ctx.beginPath()
    ctx.moveTo(rig.laserX, rig.laserY)
    ctx.lineTo(ex, ey)
    ctx.stroke()

    /* ── a) Pure-white core ─────────────────────────────────────────────
     * The only pass that is not tinted: it is white at the centre of every
     * colour the glow stacks, which is what sells a beam as "this hot".
     */
    ctx.globalAlpha = 0.95 * fade
    ctx.lineWidth = 2.4
    ctx.strokeStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(rig.laserX, rig.laserY)
    ctx.lineTo(ex, ey)
    ctx.stroke()

    /* Discharge filaments braided around the core. */
    drawIonBraid(ctx, rig.laserX, rig.laserY, ex, ey, rig.clock, fade)

    // Muzzle flash. `drawRadialFlash` replaces the hand-rolled gradient this
    // block used to allocate every frame.
    ctx.globalAlpha = 1
    drawRadialFlash(ctx, rig.laserX, rig.laserY, 46, 0.9 * fade, [34, 211, 238])

    /* ── c/d) Impact ────────────────────────────────────────────────────
     * A hot flare plus a thin white contact disc pinned to the impact point.
     * The continuous turbulence and molten sparks are emitted by `stepArm`
     * from this same coordinate, so the flare, the sparks and the scorch all
     * agree about where the beam is landing.
     */
    drawRadialFlash(ctx, ex, ey, 30 + 26 * fade, 0.95 * fade, [255, 224, 160])
    ctx.globalAlpha = 0.8 * fade
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(ex, ey, 3.4 + 3 * fade, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
  }

  ctx.restore()

  /* ── Particle layer: beam turbulence + impact sparks, in world space ─── */
  rig.engine.draw(ctx)

  /* ── Debug overlay ───────────────────────────────────────────────────── */
  if (debug) drawArmDebug(ctx, rig)
}

function drawArmDebug(ctx: CanvasRenderingContext2D, rig: ArmRig): void {
  ctx.save()
  ctx.translate(rig.recoil.x, rig.recoil.y)

  /* Angle cones at every interior joint. */
  for (let i = 1; i < rig.joints.length - 1; i++) {
    const prev = rig.joints[i - 1]
    const cur = rig.joints[i]
    drawAngleCone(ctx, prev, cur, ARM_MAX_BEND, 30, 'rgba(167, 139, 250, 0.16)')
  }

  /* Target bullseye. */
  drawBullseye(ctx, rig.target.x, rig.target.y, 14, '#fb7185')

  /* Bone index labels. */
  ctx.font = '600 8px ui-monospace, monospace'
  ctx.fillStyle = 'rgba(238, 242, 255, 0.55)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 1; i < rig.joints.length; i++) {
    const p = rig.joints[i]
    ctx.fillText(`J${i}`, p.x, p.y - 14)
  }

  /* End-effector error vector: from tip to target. */
  const tip = rig.joints[rig.joints.length - 1]
  if (tip) {
    ctx.beginPath()
    ctx.setLineDash([3, 3])
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(rig.target.x, rig.target.y)
    ctx.strokeStyle = 'rgba(251, 113, 133, 0.7)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
  }

  /* Numeric readout. */
  ctx.textAlign = 'left'
  ctx.font = '600 10px ui-monospace, monospace'
  ctx.fillStyle = rig.result.converged ? 'rgba(94, 234, 212, 0.95)' : 'rgba(251, 191, 36, 0.95)'
  ctx.fillText(
    `FABRIK  err=${rig.result.error.toFixed(3)}px  iter=${rig.result.iterations}`,
    rig.baseX - 130,
    rig.baseY + 54,
  )
  ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'
  ctx.fillText(
    `cone=±${((ARM_MAX_BEND * 180) / Math.PI).toFixed(0)}°  reach=${chainLength(rig.lengths).toFixed(0)}px`,
    rig.baseX - 130,
    rig.baseY + 68,
  )

  ctx.restore()
}

/* -------------------------------------------------------------------------- */
/*  Creature rendering                                                       */
/* -------------------------------------------------------------------------- */

function drawCreature(ctx: CanvasRenderingContext2D, rig: CreatureRig, debug: boolean): void {
  const tint = '#a78bfa'

  /* ── Landing effects, on the ground under everything else ────────────── */
  drawRipples(ctx, rig)
  drawHexRipples(ctx, rig)

  /* ── Legs first, so the body overlaps them ─────────────────────────────
   * The holographic layers are applied to the FABRIK chains only — four legs
   * with three IK nodes each. The spine is a follow-the-leader tendon, not an
   * IK chain, so it keeps its existing articulated plating instead of faking
   * pivots the solver never produces.
   */
  for (const leg of rig.legs) {
    const hip = leg.joints[0]
    const knee = leg.joints[1]
    const foot = leg.joints[2]
    if (!hip || !knee || !foot) continue

    // Rear legs are drawn darker than the front pair, which reads as depth.
    const shade = leg.hipIndex > 5 ? 0.72 : 1

    ctx.save()
    ctx.globalAlpha = shade
    drawBoneMetal(ctx, hip.x, hip.y, knee.x, knee.y, 6.5, 4.6, tint)
    drawEnergyFluid(ctx, hip.x, hip.y, knee.x, knee.y, 5.4, rig.clock, leg.hipIndex * 0.31)
    drawBoneMetal(ctx, knee.x, knee.y, foot.x, foot.y, 4.6, 2.6, tint)
    drawEnergyFluid(ctx, knee.x, knee.y, foot.x, foot.y, 3.6, rig.clock, leg.hipIndex * 0.31 + 0.5)
    drawJoint(ctx, knee.x, knee.y, 4.4, tint)
    // Both solved pivots of this leg get the holographic scan rings. The seeds
    // are derived from the hip index, so the four legs are phase-offset from one
    // another instead of spinning in lockstep.
    drawHoloJoint(ctx, hip.x, hip.y, 6.2, rig.clock, leg.hipIndex * 0.47)
    drawHoloJoint(ctx, knee.x, knee.y, 4.4, rig.clock, leg.hipIndex * 0.47 + 1.7)
    ctx.restore()

    // Foot pad: a small wedge pointing outward.
    ctx.save()
    ctx.translate(foot.x, foot.y)
    const outward = leg.side
    ctx.beginPath()
    ctx.moveTo(-5, -3)
    ctx.lineTo(5 * outward, -1)
    ctx.lineTo(3 * outward, 3.4)
    ctx.lineTo(-5, 3)
    ctx.closePath()
    ctx.fillStyle = '#4a5670'
    ctx.fill()
    ctx.strokeStyle = tint
    ctx.globalAlpha = 0.65
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()

    // The foot pad is a solved IK node too: a small ring reads as the projected
    // sensor the hound plants its weight through.
    drawHoloJoint(ctx, foot.x, foot.y, 3.4, rig.clock, leg.hipIndex * 0.47 + 3.2)
  }

  /* ── Spine: an offset polygon with varying thickness ─────────────────── */
  const spine = rig.spine
  const left: Array<{ x: number; y: number }> = []
  const right: Array<{ x: number; y: number }> = []

  for (let i = 0; i < spine.length; i++) {
    const p = spine[i]
    const prev = spine[Math.max(0, i - 1)]
    const next = spine[Math.min(spine.length - 1, i + 1)]
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl
    ty /= tl
    const nx = -ty
    const ny = tx
    // Taper: slim neck, thick chest, tapering tail.
    const t = i / (spine.length - 1)
    const halfWidth = 4 + Math.sin(Math.min(1, t * 1.25) * Math.PI) * 9.5
    left.push({ x: p.x + nx * halfWidth, y: p.y + ny * halfWidth })
    right.push({ x: p.x - nx * halfWidth, y: p.y - ny * halfWidth })
  }

  ctx.beginPath()
  ctx.moveTo(left[0].x, left[0].y)
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y)
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y)
  ctx.closePath()

  const bodyGrad = ctx.createLinearGradient(
    spine[0].x,
    spine[0].y,
    spine[spine.length - 1].x,
    spine[spine.length - 1].y,
  )
  bodyGrad.addColorStop(0, '#3b4761')
  bodyGrad.addColorStop(0.4, '#232c3e')
  bodyGrad.addColorStop(1, '#161c28')
  ctx.fillStyle = bodyGrad
  ctx.fill()
  ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)'
  ctx.lineWidth = 1.4
  ctx.stroke()

  /* ── Spine segment plates, so the body reads as articulated ──────────── */
  for (let i = 1; i < spine.length - 1; i++) {
    const p = spine[i]
    const prev = spine[i - 1]
    const next = spine[i + 1]
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl
    ty /= tl
    const nx = -ty
    const ny = tx
    const half = 3 + Math.sin(Math.min(1, (i / (spine.length - 1)) * 1.25) * Math.PI) * 8
    ctx.beginPath()
    ctx.moveTo(p.x + nx * half, p.y + ny * half)
    ctx.lineTo(p.x - nx * half, p.y - ny * half)
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.22)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  /* ── Head: a wedge with a sensor eye ─────────────────────────────────── */
  const head = spine[0]
  const neck = spine[1] ?? head
  if (head && neck) {
    const ang = Math.atan2(head.y - neck.y, head.x - neck.x)
    ctx.save()
    ctx.translate(head.x, head.y)
    ctx.rotate(ang)
    ctx.beginPath()
    ctx.moveTo(20, 0)
    ctx.lineTo(-2, -11)
    ctx.lineTo(-8, 0)
    ctx.lineTo(-2, 11)
    ctx.closePath()
    const headGrad = ctx.createLinearGradient(-8, 0, 20, 0)
    headGrad.addColorStop(0, '#232c3e')
    headGrad.addColorStop(1, '#4a5670')
    ctx.fillStyle = headGrad
    ctx.fill()
    ctx.strokeStyle = tint
    ctx.lineWidth = 1.3
    ctx.stroke()

    // Sensor eye, glowing.
    const eye = ctx.createRadialGradient(4, 0, 0, 4, 0, 6)
    eye.addColorStop(0, '#ffffff')
    eye.addColorStop(0.35, '#a78bfa')
    eye.addColorStop(1, 'rgba(167, 139, 250, 0)')
    ctx.beginPath()
    ctx.arc(4, 0, 6, 0, Math.PI * 2)
    ctx.fillStyle = eye
    ctx.fill()
    ctx.restore()
  }

  /* ── Particle layer: upward footfall motes, in world space ───────────── */
  rig.engine.draw(ctx)

  if (debug) drawCreatureDebug(ctx, rig)
}

function drawCreatureDebug(ctx: CanvasRenderingContext2D, rig: CreatureRig): void {
  /* Leg angle cones + target marks. */
  for (const leg of rig.legs) {
    const hip = leg.joints[0]
    const knee = leg.joints[1]
    const foot = leg.joints[2]
    if (knee && hip) drawAngleCone(ctx, hip, knee, LEG_MAX_BEND, 20, 'rgba(167, 139, 250, 0.14)')
    if (foot) drawBullseye(ctx, foot.x, foot.y, 7, leg.stepping ? '#5eead4' : '#94a3b8')
    // Line from the foot to where it would rather be, showing the stride lag.
    if (hip && foot) {
      ctx.beginPath()
      ctx.setLineDash([2, 4])
      ctx.moveTo(foot.x, foot.y)
      ctx.lineTo(leg.anchorX, leg.anchorY)
      ctx.strokeStyle = 'rgba(94, 234, 212, 0.35)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  /* Spine nodes. */
  for (let i = 0; i < rig.spine.length; i++) {
    const p = rig.spine[i]
    ctx.beginPath()
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(238, 242, 255, 0.75)'
    ctx.fill()
  }

  /* Centre-of-mass velocity vector. */
  drawVelocityArrow(ctx, rig.comX, rig.comY, rig.comVX * 0.18, rig.comVY * 0.18, '#fbbf24')

  /* Numeric readout. */
  ctx.font = '600 10px ui-monospace, monospace'
  ctx.textAlign = 'left'
  ctx.fillStyle = 'rgba(251, 191, 36, 0.95)'
  const speed = Math.hypot(rig.comVX, rig.comVY)
  ctx.fillText(`|v| = ${speed.toFixed(0)} px/s`, 14, 76)

  let worst = 0
  let iters = 0
  let stepping = 0
  for (const leg of rig.legs) {
    if (leg.result.error > worst) worst = leg.result.error
    if (leg.result.iterations > iters) iters = leg.result.iterations
    if (leg.stepping) stepping++
  }
  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
  ctx.fillText(`leg IK err = ${worst.toFixed(3)} px`, 14, 90)
  ctx.fillText(`iter = ${iters}  ·  swinging = ${stepping}/4`, 14, 104)
}

/**
 * Draw the landing ripples.
 *
 * ── Why an ellipse and not a circle ───────────────────────────────────────
 * A true circle reads as a bubble floating in front of the creature. Squashing
 * the vertical axis makes the ring lie flat on the ground plane, which is what
 * sells it as a shockwave travelling across the floor. The flattening also has to
 * grow slightly as the ring expands, because a ground ellipse seen in perspective
 * opens up as it comes nearer the camera.
 *
 * Two rings are drawn per landing — a bright leading edge and a fainter trailing
 * one — so the wave has a sense of thickness rather than looking like a stroked
 * outline.
 */
function drawRipples(ctx: CanvasRenderingContext2D, rig: CreatureRig): void {
  let drew = false
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'

  for (const r of rig.ripples) {
    if (!r.alive) continue
    const t = r.t
    // Cubic ease-out: fast expansion that decelerates, the way a real wave
    // loses energy. A linear ramp looks mechanical.
    const ease = 1 - (1 - t) * (1 - t) * (1 - t)
    const radius = 6 + ease * 46
    // Alpha peaks just after landing then fades to nothing.
    const fade = (1 - t) * (1 - t)

    for (const pass of [0, 1]) {
      const scale = pass === 0 ? 1 : 0.62
      const alpha = pass === 0 ? 0.85 : 0.4
      ctx.beginPath()
      ctx.ellipse(r.x, r.y, radius * scale, radius * scale * (0.34 + ease * 0.1), 0, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(34, 211, 238, ${fade * alpha})`
      ctx.lineWidth = (pass === 0 ? 2.4 : 1.4) * (1 - t * 0.5)
      ctx.stroke()
    }
    drew = true
  }

  ctx.restore()
  void drew
}

/* -------------------------------------------------------------------------- */
/*  Shared debug primitives                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Draw the allowed bend sector at a joint.
 *
 * Centred on the incoming bone's direction and spanning ±`maxBend`, which is
 * exactly the region the solver's angle constraint permits — so the wedge is a
 * literal picture of the constraint, not a decoration.
 */
function drawAngleCone(
  ctx: CanvasRenderingContext2D,
  prev: Vec2,
  joint: Vec2,
  maxBend: number,
  radius: number,
  fill: string,
): void {
  const base = Math.atan2(joint.y - prev.y, joint.x - prev.x)
  ctx.beginPath()
  ctx.moveTo(joint.x, joint.y)
  ctx.arc(joint.x, joint.y, radius, base - maxBend, base + maxBend)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = 'rgba(167, 139, 250, 0.4)'
  ctx.lineWidth = 1
  ctx.stroke()
}

/** Target reticle. */
function drawBullseye(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, r * 0.35, 0, Math.PI * 2)
  ctx.stroke()
  // Crosshair, with a gap in the middle so the centre stays readable.
  const g = r + 6
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    ctx.beginPath()
    ctx.moveTo(x + dx * r * 0.5, y + dy * r * 0.5)
    ctx.lineTo(x + dx * g, y + dy * g)
    ctx.stroke()
  }
  ctx.restore()
}

/** Velocity vector with an arrowhead. */
function drawVelocityArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  vx: number,
  vy: number,
  color: string,
): void {
  const len = Math.hypot(vx, vy)
  if (len < 1.5) return
  const ex = x + vx
  const ey = y + vy
  const ang = Math.atan2(vy, vx)

  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(ex, ey)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(ex, ey)
  ctx.lineTo(ex - 9 * Math.cos(ang - 0.4), ey - 9 * Math.sin(ang - 0.4))
  ctx.lineTo(ex - 9 * Math.cos(ang + 0.4), ey - 9 * Math.sin(ang + 0.4))
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

export default FabrikCreature
