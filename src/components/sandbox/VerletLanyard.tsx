import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
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
  type TagState,
} from '@/utils/mathPhysics'
import { useInViewAnimation } from '@/hooks/useInViewAnimation'
import { reportPhysicsSolve } from '@/lib/perfMetrics'
import { GRAVITY_SCALE, useAppStore } from '@/store/useAppStore'

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

export function VerletLanyard({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const simRef = useRef<LanyardSimulation | null>(null)

  /** Elapsed simulation time, for the wind field. */
  const timeRef = useRef(0)
  /** Accumulator for the fixed-timestep loop. */
  const accRef = useRef(0)
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

    /* ── Size management ────────────────────────────────────────────────── */
    let cssW = 0
    let cssH = 0
    let dpr = 1

    const applySize = (): void => {
      const rect = wrap.getBoundingClientRect()
      cssW = Math.max(1, Math.round(rect.width))
      cssH = Math.max(1, Math.round(rect.height))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
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
        ;(window as unknown as { __lanyardSim?: unknown }).__lanyardSim = simRef.current
      }
    }

    applySize()

    const resizeObserver = new ResizeObserver(applySize)
    resizeObserver.observe(wrap)

    /* ── Own the RAF, gated on visibility ───────────────────────────────── */
    let rafId = 0
    let lastTime = 0
    let hudTimer = 0

    const frame = (now: number): void => {
      rafId = requestAnimationFrame(frame)
      // Sleep when off screen. The loop still schedules itself (so waking is
      // instant and needs no observer callback), but does no work at all.
      if (!inViewRef.current) return

      const sim = simRef.current
      if (!sim) return

      // Clamp the frame delta: after a tab switch `now - lastTime` can be huge,
      // and feeding that into the accumulator would run dozens of steps at once.
      const dt = lastTime === 0 ? FIXED_DT : Math.min((now - lastTime) / 1000, 0.1)
      lastTime = now

      accRef.current += dt

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

      while (accRef.current >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        timeRef.current += FIXED_DT
        sim.step(FIXED_DT, timeRef.current)

        const impacts = sim.impactCount
        for (let i = 0; i < impacts; i++) {
          const v = sim.getImpactSpeed(i)
          if (v > loudestImpact) loudestImpact = v
        }
        snappedThisFrame += sim.snapCount

        accRef.current -= FIXED_DT
        steps++
      }

      if (steps > 0) {
        reportPhysicsSolve(
          performance.now() - solveStart,
          steps * RELAXATION_ITERATIONS * (sim.lanyards.length * 11),
        )
      }

      if (loudestImpact > 0) soundEngine.playPhysicsCollision(loudestImpact)
      // Any number of simultaneous snaps is one break event to the ear.
      if (snappedThisFrame > 0) soundEngine.playRopeSnap()

      // Draw once per animation frame, not once per physics step.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      drawSandbox(ctx, sim, cssW, cssH, renderTime(timeRef.current))

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
    }
  }, [inViewRef])

  /* ── Pointer interaction ──────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    /** Convert a pointer event to sandbox-local pixels. */
    const localPoint = (e: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
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
      const { x, y } = localPoint(e)
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

  /* ── Re-forge ─────────────────────────────────────────────────────────── */
  const reforge = (): void => {
    const sim = simRef.current
    if (!sim) return
    sim.reforge(LANYARD_SPECS)
    timeRef.current = 0
    accRef.current = 0
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
        style={{ touchAction: 'none' }}
        role="application"
        aria-label="可拖拽的物理工牌沙盒，拖动工牌可甩动，过度拉伸会扯断绳索"
      />

      {/* ── HUD ─────────────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="rounded-md border border-void-600/60 bg-void-950/80 px-2.5 py-1.5 backdrop-blur-md">
          <p className="font-mono text-[0.55rem] tracking-[0.22em] text-ink-700 uppercase">
            verlet sandbox
          </p>
          <div className="mt-1 flex items-center gap-2 font-mono text-[0.6rem]">
            <span className="text-ink-500">strain</span>
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
          Re-forge Lanyards
          {brokenCount > 0 && (
            <span className="rounded bg-signal-rose/20 px-1 text-signal-rose">
              {brokenCount}
            </span>
          )}
        </button>
      </div>

      {/* Hint, fades out is not needed — it stays subtle. */}
      <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center font-mono text-[0.55rem] tracking-[0.2em] text-ink-700 uppercase">
        拖拽工牌 · 过度用力会扯断
      </p>
    </div>
  )
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
 * Split into passes so overlapping objects layer correctly: ropes first (behind
 * everything), then tags back-to-front, then the strain glow on top.
 */
function drawSandbox(
  ctx: CanvasRenderingContext2D,
  sim: LanyardSimulation,
  width: number,
  height: number,
  time: number,
): void {
  void height
  // Anchor rail: a thin line the lanyards hang from.
  ctx.strokeStyle = 'rgba(42, 51, 72, 0.85)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(width * 0.06, 46)
  ctx.lineTo(width * 0.94, 46)
  ctx.stroke()

  for (const l of sim.lanyards) {
    if (!l.broken || l.ropeAlpha > 0.01) drawRope(ctx, l, time)
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
}

/**
 * Draw one lanyard's cord: a Catmull-Rom-smoothed, fabric-textured strap with a
 * specular highlight and a red overload warning.
 *
 * ── Rendering order (bottom to top) ───────────────────────────────────────
 *  1. outer glow        — accent halo, widens with strain
 *  2. shadow pass       — a dark, slightly offset copy so the cord lifts off the
 *                         backdrop
 *  3. fabric body       — the strap itself, with a cross-section gradient
 *  4. weave texture     — diagonal hatching sampled along the fitted curve
 *  5. specular edge     — a thin bright line offset toward the light
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
): void {
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
  const fitted = l.points.map((p) => ({ x: p.x + jx, y: p.y + jy }))
  const segments = catmullRomToBezier(fitted, 0.5)
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

    const p = sampleBezier(seg, localT)
    // Tangent from a finite difference on the same segment.
    const q = sampleBezier(seg, Math.min(1, localT + 0.02))
    const r = sampleBezier(seg, Math.max(0, localT - 0.02))
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

  /* ── 6. Metal clasp where the cord meets the badge ───────────────────── */
  drawClasp(ctx, l, stress, alpha)
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
