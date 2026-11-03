import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { reportParticles } from '@/lib/perfMetrics'
import { getVfxPalette } from '@/lib/vfxPalette'
import { getTransient, useAppStore } from '@/store/useAppStore'
import type { PerformanceTier } from '@/types'

/**
 * CursorStardustTrail — the cursor's three-part signature.
 *
 *   STARDUST   a ring-buffered particle plume emitted along the pointer's path
 *   RIBBON     a tapered light band built from the last 24 cursor positions
 *   SHOCKWAVE  150 sparks on pointerdown
 *
 * The click ripple used to be a fourth layer here: a pool of three WebGL quads with their own
 * shader, billboarded at the click point. It was superseded by the DOM `ClickRipple`
 * (src/components/layout/ClickRipple.tsx) and its life uniform then had no writer left, so the
 * pool was built, iterated and disposed every session without ever becoming visible. Removed.
 *
 * All three share one piece of state — where the cursor is in world space — and
 * all three are additive overlays, so they live in one component rather than
 * three that would each have to raycast the pointer independently.
 *
 * ── The particle pool ───────────────────────────────────────────────────────
 * 4 000 splats allocated ONCE as typed arrays wired straight into a
 * `BufferGeometry`. Emission overwrites the next slot off a ring cursor; nothing
 * is created or destroyed while the app runs. A slot whose life has run out
 * simply carries `life = 0`, which collapses its sprite to zero pixels in the
 * vertex shader, so "dead" costs nothing and needs no sweep.
 *
 * ── Why emission is segment-interpolated ────────────────────────────────────
 * Reading the cursor once per frame and dropping a single particle there is what
 * makes cheap trails look like beads: a fast flick moves tens of world units
 * between two frames. Instead the emitter measures how far the cursor travelled
 * and lays `distance * DENSITY` particles evenly along the segment from last
 * frame's point to this one.
 *
 * ── Allocation discipline (AGENTS.md rule 3) ────────────────────────────────
 * Every `Vector2`/`Vector3`/`Raycaster`/`Plane` used in the frame loop is built
 * once in `useMemo`. There is no `new` inside `useFrame`.
 *
 * ── Colour source ──────────────────────────────────────────────────────────
 * Every hue in this component comes from the active Visual Overdrive palette
 * (`vfxPreset` in the store → `@/lib/vfxPalette`). The colours are pushed into
 * the existing `THREE.Color` uniforms by one effect, so switching preset only
 * mutates the colour values in place: the shader programs and the particle pool
 * keep their identity, and a plume already in flight keeps animating while its
 * hue changes.
 */

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

/** Pool size at full quality. Halved on the 'medium' tier. */
const BASE_COUNT = 4000

/** Seconds a stardust splat survives. */
const LIFETIME = 1.35

/** Burst sparks age this much faster than stardust, so a click reads as a snap
 *  rather than as a slow bloom. */
const SPARK_AGE_RATE = 1.7

/**
 * Splats per world unit of cursor travel.
 *
 * The viewport is roughly 10 world units wide at the cursor plane. An earlier
 * pass used 9, which laid down ~90 splats for a whole-screen sweep and measured
 * on screen as a hairline; 90 puts a normal cursor speed near 550 splats/s,
 * which fills a readable ribbon without draining the pool.
 */
const EMIT_DENSITY = 90

/** Hard ceiling on splats spawned in a single frame. */
const MAX_EMIT_PER_FRAME = 56

/** Ignore sub-pixel cursor jitter. */
const MIN_SPAWN_DISTANCE = 0.012

/**
 * Longest cursor segment that is still treated as real movement.
 *
 * `transient.mouse` no longer jumps when the pointer leaves and re-enters the
 * window -- the position EASES back from the centre, which is what removed the
 * teleport. But this component interpolates between the previous and current
 * cursor points and also keeps a 24-frame ribbon history, so without a guard that
 * ease is drawn as a single segment across the viewport: the trail slashes from
 * the middle of the screen to wherever the pointer came back in, and the ribbon
 * sweeps with it.
 *
 * A real fast flick covers a few tenths of a unit per frame; anything an order of
 * magnitude beyond that is a discontinuity, not a sample.
 */
const MAX_SEGMENT_DISTANCE = 0.9

/**
 * Pointer influence above which the cursor counts as settled.
 *
 * The engine eases `strength` from 0 to 1 after a re-entry and snaps it to exactly
 * 1 once it is within 1e-4, so this only excludes the recovery itself.
 */
const SETTLED_STRENGTH = 0.98

/** Cap on the integration step so a stalled tab cannot age the pool out at once. */
const MAX_DT = 1 / 30

/** Base sprite size, before the life curve and perspective divide. */
const POINT_SIZE = 0.13

/**
 * Perspective gain for `gl_PointSize`: at the hero camera's z = 7.4 this is
 * `size * 84 / depth`. The first pass used 320, which put every sprite in the
 * 2–6 px range where the 8 000-particle nebula swallowed the trail entirely.
 */
const SIZE_PIXEL_GAIN = 620

/** GPUs cap point sprites; exceeding the cap drops sprites rather than clipping. */
const MAX_POINT_PIXELS = 72

/** How far the plume drifts upward over a full lifetime. */
const RISE = 0.85

/** Peak lateral displacement from the vortex field. */
const TURBULENCE = 0.16

/** Radial falloff constant in I(r) = exp(-k·r²). */
const FALLOFF = 6.0

/* ── Ribbon ────────────────────────────────────────────────────────────────── */

/** Cursor history depth, as specified. 24 frames ≈ 0.4 s at 60 Hz. */
const RIBBON_POINTS = 24

/** Half-width of the ribbon at its head, in world units. At the hero camera's
 *  z = 7.4 this is roughly 27 px each side — wide enough to read as a band
 *  rather than as a second trail. */
const RIBBON_WIDTH = 0.19

/**
 * Cross-sections along the band.
 *
 * The band is no longer drawn through the 24 history points directly -- that gave
 * one straight segment per frame sample, which is what made fast flicks look
 * faceted and "blocky". The history now feeds a Catmull-Rom spline that is
 * resampled at this many cross-sections, so the curvature is smooth regardless of
 * how fast the pointer moved.
 */
const RIBBON_SEGMENTS = RIBBON_POINTS * 3

/* -------------------------------------------------------------------------- */
/*  Particle shaders                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader.
 *
 *   AGE        `aLife` counts 1 → 0, so age is `1 - aLife`.
 *   BURST      spark displacement decelerates: d(a) = 1-(1-a)² has derivative
 *              2(1-a), i.e. launched fast and coasting to rest. Stardust passes
 *              a zero velocity and is unaffected.
 *   DRIFT      upward motion plus the curl-vortex approximation, scaled down for
 *              sparks because their burst already carries them outward.
 *   SIZE       `s(l) = s0 · sin(π·l)` — swells to full size at mid-life, then
 *              contracts to nothing as it dissipates.
 */
const PARTICLE_VERTEX = /* glsl */ `
  attribute float aLife;
  attribute float aSeed;
  attribute float aSize;
  attribute vec3 aVel;
  attribute float aKind;

  varying float vLife;
  varying float vSeed;
  varying float vKind;
  varying float vDepth;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uRise;
  uniform float uTurbulence;

  void main() {
    // 0 at birth, 1 at death.
    float age = 1.0 - aLife;

    vec3 p = position;

    // Burst flight, decelerating to a stop. Zero for stardust.
    p += aVel * (1.0 - pow(1.0 - age, 2.0));

    // Upward drift. Per-splat phase keeps the plume from rising as one slab.
    p.y += age * uRise * (1.0 - aKind) * (0.65 + 0.35 * sin(aSeed * 6.2831853));

    // Approximation of a curl-noise vortex: three hashed sines on different axes
    // and rates, growing with age so newborn splats sit exactly at the cursor.
    vec3 swirl = vec3(
      sin(p.y * 3.1 + uTime * 1.7 + aSeed * 6.2831853),
      cos(p.z * 2.7 + uTime * 1.3 + aSeed * 4.7123890),
      sin(p.x * 3.7 + uTime * 2.1 + aSeed * 3.1415927)
    );
    p += swirl * uTurbulence * age * (1.0 - aKind * 0.6);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;

    // s(l) = s0 * sin(pi * l)
    float swell = sin(3.1415927 * age);
    float pixels = aSize * swell * uPixelRatio * (${SIZE_PIXEL_GAIN.toFixed(1)} / max(vDepth, 0.1));
    gl_PointSize = clamp(pixels, 0.0, ${MAX_POINT_PIXELS.toFixed(1)});

    vLife = aLife;
    vSeed = aSeed;
    vKind = aKind;
  }
`

/**
 * Fragment shader.
 *
 * Soft radial core, `I(r) = exp(-k·r²)`, with colour driven by remaining life.
 *
 *   stardust   palette core at birth → secondary body → accent as it dies
 *   spark      primary ↔ secondary, flickering per particle (the "闪烁" the
 *              brief asks for), held near full brightness for its whole short
 *              life
 *
 * The four hues are uniforms rather than literals because the Visual Overdrive
 * palette can change while this shader is live; the CPU effect below rewrites
 * them in place. Emission is pushed above 1.0 on newborn splats. Bloom
 * downstream thresholds on LUMINANCE, so a sprite that never exceeds 1.0
 * produces almost no glow; the HDR headroom is what turns the leading edge into
 * a real highlight.
 */
const PARTICLE_FRAGMENT = /* glsl */ `
  varying float vLife;
  varying float vSeed;
  varying float vKind;
  varying float vDepth;

  uniform float uTime;
  uniform vec3 uCore;
  uniform vec3 uSecondary;
  uniform vec3 uEdge;
  uniform vec3 uPrimary;
  uniform float uFalloff;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv) * 2.0;

    // I(r) = exp(-k * r^2)
    float intensity = exp(-uFalloff * r * r);
    if (intensity < 0.004) discard;

    float age = 1.0 - vLife;
    vec3 col;
    float emission;

    if (vKind > 0.5) {
      // Burst spark: the palette's two leading hues interleaved, flickering hard.
      float pick = 0.5 + 0.5 * sin(vSeed * 31.7);
      col = mix(uPrimary, uSecondary, pick);
      float flicker = 0.45 + 0.55 * sin(uTime * 42.0 + vSeed * 91.0);
      emission = 2.2 + flicker * 1.9;
    } else {
      // Core yields to the secondary almost immediately, then slides into the
      // accent for the long tail of its life.
      col = mix(uCore, uSecondary, smoothstep(0.0, 0.28, age));
      col = mix(col, uEdge, smoothstep(0.42, 1.0, age));
      emission = mix(3.2, 1.0, age);
    }

    // Fade the far side of the plume so it has atmospheric depth instead of a
    // hard silhouette against the background.
    float depthFade = clamp(1.0 - (vDepth - 4.0) / 16.0, 0.35, 1.0);

    gl_FragColor = vec4(col * emission, intensity * depthFade);
  }
`

/* -------------------------------------------------------------------------- */
/*  Ribbon shaders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The ribbon is a triangle strip rebuilt every frame from the cursor history.
 * Positions are written on the CPU (24 points, 48 vertices — trivial), so the
 * vertex stage is a straight pass-through; `vUv.y` runs across the width and
 * `vAlong` runs from tail to head.
 */
const RIBBON_VERTEX = /* glsl */ `
  attribute float aAlong;
  varying vec2 vUv;
  varying float vAlong;

  void main() {
    vUv = uv;
    vAlong = aAlong;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/**
 * The width profile is `core = (1 - |2v-1|)^1.6`, i.e. a soft-edged band rather
 * than a hard strip — a flat quad would read as a coloured ribbon of paper. The
 * `vAlong²` factor makes the head hot and the tail dissolve, and `uFade` kills
 * the whole thing when the cursor stops moving (the history collapses, and a
 * degenerate ribbon must not linger).
 *
 * The cold→hot gradient is palette-driven through uniforms (primary at the tail,
 * secondary at the head) for the same reason as the stardust: the ribbon must
 * re-tint live without rebuilding its material.
 */
const RIBBON_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vAlong;

  uniform float uFade;
  uniform vec3 uCold;
  uniform vec3 uHot;

  void main() {
    /*
     * Lateral feather.
     *
     * abs(vUv.y - 0.5) is 0 on the centreline and 0.5 at either edge, so
     * smoothstep(0.5, 0.0, ..) gives a full-strength centre falling to nothing
     * exactly at the edge. Squaring it keeps the bright core narrow and the
     * falloff long, which is what removes the hard polygon edge the flat
     * pow(edge, 1.6) band still showed at speed.
     */
    float edge = smoothstep(0.5, 0.0, abs(vUv.y - 0.5));
    float core = edge * edge;

    // Along-axis: solid at the head, dissolving into the stardust at the tail.
    float along = pow(vAlong, 1.35);

    float alpha = core * along * uFade * 1.6;
    if (alpha < 0.004) discard;

    vec3 col = mix(uCold, uHot, vAlong);

    // The head is driven hotter so the leading edge reads as energy rather than
    // as a coloured strip.
    gl_FragColor = vec4(col * (1.0 + vAlong * 1.9), alpha);
  }
`

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export interface CursorStardustTrailProps {
  /** Quality tier — controls pool size. */
  tier?: PerformanceTier
  /** Explicit pool size, passed in by `SceneCanvas` so the tier levers live in
   *  one place alongside pixel ratio and post-processing. */
  count?: number
}

export function CursorStardustTrail({ tier = 'high', count: countProp }: CursorStardustTrailProps) {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  /*
   * The renderer's DPR, not `window.devicePixelRatio`.
   *
   * They are not the same number: the performance tier caps the renderer's pixel
   * ratio (medium runs at 1.0), while `window.devicePixelRatio` keeps reporting the
   * display's value. Sizing sprites from the window value meant the "low" tier still
   * drew 2x sprites, so downgrading saved about half the fill rate instead of the
   * ~8x it was designed to save. Reading it from the R3F viewport keeps the shader in
   * step with whatever the renderer actually uses, including a live DPR change.
   */
  const dpr = useThree((state) => state.viewport.dpr)
  const pointsRef = useRef<THREE.Points>(null)
  const ribbonRef = useRef<THREE.Mesh>(null)

  const count = countProp ?? (tier === 'high' ? BASE_COUNT : Math.round(BASE_COUNT / 2))

  /*
   * Publish the pool size to the shared perf registry.
   *
   * The telemetry HUD sums every registered canvas, so this canvas reports
   * under its own kind instead of clobbering the nebula's count. The ring
   * buffer is allocated in full, so the pool size is the contribution this
   * canvas makes to the live particle total.
   */
  useEffect(() => {
    reportParticles('trail', count)
  }, [count])

  /* ── Visual Overdrive palette ──────────────────────────────────────────── */
  // One selector subscription is enough for both visual layers: stardust and
  // ribbon are siblings in this component, so a single render on a preset change
  // re-syncs every colour uniform in one effect below.
  const vfxPreset = useAppStore((state) => state.vfxPreset)
  const palette = getVfxPalette(vfxPreset)

  /* ── Particle pool + scratch, allocated exactly once ───────────────────── */
  const sim = useMemo(() => {
    const position = new Float32Array(count * 3)
    const life = new Float32Array(count)
    const seed = new Float32Array(count)
    const sizeAttr = new Float32Array(count)
    /** Per-particle flight velocity, used only by burst sparks. */
    const velocity = new Float32Array(count * 3)
    /** 0 = stardust, 1 = burst spark. */
    const kind = new Float32Array(count)

    // xorshift32: deterministic, and keeps the pool identical across
    // StrictMode/HMR remounts.
    let s = 0x9e3779b9
    const rand = (): number => {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      return s / 4294967296
    }

    for (let i = 0; i < count; i++) {
      seed[i] = rand()
      // A wide size spread is what makes the plume read as dust rather than as
      // a uniform band.
      sizeAttr[i] = POINT_SIZE * (0.55 + Math.pow(rand(), 2.0) * 1.15)
    }

    return {
      position,
      life,
      seed,
      sizeAttr,
      velocity,
      kind,
      /** Ring cursor: the next slot to overwrite. */
      cursor: 0,
      /** Cursor position last frame, for segment interpolation. */
      prev: new THREE.Vector3(),
      hasPrev: false,
      /** Runtime RNG for bursts — a cheap LCG keeps the frame loop
       *  allocation-free and avoids touching `Math.random` per spark. */
      rand: (): number => {
        simRandState.v = (simRandState.v * 1664525 + 1013904223) >>> 0
        return simRandState.v / 4294967296
      },
      /** Pending click, consumed on the next frame. */
      pendingBurst: { active: false, x: 0, y: 0, z: 0 },
      /** Dev-only counters. */
      alive: 0,
      spawned: 0,
      bursts: 0,
      scratch: {
        ndc: new THREE.Vector2(),
        ray: new THREE.Raycaster(),
        plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
        hit: new THREE.Vector3(),
      },
    }
  }, [count])

  /* ── Particle geometry ─────────────────────────────────────────────────── */
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()

    const dynamic = (array: Float32Array, itemSize: number): THREE.BufferAttribute => {
      const attr = new THREE.BufferAttribute(array, itemSize)
      attr.setUsage(THREE.DynamicDrawUsage)
      return attr
    }

    geo.setAttribute('position', dynamic(sim.position, 3))
    geo.setAttribute('aLife', dynamic(sim.life, 1))
    geo.setAttribute('aVel', dynamic(sim.velocity, 3))
    geo.setAttribute('aKind', dynamic(sim.kind, 1))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(sim.seed, 1))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sim.sizeAttr, 1))

    // The plume roams with the cursor, so a fixed generous bound is cheaper and
    // steadier than recomputing one per frame (`frustumCulled` is off anyway).
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 48)

    return geo
  }, [sim])

  /* ── Particle material ─────────────────────────────────────────────────── */
  const particleUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uRise: { value: RISE },
      uTurbulence: { value: TURBULENCE },
      /*
       * Palette colours are seeded from the live preset at mount and then kept
       * in sync by the colour effect below. They are intentionally NOT useMemo
       * dependencies: rebuilding the uniforms would rebuild the material and
       * recompile the program, and a palette switch only changes four colours.
       */
      uCore: { value: new THREE.Color(palette.particleCore) },
      uSecondary: { value: new THREE.Color(palette.secondary) },
      uEdge: { value: new THREE.Color(palette.accent) },
      uPrimary: { value: new THREE.Color(palette.primary) },
      uFalloff: { value: FALLOFF },
    }),
    [],
  )

  const particleMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: particleUniforms,
        vertexShader: PARTICLE_VERTEX,
        fragmentShader: PARTICLE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        // Additive glow must not be tone-mapped down, or the plume turns grey.
        toneMapped: false,
      }),
    [particleUniforms],
  )

  /* ── Ribbon geometry, rebuilt in place every frame ─────────────────────── */
  const ribbon = useMemo(() => {
    /** Cursor history, oldest first. The spline reads these by reference. */
    const history = Array.from({ length: RIBBON_POINTS }, () => new THREE.Vector3())

    /*
     * The spline is built ONCE over the history array.
     *
     * CatmullRomCurve3 holds references to those Vector3s rather than copies, so
     * shifting the history in place moves the curve with it -- no per-frame
     * allocation, no rebuild.
     *
     * 'centripetal' parameterisation instead of the default: uniform
     * parameterisation produces loops and cusps when consecutive samples bunch up,
     * which is exactly what a fast flick interrupted by a slow frame looks like.
     */
    const curve = new THREE.CatmullRomCurve3(history, false, 'centripetal')

    const positions = new Float32Array(RIBBON_SEGMENTS * 2 * 3)
    const uvs = new Float32Array(RIBBON_SEGMENTS * 2 * 2)
    const along = new Float32Array(RIBBON_SEGMENTS * 2)

    for (let i = 0; i < RIBBON_SEGMENTS; i++) {
      const t = i / (RIBBON_SEGMENTS - 1)
      along[i * 2] = t
      along[i * 2 + 1] = t
      uvs[i * 4] = t
      uvs[i * 4 + 1] = 0
      uvs[i * 4 + 2] = t
      uvs[i * 4 + 3] = 1
    }

    // Two triangles per quad between consecutive cross-sections.
    const indices: number[] = []
    for (let i = 0; i < RIBBON_SEGMENTS - 1; i++) {
      const a = i * 2
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }

    const geo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(positions, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1))
    geo.setIndex(indices)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 48)

    /*
     * Scratch, allocated once.
     *
     * `samplePoints` is a full row of cross-section positions rather than a single
     * reusable vector, because the tangent is now derived from the neighbouring
     * samples instead of from `curve.getTangent()`.
     */
    const samplePoints = Array.from({ length: RIBBON_SEGMENTS }, () => new THREE.Vector3())

    return { history, curve, positions, geo, posAttr, samplePoints }
  }, [])

  /**
   * Ribbon uniforms.
   *
   * `uCold`/`uHot` are the palette gradient endpoints; they are seeded here and
   * mutated in place by the palette effect below, so the ribbon keeps one
   * material identity across a preset switch.
   */
  const ribbonUniforms = useMemo(
    () => ({
      uFade: { value: 0 },
      uCold: { value: new THREE.Color(palette.primary) },
      uHot: { value: new THREE.Color(palette.secondary) },
    }),
    [],
  )

  const ribbonMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: ribbonUniforms,
        vertexShader: RIBBON_VERTEX,
        fragmentShader: RIBBON_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [ribbonUniforms],
  )
  /* ── Palette → every colour uniform, in place ───────────────────────────── */
  /**
   * One effect re-tints all three layers at once.
   *
   * WHY mutate instead of rebuilding: these materials and their shader programs
   * are created once for the whole session. Recreating them on a preset change
   * would dispose/recompile programs, and a plume already in flight would lose
   * its uniforms mid-animation. `THREE.Color.set` only rewrites the RGB values the
   * uniforms already point at, so the visual change lands on the very next frame
   * with no rebuild at all.
   */
  useEffect(() => {
    particleUniforms.uCore.value.set(palette.particleCore)
    particleUniforms.uSecondary.value.set(palette.secondary)
    particleUniforms.uEdge.value.set(palette.accent)
    particleUniforms.uPrimary.value.set(palette.primary)

    ribbonUniforms.uCold.value.set(palette.primary)
    ribbonUniforms.uHot.value.set(palette.secondary)
  }, [palette, particleUniforms, ribbonUniforms])

  /* ── Keep sprite size correct across DPR changes ───────────────────────── */
  useEffect(() => {
    particleUniforms.uPixelRatio.value = dpr
  }, [size.width, size.height, particleUniforms, dpr])

  /* ── Dispose every GPU resource we created ─────────────────────────────── */
  useEffect(
    () => () => {
      geometry.dispose()
      particleMaterial.dispose()
      ribbon.geo.dispose()
      ribbonMaterial.dispose()
    },
    [geometry, particleMaterial, ribbon, ribbonMaterial],
  )

  /*
   * Click feedback deliberately lives elsewhere now.
   *
   * This component used to listen for `pointerdown` and fire a 150-spark sphere
   * burst plus an expanding holographic ring. That read as a game effect: on a
   * dark page the ring, the glow and the sparks all landed at once and competed
   * with the content the user had just clicked. The replacement is a single thin
   * Material-style ripple (src/components/layout/ClickRipple.tsx) — one ring, no
   * particles, no flash. Nothing here should re-introduce a click response.
   */

  /* ── Dev-only probe ────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __stardust?: typeof sim }).__stardust = sim
  }, [sim])

  /* ── Frame loop ────────────────────────────────────────────────────────── */
  useFrame((state, rawDelta) => {
    if (!pointsRef.current) return

    const dt = Math.min(rawDelta, MAX_DT)
    if (!(dt > 0)) return

    const { position, life, seed, velocity, kind, prev, scratch } = sim
    const { ndc, ray, plane, hit } = scratch
    const time = state.clock.elapsedTime
    particleUniforms.uTime.value = time

    /* 1. Age the pool. Dead splats collapse to zero pixels, so there is no
     *    compaction step. Sparks age faster than stardust. */
    const baseDecay = dt / LIFETIME
    let alive = 0
    for (let i = 0; i < count; i++) {
      const l = life[i]
      if (l > 0) {
        const decay = kind[i] > 0.5 ? baseDecay * SPARK_AGE_RATE : baseDecay
        const next = l > decay ? l - decay : 0
        life[i] = next
        if (next > 0) alive++
      }
    }
    sim.alive = alive

    /* 2. Resolve the cursor on the z = 0 plane. */
    const transient = getTransient()
    const mouse = transient.mouse

    let cursorValid = false
    camera.updateMatrixWorld()

    /*
     * Suspend the trail while the pointer influence is still easing back in.
     *
     * The eased position is the fix for the re-entry teleport, but it makes the
     * cursor travel most of the viewport over the ~0.5s recovery. A trail is a
     * MOTION effect, and 24 frames of that recovery spans a third of the screen --
     * which is the wedge that was being drawn. Nothing is lost by waiting: the
     * trail is meant to start where the pointer actually settles.
     */
    if (mouse.active && mouse.strength > SETTLED_STRENGTH) {
      ndc.set(mouse.x, mouse.y)
      ray.setFromCamera(ndc, camera)
      cursorValid = ray.ray.intersectPlane(plane, hit) !== null
    }

    /* 3. Emit stardust along the frame-to-frame segment. */
    let spawned = false

    /*
     * The history has to be restarted whenever the cursor reappears, not merely
     * when the step is large.
     *
     * `hasPrev` is false on the first valid frame after the pointer comes back,
     * and the ribbon still holds the 24 points recorded before it left -- which is
     * why the guard alone still drew a wedge from the old position to the new one.
     * Starting from `!hasPrev` covers that case and the large-step case below.
     */
    let resetHistory = !sim.hasPrev

    if (cursorValid) {
      if (sim.hasPrev) {
        const dx = hit.x - prev.x
        const dy = hit.y - prev.y
        const dz = hit.z - prev.z
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (distance > MAX_SEGMENT_DISTANCE) resetHistory = true

        if (!resetHistory && distance > MIN_SPAWN_DISTANCE) {
          let n = Math.round(distance * EMIT_DENSITY)
          if (n < 1) n = 1
          else if (n > MAX_EMIT_PER_FRAME) n = MAX_EMIT_PER_FRAME

          for (let k = 0; k < n; k++) {
            // Evenly spaced along last frame's point -> this frame's point.
            // This is what removes the beading on fast movement.
            const t = (k + 1) / n
            const slot = sim.cursor
            sim.cursor = slot + 1 === count ? 0 : slot + 1

            const i3 = slot * 3
            position[i3] = prev.x + dx * t
            position[i3 + 1] = prev.y + dy * t
            position[i3 + 2] = prev.z + dz * t
            velocity[i3] = 0
            velocity[i3 + 1] = 0
            velocity[i3 + 2] = 0
            kind[slot] = 0
            life[slot] = 1
            seed[slot] = sim.rand()
          }

          sim.spawned += n
          spawned = true
        }
      }
      prev.copy(hit)
      sim.hasPrev = true
    } else {
      sim.hasPrev = false
    }

    /* 4. (was: consume a queued click — see the note where the listener used to
     *    live; click feedback is now a single thin ripple outside WebGL.) */

    /* 5. Upload the particle buffers. */
    if (spawned) {
      ;(geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
      ;(geometry.getAttribute('aVel') as THREE.BufferAttribute).needsUpdate = true
      ;(geometry.getAttribute('aKind') as THREE.BufferAttribute).needsUpdate = true
      ;(geometry.getAttribute('aSeed') as THREE.BufferAttribute).needsUpdate = true
    }
    ;(geometry.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true

    /* 6. Ribbon: shift the 24-frame history and rebuild the strip in place. */
    const { history, positions, posAttr } = ribbon
    const target = cursorValid ? hit : prev

    if (cursorValid) {
      if (resetHistory) {
        // Restart the history at the new point rather than letting the strip
        // stretch from the old one: every entry coinciding makes `span` zero, so
        // `uFade` collapses and nothing is drawn this frame.
        for (let i = 0; i < RIBBON_POINTS; i++) history[i].copy(target)
      } else {
        for (let i = 0; i < RIBBON_POINTS - 1; i++) history[i].copy(history[i + 1])
        history[RIBBON_POINTS - 1].copy(target)
      }
    }

    // Total span of the history — the ribbon must vanish when the cursor stops,
    // because every point then coincides and the strip has no area.
    const head = history[RIBBON_POINTS - 1]
    const tail = history[0]
    const span = Math.sqrt((head.x - tail.x) ** 2 + (head.y - tail.y) ** 2 + (head.z - tail.z) ** 2)
    let fade = span * 2.2
    if (fade > 1) fade = 1
    if (!cursorValid) fade = 0
    ribbonUniforms.uFade.value = fade

    if (fade > 0.002) {
      const { curve, samplePoints } = ribbon

      /*
       * Pass 1: the cross-section positions.
       *
       * Pass 2 derives each tangent by differencing its neighbours instead of calling
       * `curve.getTangent()`. three's implementation evaluates `getPoint` twice with
       * fresh temporaries per call, so the previous version allocated four Vector3 per
       * sample -- 288 objects per frame for a 72-sample ribbon, in a file whose whole
       * contract is "no per-frame garbage".
       */
      for (let i = 0; i < RIBBON_SEGMENTS; i++) {
        curve.getPoint(i / (RIBBON_SEGMENTS - 1), samplePoints[i])
      }

      for (let i = 0; i < RIBBON_SEGMENTS; i++) {
        const u = i / (RIBBON_SEGMENTS - 1)
        const samplePoint = samplePoints[i]
        const prevPoint = samplePoints[i === 0 ? 0 : i - 1]
        const nextPoint = samplePoints[i === RIBBON_SEGMENTS - 1 ? i : i + 1]

        let tx = nextPoint.x - prevPoint.x
        let ty = nextPoint.y - prevPoint.y
        const len = Math.sqrt(tx * tx + ty * ty)

        // Degenerate (cursor stationary): fall back to a fixed direction so the
        // strip stays valid instead of emitting NaNs into the buffer.
        if (len < 1e-5) {
          tx = 1
          ty = 0
        } else {
          tx /= len
          ty /= len
        }

        // Perpendicular in the cursor plane.
        const px = -ty
        const py = tx

        // Width taper: full at the head, converging to a point at the tail. The
        // 1.5 exponent is what makes the band read as a contracting ribbon rather
        // than a strip with two parallel edges.
        const half = RIBBON_WIDTH * Math.pow(u, 1.5)

        const o = i * 6
        positions[o] = samplePoint.x + px * half
        positions[o + 1] = samplePoint.y + py * half
        positions[o + 2] = samplePoint.z
        positions[o + 3] = samplePoint.x - px * half
        positions[o + 4] = samplePoint.y - py * half
        positions[o + 5] = samplePoint.z
      }

      posAttr.needsUpdate = true
    }
    if (ribbonRef.current) ribbonRef.current.visible = fade > 0.002
  })

  return (
    <>
      <points
        ref={pointsRef}
        geometry={geometry}
        material={particleMaterial}
        frustumCulled={false}
      />

      {/*
       * The ribbon is a strip of 23 quads rebuilt every frame. `DoubleSide` is
       * required because the winding flips whenever the cursor doubles back on
       * itself.
       */}
      <mesh
        ref={ribbonRef}
        geometry={ribbon.geo}
        material={ribbonMaterial}
        frustumCulled={false}
        visible={false}
      />
    </>
  )
}

/**
 * Module-level RNG state for bursts.
 *
 * Kept outside the closure because `sim.rand` is recreated with the pool and
 * must not reset to the same sequence on every remount — a click storm would
 * then produce identical spark patterns.
 */
const simRandState = { v: 0x1f123bb5 }

export default CursorStardustTrail
