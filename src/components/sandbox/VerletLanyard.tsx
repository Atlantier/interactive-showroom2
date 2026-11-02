import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { announce } from '@/lib/announce'
import { soundEngine } from '@/utils/soundEngine'
import {
  BREAK_STRAIN,
  FIXED_DT,
  RELAXATION_ITERATIONS,
  LanyardSimulation,
  bezierPathLength,
  catmullRomToBezier,
  sampleBezier,
  traceBezierPath,
  type LanyardSpec,
  type LanyardState,
  type Obb,
  type ObbHit,
  type TagState,
} from '@/utils/mathPhysics'
import {
  VfxParticleEngine,
  drawIllumination,
  drawRadialFlash,
  fractalLightning,
  strokePolyline,
  type VfxBounds,
  type VfxBurstOptions,
  type VfxIllumination,
  type VfxSpawnOptions,
} from '@/utils/vfxParticleEngine'
import { useInViewAnimation } from '@/hooks/useInViewAnimation'
import { reportPhysicsSolve } from '@/lib/perfMetrics'
import { GRAVITY_SCALE, useAppStore } from '@/store/useAppStore'
import { useI18n } from '@/i18n/useI18n'

import { isScrollBusy } from '@/lib/scrollEngine'
import { createFixedStepClock, type FixedStepClock } from '@/lib/fixedStep'
/**
 * VerletLanyard — an interactive physics sandbox of hanging geek badges.
 *
 * ── Simulation vs rendering ───────────────────────────────────────────────
 * The solver owns all state in plain mutable objects (`LanyardSimulation`). This
 * component only reads that state each frame and draws it to a 2D canvas. Canvas
 * rather than DOM/SVG because a rope is 12 polylines plus 4 rotated rounded
 * rects with gradients — at 60fps that is thousands of style mutations for SVG,
 * versus a few dozen canvas calls.
 *
 * ── Fixed timestep with accumulator ───────────────────────────────────────
 * The simulation runs at a fixed 60Hz regardless of display refresh. A variable
 * step would make the rope's behaviour depend on the monitor, and at 30fps a
 * large step makes a Verlet rope explode or go limp. The accumulator carries the
 * remainder, and a frame is capped so a backgrounded tab cannot spiral.
 *
 * ── Why the RAF is local ──────────────────────────────────────────────────
 * This is a self-contained toy, not part of the page's scroll narrative, so it
 * runs its own loop. It is also gated by an IntersectionObserver: an offscreen
 * sandbox costs zero.
 */

/** The four badges, per the spec. */
const LANYARD_SPECS: LanyardSpec[] = [
  { id: 'ai', label: 'AI Architecture', accent: '#22d3ee', anchorXRatio: 0.14 },
  { id: 'rust', label: 'Rust & Systems', accent: '#fb923c', anchorXRatio: 0.38 },
  { id: 'webgl', label: 'WebGL Shaders', accent: '#a78bfa', anchorXRatio: 0.62 },
  { id: 'cloud', label: 'Distributed Cloud', accent: '#5eead4', anchorXRatio: 0.86 },
]

/** Max simulation steps per frame (protects against tab-switch catch-up). */
const MAX_STEPS_PER_FRAME = 4

/** Pixels the held badge travels per arrow-key press; Shift multiplies it. */
const KEY_STEP = 14
const KEY_STEP_COARSE = 56

/**
 * Hold a point inside the canvas by half a badge on each side.
 *
 * The tag eases toward the drag target and nothing else bounds it, so a target past
 * the edge used to carry the badge outside the sandbox entirely -- the canvas clips
 * it mid-drag and it can be left stranded out there on release, with only the rope
 * still attached. Clamping the TARGET rather than the tag keeps the physics honest:
 * the rope constraint still resolves normally, the badge simply cannot be dragged
 * somewhere it cannot be seen.
 *
 * Shared by the pointer path and the keyboard path so both obey one rule; the two
 * drifting apart is how a keyboard user ends up able to lose a badge off-screen.
 */
function clampBadgePoint(
  canvas: HTMLCanvasElement,
  sim: LanyardSimulation,
  x: number,
  y: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  let halfW = 0
  let halfH = 0
  for (const l of sim.lanyards) {
    halfW = Math.max(halfW, l.tag.width / 2)
    halfH = Math.max(halfH, l.tag.height / 2)
  }
  // A canvas smaller than one badge cannot satisfy both bounds; fall back to
  // the free position rather than producing an inverted range.
  if (rect.width <= halfW * 2 || rect.height <= halfH * 2) return { x, y }

  return {
    x: Math.min(Math.max(x, halfW), rect.width - halfW),
    y: Math.min(Math.max(y, halfH), rect.height - halfH),
  }
}

/* -------------------------------------------------------------------------- */
/*  VFX layer — tuning, module-level scratch, snap-effect pool                 */
/* -------------------------------------------------------------------------- */

/**
 * The spark layer for the lanyard sandbox.
 *
 * ── Why almost nothing here allocates ─────────────────────────────────────
 * `engine.burst()` and `engine.spawn()` take an options object. Building that
 * object at the call site would allocate on every collision — a GC pause at
 * exactly the moment the scene is busiest. The option records below are written
 * once at module load and mutated in place; a frame only writes numbers into
 * them. The one deliberate exception is the snap bolt, whose `fractalLightning`
 * polyline has to be built once per break (see `SnapArc`).
 *
 * ── Why the engine is stepped here and nowhere else ───────────────────────
 * `VfxParticleEngine` owns no clock and never calls `requestAnimationFrame`. The
 * sandbox already has exactly one gated loop; the engine is advanced from inside
 * it, so the single-animation-loop rule stays intact.
 */

/** Pool size for the shared particle engine. */
const VFX_PARTICLE_CAPACITY = 512

/**
 * Impact-speed range mapped onto the 15–40 spark count, in px/s.
 *
 * 110 px/s is about the slowest contact that still reads as a hit rather than two
 * badges resting against each other; 950 is a hard drag slam. Speed and count are
 * both linearly ramped across this band.
 */
const IMPACT_MIN_SPEED = 110
const IMPACT_MAX_SPEED = 950

/** Minimum gap between two bursts for the same contact, in seconds. */
const IMPACT_SPARK_COOLDOWN = 0.09
const WALL_SPARK_COOLDOWN = 0.12

/** The lightning arc and its flash live this long. */
const SNAP_ARC_LIFE = 0.25
/** Stray sparks keep dribbling from the break for this long. */
const SNAP_STRAY_LIFE = 1
/** One arc slot per lanyard: a full four-lanyard break must fit in the pool. */
const SNAP_ARC_POOL = 4

/** Collision sparks: velocity-stretched streaks that bounce and split. */
const COLLISION_SPARK_OPTIONS: VfxBurstOptions = {
  count: 15,
  x: 0,
  y: 0,
  speedMin: 40,
  speedMax: 420,
  lifeMin: 0.22,
  lifeMax: 0.62,
  sizeMin: 0.8,
  sizeMax: 2,
  color: [255, 210, 132],
  gravity: 900,
  drag: 0.7,
  restitution: 0.6,
  bounce: true,
  stretch: 0.022,
  splits: 1,
}

/** The pop at the instant the cord tears. Colour is overwritten per lanyard. */
const SNAP_BURST_OPTIONS: VfxBurstOptions = {
  count: 18,
  x: 0,
  y: 0,
  speedMin: 80,
  speedMax: 340,
  lifeMin: 0.24,
  lifeMax: 0.7,
  sizeMin: 0.7,
  sizeMax: 1.7,
  color: [34, 211, 238],
  gravity: 620,
  drag: 0.55,
  restitution: 0.6,
  bounce: true,
  stretch: 0.018,
  splits: 1,
}

/** The fading after-dribble from a break: a handful of sparks per second. */
const STRAY_SPARK_OPTIONS: VfxSpawnOptions = {
  x: 0,
  y: 0,
  speedMin: 40,
  speedMax: 150,
  lifeMin: 0.2,
  lifeMax: 0.65,
  sizeMin: 0.6,
  sizeMax: 1.5,
  color: [34, 211, 238],
  gravity: 820,
  drag: 0.5,
  restitution: 0.6,
  bounce: true,
  stretch: 0.014,
  splits: 0,
}

/** Reused bounds record: `engine.step` reads it, the frame loop refills it. */
const VFX_BOUNDS: VfxBounds = { left: 0, right: 0, bottom: 0 }

/**
 * Module-level illumination record.
 *
 * Written and read every frame, so it must not be an object literal in the loop.
 * One record is enough even if two sandboxes are mounted: each computes and
 * consumes it inside its own frame, synchronously.
 */
const ILLUMINATION: VfxIllumination = { x: 0, y: 0, intensity: 0 }

/** Cool white-blue light the spark clouds cast on the scene. */
const VFX_LIGHT_RGB: [number, number, number] = [150, 235, 255]

/** Radii of the two illumination passes; see `drawSandbox`. */
const AMBIENT_LIGHT_RADIUS = 280
const BADGE_LIGHT_RADIUS = 130

/** Scratch OBBs / hit for the contact test (allocated once, mutated per pair). */
const VFX_OBB_A: Obb = { cx: 0, cy: 0, hw: 0, hh: 0, angle: 0 }
const VFX_OBB_B: Obb = { cx: 0, cy: 0, hw: 0, hh: 0, angle: 0 }
const VFX_HIT: ObbHit = { hit: false, nx: 0, ny: 0, depth: 0 }
/** Scratch colour tuple for the break flash, so it is never an array literal. */
const SNAP_FLASH_RGB: [number, number, number] = [0, 0, 0]
const SNAP_CORE_STYLE = 'rgba(244, 252, 255, 0.92)'

/* ── Fibre-optic pulse tuning ────────────────────────────────────────────── */
/** Seconds for one photon to travel the whole cord. */
const PULSE_CYCLE = 2.8
/** Half-width of the travelling light band, as a fraction of the cord. */
const PULSE_BAND = 0.16
/** Constant style strings: assigning these per segment allocates nothing. */
const PULSE_GLOW_STYLE = '#22d3ee'
const PULSE_CORE_STYLE = '#e8feff'

/**
 * Resolve each lanyard's accent to channel numbers ONCE.
 *
 * `l.accent` is a CSS string, but `drawRadialFlash` and the engine's colour field
 * need `[r, g, b]`. Parsing the hex on every break would be waste, so the table is
 * built at module load and indexed by lanyard position.
 */
const ACCENT_RGB: [number, number, number][] = LANYARD_SPECS.map((spec) =>
  hexToRgb(spec.accent),
)

/* ── Reused draw-path scratch (module scope: zero per-frame garbage) ──────── */
/** Fit points for the current cord; grown once, then reused. */
const ropeFitScratch: Array<{ x: number; y: number }> = []
/** Bezier samples for the weave marks: position plus the two tangent taps. */
const bezierP = { x: 0, y: 0 }
const bezierQ = { x: 0, y: 0 }
const bezierR = { x: 0, y: 0 }

/** `#rrggbb` → `[r, g, b]`. Module-load only. */
function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * One live break effect.
 *
 * The polylines are generated once when the rope snaps — `fractalLightning`
 * allocates a fresh array — and only re-stroked while the arc decays. Rebuilding
 * the bolt every frame would put an allocation burst inside the render loop for
 * the 250 ms the arc is alive; a cached zig-zag with a flickering alpha reads just
 * as electrical, and the flash is what the eye actually tracks.
 */
interface SnapArc {
  active: boolean
  /** Break node, in sandbox pixels. */
  x: number
  y: number
  /** Seconds since the break; the arc and flash use its first 0.25 s. */
  age: number
  /** Seconds of after-dribble, which outlives the arc itself. */
  strayAge: number
  /** Fractional spark owed by the dribble, drained one whole spark at a time. */
  spawnAccumulator: number
  /** Accent channels of the lanyard that broke. */
  r: number
  g: number
  b: number
  /** Cached fractal bolt plus two branches. */
  bolt: number[]
  branchA: number[]
  branchB: number[]
  /** `rgba(...)` string built once at break time, not per frame. */
  glowStyle: string
}

/**
 * Per-instance state for the vfx layer.
 *
 * Off module scope (except `ILLUMINATION`, which the brief pins there) so two
 * mounted sandboxes can never draw each other's sparks. Created once per effect.
 */
interface LanyardVfx {
  engine: VfxParticleEngine
  snaps: SnapArc[]
  snapCursor: number
  /**
   * Tag velocities as of the END of the previous substep.
   *
   * That is the pre-impact state for the next substep: by the time a contact is
   * visible in the post-step pose, the solver has already reversed the relative
   * velocity, so the impulse has to be measured against these instead.
   */
  prevVx: number[]
  prevVy: number[]
  /** Broken flag as of the previous substep, so the break edge is detectable. */
  wasBroken: boolean[]
  /** Per-pair and per-lanyard spark cooldowns, in seconds. */
  pairCooldown: number[]
  wallCooldown: number[]
}

export function VerletLanyard({ className }: { className?: string }) {
  const { t } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const simRef = useRef<LanyardSimulation | null>(null)
  /** Live vfx bundle, so "Re-forge" can retire sparks along with the ropes. */
  const vfxRef = useRef<LanyardVfx | null>(null)

  /** Elapsed simulation time, for the wind field. */
  const timeRef = useRef(0)
  /** Accumulator for the fixed-timestep loop. */
  /*
   * Fixed-step clock, shared with the FABRIK sandbox.
   *
   * This file used to own a `lastTime`, a delta clamp, an accumulator, a step budget
   * and a debt cap inline -- and so did the other sandbox, which is how the same three
   * bugs ended up existing twice. The clock is created lazily so a re-render does not
   * allocate a new one and silently reset the accumulator.
   */
  const clockRef = useRef<FixedStepClock | null>(null)
  if (!clockRef.current) {
    clockRef.current = createFixedStepClock({ fixedDt: FIXED_DT, maxSteps: MAX_STEPS_PER_FRAME })
  }
  const clock = clockRef.current
  /** Whether the sandbox is on screen. */
  /**
   * Viewport gating.
   *
   * The loop below reads `inViewRef.current` at the top of every frame and
   * returns early when the sandbox is off screen, so a scrolled-away sandbox
   * costs one function call per frame instead of ~4 physics steps, a full canvas
   * repaint, and (on a 4K panel) a large fill.
   */
  const inViewRef = useInViewAnimation(wrapRef, { rootMargin: '25% 0px 25% 0px' })

  /**
   * Gravity preset, driven by the command palette.
   *
   * Applied through a setter on the simulation rather than by rebuilding it:
   * the bodies keep their positions and velocities, so switching to zero-g makes
   * the rope drift from wherever it currently hangs instead of teleporting. That
   * continuity is what makes the switch read as a change in physics rather than
   * a re-mount.
   */
  const gravityMode = useAppStore((state) => state.gravityMode)

  useEffect(() => {
    // The simulation is created lazily by the first resize; when this runs first,
    // the creation path in `applySize` seeds the scale from the store instead.
    simRef.current?.setGravityScale(GRAVITY_SCALE[gravityMode])
  }, [gravityMode])

  /** HUD state: how many lanyards have snapped. */
  const [brokenCount, setBrokenCount] = useState(0)
  /** HUD state: peak strain of the most stressed rope, for the readout. */
  const [peakStrain, setPeakStrain] = useState(0)

  /* ── Simulation + render loop ─────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    /* ── VFX state ──────────────────────────────────────────────────────── */
    // One engine per mounted sandbox. The pool is a few hundred mutable slots;
    // sharing it between instances would leak sparks across canvases, and
    // recreating it on resize would allocate at the worst possible moment.
    const vfx = createLanyardVfx(LANYARD_SPECS.length)
    vfxRef.current = vfx

    /* ── Size management ────────────────────────────────────────────────── */
    let cssW = 0
    let cssH = 0
    let dpr = 1

    const applySize = (): void => {
      const rect = wrap.getBoundingClientRect()
      cssW = Math.max(1, Math.round(rect.width))
      cssH = Math.max(1, Math.round(rect.height))
      // 1.5 rather than 2: this canvas is pure additive glow on a near-black
    // ground, where the extra density of a 2x buffer is invisible, but the
    // per-frame fill cost is 44% higher.
    dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`

      if (!simRef.current) {
        simRef.current = new LanyardSimulation({
          width: cssW,
          height: cssH,
          specs: LANYARD_SPECS,
        })
        // Seed from the live store rather than the prop captured when this
        // effect was created: the simulation is built lazily on the first
        // resize, which can happen after the visitor has already switched
        // gravity from the palette.
        simRef.current.setGravityScale(
          GRAVITY_SCALE[useAppStore.getState().gravityMode],
        )
      } else {
        simRef.current.resize(cssW, cssH)
      }

      // Dev-only inspection handle. The simulation state is private, and driving
      // it from a test through synthetic pointer coordinates turned out to be
      // unreliable — the canvas' document position shifts with the page layout,
      // so events aimed "at the badge" were landing outside it. Exposing the
      // solver lets verification assert on real physics state instead of pixels.
      if (import.meta.env.DEV) {
        // The vfx bundle rides along: sparks and break arcs live in a pool with
        // no DOM trace, so a pixel assertion cannot tell a working burst from a
        // decorative gradient. `engine.alive` and the illumination record are what
        // prove the burst actually fired.
        const debugWindow = window as unknown as {
          __lanyardSim?: unknown
          __lanyardVfx?: unknown
        }
        debugWindow.__lanyardSim = simRef.current
        debugWindow.__lanyardVfx = vfx
      }
    }

    applySize()

    const resizeObserver = new ResizeObserver(applySize)
    resizeObserver.observe(wrap)

    /* ── Own the RAF, gated on visibility ───────────────────────────────── */
    let rafId = 0
    let hudTimer = 0

    const frame = (now: number): void => {
      rafId = requestAnimationFrame(frame)
      // Sleep when off screen. The loop still schedules itself (so waking is
      // instant and needs no observer callback), but does no work at all.
      if (!inViewRef.current) {
        // Rebase: without it the first frame back replays the whole absence as a hop.
        clock.skip(now)
        return
      }
      /*
       * Scroll-busy gate.
       *
       * The solver, the ribbon solver pass and the additive glow compositing all
       * run every frame for a scene the visitor is currently scrolling past. A/B
       * measurement with both sandboxes unmounted moved a full-page scroll from
       * 121 to 144 fps and halved p99, so this loop is the single most expensive
       * thing on the page. Freezing it while the scroll is in flight costs nothing
       * perceptible -- the canvas keeps its last frame -- and hands that time back
       * to the frames that are being composited.
       */
      if (isScrollBusy()) {
        clock.skip(now)
        return
      }

      const sim = simRef.current
      if (!sim) return

      // The clock clamps the delta too: after a tab switch `now - lastTime` can be
      // huge, and feeding that in would run the whole step budget at once.
      const dt = clock.begin(now)

      let steps = 0
      /**
       * Audio is triggered once per FRAME, not once per physics step.
       *
       * The accumulator can run up to four 60 Hz steps inside a single frame, and
       * firing a collision voice for each would stack four near-identical
       * transients 16 ms apart — audible as a flam. Collecting the loudest impact
       * and the snap count across the substeps and playing them once keeps the
       * sound tied to what the frame actually looked like.
       */
      let loudestImpact = 0
      let snappedThisFrame = 0

      /**
       * Time the constraint solve.
       *
       * Measured around the whole substep batch rather than per step so the
       * number reflects what this frame actually cost. `performance.now()` is
       * called twice per frame — negligible next to the solve itself, and it is
       * the only way to answer "is the solver affordable?" with a real figure
       * instead of a guess.
       */
      const solveStart = performance.now()

      while (clock.pending()) {
        timeRef.current += FIXED_DT
        sim.step(FIXED_DT, timeRef.current)

        /*
         * Turn this substep's solver output into sparks and break effects.
         *
         * Done HERE, inside the fixed-step loop, for two reasons: the solver
         * only partly separates overlapping badges (72% of the penetration per
         * step), so the remaining sliver is what the contact test can still see;
         * and the solver reports impact SPEED for audio but never the contact
         * POINT, which has to be read from the pose before the next step moves it.
         */
        captureImpactEvents(vfx, sim)

        const impacts = sim.impactCount
        for (let i = 0; i < impacts; i++) {
          const v = sim.getImpactSpeed(i)
          if (v > loudestImpact) loudestImpact = v
        }
        snappedThisFrame += sim.snapCount

        clock.consume()
        steps++
      }

      /*
       * Cap the accumulated debt.
       *
       * The loop spends at most MAX_STEPS_PER_FRAME steps per frame but the
       * accumulator keeps whatever it could not spend. Below roughly 15 fps that
       * leftover grows without bound, so the simulation's time falls permanently
       * behind wall-clock time and never catches up -- the ropes look like they are
       * moving in slow motion, and the gap widens for the rest of the session.
       * Clamping to one frame's worth of steps makes the sim fall behind under load
       * and then keep the correct RATE, which is the behaviour you want from a
       * fixed-step integrator.
       */
      clock.end()

      if (steps > 0) {
        reportPhysicsSolve(
          performance.now() - solveStart,
          steps * RELAXATION_ITERATIONS * (sim.lanyards.length * 11),
        )
      }

      if (loudestImpact > 0) soundEngine.playPhysicsCollision(loudestImpact)
      // Any number of simultaneous snaps is one break event to the ear.
      if (snappedThisFrame > 0) soundEngine.playRopeSnap()

      /*
       * Advance the vfx layer by the PHYSICS time this frame consumed, not by
       * the raw wall-clock delta: the accumulator usually carries a remainder,
       * and ageing sparks by `dt` while the rope only advanced `steps * FIXED_DT`
       * would make them drift ahead of the motion they belong to.
       */
      const vfxDt = steps > 0 ? steps * FIXED_DT : dt
      updateVfx(vfx, vfxDt, cssW, cssH)

      // Draw once per animation frame, not once per physics step.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      drawSandbox(ctx, sim, cssW, cssH, renderTime(timeRef.current), vfx, clock.alpha())

      // Push HUD numbers ~6×/s rather than every frame: this is a readout, and
      // re-rendering React at 60fps for it would defeat the point of the canvas.
      hudTimer += dt
      if (hudTimer > 0.16) {
        hudTimer = 0
        let maxStrain = 0
        for (const l of sim.lanyards) {
          if (!l.broken && l.peakStrain > maxStrain) maxStrain = l.peakStrain
        }
        setPeakStrain(maxStrain)
        setBrokenCount(sim.brokenCount)
      }
    }

    rafId = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      // Retire the pool with the canvas. A dead sandbox must not keep a few
      // hundred live spark records (or an in-flight break arc) referenced by the
      // bundle it just dropped.
      resetLanyardVfx(vfx)
      if (vfxRef.current === vfx) vfxRef.current = null
    }
  }, [inViewRef])

  /* ── Pointer interaction ──────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    /**
     * Convert a pointer event to sandbox-local pixels.
     *
     * With `clampToTag`, the result is held inside the canvas by half a badge on
     * each side. This is the drag bug fix: the tag eases toward this point and
     * nothing else bounds it, so dragging past the edge used to carry the badge
     * outside the sandbox entirely -- the canvas clips it mid-drag and it can be
     * left stranded out there on release, with only the rope still attached.
     *
     * Clamping the TARGET rather than the tag keeps the physics honest: the rope
     * constraint still resolves normally, the badge simply cannot be dragged
     * somewhere it cannot be seen.
     */
    const localPoint = (e: PointerEvent, clampToTag = false): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (!clampToTag) return { x, y }
      const sim = simRef.current
      return sim ? clampBadgePoint(canvas, sim, x, y) : { x, y }
    }

    const onDown = (e: PointerEvent): void => {
      const sim = simRef.current
      if (!sim) return
      const { x, y } = localPoint(e)
      if (sim.pointerDown(x, y)) {
        // Capture so a fast drag outside the canvas keeps tracking.
        canvas.setPointerCapture(e.pointerId)
        e.preventDefault()
      }
    }

    const onMove = (e: PointerEvent): void => {
      const sim = simRef.current
      if (!sim || !sim.isDragging) return
      const { x, y } = localPoint(e, true)
      sim.pointerMove(x, y)
      e.preventDefault()
    }

    const onUp = (e: PointerEvent): void => {
      const sim = simRef.current
      if (!sim) return
      sim.pointerUp()
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId)
      }
    }

    /**
     * Belt-and-braces touch guard.
     *
     * `touch-action: none` on the canvas is the primary defence and is what
     * actually stops the compositor from claiming the pan. This listener exists
     * for the engines that ignore it mid-gesture — notably older iOS Safari,
     * where a drag started inside a `none` region can still begin a rubber-band
     * scroll and swipe the whole page sideways.
     *
     * It only calls `preventDefault` while a badge is actually held, so simply
     * resting a finger on the sandbox does not fight the browser for nothing.
     * Registered with `passive: false` because a passive listener's
     * `preventDefault` is silently ignored — the trap that makes this pattern
     * look correct while doing nothing.
     */
    const onTouchMove = (e: TouchEvent): void => {
      const sim = simRef.current
      if (!sim || !sim.isDragging) return
      if (e.cancelable) e.preventDefault()
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })

    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  /* ── Keyboard interaction (PB-05) ─────────────────────────────────────── */
  /**
   * The sandbox was pointer-only: a keyboard or switch user could focus the card
   * and reach the buttons, but could not touch the toy itself.
   *
   * Keyboard parity is a grab/release model rather than a synthetic pointer, because
   * the simulation only has one gesture (`pointerDown` / `pointerMove` / `pointerUp`)
   * and driving that same path is the only way to be sure the two input methods
   * cannot diverge.
   *
   *   Enter / Space   grab the nearest badge, or let go of the held one
   *   Arrow keys      swing the held badge (Shift = 4× step)
   *   Escape          let go
   *
   * Arrows are only swallowed while a badge is held. This canvas is ~52vh tall, so
   * eating the page's arrow-key scrolling just because the sandbox has focus would
   * re-create, for keyboard users, the scroll trap that `touch-action: pan-y` fixed
   * for phones.
   */
  const keyboardHand = useRef({ x: 0, y: 0 })

  /** Grab the badge closest to the invisible keyboard hand. */
  const grabNearestBadge = (): boolean => {
    const sim = simRef.current
    const canvas = canvasRef.current
    if (!sim || !canvas || sim.lanyards.length === 0) return false

    const hand = keyboardHand.current
    // Start from the middle of the sandbox the first time; afterwards continue from
    // wherever the last release left off, so a second grab is not a jump back.
    if (hand.x === 0 && hand.y === 0) {
      const rect = canvas.getBoundingClientRect()
      hand.x = rect.width / 2
      hand.y = rect.height / 2
    }

    let best: LanyardState | null = null
    let bestDist = Infinity
    for (const l of sim.lanyards) {
      // A snapped rope has no tag to hold; aim at a live one instead of a corpse.
      if (l.broken) continue
      const dx = l.tag.x - hand.x
      const dy = l.tag.y - hand.y
      const d = dx * dx + dy * dy
      if (d < bestDist) {
        bestDist = d
        best = l
      }
    }
    if (!best) return false

    // Grab at the tag's own centre: `pointerDown` hit-tests, and a stale hand
    // position is exactly the case where the hit test would miss.
    if (!sim.pointerDown(best.tag.x, best.tag.y)) return false
    hand.x = best.tag.x
    hand.y = best.tag.y
    return true
  }

  const onCanvasKeyDown = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    const sim = simRef.current
    const canvas = canvasRef.current
    if (!sim || !canvas) return

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (sim.isDragging) {
        sim.pointerUp()
        announce(t.sandbox.kbdRelease)
      } else if (grabNearestBadge()) {
        announce(t.sandbox.kbdGrab)
      }
      return
    }

    if (e.key === 'Escape') {
      if (!sim.isDragging) return
      e.preventDefault()
      sim.pointerUp()
      announce(t.sandbox.kbdRelease)
      return
    }

    const step = e.shiftKey ? KEY_STEP_COARSE : KEY_STEP
    let dx = 0
    let dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = -step
    else if (e.key === 'ArrowDown') dy = step
    else return

    if (!sim.isDragging) return
    e.preventDefault()
    const hand = keyboardHand.current
    const next = clampBadgePoint(canvas, sim, hand.x + dx, hand.y + dy)
    hand.x = next.x
    hand.y = next.y
    sim.pointerMove(hand.x, hand.y)
  }

  /* ── Re-forge ─────────────────────────────────────────────────────────── */
  const reforge = (): void => {
    const sim = simRef.current
    if (!sim) return
    sim.reforge(LANYARD_SPECS)
    // The sparks and arcs belonged to the ropes that just got replaced, so a
    // re-forge clears them too; otherwise lightning would hang over fresh cord.
    const vfx = vfxRef.current
    if (vfx) resetLanyardVfx(vfx)
    timeRef.current = 0
    clock.reset(performance.now())
    setBrokenCount(0)
    setPeakStrain(0)
  }

  const strainRatio = Math.min(1, peakStrain / BREAK_STRAIN)

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative overflow-hidden rounded-panel border border-void-600/70 bg-void-950/55',
        className,
      )}
    >
      {/* Ambient backdrop so the rope reads against something. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_0%,rgba(34,211,238,0.10),transparent_70%)]"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 grid-backdrop opacity-30" />

      <canvas
        ref={canvasRef}
        className="drag-surface relative block h-full w-full select-none"
        // `drag-surface` scopes `touch-action: none` (plus the iOS callout and
        // tap-highlight resets) to exactly the element the drag happens on, so
        // the surrounding card still scrolls the page normally.
        /*
     * `pan-y`, not `none`.
     *
     * `none` was chosen so a drag can never be stolen by the browser, and it works --
     * but this canvas is ~52vh tall, so on a phone a finger that lands anywhere on it
     * could not scroll the page at all. The sandbox became a scroll trap in the middle
     * of a scrolling narrative.
     *
     * `pan-y` keeps vertical page scrolling while still giving us horizontal gestures,
     * which is the trade the review asks for: horizontal drags move badges, vertical
     * swipes scroll. Vertical badge dragging is now a mouse/pen gesture.
     */
    style={{ touchAction: 'pan-y' }}
        role="application"
        // `tabIndex=0` is what makes the toy reachable at all (PB-05); the global
        // `:focus-visible` rule in index.css supplies the ring, which SVG `<g>` could
        // not do (see UI-10) but a canvas can.
        tabIndex={0}
        aria-label={t.sandbox.verletAria}
        aria-describedby="sandbox-verlet-keys"
        onKeyDown={onCanvasKeyDown}
      />
      {/* Instructions live here rather than in the accessible name: a name that reads
          out four key bindings stops being a name. */}
      <p id="sandbox-verlet-keys" className="sr-only">
        {t.sandbox.verletKeys}
      </p>

      {/* ── HUD ─────────────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="rounded-md border border-void-600/60 bg-void-950/92 px-2.5 py-1.5">
          <p className="font-mono text-[0.55rem] tracking-[0.22em] text-ink-700 uppercase">
            {t.sandbox.verletLabel}
          </p>
          <div className="mt-1 flex items-center gap-2 font-mono text-[0.6rem]">
            <span className="text-ink-500">{t.sandbox.verletStrain}</span>
            <span
              className={cn(
                'tabular-nums',
                strainRatio > 0.66
                  ? 'text-signal-rose'
                  : strainRatio > 0.33
                    ? 'text-signal-amber'
                    : 'text-signal-teal',
              )}
            >
              {peakStrain.toFixed(2)}×
            </span>
            <span className="text-ink-700">/ {BREAK_STRAIN}×</span>
          </div>
          {/* Strain meter */}
          <div className="mt-1.5 h-0.5 w-24 overflow-hidden rounded-full bg-void-700">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-100',
                strainRatio > 0.66
                  ? 'bg-signal-rose'
                  : strainRatio > 0.33
                    ? 'bg-signal-amber'
                    : 'bg-signal-teal',
              )}
              style={{ width: `${strainRatio * 100}%` }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={reforge}
          className={cn(
            'pointer-events-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1.5',
            'font-mono text-[0.6rem] tracking-wider uppercase transition-colors',
            brokenCount > 0
              ? 'border-signal-cyan/70 bg-signal-cyan/15 text-signal-cyan hover:bg-signal-cyan/25'
              : 'border-void-600/70 bg-void-950/80 text-ink-500 hover:border-void-500 hover:text-ink-300',
          )}
        >
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
            <path
              d="M6 1.5A4.5 4.5 0 1 0 10.4 4M10.5 1v3.2H7.3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t.sandbox.verletReset}
          {brokenCount > 0 && (
            <span className="rounded bg-signal-rose/20 px-1 text-signal-rose">
              {brokenCount}
            </span>
          )}
        </button>
      </div>

      {/* Hint, fades out is not needed — it stays subtle. */}
      <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center font-mono text-[0.55rem] tracking-[0.2em] text-ink-700 uppercase">
        {t.sandbox.verletHint}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  VFX layer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the per-mount vfx state.
 *
 * Called once from the effect, not per frame. The arrays are sized from the
 * lanyard count so the contact and cooldown passes can index into them directly
 * instead of using maps or lookups.
 */
function createLanyardVfx(lanyardCount: number): LanyardVfx {
  const snaps: SnapArc[] = []
  for (let i = 0; i < SNAP_ARC_POOL; i++) {
    snaps.push({
      active: false,
      x: 0,
      y: 0,
      age: 0,
      strayAge: 0,
      spawnAccumulator: 0,
      r: 255,
      g: 255,
      b: 255,
      bolt: [],
      branchA: [],
      branchB: [],
      glowStyle: 'rgba(255, 255, 255, 0.6)',
    })
  }

  return {
    engine: new VfxParticleEngine(VFX_PARTICLE_CAPACITY),
    snaps,
    snapCursor: 0,
    prevVx: new Array<number>(lanyardCount).fill(0),
    prevVy: new Array<number>(lanyardCount).fill(0),
    wasBroken: new Array<boolean>(lanyardCount).fill(false),
    pairCooldown: new Array<number>(lanyardCount * lanyardCount).fill(0),
    wallCooldown: new Array<number>(lanyardCount).fill(0),
  }
}

/**
 * Retire every effect at once: unmount and "Re-forge Lanyards".
 *
 * `engine.clear()` deactivates every pooled particle without freeing the pool;
 * the snap slots are marked inactive so the next break reuses them. The
 * illumination record is zeroed too, or one frame of stale light would flash at
 * the last collision's position after a reset.
 */
function resetLanyardVfx(vfx: LanyardVfx): void {
  vfx.engine.clear()
  for (let i = 0; i < vfx.snaps.length; i++) vfx.snaps[i].active = false
  vfx.snapCursor = 0
  for (let i = 0; i < vfx.prevVx.length; i++) {
    vfx.prevVx[i] = 0
    vfx.prevVy[i] = 0
    vfx.wasBroken[i] = false
    vfx.wallCooldown[i] = 0
  }
  for (let i = 0; i < vfx.pairCooldown.length; i++) vfx.pairCooldown[i] = 0
  ILLUMINATION.intensity = 0
}

/**
 * Scalar separating-axis test, used only to locate contacts for sparks.
 *
 * ── Why this duplicates `collideObb` ──────────────────────────────────────
 * The solver's version is the source of truth and is used for the real
 * resolution, but it allocates its eight axis components into an array on every
 * call. That is fine for a handful of pairs inside a physics step, and not fine
 * for the render loop's no-allocation rule, so this is the same four-axis test
 * with the axes kept in locals and the result written into a caller-owned record.
 * The maths is deliberately identical, normal direction included, so the two
 * agree about which way the badges hit.
 */
function overlapObb(a: Obb, b: Obb, out: ObbHit): ObbHit {
  const ca = Math.cos(a.angle)
  const sa = Math.sin(a.angle)
  const cb = Math.cos(b.angle)
  const sb = Math.sin(b.angle)
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy

  let minOverlap = Number.POSITIVE_INFINITY
  let nx = 0
  let ny = 0

  for (let k = 0; k < 4; k++) {
    let ax: number
    let ay: number
    if (k === 0) {
      ax = ca
      ay = sa
    } else if (k === 1) {
      ax = -sa
      ay = ca
    } else if (k === 2) {
      ax = cb
      ay = sb
    } else {
      ax = -sb
      ay = cb
    }

    // Projected radii of both boxes on this axis.
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

/**
 * Throw the collision burst.
 *
 * Count and speed are both driven by the measured impulse, across the 15–40
 * spark band: a nudge pops, a slam explodes. The spark options themselves carry
 * `stretch` (velocity-stretched streaks), `bounce`, `restitution` 0.6 and
 * `splits` 1, so floor hits throw secondary sparks — that cascade is what sells
 * the impact as energy rather than as decoration.
 */
function emitImpactSparks(
  engine: VfxParticleEngine,
  x: number,
  y: number,
  impulse: number,
): void {
  // Above the calibration ceiling the burst is already at maximum; clamping the
  // speed too stops a very fast drag from throwing sparks clear off the canvas.
  const speed = Math.min(impulse, IMPACT_MAX_SPEED * 1.15)
  const t = Math.min(
    1,
    Math.max(0, (speed - IMPACT_MIN_SPEED) / (IMPACT_MAX_SPEED - IMPACT_MIN_SPEED)),
  )

  COLLISION_SPARK_OPTIONS.count = 15 + Math.round(t * 25)
  COLLISION_SPARK_OPTIONS.x = x
  COLLISION_SPARK_OPTIONS.y = y
  COLLISION_SPARK_OPTIONS.speedMin = Math.max(40, speed * 0.18)
  COLLISION_SPARK_OPTIONS.speedMax = speed * 0.9
  engine.burst(COLLISION_SPARK_OPTIONS)
}

/**
 * Set off the break effect at the node that failed.
 *
 * ── Finding the break node ────────────────────────────────────────────────
 * `snap()` freezes the rope and reports how many ropes broke, but not where. The
 * failing constraint is the most overstretched one — that is the definition of
 * the break test — so it is recovered by walking the constraints of the frozen
 * pose and taking the maximum strain.
 *
 * ── One allocation per break, not per frame ──────────────────────────────
 * The bolt polylines are produced here, at the instant of the break, and cached
 * in the arc record; the 250 ms of rendering only re-strokes them.
 */
function spawnSnapArc(vfx: LanyardVfx, sim: LanyardSimulation, index: number): void {
  const l = sim.lanyards[index]
  if (!l || l.points.length < 2) return

  let worstStrain = -1
  let breakX = l.points[0].x
  let breakY = l.points[0].y
  for (let i = 0; i < l.constraints.length; i++) {
    const c = l.constraints[i]
    const pa = l.points[c.a]
    const pb = l.points[c.b]
    if (!pa || !pb) continue
    const dx = pb.x - pa.x
    const dy = pb.y - pa.y
    const strain = Math.abs(Math.hypot(dx, dy) - c.restLength) / c.restLength
    if (strain > worstStrain) {
      worstStrain = strain
      breakX = (pa.x + pb.x) * 0.5
      breakY = (pa.y + pb.y) * 0.5
    }
  }

  // Round-robin slots: a full quartet of breaks fits exactly, and an old arc is
  // the least valuable thing to keep if a fifth somehow arrives.
  const arc = vfx.snaps[vfx.snapCursor]
  vfx.snapCursor = (vfx.snapCursor + 1) % vfx.snaps.length

  const rgb = ACCENT_RGB[index < ACCENT_RGB.length ? index : 0]
  arc.active = true
  arc.x = breakX
  arc.y = breakY
  arc.age = 0
  arc.strayAge = 0
  arc.spawnAccumulator = 0
  arc.r = rgb[0]
  arc.g = rgb[1]
  arc.b = rgb[2]
  // Built once: the fade applies a globalAlpha on top, so all the frames of the
  // arc's life reuse one string.
  arc.glowStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.6)`

  // Main bolt, thrown from the break node in a direction biased upward (cord
  // failure sprays along the tension, but upward reads better against the rail).
  const boltAngle = -Math.PI * 0.5 + (Math.random() - 0.5) * 1.8
  const boltLength = 46 + Math.random() * 52
  arc.bolt = fractalLightning(
    breakX,
    breakY,
    breakX + Math.cos(boltAngle) * boltLength,
    breakY + Math.sin(boltAngle) * boltLength,
    5,
    0.52,
    0.2,
  )

  // A fork starting partway along the main bolt: two identical bolts would look
  // like a drawn glyph, a fork reads like an arc seeking a ground.
  const forkVertex = Math.floor((arc.bolt.length / 2) * 0.45) * 2
  const forkX = arc.bolt[forkVertex]
  const forkY = arc.bolt[forkVertex + 1]
  const forkAngle = boltAngle + (Math.random() - 0.5) * 2.2
  const forkLength = 18 + Math.random() * 30
  arc.branchA = fractalLightning(
    forkX,
    forkY,
    forkX + Math.cos(forkAngle) * forkLength,
    forkY + Math.sin(forkAngle) * forkLength,
    4,
    0.5,
    0.22,
  )

  // Second, lower fork off the break node itself.
  const branchAngle = boltAngle + (Math.random() - 0.5) * 2.8
  const branchLength = 14 + Math.random() * 26
  arc.branchB = fractalLightning(
    breakX,
    breakY,
    breakX + Math.cos(branchAngle) * branchLength,
    breakY + Math.sin(branchAngle) * branchLength,
    4,
    0.5,
    0.24,
  )

  /* ── The hot pop: a short burst in the lanyard's own accent ───────────── */
  SNAP_BURST_OPTIONS.color[0] = rgb[0]
  SNAP_BURST_OPTIONS.color[1] = rgb[1]
  SNAP_BURST_OPTIONS.color[2] = rgb[2]
  SNAP_BURST_OPTIONS.x = breakX
  SNAP_BURST_OPTIONS.y = breakY
  vfx.engine.burst(SNAP_BURST_OPTIONS)
}

/**
 * Age every break effect by `dt`, dribbling stray sparks as it goes.
 *
 * The arc itself is a 250 ms flash, but the cord keeps spitting for about a
 * second: the emission rate decays linearly to zero over `SNAP_STRAY_LIFE`, so
 * the last sparks are sparse rather than cutting off on a frame boundary.
 */
function advanceSnapArcs(vfx: LanyardVfx, dt: number): void {
  if (!(dt > 0)) return

  for (let i = 0; i < vfx.snaps.length; i++) {
    const arc = vfx.snaps[i]
    if (!arc.active) continue
    arc.age += dt

    if (arc.strayAge < SNAP_STRAY_LIFE) {
      arc.strayAge += dt
      const fade = 1 - arc.strayAge / SNAP_STRAY_LIFE
      arc.spawnAccumulator += dt * 22 * fade

      // Whole sparks only, and bounded per frame so a stalled/backgrounded tab
      // cannot dump the whole second of dribble into one frame when it returns.
      let guard = 4
      while (arc.spawnAccumulator >= 1 && guard > 0) {
        arc.spawnAccumulator -= 1
        guard--
        STRAY_SPARK_OPTIONS.x = arc.x
        STRAY_SPARK_OPTIONS.y = arc.y
        STRAY_SPARK_OPTIONS.color[0] = arc.r
        STRAY_SPARK_OPTIONS.color[1] = arc.g
        STRAY_SPARK_OPTIONS.color[2] = arc.b
        vfx.engine.spawn(STRAY_SPARK_OPTIONS)
      }
    }

    // The slot is free only when BOTH windows have expired: the flash uses the
    // first 250 ms, the dribble the full second.
    if (arc.age >= SNAP_ARC_LIFE && arc.strayAge >= SNAP_STRAY_LIFE) {
      arc.active = false
    }
  }
}

/**
 * Convert one solver step into spark/break events.
 *
 * Called immediately after `sim.step`, while the post-step pose still carries
 * the contact geometry. Nothing here allocates: the OBBs, the hit record and the
 * burst option objects are module scratch.
 */
function captureImpactEvents(vfx: LanyardVfx, sim: LanyardSimulation): void {
  const lanyards = sim.lanyards
  const count = Math.min(lanyards.length, vfx.prevVx.length)

  // Cooldowns tick on the fixed step, so one contact cannot fire a burst on every
  // substep while the boxes are still touching.
  for (let i = 0; i < vfx.pairCooldown.length; i++) {
    if (vfx.pairCooldown[i] > 0) vfx.pairCooldown[i] -= FIXED_DT
  }
  for (let i = 0; i < vfx.wallCooldown.length; i++) {
    if (vfx.wallCooldown[i] > 0) vfx.wallCooldown[i] -= FIXED_DT
  }

  /* ── Badge vs badge ───────────────────────────────────────────────────── */
  for (let i = 0; i < count; i++) {
    const ta = lanyards[i].tag
    for (let j = i + 1; j < count; j++) {
      const tb = lanyards[j].tag

      // Cheap distance reject first, exactly like the solver's broad phase.
      const dx = tb.x - ta.x
      const dy = tb.y - ta.y
      const reach = (ta.width + ta.height + tb.width + tb.height) * 0.5
      if (dx * dx + dy * dy > reach * reach) continue

      const key = i * count + j
      if (vfx.pairCooldown[key] > 0) continue

      VFX_OBB_A.cx = ta.x
      VFX_OBB_A.cy = ta.y
      VFX_OBB_A.hw = ta.width * 0.5
      VFX_OBB_A.hh = ta.height * 0.5
      VFX_OBB_A.angle = ta.angle

      VFX_OBB_B.cx = tb.x
      VFX_OBB_B.cy = tb.y
      VFX_OBB_B.hw = tb.width * 0.5
      VFX_OBB_B.hh = tb.height * 0.5
      VFX_OBB_B.angle = tb.angle

      const hit = overlapObb(VFX_OBB_A, VFX_OBB_B, VFX_HIT)
      // The solver corrects 72% of the penetration, so a real hit still leaves a
      // visible sliver; sub-pixel overlap is just badges resting together.
      if (!hit.hit || hit.depth < 0.5) continue

      // Impulse from the velocities as they were BEFORE this substep. Post-step
      // values are useless here: the solver has already reversed them.
      const rvx = vfx.prevVx[j] - vfx.prevVx[i]
      const rvy = vfx.prevVy[j] - vfx.prevVy[i]
      const closing = -(rvx * hit.nx + rvy * hit.ny)
      if (closing < IMPACT_MIN_SPEED) continue

      vfx.pairCooldown[key] = IMPACT_SPARK_COOLDOWN
      /*
       * Contact point ≈ midpoint of the two centres.
       *
       * Both badges are the same 132×84 box, so for equal projected extents the
       * midpoint lies on the contact plane; a difference in rotation moves it by
       * a few pixels at most, which is invisible inside a 15–40 spark burst and
       * far cheaper than computing the exact support point.
       */
      emitImpactSparks(
        vfx.engine,
        (ta.x + tb.x) * 0.5,
        (ta.y + tb.y) * 0.5,
        closing,
      )
    }
  }

  /* ── Badge vs sandbox wall ────────────────────────────────────────────── */
  // Only detached badges are wall-contained by the solver, so these are the
  // impacts that exist. The test is positional because `containFreeTag` clamps
  // the badge exactly onto the barrier: "on the wall with a velocity that was
  // reversed this step" is a collision.
  for (let i = 0; i < count; i++) {
    const l = lanyards[i]
    if (!l.broken || vfx.wallCooldown[i] > 0) continue

    const t = l.tag
    const halfW = t.width * 0.5
    const halfH = t.height * 0.5
    // Same circumscribed-radius approximation `containFreeTag` uses, so the
    // detected contact line is exactly where the solver stopped the badge.
    const inner = Math.min(halfW, halfH) + Math.abs(Math.sin(t.angle)) * (halfW - halfH) * 0.5
    const radius = Math.max(halfW, halfH) * 0.82 + inner * 0.18
    const floor = sim.height - 6

    const prevVx = vfx.prevVx[i]
    const prevVy = vfx.prevVy[i]

    let impulse = 0
    let contactX = 0
    let contactY = 0
    if (t.y + radius >= floor - 0.75 && prevVy > IMPACT_MIN_SPEED) {
      impulse = prevVy
      contactX = t.x
      contactY = floor
    } else if (t.y - radius <= 0.75 && prevVy < -IMPACT_MIN_SPEED) {
      impulse = -prevVy
      contactX = t.x
      contactY = 0
    } else if (t.x - radius <= 0.75 && prevVx < -IMPACT_MIN_SPEED) {
      impulse = -prevVx
      contactX = 0
      contactY = t.y
    } else if (t.x + radius >= sim.width - 0.75 && prevVx > IMPACT_MIN_SPEED) {
      impulse = prevVx
      contactX = sim.width
      contactY = t.y
    }

    if (impulse <= 0) continue
    vfx.wallCooldown[i] = WALL_SPARK_COOLDOWN
    emitImpactSparks(vfx.engine, contactX, contactY, impulse)
  }

  /* ── Remember this step's outgoing state for the next one ─────────────── */
  for (let i = 0; i < count; i++) {
    const l = lanyards[i]
    // Falling edge of the broken flag: the rope failed THIS step, so the break
    // effect belongs at the pose we are looking at right now.
    if (!vfx.wasBroken[i] && l.broken) spawnSnapArc(vfx, sim, i)
    vfx.prevVx[i] = l.tag.vx
    vfx.prevVy[i] = l.tag.vy
    vfx.wasBroken[i] = l.broken
  }
}

/**
 * Advance the whole vfx layer by one rendered frame.
 *
 * Ordering is deliberate: strays from a fresh break are spawned first so they are
 * integrated on the same frame they appear; then the pool is stepped against the
 * same floor the solver uses; then the cloud's energy centroid is measured for
 * the illumination pass.
 *
 * The engine has no clock of its own — every call here is driven by the sandbox's
 * single rAF loop.
 */
function updateVfx(
  vfx: LanyardVfx,
  dt: number,
  width: number,
  height: number,
): void {
  advanceSnapArcs(vfx, dt)

  VFX_BOUNDS.left = 0
  VFX_BOUNDS.right = width
  // Match `containFreeTag`'s floor (6 px above the canvas edge) so a spark that
  // bounces and a badge that lands agree about where the ground is.
  VFX_BOUNDS.bottom = height - 6
  vfx.engine.step(dt, VFX_BOUNDS)

  // Particle-driven light. The engine fills the module record in place; this is
  // the read side of `drawIllumination` in `drawSandbox`.
  vfx.engine.computeIllumination(ILLUMINATION)
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the clock handed to the renderer for time-based effects.
 *
 * In development a `window.__rdTime` override takes precedence over the real
 * elapsed time. That exists so verification can repaint at arbitrary times while
 * the SIMULATION stays frozen — the only way to measure render jitter separately
 * from the rope's physical swinging.
 */
function renderTime(fallback: number): number {
  if (import.meta.env.DEV) {
    const override = (window as unknown as { __rdTime?: unknown }).__rdTime
    if (typeof override === 'number') return override
  }
  return fallback
}

/**
 * Draw the whole sandbox. Called once per animation frame.
 *
 * Split into passes so overlapping objects layer correctly: particle-driven light
 * first, then ropes (behind everything), then tags back-to-front, then the break
 * flash and finally the sparks.
 *
 * ── Why the light has two passes ─────────────────────────────────────────
 * The ambient pass is drawn UNDER all content, before even the anchor rail. The
 * canvas is transparent, so its additive glow also lands on the CSS tech grid
 * behind the canvas — which is how the backdrop visibly brightens near a spark
 * cloud. An opaque badge, however, cannot be lit by a pass drawn beneath it, so a
 * second, tighter and weaker pass sits on top of the tags to light their faces.
 * That split (broad light below, local response above) is the same trick a
 * compositor uses: the light is a source, the badge is a surface that catches it.
 */
function drawSandbox(
  ctx: CanvasRenderingContext2D,
  sim: LanyardSimulation,
  width: number,
  height: number,
  time: number,
  vfx: LanyardVfx,
  /** Leftover accumulator fraction, in [0,1). See `PB-03` in 修改计划.md. */
  interpolation: number,
): void {
  void height

  /* ── Particle-driven light, pass 1: under everything ─────────────────── */
  drawIllumination(ctx, ILLUMINATION, AMBIENT_LIGHT_RADIUS, VFX_LIGHT_RGB, 0.34)

  // Anchor rail: a thin line the lanyards hang from.
  ctx.strokeStyle = 'rgba(42, 51, 72, 0.85)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(width * 0.06, 46)
  ctx.lineTo(width * 0.94, 46)
  ctx.stroke()

  for (const l of sim.lanyards) {
    if (!l.broken || l.ropeAlpha > 0.01) drawRope(ctx, l, time, interpolation)
  }

  for (const l of sim.lanyards) {
    drawTag(ctx, l)
  }

  // Anchor nubs, drawn over the rail.
  for (const l of sim.lanyards) {
    ctx.beginPath()
    ctx.arc(l.anchorX, l.anchorY, 3, 0, Math.PI * 2)
    ctx.fillStyle = l.broken ? 'rgba(74, 86, 112, 0.7)' : l.accent
    ctx.fill()
  }

  /* ── Particle-driven light, pass 2: the badges' response ─────────────── */
  // Deliberately weaker than pass 1 and half the radius: it is the hot spot on
  // the metal, not the ambient pool. Without it the badges stay flat plates while
  // the grid around them glows, which reads as a decal rather than as lighting.
  drawIllumination(ctx, ILLUMINATION, BADGE_LIGHT_RADIUS, VFX_LIGHT_RGB, 0.16)

  // Break arc + flash above the cord and badge it tore from, but below the
  // particles so the lingering sparks stay the sharpest thing on screen.
  drawSnapArcs(ctx, vfx)

  // Sparks last: additive, velocity-stretched streaks.
  vfx.engine.draw(ctx)
}

/**
 * Draw the live break effects: radial flash, fractal arc, fading forks.
 *
 * Everything is additive, because a tearing cord is a light source, not a line.
 * The bolt is a cached polyline (generated once in `spawnSnapArc`); the visible
 * "electricity" comes from two layers over it — a deterministic high-frequency
 * alpha tremble plus a white core — rather than from new geometry per frame.
 */
function drawSnapArcs(ctx: CanvasRenderingContext2D, vfx: LanyardVfx): void {
  let hasActive = false
  for (let i = 0; i < vfx.snaps.length; i++) {
    if (vfx.snaps[i].active) {
      hasActive = true
      break
    }
  }
  if (!hasActive) return

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (let i = 0; i < vfx.snaps.length; i++) {
    const arc = vfx.snaps[i]
    if (!arc.active) continue

    // The arc and flash share one 250 ms window; the dribble outlives them.
    const life = Math.min(1, arc.age / SNAP_ARC_LIFE)
    if (life < 1) {
      const fade = 1 - life
      // Radial flash decays on the same schedule as the bolt: a bright pop whose
      // radius also shrinks, so it reads as a flash rather than a fading lamp.
      SNAP_FLASH_RGB[0] = arc.r
      SNAP_FLASH_RGB[1] = arc.g
      SNAP_FLASH_RGB[2] = arc.b
      drawRadialFlash(
        ctx,
        arc.x,
        arc.y,
        24 + 52 * fade,
        fade * fade * 0.85,
        SNAP_FLASH_RGB,
      )

      // Deterministic tremble: 96 rad/s is far above the 60 Hz sampling rate, so
      // it aliases into an electrical shimmer instead of a smooth pulse.
      const flicker = 0.62 + 0.38 * Math.abs(Math.sin(arc.age * 96))

      // Wide coloured halo.
      ctx.globalAlpha = fade * 0.5 * flicker
      ctx.strokeStyle = arc.glowStyle
      ctx.lineWidth = 5.5
      strokePolyline(ctx, arc.bolt)

      // White core: the arc itself, thin enough to read as a bright line.
      ctx.globalAlpha = fade * flicker
      ctx.strokeStyle = SNAP_CORE_STYLE
      ctx.lineWidth = 1.4
      strokePolyline(ctx, arc.bolt)

      // Forks: dimmer, so the eye follows the main discharge.
      ctx.globalAlpha = fade * 0.45 * flicker
      ctx.strokeStyle = arc.glowStyle
      ctx.lineWidth = 2.2
      strokePolyline(ctx, arc.branchA)
      strokePolyline(ctx, arc.branchB)
    }
  }

  ctx.restore()
}

/**
 * Draw one lanyard's cord: a Catmull-Rom-smoothed, fabric-textured strap with a
 * specular highlight and a red overload warning.
 *
 * ── Rendering order (bottom to top) ───────────────────────────────────────
 *  0. fibre bloom       — very wide cyan haze, the "light in the fibre" layer
 *  1. outer glow        — accent halo, widens with strain
 *  2. shadow pass       — a dark, slightly offset copy so the cord lifts off the
 *                         backdrop
 *  3. fabric body       — the strap itself, with a cross-section gradient
 *  4. weave texture     — diagonal hatching sampled along the fitted curve
 *  5. specular edge     — a thin bright line offset toward the light
 *  6. photon pulses     — a travelling cyan band of lit segments
 *  7. clasp             — metal clip at the badge junction
 *
 * ── The stress state ──────────────────────────────────────────────────────
 * `stress` is a 0..1 ramp that only starts above ~55% of the break threshold.
 * Below that the cord is its normal slate/grey-white; approaching the limit it
 * shifts through amber to red, and gains a high-frequency jitter that reads as
 * vibration under load.
 */
function drawRope(
  ctx: CanvasRenderingContext2D,
  l: LanyardState,
  time: number,
  interpolation: number,
): void {
  // NOTE: `smooth` rather than `alpha` -- this function already uses `alpha` for the
  // rope's own fade-in factor, and shadowing it would have broken the fade silently.
  const smooth = interpolation
  const alpha = l.ropeAlpha
  if (alpha <= 0.01) return

  /* ── Stress state ────────────────────────────────────────────────────── */
  const strain = Math.max(0, l.peakStrain)
  const ratio = strain / BREAK_STRAIN
  // Nothing happens until the cord is genuinely loaded; then it ramps to 1 at
  // the break threshold. A linear ramp from zero would make every resting rope
  // look angry.
  const stress = Math.max(0, Math.min(1, (ratio - 0.55) / 0.45))

  /* ── Overload jitter ───────────────────────────────────────────────────
   * High frequency, low amplitude, and scaled by how close the cord is to
   * snapping. Sampling two incommensurate sines (rather than random) keeps it
   * deterministic frame-to-frame, so it reads as vibration instead of noise.
   */
  const jitterAmp = stress * stress * 2.4
  let jx = 0
  let jy = 0
  if (jitterAmp > 0.01) {
    // 47 Hz and 61 Hz are incommensurate: the sum never repeats a short cycle.
    jx = (Math.sin(time * 47.3) + Math.sin(time * 61.7) * 0.6) * jitterAmp
    jy = (Math.cos(time * 53.1) + Math.sin(time * 43.9) * 0.6) * jitterAmp
  }

  /* ── Fit the curve through the particles ─────────────────────────────── */
  // The jitter is applied to the sampled points, not after fitting, so the whole
  // cord shivers coherently rather than the texture sliding over a still strap.
  /*
   * Reused fit buffer.
   *
   * `l.points.map(...)` allocated one array plus one object per particle on every
   * frame for every lanyard -- roughly 740 objects per frame across the four cords,
   * which is the exact thing this file's header promises not to do. The particles'
   * count is fixed, so one growable array of plain points is enough.
   */
  const points = l.points
  for (let i = 0; i < points.length; i++) {
    const source = points[i]
    const slot = ropeFitScratch[i] ?? (ropeFitScratch[i] = { x: 0, y: 0 })
    // Interpolate from the position at the start of the last step to the current one.
    // At 144 Hz most frames execute zero physics steps, so the un-interpolated rope
    // only moved 60 times a second -- visibly steppy against a 144 Hz cursor and camera.
    slot.x = source.rx + (source.x - source.rx) * smooth + jx
    slot.y = source.ry + (source.y - source.ry) * smooth + jy
  }
  ropeFitScratch.length = points.length
  const segments = catmullRomToBezier(ropeFitScratch, 0.5)
  if (segments.length === 0) return

  /* ── Stress palette ──────────────────────────────────────────────────── */
  // Rest: cool grey-white (#c7d2e0). Alarm: red (#ff3b4e). Amber between.
  const restR = 199
  const restG = 210
  const restB = 224
  const hotR = 255
  const hotG = 59
  const hotB = 78

  // Two-stage blend: grey → amber → red, so the transition reads as heating.
  let cr: number
  let cg: number
  let cb: number
  if (stress < 0.5) {
    const t = stress / 0.5
    cr = restR + (251 - restR) * t
    cg = restG + (191 - restG) * t
    cb = restB + (36 - restB) * t
  } else {
    const t = (stress - 0.5) / 0.5
    cr = 251 + (hotR - 251) * t
    cg = 191 + (hotG - 191) * t
    cb = 36 + (hotB - 36) * t
  }
  const cordColor = `rgb(${Math.round(cr)}, ${Math.round(cg)}, ${Math.round(cb)})`

  /* ── 0. Fibre-optic bloom ────────────────────────────────────────────── */
  /*
   * The wide, diffuse layer. Two halos stacked (this 18 px cyan one and the
   * accent glow below at 7 px) read as light bleeding OUT of the cord; a single
   * stroke with one `shadowBlur` looks like exactly what it is, because the blur
   * is centred on the same line as the stroke. The shadow here doubles the
   * softness without a second geometry pass.
   */
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.globalAlpha = alpha * (0.045 + stress * 0.05)
  ctx.strokeStyle = '#22d3ee'
  ctx.lineWidth = 18 + stress * 8
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowColor = '#22d3ee'
  ctx.shadowBlur = 22
  ctx.beginPath()
  traceBezierPath(ctx, segments)
  ctx.stroke()
  ctx.restore()

  /* ── 1. Outer glow ───────────────────────────────────────────────────── */
  ctx.save()
  ctx.globalAlpha = alpha * (0.16 + stress * 0.55)
  ctx.strokeStyle = cordColor
  ctx.lineWidth = 7 + stress * 5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // A blurred stroke via shadow is cheaper than a CSS filter and works on canvas.
  ctx.shadowColor = cordColor
  ctx.shadowBlur = 10 + stress * 16
  ctx.beginPath()
  traceBezierPath(ctx, segments)
  ctx.stroke()
  ctx.restore()

  /* ── 2. Shadow pass: a dark offset copy under the cord ───────────────── */
  ctx.save()
  ctx.globalAlpha = alpha * 0.5
  ctx.strokeStyle = 'rgba(2, 4, 10, 0.85)'
  ctx.lineWidth = 7.5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.translate(1.6, 2.4)
  ctx.beginPath()
  traceBezierPath(ctx, segments)
  ctx.stroke()
  ctx.restore()

  /* ── 3. Fabric body ──────────────────────────────────────────────────── */
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Base strap.
  ctx.strokeStyle = cordColor
  ctx.lineWidth = 6
  ctx.beginPath()
  traceBezierPath(ctx, segments)
  ctx.stroke()

  // Inner shading: a narrower darker stroke down the middle creates the illusion
  // of a woven strap rather than a solid tube.
  ctx.globalAlpha = alpha * 0.35
  ctx.strokeStyle = stress > 0.35 ? 'rgba(80, 0, 12, 0.8)' : 'rgba(24, 32, 48, 0.85)'
  ctx.lineWidth = 2.4
  ctx.beginPath()
  traceBezierPath(ctx, segments)
  ctx.stroke()
  ctx.restore()

  /* ── 4. Weave texture ────────────────────────────────────────────────── */
  // Diagonal hatch marks placed along the curve, alternating sides, so the cord
  // reads as braided fabric at any zoom.
  ctx.save()
  ctx.globalAlpha = alpha * (0.26 + stress * 0.2)
  ctx.strokeStyle = stress > 0.3 ? 'rgba(255, 190, 190, 0.6)' : 'rgba(150, 170, 200, 0.55)'
  ctx.lineWidth = 1

  const totalLen = bezierPathLength(segments)
  const spacing = 5.5
  const marks = Math.max(1, Math.floor(totalLen / spacing))
  const totalSegs = segments.length

  for (let i = 0; i < marks; i++) {
    const along = (i + 0.5) / marks
    // Map arc-length fraction onto segment index (segments are near-equal length
    // because the particles are evenly spaced by the solver).
    const segIndex = Math.min(totalSegs - 1, Math.floor(along * totalSegs))
    const localT = along * totalSegs - segIndex
    const seg = segments[segIndex]
    if (!seg) continue

    // Scratch objects, reused across marks: three allocations per mark per cord per
    // frame adds up fast. Consumed immediately below, before the next iteration.
    const p = sampleBezier(seg, localT, bezierP)
    // Tangent from a finite difference on the same segment.
    const q = sampleBezier(seg, Math.min(1, localT + 0.02), bezierQ)
    const r = sampleBezier(seg, Math.max(0, localT - 0.02), bezierR)
    const tx = q.x - r.x
    const ty = q.y - r.y
    const tl = Math.hypot(tx, ty) || 1
    const nx = -ty / tl
    const ny = tx / tl

    // Alternating diagonal so the hatch reads as a woven pattern.
    const slant = i % 2 === 0 ? 1 : -1
    const half = 2.6
    ctx.beginPath()
    ctx.moveTo(p.x - nx * half, p.y - ny * half)
    ctx.lineTo(
      p.x + nx * half + (tx / tl) * half * 0.9 * slant,
      p.y + ny * half + (ty / tl) * half * 0.9 * slant,
    )
    ctx.stroke()
  }
  ctx.restore()

  /* ── 5. Specular highlight ───────────────────────────────────────────── */
  // A bright thin line offset to the upper-left of the cord, as if lit from above
  // left. This is the detail that makes a flat stroke look cylindrical.
  ctx.save()
  ctx.globalAlpha = alpha * (0.5 - stress * 0.2)
  ctx.strokeStyle = stress > 0.4 ? 'rgba(255, 226, 226, 0.85)' : 'rgba(240, 248, 255, 0.9)'
  ctx.lineWidth = 1.5
  ctx.lineCap = 'round'
  ctx.translate(-1.1, -1.4)
  ctx.beginPath()
  traceBezierPath(ctx, segments)
  ctx.stroke()
  ctx.restore()

  /* ── 6. Photon pulses ────────────────────────────────────────────────── */
  // The light travelling inside the fibre. Drawn after the fabric and specular
  // so it sits ON the cord, before the clasp so the metal still reads as the top
  // object. The jitter offsets are forwarded so the band rides the same shivering
  // polyline the fabric does — otherwise it would slide over a still strap.
  drawFibrePulses(ctx, l, time, alpha, jx, jy)

  /* ── 7. Metal clasp where the cord meets the badge ───────────────────── */
  drawClasp(ctx, l, stress, alpha)
}

/**
 * Fibre-optic photon pulses: a travelling band of lit segments on the cord.
 *
 * ── Why it is not a new animation loop ───────────────────────────────────
 * The band position is derived from the `time` clock the renderer already
 * receives. There is no accumulator, no timer and no rAF of its own: if the
 * sandbox is scrolled off screen the loop sleeps, and when it wakes the pulse is
 * simply further along its cycle. That keeps the one-animation-loop rule intact.
 *
 * ── Why it walks `l.points` and not the Bezier ───────────────────────────
 * The fitted spline in `drawRope` is a rendering convenience; the solver's point
 * array is the physical cord. Walking the points guarantees the light rides the
 * real path (and the brief asks for exactly that), segment by segment, so the
 * band's length is in cord length rather than in curve-parameter space.
 *
 * ── Allocation ───────────────────────────────────────────────────────────
 * Intensity is applied through `globalAlpha` — a number write — rather than a
 * fresh `rgba(...)` string per segment. The two style strings are module
 * constants, so a frame allocates nothing for the pulses.
 */
function drawFibrePulses(
  ctx: CanvasRenderingContext2D,
  l: LanyardState,
  time: number,
  alpha: number,
  jitterX: number,
  jitterY: number,
): void {
  // A broken cord has no light left in it; its rope is only fading out.
  if (l.broken || alpha <= 0.01) return
  const points = l.points
  const n = points.length
  if (n < 2) return

  /*
   * Two heads per cycle, the second half a lap behind and dimmer. One lone pulse
   * reads as a loading bar; the echo makes the cord look like it is carrying
   * traffic in both directions.
   *
   * `windPhase` is already a per-lanyard arbitrary offset, so reusing it keeps
   * the four cords from flashing in lockstep without introducing Math.random at
   * mount (which would make the effect differ between two otherwise identical
   * reloads).
   */
  let headA = (time / PULSE_CYCLE + l.windPhase * 0.159) % 1
  if (headA < 0) headA += 1
  const headB = headA > 0.52 ? headA - 0.52 : headA + 0.48

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (let i = 0; i < n - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (!a || !b) continue

    // `along` is the segment midpoint as a fraction of the cord, so the band has
    // the same width in every segment regardless of how stretched it is.
    const along = (i + 0.5) / (n - 1)

    // Circular distance: a pulse reaching the clasp wraps back to the anchor.
    let distA = Math.abs(along - headA)
    if (distA > 0.5) distA = 1 - distA
    let distB = Math.abs(along - headB)
    if (distB > 0.5) distB = 1 - distB

    let intensity = 1 - distA / PULSE_BAND
    if (intensity < 0) intensity = 0
    intensity *= intensity

    let echo = 1 - distB / PULSE_BAND
    if (echo < 0) echo = 0
    echo *= echo * 0.42
    if (echo > intensity) intensity = echo
    if (intensity < 0.015) continue

    const x1 = a.x + jitterX
    const y1 = a.y + jitterY
    const x2 = b.x + jitterX
    const y2 = b.y + jitterY

    // Soft cyan bloom around the lit segment.
    ctx.globalAlpha = alpha * intensity * 0.34
    ctx.strokeStyle = PULSE_GLOW_STYLE
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()

    // Hot white core: the photon itself.
    ctx.globalAlpha = alpha * intensity * 0.95
    ctx.strokeStyle = PULSE_CORE_STYLE
    ctx.lineWidth = 1.9
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * Draw the silver metal clasp at the cord/badge junction.
 *
 * ── Construction ──────────────────────────────────────────────────────────
 * A realistic-looking clip needs four things a plain rectangle lacks:
 *
 *  1. an ORIENTATION — it must rotate with the badge, not stay upright
 *  2. a BARREL BODY — a vertical gradient across the width, so it reads as a
 *     rounded metal tube rather than a flat chip
 *  3. a SPECULAR BAND — one bright, off-centre highlight; metal is defined by
 *     where it is not bright
 *  4. a THROUGH-HOLE — the cord passes through it, so the cord is drawn again on
 *     top of the hole
 *
 * The clasp sits at the cord's end point and is rotated to match the badge angle,
 * because that is physically where the two are pinned together.
 */
function drawClasp(
  ctx: CanvasRenderingContext2D,
  l: LanyardState,
  stress: number,
  alpha: number,
): void {
  const t = l.tag
  const pts = l.points
  const end = pts[pts.length - 1]
  if (!end) return

  // The cord enters the clasp here, oriented with the badge.
  const hw = 9
  const hh = 7

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(end.x, end.y + 1)
  ctx.rotate(t.angle)

  /* ── Drop shadow ─────────────────────────────────────────────────────── */
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
  ctx.shadowBlur = 5
  ctx.shadowOffsetY = 2
  ctx.beginPath()
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 3.5)
  ctx.fillStyle = '#1b2230'
  ctx.fill()
  ctx.restore()

  /* ── Barrel body: horizontal metal gradient ──────────────────────────── */
  const body = ctx.createLinearGradient(-hw, 0, hw, 0)
  // Cool steel with a bright core slightly left of centre, matching a top-left
  // light. The four stops are what create the cylindrical illusion.
  body.addColorStop(0, '#4a5468')
  body.addColorStop(0.22, '#8d9bb5')
  body.addColorStop(0.42, '#dfe8f5')
  body.addColorStop(0.6, '#9aa8c0')
  body.addColorStop(0.82, '#5b677d')
  body.addColorStop(1, '#3b4557')

  ctx.beginPath()
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 3.5)
  ctx.fillStyle = body
  ctx.fill()

  /* ── Specular band across the upper third ────────────────────────────── */
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 3.5)
  ctx.clip()

  const spec = ctx.createLinearGradient(0, -hh, 0, -hh * 0.1)
  spec.addColorStop(0, 'rgba(255, 255, 255, 0)')
  spec.addColorStop(0.45, 'rgba(255, 255, 255, 0.72)')
  spec.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = spec
  ctx.fillRect(-hw, -hh, hw * 2, hh)

  // A second, dimmer bounce light along the bottom edge sells the roundness.
  const bounce = ctx.createLinearGradient(0, hh * 0.15, 0, hh)
  bounce.addColorStop(0, 'rgba(190, 214, 240, 0)')
  bounce.addColorStop(1, 'rgba(190, 214, 240, 0.42)')
  ctx.fillStyle = bounce
  ctx.fillRect(-hw, hh * 0.15, hw * 2, hh * 0.85)
  ctx.restore()

  /* ── Bevel outline ───────────────────────────────────────────────────── */
  ctx.beginPath()
  roundRect(ctx, -hw + 0.5, -hh + 0.5, hw * 2 - 1, hh * 2 - 1, 3.2)
  ctx.strokeStyle = stress > 0.3 ? 'rgba(255, 150, 150, 0.7)' : 'rgba(226, 238, 255, 0.55)'
  ctx.lineWidth = 1
  ctx.stroke()

  /* ── Through-hole: the cord passes behind, so punch a dark slot ──────── */
  ctx.beginPath()
  roundRect(ctx, -3.2, -hh - 0.5, 6.4, 5, 2)
  ctx.fillStyle = 'rgba(8, 12, 20, 0.92)'
  ctx.fill()
  // A bright inner rim on the lower lip of the hole: the classic metal detail.
  ctx.beginPath()
  ctx.moveTo(-3.2, -hh + 3.2)
  ctx.lineTo(3.2, -hh + 3.2)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
  ctx.lineWidth = 0.8
  ctx.stroke()

  /* ── Rivets: two tiny studs, one each side of the hole ───────────────── */
  for (const rx of [-5.6, 5.6]) {
    const rivet = ctx.createRadialGradient(rx - 0.6, -hh * 0.35, 0, rx, -hh * 0.35, 1.9)
    rivet.addColorStop(0, '#f4f8ff')
    rivet.addColorStop(0.55, '#9fb0c8')
    rivet.addColorStop(1, '#3f4a5c')
    ctx.beginPath()
    ctx.arc(rx, -hh * 0.35, 1.9, 0, Math.PI * 2)
    ctx.fillStyle = rivet
    ctx.fill()
  }

  ctx.restore()
}

/** Draw one badge: a rotated, rounded rect with a brushed metal face. */
function drawTag(ctx: CanvasRenderingContext2D, l: LanyardState): void {
  const t: TagState = l.tag
  const alpha = l.broken ? 1 : l.ropeAlpha
  if (alpha <= 0.01) return

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(t.x, t.y)
  ctx.rotate(t.angle)

  const w = t.width
  const h = t.height
  const hw = w / 2
  const hh = h / 2
  const radius = 10

  /* ── Drop shadow ─────────────────────────────────────────────────────── */
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.75)'
  ctx.shadowBlur = t.attached ? 16 : 22
  ctx.shadowOffsetY = t.attached ? 6 : 10
  ctx.beginPath()
  roundRect(ctx, -hw, -hh, w, h, radius)
  ctx.fillStyle = 'rgba(10, 14, 24, 0.95)'
  ctx.fill()
  ctx.restore()

  /* ── Brushed metal face ──────────────────────────────────────────────── */
  const grad = ctx.createLinearGradient(-hw, -hh, hw, hh)
  grad.addColorStop(0, '#121a29')
  grad.addColorStop(0.45, '#1b2437')
  grad.addColorStop(0.55, '#232f45')
  grad.addColorStop(1, '#0e1420')
  ctx.beginPath()
  roundRect(ctx, -hw, -hh, w, h, radius)
  ctx.fillStyle = grad
  ctx.fill()

  // Fine brushed lines across the face.
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, -hw, -hh, w, h, radius)
  ctx.clip()
  ctx.globalAlpha = alpha * 0.14
  ctx.strokeStyle = '#8fa6c8'
  ctx.lineWidth = 0.5
  for (let i = -hh; i < hh; i += 2.5) {
    ctx.beginPath()
    ctx.moveTo(-hw, i)
    ctx.lineTo(hw, i)
    ctx.stroke()
  }
  ctx.restore()

  /* ── Accent edge ─────────────────────────────────────────────────────── */
  ctx.beginPath()
  roundRect(ctx, -hw + 0.75, -hh + 0.75, w - 1.5, h - 1.5, radius - 0.75)
  ctx.strokeStyle = l.accent
  ctx.globalAlpha = alpha * 0.85
  ctx.lineWidth = 1.4
  ctx.stroke()

  /* ── Top clip is drawn by `drawClasp`, in world space at the cord end, so it
     rotates correctly with the badge and sits above the cord. Nothing here. ── */

  /* ── Label text ──────────────────────────────────────────────────────── */
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  // Small index line.
  ctx.globalAlpha = alpha * 0.5
  ctx.fillStyle = l.accent
  ctx.font = '600 6px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillText(l.id.toUpperCase(), -hw + 11, -hh + 15)

  // Main label, wrapped to two lines if needed.
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#eef2ff'
  ctx.font = '600 11px "Space Grotesk", ui-sans-serif, system-ui, sans-serif'
  const words = l.label.split(' ')
  if (words.length > 2) {
    // e.g. "Distributed Cloud" stays on one; "Rust & Systems" too. Only wrap
    // when the whole string is genuinely long.
    if (l.label.length > 15) {
      const mid = Math.ceil(words.length / 2)
      ctx.fillText(words.slice(0, mid).join(' '), -hw + 11, -hh + 33)
      ctx.fillText(words.slice(mid).join(' '), -hw + 11, -hh + 47)
    } else {
      ctx.fillText(l.label, -hw + 11, -hh + 36)
    }
  } else {
    ctx.fillText(l.label, -hw + 11, -hh + 36)
  }

  /* ── Grab affordance: three grip dots, brighter while held ──────────── */
  ctx.globalAlpha = alpha * (t.grabbed ? 0.95 : 0.35)
  ctx.fillStyle = l.accent
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.arc(hw - 13, -3 + (i - 1) * 5, 1.2, 0, Math.PI * 2)
    ctx.fill()
  }

  /* ── Strain warning border while being pulled near the limit ────────── */
  if (!l.broken && l.peakStrain > BREAK_STRAIN * 0.45) {
    const warn = Math.min(1, (l.peakStrain - BREAK_STRAIN * 0.45) / (BREAK_STRAIN * 0.55))
    ctx.beginPath()
    roundRect(ctx, -hw, -hh, w, h, radius)
    ctx.strokeStyle = `rgba(251, 113, 133, ${warn * 0.9})`
    ctx.lineWidth = 2
    ctx.globalAlpha = alpha
    ctx.stroke()
  }

  ctx.restore()
}

/** Path a rounded rectangle. Kept local so no polyfill is needed. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

export default VerletLanyard
