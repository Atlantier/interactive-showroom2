import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Noise,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction, type ChromaticAberrationEffect } from 'postprocessing'
import { preloadR3FAdvance, setCanvasActive } from '@/lib/frameBridge'
import { supportsWebGL } from '@/lib/device'
import { getTransient, useAppStore } from '@/store/useAppStore'
import { CameraRig } from '@/components/canvas/CameraRig'
import { FlowFieldParticles } from '@/components/canvas/FlowFieldParticles'
import { CursorStardustTrail } from '@/components/canvas/CursorStardustTrail'
import { VolumetricStageLights } from '@/components/canvas/VolumetricStageLights'

/**
 * SceneCanvas — the full-viewport, fixed WebGL background.
 *
 * ── The single-clock rule ───────────────────────────────────────────────────
 * `frameloop="never"` is mandatory here. This app runs exactly one animation
 * loop: the Lenis RAF in `src/lib/scrollEngine.ts`. Each tick it advances the
 * inertial scroll, publishes progress/velocity to the transient store, and then
 * calls `advanceR3F(timestamp)` — which advances this canvas with the *same*
 * timestamp. Letting R3F start its own loop would create two clocks, and the
 * nebula would visibly lag the DOM scroll by a frame.
 *
 * (In `never` mode R3F's `invalidate()` is a no-op, so nothing can silently
 * restart a competing loop either.)
 *
 * ── Quality tiers ───────────────────────────────────────────────────────────
 * The 'high' tier is the design target; 'medium' is the escape hatch and is
 * reached either by device detection on boot or by the adaptive monitor below.
 * The three levers are chosen because each attacks a different bottleneck:
 *
 *   PARTICLES  8000 → 4000. Halves the vertex work and the additive fill, which
 *              is the dominant cost on integrated GPUs.
 *   DPR        up to 2× → exactly 1.0. On a 4K panel this cuts the fragment
 *              count by 4×, the single largest saving available.
 *   POST       Bloom + ChromaticAberration → Vignette only. Bloom's mipmap blur
 *              is several full-screen passes; on a 1× framebuffer those passes
 *              are still the most expensive thing in the pipeline.
 */

/** Particle counts per tier: halved on 'medium' as specified. */
const PARTICLE_COUNT = { high: 8000, medium: 4000 } as const

/**
 * Stardust-trail pool size per tier.
 *
 * Kept separate from `PARTICLE_COUNT` because the two effects scale for
 * different reasons: the nebula is a fill-rate cost across the whole viewport,
 * while the trail is a sparse plume whose pool only needs to hold one lifetime
 * of emission, so it is roughly half the size at every tier.
 */
const TRAIL_COUNT = { high: 4000, medium: 2000 } as const

/** Average fps below which the monitor steps the tier down. */
const DEGRADE_FPS = 45

/**
 * Monitor sampling geometry.
 *
 * `ms` is the interval between fps readings and `iterations` how many are kept,
 * so the analysis window is `MS * ITERATIONS` = 8 × 250 ms = **exactly the two
 * seconds the spec calls for**.
 *
 * Note that drei's `onChange` is NOT a periodic callback — it only fires when the
 * internal `factor` transitions. The periodic signal is `onDecline`, which is why
 * the threshold check lives there.
 */
const MONITOR_MS = 250
const MONITOR_ITERATIONS = 8

/**
 * Keep the renderer's pixel ratio in step with the tier.
 *
 * The `dpr` prop is applied when the Canvas configures itself; it is not
 * re-applied on an arbitrary re-render, so a tier change mid-session would leave
 * the framebuffer at its original resolution. This pushes it through explicitly,
 * which is the difference between the medium tier actually saving 4× the fragment
 * work on a 4K panel and merely claiming to.
 */
function DprSync({ max }: { max: number }) {
  const setDpr = useThree((state) => state.setDpr)
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    const ratio = Math.min(window.devicePixelRatio || 1, max)
    setDpr(ratio)
    // `setDpr` resizes through the store; the explicit call covers the case
    // where the store value is already correct but the drawing buffer is not.
    gl.setPixelRatio(ratio)
  }, [gl, setDpr, max])

  return null
}

/* -------------------------------------------------------------------------- */
/*  Motion-driven optical dispersion                                          */
/* -------------------------------------------------------------------------- */

/**
 * Ceiling on the fringe offset, in NDC. Well under a pixel at the canvas edge —
 * past roughly this value it stops reading as a lens and starts reading as a
 * rendering fault.
 */
const CA_MAX_OFFSET = 0.006

/** Offset per unit of scroll velocity (progress/second). */
const CA_SCROLL_GAIN = 0.0022

/** Offset per unit of pointer speed (NDC/second). */
const CA_MOUSE_GAIN = 0.0009

/** Exponential approach rate for the smoothed offset, per second. */
const CA_SMOOTHING = 7

/**
 * Optical dispersion that only exists while the page is in motion.
 *
 * A constant chromatic-aberration offset — the obvious implementation — makes
 * every line of text permanently soft, which is the opposite of the "text stays
 * absolutely crisp" requirement. So the resting offset is exactly zero and the
 * fringe is driven by the two things that would actually flex a real lens: fast
 * scrolling and a hard pointer sweep.
 *
 *   delta = min(0.006, k_scroll * |v_scroll| + k_mouse * |v_mouse|)
 *
 * Both signals come from the transient store, read once per frame — no React
 * subscription, so this costs nothing when idle.
 */
function DynamicChromaticAberration() {
  const effectRef = useRef<ChromaticAberrationEffect | null>(null)
  const current = useRef(0)
  const prevMouse = useRef({ x: 0, y: 0 })

  useFrame((_, rawDelta) => {
    const effect = effectRef.current
    if (!effect) return

    // Clamped so a long stall cannot turn one sample into a huge derivative.
    const dt = Math.min(rawDelta, 1 / 20)
    const transient = getTransient()

    const mouseSpeed = Math.min(
      6,
      Math.hypot(
        transient.mouse.x - prevMouse.current.x,
        transient.mouse.y - prevMouse.current.y,
      ) / Math.max(dt, 1 / 240),
    )
    prevMouse.current.x = transient.mouse.x
    prevMouse.current.y = transient.mouse.y

    const target = Math.min(
      CA_MAX_OFFSET,
      CA_SCROLL_GAIN * Math.abs(transient.scroll.velocity) + CA_MOUSE_GAIN * mouseSpeed,
    )

    // Exponential approach, so the fringe swells and recedes instead of snapping
    // on and off at the threshold.
    current.current += (target - current.current) * Math.min(1, dt * CA_SMOOTHING)

    /*
     * The horizontal component is deliberately smaller than the vertical one.
     * Real dispersion is radial — fringing grows toward the edges of the frame —
     * and a slight axis split approximates that falloff without paying for a
     * per-pixel radial term in the shader.
     */
    effect.offset.set(current.current * 0.6, current.current)
  })

  return (
    <ChromaticAberration
      ref={effectRef}
      offset={[0, 0]}
      radialModulation={false}
      modulationOffset={0}
      blendFunction={BlendFunction.NORMAL}
    />
  )
}

export function SceneCanvas() {
  const tier = useAppStore((state) => state.performanceTier)
  const degrade = useAppStore((state) => state.degradePerformanceTier)
  const [webgl, setWebgl] = useState(false)

  // Probe once on the client so restricted/SSR environments never crash.
  useEffect(() => {
    setWebgl(supportsWebGL())
    preloadR3FAdvance()
  }, [])

  // Safety net: if this canvas unmounts, stop advancing it.
  useEffect(() => () => setCanvasActive(false), [])

  /**
   * Adaptive downgrade.
   *
   * ── Why the check is in `onDecline` and not `onChange` ────────────────────
   * drei's `onChange` fires only when the internal `factor` transitions, not on
   * every sampling window — so a machine sitting steadily at 30 fps would never
   * trigger it. `onDecline` is the periodic signal.
   *
   * `api.averages` holds the last `MONITOR_ITERATIONS` one-per-`MONITOR_MS`
   * readings, i.e. the two-second window. The mean of that window is checked
   * explicitly rather than trusting drei's bounds heuristic: the requirement is
   * "the two-second AVERAGE is below 45", and bounds fire on a majority-below
   * test, which is not the same thing.
   */
  const handleDecline = useCallback(
    (api: { averages: number[] }) => {
      const samples = api.averages
      if (!samples.length) return
      let total = 0
      for (let i = 0; i < samples.length; i++) total += samples[i]
      const average = total / samples.length
      if (average >= DEGRADE_FPS) return
      degrade(
        `最近 ${((MONITOR_MS * MONITOR_ITERATIONS) / 1000).toFixed(0)} 秒平均 ${average.toFixed(0)} FPS，低于 ${DEGRADE_FPS} FPS 阈值`,
      )
    },
    [degrade],
  )

  const particleCount = PARTICLE_COUNT[tier]
  const trailCount = TRAIL_COUNT[tier]
  const highQuality = tier === 'high'

  /**
   * Dev-only quality probe.
   *
   * Publishes what the tier actually changed so verification can assert on the
   * renderer's real configuration — particle count, pixel ratio and which post
   * effects are mounted — instead of inferring them from a screenshot or trusting
   * that the conditional rendered. Assignment goes onto the same
   * `__showroomScene` handle the other canvases already expose; stripped from
   * production by the DEV guard.
   *
   * Registered ABOVE the `if (!webgl)` early return. Putting a hook after a
   * conditional return changes the hook count between the first render (webgl
   * false) and the second (webgl true), and React throws "Rendered more hooks
   * than during the previous render" — which took the whole tree down.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const host = window as unknown as { __showroomScene?: Record<string, unknown> }
    if (!host.__showroomScene) return
    host.__showroomScene.quality = {
      tier,
      particleCount,
      trailCount,
      highQuality,
      effects: highQuality
        ? ['Bloom', 'ChromaticAberration', 'Vignette']
        : ['Vignette'],
    }
  })

  if (!webgl) return null

  return (
    <Canvas
      frameloop="never"
      /**
       * `dpr={[1, 2]}` on 'high': never below 1× (blurry) or above 2× (pointless
       * on a 4K panel and very expensive with thousands of additive sprites).
       * 'medium' pins it to exactly 1.0, per the adaptive-quality spec.
       */
      dpr={highQuality ? [1, 2] : 1}
      camera={{ position: [0, 0, 7.4], fov: 45, near: 0.1, far: 100 }}
      gl={{
        antialias: false, // additive point sprites do not need MSAA
        alpha: true,
        powerPreference: 'high-performance',
        stencil: false,
        depth: true,
      }}
      onCreated={({ gl, scene, camera, size }) => {
        // Transparent so the DOM's ambient gradient layers show through.
        gl.setClearColor(0x000000, 0)

        setCanvasActive(true)

        // Dev-only inspection handle. R3F v9 no longer hangs its root store off
        // the canvas element, which makes the scene graph unreachable from the
        // console and from headless verification scripts. Exposing it here costs
        // nothing (a single assignment at mount) and makes the live scene
        // inspectable. Stripped from production bundles by the DEV guard.
        if (import.meta.env.DEV) {
          ;(window as unknown as { __showroomScene?: unknown }).__showroomScene = {
            scene,
            camera,
            gl,
            size,
            /**
             * Seeded here as well as from the effect below.
             *
             * The effect only runs when `SceneCanvas` re-renders, and this handle
             * does not exist until `onCreated` — so on a page that never changes
             * tier the effect's first (and only) run would fire before the handle
             * exists, bail on the guard, and never write anything. Writing the
             * initial value here guarantees it is present regardless.
             */
            quality: {
              tier,
              particleCount,
              trailCount,
              highQuality,
              effects: highQuality
                ? ['Bloom', 'ChromaticAberration', 'Vignette']
                : ['Vignette'],
            },
          }
        }
      }}
      className="!fixed !inset-0 !h-full !w-full"
      style={{ pointerEvents: 'none' }}
    >
      <PerformanceMonitor
        ms={MONITOR_MS}
        iterations={MONITOR_ITERATIONS}
        // Lower bound is the degrade threshold; the upper bound only has to sit
        // above it. `threshold` is the fraction of the window that must fall
        // below `lower` before the decline callback fires at all.
        bounds={() => [DEGRADE_FPS, DEGRADE_FPS + 15]}
        threshold={0.5}
        onDecline={handleDecline}
      />

      <DprSync max={highQuality ? 2 : 1} />
      <CameraRig />
      <FlowFieldParticles tier={tier} count={particleCount} />

      {/*
       * God rays for the first screen. This canvas is the always-mounted
       * background, so the rig fades itself out as the hero scrolls away —
       * otherwise the beams would shine through every later chapter.
       */}
      <VolumetricStageLights tier={tier} height={7} intensity={1} fadeWithScroll />

      {/*
       * Cursor stardust. Last in the scene graph on purpose: it is an additive
       * overlay drawn with `depthTest: false`, so it composites on top of the
       * nebula rather than being occluded by it.
       */}
      <CursorStardustTrail tier={tier} count={trailCount} />

      <Suspense fallback={null}>
        <EffectComposer multisampling={0} enableNormalPass={false}>
          {highQuality ? (
            <>
              <Bloom
                /*
                 * The threshold sits deliberately low: every glowing mote, comet
                 * beam and wireframe edge in the scene is above it, so they all
                 * feed the mipmap chain and bleed a soft multi-octave halo
                 * instead of only the brightest cores doing so.
                 */
                luminanceThreshold={0.15}
                intensity={1.2}
                // Soften the knee so the bloom ramps in instead of clipping.
                luminanceSmoothing={0.28}
                mipmapBlur
                radius={0.78}
              />
              <DynamicChromaticAberration />
            </>
          ) : (
            <></>
          )}
          <Vignette
            eskil={false}
            offset={0.2}
            darkness={0.78}
            blendFunction={BlendFunction.NORMAL}
          />
          {/*
           * Film grain. Kept at 0.025, which is enough to break the banding that
           * large additive gradients show on 8-bit output, and low enough to be
           * invisible on its own. OVERLAY rather than NORMAL so it modulates the
           * existing image instead of veiling it.
           *
           * Tier-gated with the rest of the expensive post stack: grain buys a
           * little polish but costs a full-screen pass, which is the wrong trade
           * on integrated graphics where the fps target is the thing at risk.
           */}
          {highQuality && (
            <Noise premultiply opacity={0.025} blendFunction={BlendFunction.OVERLAY} />
          )}
        </EffectComposer>
      </Suspense>
    </Canvas>
  )
}

export default SceneCanvas
