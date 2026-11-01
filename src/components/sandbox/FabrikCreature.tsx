import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { damp } from '@/lib/math'
import { soundEngine } from '@/utils/soundEngine'
import { useInViewAnimation } from '@/hooks/useInViewAnimation'
import { reportIkSolve } from '@/lib/perfMetrics'
import {
  applyAngleConstraints,
  chainLength,
  createFABRIKResult,
  solveFABRIK,
  type FABRIKResult,
  type IKJoint,
  type Vec2,
} from '@/utils/fabrik'

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
const LASER_RANGE = 1400

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

  // Pre-allocated ripple pool; nothing here allocates at run time.
  const ripples: Ripple[] = []
  for (let i = 0; i < RIPPLE_POOL; i++) {
    ripples.push({ x: 0, y: 0, t: 1, alive: false })
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
  }
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
  let dx = rig.target.x - base.x
  let dy = rig.target.y - base.y
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
  rig.recoilVel.x +=
    (-RECOIL_STIFFNESS * rig.recoil.x - RECOIL_DAMPING * rig.recoilVel.x) * dt
  rig.recoilVel.y +=
    (-RECOIL_STIFFNESS * rig.recoil.y - RECOIL_DAMPING * rig.recoilVel.y) * dt
  rig.recoil.x += rig.recoilVel.x * dt
  rig.recoil.y += rig.recoilVel.y * dt

  /* ── Laser countdown ─────────────────────────────────────────────────── */
  if (rig.laserT < 1) rig.laserT = Math.min(1, rig.laserT + dt / LASER_DURATION)
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

    solveFABRIK(
      leg.joints,
      { x: footX, y: footY },
      leg.lengths,
      0.4,
      { maxBend: LEG_MAX_BEND, maxIterations: 8, result: leg.result },
    )
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
function stanceFor(
  hip: Vec2,
  dirX: number,
  dirY: number,
  side: number,
): { x: number; y: number } {
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

  const accRef = useRef(0)

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
      dpr = Math.min(window.devicePixelRatio || 1, 2)
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
    let last = 0
    let hudTimer = 0

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      // Sleep when off screen; the loop keeps its rAF handle so waking is a
      // single flag flip with no observer round-trip.
      if (!inViewRef.current) return

      const dt = last === 0 ? FIXED : Math.min((now - last) / 1000, 0.1)
      last = now
      accRef.current += dt

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
      while (accRef.current >= FIXED && steps < 4) {
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
        accRef.current -= FIXED
        steps++
      }

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
        style={{ touchAction: 'none', cursor: mode === 'arm' ? 'crosshair' : 'default' }}
        role="application"
        aria-label={
          mode === 'arm'
            ? '六轴机械臂 FABRIK 逆向运动学演示，移动鼠标追踪，点击发射激光'
            : '程序化步态四足生物演示，移动鼠标以转向行为追踪'
        }
      />

      {/* ── Control bar ──────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          {/* Mode switch */}
          <div className="flex overflow-hidden rounded-md border border-void-600/70 bg-void-950/85 backdrop-blur-md">
            {(
              [
                ['arm', '机械臂'],
                ['creature', '四足'],
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
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-void-600/70 bg-void-950/85 px-2.5 py-1.5 backdrop-blur-md">
            <input
              type="checkbox"
              checked={debug.vectors}
              onChange={(e) => setDebug({ vectors: e.target.checked })}
              className="size-3 accent-[#a78bfa]"
            />
            <span className="font-mono text-[0.6rem] tracking-wider text-ink-300 uppercase">
              Show IK Vectors
            </span>
          </label>
        </div>

        {/* Telemetry */}
        <div className="rounded-md border border-void-600/60 bg-void-950/85 px-2.5 py-1.5 backdrop-blur-md">
          <p className="font-mono text-[0.55rem] tracking-[0.22em] text-ink-700 uppercase">
            fabrik solver
          </p>
          <div className="mt-1 flex items-center gap-2 font-mono text-[0.6rem]">
            <span className="text-ink-500">err</span>
            <span
              className={cn(
                'tabular-nums',
                hud.converged ? 'text-signal-teal' : 'text-signal-amber',
              )}
            >
              {hud.error < 0.01 ? hud.error.toExponential(1) : hud.error.toFixed(2)}px
            </span>
            <span className="text-ink-700">·</span>
            <span className="text-ink-500">iter</span>
            <span className="tabular-nums text-ink-300">{hud.iterations}</span>
            {mode === 'arm' && (
              <>
                <span className="text-ink-700">·</span>
                <span className="text-ink-500">shots</span>
                <span className="tabular-nums text-signal-rose">{hud.shots}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center font-mono text-[0.55rem] tracking-[0.2em] text-ink-700 uppercase">
        {mode === 'arm' ? '移动鼠标追踪 · 点击发射激光' : '移动鼠标 · 步态自动规划落脚点'}
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
function drawJoint(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, tint: string): void {
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
/*  Arm rendering                                                            */
/* -------------------------------------------------------------------------- */

function drawArm(ctx: CanvasRenderingContext2D, rig: ArmRig, debug: boolean): void {
  const rx = rig.recoil.x
  const ry = rig.recoil.y
  const tint = '#22d3ee'

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
  }

  /* ── Joints ──────────────────────────────────────────────────────────── */
  for (let i = 0; i < n - 1; i++) {
    const p = rig.joints[i]
    drawJoint(ctx, p.x, p.y, i === 0 ? 11 : 8.5 - i * 0.5, tint)
  }

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

  /* ── Laser pulse ─────────────────────────────────────────────────────── */
  if (rig.laserT < 1 && tip) {
    // Quadratic decay: bright flash, fast fade. Reads as a pulse, not a beam.
    const fade = (1 - rig.laserT) * (1 - rig.laserT)
    const ex = rig.laserX + rig.laserDirX * LASER_RANGE
    const ey = rig.laserY + rig.laserDirY * LASER_RANGE

    ctx.save()
    ctx.lineCap = 'round'
    ctx.globalCompositeOperation = 'lighter'

    // Wide soft glow.
    ctx.globalAlpha = 0.16 * fade
    ctx.strokeStyle = '#22d3ee'
    ctx.lineWidth = 20
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

    // Hot core.
    ctx.globalAlpha = 0.95 * fade
    ctx.lineWidth = 2.2
    ctx.strokeStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(rig.laserX, rig.laserY)
    ctx.lineTo(ex, ey)
    ctx.stroke()

    // Muzzle flash.
    const flash = ctx.createRadialGradient(rig.laserX, rig.laserY, 0, rig.laserX, rig.laserY, 46)
    flash.addColorStop(0, `rgba(255, 255, 255, ${0.85 * fade})`)
    flash.addColorStop(0.35, `rgba(34, 211, 238, ${0.5 * fade})`)
    flash.addColorStop(1, 'rgba(34, 211, 238, 0)')
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(rig.laserX, rig.laserY, 46, 0, Math.PI * 2)
    ctx.fillStyle = flash
    ctx.fill()

    ctx.restore()
  }

  ctx.restore()

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

function drawCreature(
  ctx: CanvasRenderingContext2D,
  rig: CreatureRig,
  debug: boolean,
): void {
  const tint = '#a78bfa'

  /* ── Landing ripples, on the ground under everything else ────────────── */
  drawRipples(ctx, rig)

  /* ── Legs first, so the body overlaps them ───────────────────────────── */
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
    drawBoneMetal(ctx, knee.x, knee.y, foot.x, foot.y, 4.6, 2.6, tint)
    drawJoint(ctx, knee.x, knee.y, 4.4, tint)
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
      ctx.ellipse(
        r.x,
        r.y,
        radius * scale,
        radius * scale * (0.34 + ease * 0.1),
        0,
        0,
        Math.PI * 2,
      )
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
