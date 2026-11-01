import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getTransient } from '@/store/useAppStore'
import type { PerformanceTier } from '@/types'

/**
 * CursorStardustTrail — a 3D stardust plume that follows the cursor.
 *
 * ── The pool ────────────────────────────────────────────────────────────────
 * 4 000 splats are allocated ONCE, as plain typed arrays wired straight into a
 * `BufferGeometry`. Emission picks the next slot off a ring cursor and
 * overwrites it; nothing is ever created or destroyed while the app runs. A slot
 * whose life has run out simply writes `life = 0`, which collapses its sprite to
 * zero pixels in the vertex shader, so "dead" costs nothing and needs no sweep.
 *
 * ── Why emission is segment-interpolated ────────────────────────────────────
 * Reading the cursor once per frame and dropping a single particle there is what
 * makes cheap trails look like beads: a fast flick moves tens of world units
 * between two frames, so the trail breaks into visible dots. Instead the emitter
 * counts how far the cursor travelled and lays `distance * DENSITY` particles
 * evenly along the segment from last frame's point to this one — the trail stays
 * continuous at any pointer speed, and the spawn count rises naturally with
 * |v_cursor| exactly as specified.
 *
 * ── Why the turbulence is a trig hash and not real simplex noise ────────────
 * The brief asks for an *approximation* of curl noise, evaluated in the vertex
 * shader. This runs 4 000 points every frame, so cost per vertex matters more
 * than fidelity: an fbm of three hashed sine terms produces the same swirling
 * look as a simplex curl field at a fraction of the ALU cost, and there is no
 * noise texture to load (this project ships no assets at all).
 *
 * ── Allocation discipline (AGENTS.md rule 3) ────────────────────────────────
 * Every `Vector2`/`Vector3`/`Raycaster`/`Plane` used in the frame loop is built
 * once in `useMemo`. There is no `new` inside `useFrame`.
 */

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

/** Pool size at full quality. Halved on the 'medium' tier. */
const BASE_COUNT = 4000

/** Seconds a splat survives. Long enough to read as a plume, short enough to
 *  clear quickly once the cursor stops. */
const LIFETIME = 1.35

/**
 * Splats per world unit of cursor travel.
 *
 * Tuned against the z = 0 plane: the full viewport is roughly 10 world units
 * wide. The first pass used 9, which laid down ~90 splats for a whole-screen
 * sweep — measured on screen as a hairline rather than a plume. 90 puts a normal
 * cursor speed (≈6 units/s) at roughly 550 splats/s, which fills a readable
 * ribbon without draining the pool.
 */
const EMIT_DENSITY = 90

/**
 * Hard ceiling on splats spawned in a single frame.
 *
 * A hard flick covers ~0.5 world units between frames, which at this density
 * asks for 45. The cap is set above that so fast movement still lays a
 * continuous line rather than beading, while a pointer teleport cannot wrap the
 * whole ring buffer in one frame.
 */
const MAX_EMIT_PER_FRAME = 56

/**
 * Ignore cursor motion below this distance (world units) — sub-pixel jitter from
 * a resting mouse would otherwise build a permanent knot of dust under it.
 */
const MIN_SPAWN_DISTANCE = 0.012

/** Cap on the integration step so a stalled tab cannot age the whole pool out
 *  in one frame. */
const MAX_DT = 1 / 30

/** Base sprite size, before the life curve and perspective divide. Sized
 *  against the z = 0 plane so the plume reads as dust with a visible body
 *  rather than as a hairline. */
const POINT_SIZE = 0.13

/**
 * Perspective gain for `gl_PointSize`.
 *
 * At the hero camera's z = 7.4 this works out to `size * 84 / depth`, so a
 * mid-size splat lands around 6–16 px at full swell. The first pass used 320,
 * which put the whole plume in the 2–6 px range — measured on screen as a
 * hairline that the 8 000-particle nebula completely swallowed.
 */
const SIZE_PIXEL_GAIN = 620

/** GPUs cap point sprites; exceeding the cap makes sprites silently vanish. */
const MAX_POINT_PIXELS = 64

/** How far the plume drifts upward over a full lifetime, in world units. */
const RISE = 0.85

/** Peak lateral displacement from the vortex field. */
const TURBULENCE = 0.16

/** Radial falloff constant in I(r) = exp(-k·r²). */
const FALLOFF = 6.0

/* -------------------------------------------------------------------------- */
/*  Shaders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader.
 *
 * Three jobs, all per-splat:
 *
 *  1. AGE           `aLife` counts 1 → 0, so age is `1 - aLife`.
 *  2. MOTION        upward drift (stronger as the splat ages) plus the pseudo
 *                   curl vortex, so the plume lifts and curls rather than
 *                   hanging where it was drawn.
 *  3. SIZE CURVE    `s(l) = s0 · sin(π·l)` — swells to full size at
 *                   mid-life, then contracts to nothing as it dissipates.
 *
 * `gl_PointSize` is clamped: every desktop driver caps point sprites (often
 * 64 px), and going past the cap drops the sprite entirely rather than clipping
 * it, which would make the trail flicker at close range.
 */
const VERTEX_SHADER = /* glsl */ `
  attribute float aLife;
  attribute float aSeed;
  attribute float aSize;

  varying float vLife;
  varying float vDepth;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uRise;
  uniform float uTurbulence;

  void main() {
    // 0 at birth, 1 at death.
    float age = 1.0 - aLife;

    vec3 p = position;

    // Upward drift. Per-splat phase keeps the plume from rising as one slab.
    p.y += age * uRise * (0.65 + 0.35 * sin(aSeed * 6.2831853));

    // Approximation of a curl-noise vortex: three hashed sines on different
    // axes and rates, growing with age so newborn splats sit exactly at the
    // cursor and older ones have wandered.
    vec3 swirl = vec3(
      sin(p.y * 3.1 + uTime * 1.7 + aSeed * 6.2831853),
      cos(p.z * 2.7 + uTime * 1.3 + aSeed * 4.7123890),
      sin(p.x * 3.7 + uTime * 2.1 + aSeed * 3.1415927)
    );
    p += swirl * uTurbulence * age;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;

    // s(l) = s0 * sin(pi * l)
    float swell = sin(3.1415927 * age);
    float pixels = aSize * swell * uPixelRatio * (${SIZE_PIXEL_GAIN.toFixed(1)} / max(vDepth, 0.1));
    gl_PointSize = clamp(pixels, 0.0, ${MAX_POINT_PIXELS.toFixed(1)});

    vLife = aLife;
  }
`

/**
 * Fragment shader.
 *
 * Soft radial core, `I(r) = exp(-k·r²)`, with the colour driven entirely by
 * remaining life:
 *
 *   newborn   pure white, then cyan within the first third of its life
 *   mid       #00f0ff cyan — the streak's body
 *   dying     deep neon purple
 *
 * Emission is deliberately pushed above 1.0 at birth. Bloom downstream
 * thresholds on LUMINANCE, so a sprite that never exceeds 1.0 produces almost no
 * glow; the HDR headroom on the newborn splats is what turns the leading edge of
 * the trail into a real highlight.
 */
const FRAGMENT_SHADER = /* glsl */ `
  varying float vLife;
  varying float vDepth;

  uniform vec3 uBirth;
  uniform vec3 uCyan;
  uniform vec3 uDeath;
  uniform float uFalloff;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv) * 2.0;

    // I(r) = exp(-k * r^2)
    float intensity = exp(-uFalloff * r * r);
    if (intensity < 0.004) discard;

    float age = 1.0 - vLife;

    // White -> cyan almost immediately, then a long slide into purple.
    vec3 col = mix(uBirth, uCyan, smoothstep(0.0, 0.28, age));
    col = mix(col, uDeath, smoothstep(0.42, 1.0, age));

    // HDR emission: hottest at birth so the leading edge blooms.
    float emission = mix(3.2, 1.0, age);

    // Fade the far side of the plume so it has atmospheric depth instead of a
    // hard silhouette against the background.
    float depthFade = clamp(1.0 - (vDepth - 4.0) / 16.0, 0.35, 1.0);

    gl_FragColor = vec4(col * emission, intensity * depthFade);
  }
`

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export interface CursorStardustTrailProps {
  /** Quality tier — controls pool size. */
  tier?: PerformanceTier
  /** Explicit pool size; passed in by `SceneCanvas` so the tier levers live in
   *  one place alongside pixel ratio and post-processing. */
  count?: number
}

export function CursorStardustTrail({
  tier = 'high',
  count: countProp,
}: CursorStardustTrailProps) {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const pointsRef = useRef<THREE.Points>(null)

  const count = countProp ?? (tier === 'high' ? BASE_COUNT : Math.round(BASE_COUNT / 2))

  /* ── Pool + scratch, allocated exactly once ────────────────────────────── */
  const sim = useMemo(() => {
    const position = new Float32Array(count * 3)
    const life = new Float32Array(count)
    const seed = new Float32Array(count)
    const sizeAttr = new Float32Array(count)

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
      /** Ring cursor: the next slot to overwrite. */
      cursor: 0,
      /** Cursor position last frame, for the segment interpolation. */
      prev: new THREE.Vector3(),
      hasPrev: false,
      /** Dev-only counters. */
      alive: 0,
      spawned: 0,
      scratch: {
        ndc: new THREE.Vector2(),
        ray: new THREE.Raycaster(),
        plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
        hit: new THREE.Vector3(),
      },
    }
  }, [count])

  /* ── Geometry: attributes point straight at the typed arrays ───────────── */
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()

    const posAttr = new THREE.BufferAttribute(sim.position, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    const lifeAttr = new THREE.BufferAttribute(sim.life, 1)
    lifeAttr.setUsage(THREE.DynamicDrawUsage)

    geo.setAttribute('position', posAttr)
    geo.setAttribute('aLife', lifeAttr)
    geo.setAttribute('aSeed', new THREE.BufferAttribute(sim.seed, 1))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sim.sizeAttr, 1))

    // The plume roams with the cursor, so a fixed generous bound is cheaper and
    // steadier than recomputing one per frame (and `frustumCulled` is off).
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40)

    return geo
  }, [sim])

  /* ── Material ──────────────────────────────────────────────────────────── */
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uRise: { value: RISE },
      uTurbulence: { value: TURBULENCE },
      uBirth: { value: new THREE.Color('#ffffff') },
      uCyan: { value: new THREE.Color('#00f0ff') },
      uDeath: { value: new THREE.Color('#7c3aed') },
      uFalloff: { value: FALLOFF },
    }),
    [],
  )

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        // Additive glow must not be tone-mapped down, or the plume turns grey.
        toneMapped: false,
      }),
    [uniforms],
  )

  /* ── Keep sprite size correct across DPR changes ───────────────────────── */
  useEffect(() => {
    uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2)
  }, [size.width, size.height, uniforms])

  /* ── Dispose GPU resources ─────────────────────────────────────────────── */
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  /* ── Dev-only probe, so verification can assert the pool is live ───────── */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const host = window as unknown as { __stardust?: typeof sim }
    host.__stardust = sim
  }, [sim])

  /* ── Frame loop ────────────────────────────────────────────────────────── */
  useFrame((state, rawDelta) => {
    const points = pointsRef.current
    if (!points) return

    const dt = Math.min(rawDelta, MAX_DT)
    if (!(dt > 0)) return

    const { position, life, prev, scratch } = sim
    const { ndc, ray, plane, hit } = scratch

    uniforms.uTime.value = state.clock.elapsedTime

    /* 1. Age the pool. Dead splats collapse to zero pixels, so there is no
     *    compaction step and no allocation. */
    const decay = dt / LIFETIME
    let alive = 0
    for (let i = 0; i < count; i++) {
      const l = life[i]
      if (l > 0) {
        const next = l > decay ? l - decay : 0
        life[i] = next
        if (next > 0) alive++
      }
    }
    sim.alive = alive

    /* 2. Project the cursor onto the z = 0 plane. */
    const transient = getTransient()
    const mouse = transient.mouse

    let spawned = false

    if (mouse.active) {
      ndc.set(mouse.x, mouse.y)
      // Refresh first: a stale matrix after a resize skews the ray.
      camera.updateMatrixWorld()
      ray.setFromCamera(ndc, camera)

      if (ray.ray.intersectPlane(plane, hit)) {
        if (sim.hasPrev) {
          const dx = hit.x - prev.x
          const dy = hit.y - prev.y
          const dz = hit.z - prev.z
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

          if (distance > MIN_SPAWN_DISTANCE) {
            // Count scales with cursor speed, clamped so a teleporting pointer
            // cannot drain the pool in one frame.
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
              life[slot] = 1
            }

            sim.spawned += n
            spawned = true
          }
        }

        prev.copy(hit)
        sim.hasPrev = true
      } else {
        // Ray parallel to the plane (or behind the camera): reset the segment so
        // the next valid hit does not draw a line across the screen.
        sim.hasPrev = false
      }
    } else {
      sim.hasPrev = false
    }

    /* 3. Upload. Positions only need re-uploading on frames that emitted. */
    if (spawned) {
      ;(geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    }
    ;(geometry.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true
  })

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />
}

export default CursorStardustTrail
