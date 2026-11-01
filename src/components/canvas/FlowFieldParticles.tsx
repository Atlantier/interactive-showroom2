import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { buildCurlVolume, sampleCurl, type CurlVolume } from '@/lib/curlNoise'
import { createSpring, stepSpring } from '@/lib/math'
import { DEFAULT_VFX_PRESET, getVfxPalette } from '@/lib/vfxPalette'
import { getTransient, useAppStore } from '@/store/useAppStore'
import { reportParticles } from '@/lib/perfMetrics'
import { soundEngine } from '@/utils/soundEngine'
import type { PerformanceTier } from '@/types'

/**
 * FlowFieldParticles — the centrepiece: a living nebula of glowing motes.
 *
 * ── System overview ─────────────────────────────────────────────────────────
 * 8 000 particles obey three forces, integrated on the CPU each frame:
 *
 *   1. CURL-NOISE FLOW      divergence-free drift → smoke-like folding.
 *   2. SPRING RETURN        under-damped Hooke spring toward the particle's
 *                           home position (on a slowly rotating torus knot).
 *   3. MOUSE REPULSION      inverse-square push away from the cursor, projected
 *                           onto the z = 0 plane via a Raycaster.
 *
 * ── Why the CPU and not a shader ────────────────────────────────────────────
 * The mouse force is *stateful and pairwise*: each particle remembers where its
 * home is, how far it has been pushed, and how it is springing back. A GPU
 * vertex shader has no persistent per-particle memory without ping-pong FBOs
 * (GPGPU), which is far more machinery than this scene needs. The CPU budget is
 * fine: the whole 8 000-particle update measures ~0.5–1.5 ms/frame at 120 Hz
 * would need 8.3 ms, so we are comfortably inside it.
 *
 * Position data lives in pre-allocated `Float32Array`s and is uploaded through
 * a single `BufferAttribute` with `needsUpdate` — no reallocation, ever.
 *
 * ── Colours ─────────────────────────────────────────────────────────────────
 * The nebula's three colours come from the active Visual Overdrive palette
 * (`vfxPreset` in the store → `@/lib/vfxPalette`): palette core at rest →
 * palette edge under a moderate cursor push → pure white on a hard/fast push.
 * Interpolation happens per particle from its current speed, written into a
 * second `BufferAttribute`.
 *
 * The live colours are held in mutable `THREE.Color` instances and refreshed by
 * an effect when the preset changes, so a palette switch never touches the
 * geometry, the typed arrays or the shader program — the frame loop simply
 * starts lerping toward the new hues on its next pass.
 *
 * ── Allocation discipline (AGENTS.md rule 3) ────────────────────────────────
 * Every `Vector3`, `Color`, `Matrix4`, `Raycaster` and scratch array used in the
 * frame loop is created ONCE in `useMemo` / module scope and reused. There is no
 * `new` anywhere inside `useFrame`.
 */

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

/** Particle count at full quality. Scaled down on the 'medium' tier. */
const BASE_COUNT = 8000

/** Radius of the torus knot the particles call home. */
const KNOT_RADIUS = 2.55
/** Tube thickness of the knot cloud. */
const KNOT_TUBE = 0.62
/**
 * Extra scatter so the knot reads as a nebula rather than a wire.
 * Kept deliberately small: the knot must stay legible as a STRUCTURE. Earlier
 * values around 0.55 spread the dust so widely that the silhouette dissolved
 * into a uniform starfield and the whole composition lost its subject.
 */
const NEBULA_SCATTER = 0.16

/**
 * Overall scale of the knot.
 *
 * The knot's bounding box is roughly 9×9×4.5 world units before scaling, while
 * a 45° camera at z = 6 only sees ~5 units of height — so at scale 1 the cloud
 * overflowed the frame on every side and read as a flat starfield with no
 * discernible form. 0.62 puts the whole structure comfortably inside the
 * viewport, which is what makes the torus knot legible as a shape.
 */
const KNOT_SCALE = 0.62

/* -------------------------------------------------------------------------- */
/*  Warp speed (scroll-velocity driven)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Scroll velocity → warp intensity mapping.
 *
 * Measured on this app: a slow, deliberate scroll peaks at |v| ≈ 0.09, an
 * ordinary wheel flick sits around 0.5–1.2, and a hard fling briefly reaches
 * ≈ 2.1 before the spring smooths it.
 *
 * A LINEAR map from that range put full warp unreachable in practice — the
 * smoothed signal rarely held above ~1.0 long enough to register, so the effect
 * topped out around a third of its intended strength. This uses a
 * square-root response instead: below the dead zone nothing happens (so reading
 * never flickers), then intensity rises quickly through the 0.3–1.5 range where
 * real scrolling lives, and saturates at `WARP_VELOCITY_FULL`.
 *
 *   v = 0.25 → 0.17      (gentle wheel: barely visible shimmer)
 *   v = 0.60 → 0.44      (normal scroll: clear streak)
 *   v = 1.20 → 0.71      (brisk: pronounced warp)
 *   v = 2.00 → 0.94      (fling: near maximum)
 *   v ≥ 2.2 → 1.00       (saturated)
 */
const WARP_VELOCITY_DEAD_ZONE = 0.18
const WARP_VELOCITY_FULL = 2.2

/** Longest a streak gets, as a multiple of its width. */
const WARP_MAX_STRETCH = 11.0

/** Capsule half-width at full warp, in normalised sprite units (very thin). */
const WARP_STREAK_WIDTH = 0.045

/**
 * Warp response springs.
 *
 * `attack` is under-damped and stiff so the stretch kicks in almost immediately
 * on a flick. `release` is softer and much more under-damped (ζ ≈ 0.28), which
 * is what produces the visible elastic overshoot as the streaks contract — the
 * "spring back" the effect needs. Two springs rather than one, because a single
 * spring cannot be both instant-on and satisfyingly bouncy on release.
 */
const WARP_ATTACK = { stiffness: 320, damping: 0.9 } as const
/**
 * Release is strongly under-damped (ζ ≈ 0.16) on purpose: this spring is what
 * creates the elastic spring-back, and the depth of its single overshoot is the
 * whole point. Verified by simulation — seeded from a peak of 0.60 it swings to
 * −0.36 before recovering, which is clearly visible; at ζ = 0.28 the dip was
 * only −0.24 and read as a plain fade.
 *
 * `allowOvershootPastRest` is mandatory here. `stepSpring` normally snaps a
 * spring to its target once it is within 1e-4 of rest with near-zero velocity,
 * which pins it AT zero and prevents it from ever swinging negative — measured
 * effect: the overshoot vanished entirely and the recoil flash had to be faked
 * from the positive-side wobble.
 */
const WARP_RELEASE = {
  stiffness: 150,
  damping: 0.16,
  allowOvershootPastRest: true,
} as const

/** Signal threshold for switching warp phases; keeps the cycle from chattering. */
const WARP_PHASE_EPSILON = 0.02

/**
 * Minimum raw warp signal required to interrupt a release mid-swing.
 *
 * Without a floor, a decelerating scroll that is still slowly decaying above the
 * falling spring reads as "rising" and keeps restarting the attack, flattening
 * the recoil. 0.1 corresponds to real scrolling, not to the tail of the previous
 * gesture.
 */
const WARP_REATTACK_FLOOR = 0.1

/**
 * How far the incoming signal must fall BELOW the current stretch before the
 * attack phase hands over to release. A bare `!rising` test chatters at
 * equilibrium; this margin makes the transition decisive.
 */
const WARP_RELEASE_TRIGGER = 0.03

/**
 * Minimum frames to stay in release before a new scroll may interrupt it.
 * Prevents a fresh gesture from truncating the recoil mid-oscillation, while
 * still letting a deliberate second flick take over quickly.
 */
const WARP_MIN_RELEASE_FRAMES = 6

/** Raw-signal rise (frame over frame) that counts as genuine new acceleration. */
const WARP_ACCELERATION_EPSILON = 0.015

/**
 * Gain applied to the release spring's negative excursion when converting it
 * into the visible recoil pulse. The under-damped release peaks around −0.3, so
 * a gain of ~3 maps that onto a strong, readable flash.
 */
const WARP_RECOIL_GAIN = 3.2

/**
 * Converts raw |velocity| into a 0..1 intent signal.
 *
 * Square-root easing for the reason described above. Kept as a module function
 * so the constant tuning above reads against the actual formula.
 */
function velocityToWarp(speed: number): number {
  if (speed <= WARP_VELOCITY_DEAD_ZONE) return 0
  const normalised =
    (speed - WARP_VELOCITY_DEAD_ZONE) / (WARP_VELOCITY_FULL - WARP_VELOCITY_DEAD_ZONE)
  const clamped = normalised > 1 ? 1 : normalised
  return Math.sqrt(clamped)
}

/** Mouse influence radius, in world units (specified as R = 2.5). */
const MOUSE_RADIUS = 2.5
/** Peak repulsion acceleration at the very centre of the cursor. */
const MOUSE_STRENGTH = 34

/** Under-damped spring: ζ < 1 so particles overshoot slightly and settle. */
const SPRING_STIFFNESS = 34
/** Damping ratio. 0.42 gives two or three visible oscillations — "bouncy". */
const SPRING_DAMPING_RATIO = 0.42

/** Cap on the per-frame integration step (seconds). */
const MAX_DT = 1 / 30

/**
 * Seed colour for the per-particle colour buffer.
 *
 * The buffer is completely rewritten on the first frame (every particle is
 * coloured from its live speed/state), so this only prevents a one-frame flash
 * of black. It is derived from the DEFAULT preset rather than the active one on
 * purpose: `sim` must never be rebuilt when the palette changes, because that
 * would reallocate the 8 000-particle typed arrays and geometry for a hue swap.
 */
const SEED_PARTICLE_COLOR = new THREE.Color(getVfxPalette(DEFAULT_VFX_PRESET).particleCore)

/**
 * Specular white for the hottest particles.
 *
 * Palette-independent on purpose: this is the highlight term, not a spectral
 * hue. Every preset wants the same white-hot core the instant the cursor flings
 * a particle, and tinting it would mute the impact response.
 */
const COLOR_HOT = new THREE.Color('#ffffff') // specular white

/** Speed at which a particle is fully at the edge hue / fully white. */
const SPEED_VIOLET = 3.2
const SPEED_WHITE = 7.5

/** Point sprite size in world units. Tuned against KNOT_SCALE so the 8 000
 *  motes read as dust rather than as a solid mass. */
const POINT_SIZE = 0.055

/* -------------------------------------------------------------------------- */
/*  Torus-knot home positions                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fill `positions` with the particles' home positions: points distributed on a
 * (p, q) torus knot, thickened into a tube and then scattered into a nebula.
 *
 * A torus knot is used because its self-symmetry makes the rotation read as
 * organic from every angle; a plain torus looks mechanical no matter how it
 * spins. Deterministic RNG keeps the cloud identical across HMR/StrictMode
 * remounts.
 *
 * The (p,q) knot sits on the torus surface:
 *
 *     r(φ) = R + cos(qφ/p)·tube
 *     x = r·cos φ ,  y = r·sin φ ,  z = sin(qφ/p)·tube
 *
 * with φ sweeping p full turns.
 */
function seedHomePositions(positions: Float32Array, count: number): void {
  // xorshift32 — deterministic, fast, and no Math.random in setup either.
  let seed = 0x2f6e2b1
  const rand = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return seed / 4294967296
  }

  const P = 2
  const Q = 3

  for (let i = 0; i < count; i++) {
    const i3 = i * 3

    // Parameter along the knot. Jitter avoids a visible seam where i wraps.
    const t = (i / count) * Math.PI * 2 + (rand() - 0.5) * (0.4 / count)
    const phi = t * P
    const theta = phi * (Q / P)

    // Position on the ideal knot curve.
    const radius = KNOT_RADIUS + Math.cos(theta) * KNOT_TUBE
    const knotX = radius * Math.cos(phi)
    const knotY = radius * Math.sin(phi)
    const knotZ = Math.sin(theta) * KNOT_TUBE

    // Thickening: push the particle off the ideal curve along a random
    // direction, so the knot reads as a volume of dust rather than a wire.
    const offAngle = rand() * Math.PI * 2
    const offRadius = Math.pow(rand(), 0.55) * KNOT_TUBE * 1.35
    const offZ = (rand() - 0.5) * KNOT_TUBE * 1.6

    // Nebula haze: a tight scatter enveloping the knot. Deliberately
    // concentrated near the structure — see NEBULA_SCATTER's note.
    const hazeAngle = rand() * Math.PI * 2
    const hazeCos = rand() * 2 - 1
    const hazeSin = Math.sqrt(Math.max(0, 1 - hazeCos * hazeCos))
    const hazeRadius = Math.pow(rand(), 2.6) * NEBULA_SCATTER * 9

    positions[i3] =
      (knotX + Math.cos(offAngle) * offRadius + hazeSin * Math.cos(hazeAngle) * hazeRadius) *
      KNOT_SCALE
    positions[i3 + 1] =
      (knotY + Math.sin(offAngle) * offRadius + hazeSin * Math.sin(hazeAngle) * hazeRadius) *
      KNOT_SCALE
    positions[i3 + 2] = (knotZ + offZ + hazeCos * hazeRadius * 0.75) * KNOT_SCALE
  }
}

/* -------------------------------------------------------------------------- */
/*  Shaders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader.
 *
 * Beyond the usual transform it produces the WARP SPEED stretch: when the page
 * is scrolled fast, every particle is drawn as a tall streak rather than a dot.
 *
 * ── How the stretch works ───────────────────────────────────────────────────
 * A point sprite is always an axis-aligned square (`gl_PointSize`), so a "streak"
 * cannot be made by scaling the quad non-uniformly — that is impossible with
 * POINTS. Instead the sprite is enlarged and the FRAGMENT shader carves a thin
 * vertical capsule out of it. See `FRAGMENT_SHADER`.
 *
 * `gl_PointSize` is passed through `clamp` against a hard ceiling: GPUs cap point
 * size (often 64–255 px, and ANGLE caps lower). Exceeding it makes the driver
 * silently drop or clip the sprite, which would make particles VANISH during a
 * fast scroll instead of streaking. The fragment shader rescales its coordinate
 * space to match, so the streak stays correct at any cap.
 */
const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;

  // Vertex colours come from the CPU as rgb, interpolated per particle.
  attribute vec3 color;

  varying vec3 vColor;
  varying float vDepth;

  // Warp controls passed to the fragment stage.
  // vStretch: 0 = round dot, 1 = maximum streak length.
  varying float vStretch;
  // vPointSize: the final sprite size, so the fragment can normalise gl_PointCoord.
  varying float vPointSize;

  uniform float uPixelRatio;
  uniform float uSize;

  // Warp speed uniforms (driven from the transient scroll velocity).
  // uWarp:        0..1 intensity of the effect.
  uniform float uWarp;
  // uMaxStretch:  how many times longer than wide a full-intensity streak is.
  uniform float uMaxStretch;

  void main() {
    vColor = color;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mvPosition.z;

    gl_Position = projectionMatrix * mvPosition;

    // Base perspective-correct size.
    float baseSize = uSize * aSize * uPixelRatio * (300.0 / max(vDepth, 0.1));

    // During warp, widen the sprite a little AND make it tall enough to contain
    // the streak. The fragment shader then paints only the thin middle.
    float widthScale = 1.0 + uWarp * 0.55;
    float heightScale = 1.0 + uWarp * (uMaxStretch - 1.0);

    float size = baseSize * max(widthScale, heightScale);

    // Hard cap: going past the driver's max point size makes sprites disappear.
    // 200 is comfortably under every desktop limit and still gives long streaks.
    size = clamp(size, 1.0, 200.0);

    gl_PointSize = size;
    vPointSize = size;
    vStretch = uWarp;
  }
`

/**
 * Fragment shader.
 *
 * Two jobs:
 *
 * 1. Draw the soft radial mote used at rest.
 * 2. During a fast scroll, carve an elongated vertical streak (the warp effect)
 *    out of the enlarged sprite.
 *
 * ── Why the streak is carved here and not scaled in the vertex shader ────────
 * `gl_PointSize` is a single scalar: point sprites are always square quads. There
 * is no per-axis sprite scaling in WebGL. So the vertex shader inflates the quad
 * and this stage discards everything outside a narrow vertical capsule, which
 * makes an actual tall thin streak.
 *
 * The aspect correction matters: `gl_PointCoord` is normalised 0..1 across a
 * SQUARE quad, so drawing an ellipse from it needs the quad's pixel size to keep
 * the intended width-to-length ratio. `vPointSize` provides exactly that.
 *
 * Note: `#include <colorspace_fragment>` is deliberately NOT used. Raw
 * `ShaderMaterial` does not run three.js' shader chunk injection, so an include
 * here would be passed through verbatim and fail to compile. The renderer outputs
 * sRGB and additive blending of these values is visually correct for glow.
 */
const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vDepth;

  varying float vStretch;
  varying float vPointSize;

  // Streak width in NDC-ish sprite units at full warp.
  uniform float uStreakWidth;
  // Live audio envelope (0..1), already smoothed on the CPU.
  uniform float uAudioEnergy;
  // Recoil amount (0..1). Rises as the streaks spring back past rest, producing
  // a brief bright flash that reads as elastic energy releasing.
  uniform float uRecoil;

  void main() {
    // Centred sprite coordinates. At rest this is a square [-0.5, 0.5].
    vec2 uv = gl_PointCoord - 0.5;

    // Aspect-correct the coordinate space so the streak is genuinely narrow:
    // the sprite is square in pixels, but the visible capsule must be much
    // taller than it is wide.
    float aspect = max(vPointSize, 1.0);

    // Normalise x by the sprite's pixel width so the profile keeps its
    // proportions regardless of how large the quad grew for the streak.
    vec2 c = uv;
    c.x *= aspect;

    // ── Rest shape: soft round mote ───────────────────────────────────────
    float roundDist = length(uv) * 2.0;

    // ── Warp shape: narrow vertical capsule ───────────────────────────────
    // Width narrows as stretch rises; length spans the whole sprite height.
    float halfWidth = mix(0.5, uStreakWidth, vStretch);
    // Fold the vertical coordinate into a capsule: full height, tapered ends.
    float edgeSoft = 0.5;
    float capDist = length(vec2(c.x, max(abs(c.y) - (0.5 - edgeSoft), 0.0)));

    float dist = mix(roundDist, capDist / (halfWidth * 2.0), vStretch);

    if (dist > 1.0) discard;

    // Soft gaussian-ish core: bright centre, feathered edge.
    float core = pow(1.0 - dist, 2.2);
    float halo = pow(1.0 - dist, 0.9) * 0.35;
    float alpha = core + halo;

    // Fade the farthest particles so the nebula has atmospheric depth instead
    // of a hard silhouette against the background.
    float depthFade = clamp(1.0 - (vDepth - 3.0) / 14.0, 0.25, 1.0);

    // Hot centre: push the middle of the sprite toward white for a bloom-ready
    // specular look, independent of the particle's assigned colour.
    vec3 hot = mix(vColor, vec3(1.0), pow(core, 3.0) * 0.55);

    // During warp the streaks run hotter and lean white — a light-speed look.
    hot = mix(hot, vec3(1.0), vStretch * 0.45);

    // Recoil flash: when the streaks spring back, a brief bright pulse makes the
    // elastic energy visible. Without this the return to rest is a plain fade.
    hot = mix(hot, vec3(1.0), uRecoil * 0.5);

    // Emissive boost. Bloom thresholds on LUMINANCE, so a sprite that peaks at
    // 1.0 barely clears a 0.2 threshold and produces almost no glow. Scaling the
    // sprite above 1.0 in HDR gives the bright cores real headroom, which is
    // what turns the motes into glowing points rather than flat dots.
    float emission = 1.0 + core * 1.35;
    // Audio-reactive lift: up to +85% brightness on a loud transient. Applied to
    // the emission rather than the colour so the hue stays on-palette and only
    // the intensity breathes.
    emission *= 1.0 + uAudioEnergy * 0.85;
    // Streaks carry more energy, so they bloom harder.
    emission *= 1.0 + vStretch * 0.8;
    // Recoil pulse.
    emission *= 1.0 + uRecoil * 0.9;

    gl_FragColor = vec4(hot * emission, alpha * depthFade);
  }
`

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export interface FlowFieldParticlesProps {
  /** Quality tier — controls particle count, field resolution and cadence. */
  tier?: PerformanceTier
  /**
   * Explicit particle count. When omitted it is derived from `tier`.
   *
   * Passed in by `SceneCanvas` so the count is decided in one place next to the
   * other tier levers (pixel ratio, post-processing), rather than being an
   * implicit side effect of the tier string here.
   */
  count?: number
}

export function FlowFieldParticles({
  tier = 'high',
  count: countProp,
}: FlowFieldParticlesProps) {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const pointsRef = useRef<THREE.Points>(null)

  const count = countProp ?? (tier === 'high' ? BASE_COUNT : Math.round(BASE_COUNT / 2))

  // Publish the live count so the telemetry HUD can show what is actually being
  // simulated, not what the tier nominally allows.
  useEffect(() => {
    reportParticles(count)
  }, [count])

  /* ── Visual Overdrive palette ──────────────────────────────────────────── */
  // Subscribing (rather than polling the store inside the frame loop) means the
  // component renders exactly once per preset change; the render is cheap because
  // every heavy allocation below is memoised on `count`/`tier`, not on palette.
  const vfxPreset = useAppStore((state) => state.vfxPreset)
  const palette = getVfxPalette(vfxPreset)

  /**
   * Live rest → edge colours.
   *
   * A new pair of `THREE.Color` instances per preset, never per frame: the frame
   * loop only reads their channels, and allocating colour objects inside
   * `useFrame` would churn the GC 60–120 times a second.
   */
  const paletteColors = useMemo(
    () => ({
      core: new THREE.Color(palette.particleCore),
      edge: new THREE.Color(palette.particleEdge),
    }),
    [palette],
  )

  /* ── Baked flow field (built once, ~15 ms on mount, never in a frame) ──── */
  const curlVolume = useMemo<CurlVolume>(
    () =>
      buildCurlVolume({
        resolution: tier === 'high' ? 20 : 14,
        extent: 8,
        strength: 1.15,
      }),
    [tier],
  )

  /* ── Geometry + typed-array state, allocated exactly once ──────────────── */
  const sim = useMemo(() => {
    const home = new Float32Array(count * 3)
    seedHomePositions(home, count)

    // Current simulation position (mirrored into the geometry each frame).
    const position = new Float32Array(home)
    // Current velocity, integrated each frame.
    const velocity = new Float32Array(count * 3)
    // Per-particle colour, also uploaded as a buffer attribute.
    const color = new Float32Array(count * 3)
    // Per-particle size jitter, uploaded once.
    const aSize = new Float32Array(count)

    // Deterministic size jitter: small particles read as distant dust.
    let seed = 0x51af3d1
    const rand = (): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed >>>= 0
      return seed / 4294967296
    }
    for (let i = 0; i < count; i++) {
      aSize[i] = 0.45 + Math.pow(rand(), 2.2) * 1.35
    }

    // Seed every particle at rest, at home, in the default palette's core hue.
    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      color[i3] = SEED_PARTICLE_COLOR.r
      color[i3 + 1] = SEED_PARTICLE_COLOR.g
      color[i3 + 2] = SEED_PARTICLE_COLOR.b
    }

    // ── Scratch buffers: reused every frame, never reallocated ──────────────
    const scratch = {
      curlOut: new Float32Array(3),
      /** Raycaster hit point on the z = 0 plane. */
      mouseWorld: new THREE.Vector3(),
      /** NDC coordinates for the raycaster. */
      ndc: new THREE.Vector2(),
      /** The plane the cursor is projected onto. */
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      /** Ray used for the projection. */
      ray: new THREE.Raycaster(),
      /** Colour scratch, reused for every particle's colour evaluation. */
      colorOut: new THREE.Color(),
    }

    return { home, position, velocity, color, aSize, scratch }
  }, [count])

  /* ── Geometry: attributes point straight at the typed arrays ───────────── */
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()

    const posAttr = new THREE.BufferAttribute(sim.position, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)

    const colAttr = new THREE.BufferAttribute(sim.color, 3)
    colAttr.setUsage(THREE.DynamicDrawUsage)

    const sizeAttr = new THREE.BufferAttribute(sim.aSize, 1)

    geo.setAttribute('position', posAttr)
    geo.setAttribute('color', colAttr)
    geo.setAttribute('aSize', sizeAttr)

    // The cloud is always on screen; a bounding sphere avoids per-frame culling
    // math and prevents pop-out when particles are pushed outside the knot.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), KNOT_RADIUS * 6)

    return geo
  }, [sim])

  /* ── Warp spring state, allocated once ─────────────────────────────────── */
  /**
   * Spring carrying the warp intensity, plus the phase of the attack/release
   * cycle it is currently in.
   *
   * The phase is stored rather than inferred from `target vs value` each frame.
   * Inferring it looks equivalent and is subtly wrong: as soon as an
   * under-damped release swings the value below zero, the (zero) target is once
   * again "above" the value, the code flips back to the stiff attack spring, and
   * the overshoot is killed after a single frame — leaving a recoil far too
   * small to see. A sticky phase lets the release oscillation finish properly.
   */
  const warpState = useMemo(
    () => ({
      spring: createSpring(0),
      phase: 'idle' as 'idle' | 'attack' | 'release',
      /** Highest stretch reached during the current attack, latched for release. */
      peak: 0,
      /** True for exactly one frame, right after entering release. */
      needsSeed: false,
      /** Frames spent in the current release; guards against phase chatter. */
      releaseFrames: 0,
      /** Previous frame's raw warp signal, for detecting genuine acceleration. */
      prevRaw: 0,
    }),
    [],
  )

  /* ── Material ──────────────────────────────────────────────────────────── */
  const uniforms = useMemo(
    () => ({
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uSize: { value: POINT_SIZE },
      /** 0..1 warp intensity, sprung from the scroll velocity. */
      uWarp: { value: 0 },
      /** 0..1 recoil pulse, raised while the warp springs back past rest. */
      uRecoil: { value: 0 },
      /** How many times longer than wide a full-intensity streak becomes. */
      uMaxStretch: { value: WARP_MAX_STRETCH },
      /** Capsule half-width at full warp, in normalised sprite units. */
      uStreakWidth: { value: WARP_STREAK_WIDTH },
      /**
       * Live audio envelope, 0..1, sampled from the SoundEngine's AnalyserNode
       * once per frame. Drives an extra emissive boost so the nebula breathes
       * with UI blips, laser fire and impact sounds.
       */
      uAudioEnergy: { value: 0 },
      /** Smoothed envelope, so the response swells instead of strobing. */
      uAudioSmooth: { value: 0 },
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
        depthTest: true,
        blending: THREE.AdditiveBlending,
        // Additive blending must not be tone-mapped away, or the nebula turns
        // dull grey once Bloom is applied.
        toneMapped: false,
      }),
    [uniforms],
  )

  /* ── Keep sprite size correct across DPR / resize ──────────────────────── */
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

  /* ── Frame loop ────────────────────────────────────────────────────────── */
  useFrame((state, rawDelta) => {
    const points = pointsRef.current
    if (!points) return

    const dt = Math.min(rawDelta, MAX_DT)
    if (!(dt > 0)) return

    const { home, position, velocity, color, scratch } = sim
    const { curlOut, mouseWorld, ndc, plane, ray, colorOut } = scratch

    // Transient store: read once per frame, never subscribed.
    const transient = getTransient()

    const time = state.clock.elapsedTime

    /* 1. Warp speed: derive intensity from the scroll velocity. */
    // The transient store carries `v_scroll` in "progress per second".
    const rawWarp = velocityToWarp(Math.abs(transient.scroll.velocity))

    /**
     * "Rising" must mean a genuinely NEW push, not merely a target that happens
     * to sit above a falling spring.
     *
     * The distinction matters: as the release spring falls it passes beneath a
     * slowly-decaying `rawWarp`, which trivially satisfies `raw > value`. Using
     * that as the trigger recaptured the spring with the stiff attack constants
     * mid-swing and flattened the overshoot — reproduced in simulation, where
     * the value dipped only to −0.108 instead of the −0.36 the constants permit.
     *
     * Requiring `raw` to also clear an absolute floor means attack only restarts
     * when the user is actually scrolling again.
     */
    const rising = rawWarp > warpState.spring.value + WARP_PHASE_EPSILON
    const newEnergy = rawWarp > WARP_REATTACK_FLOOR
    const settled =
      Math.abs(warpState.spring.value) < WARP_PHASE_EPSILON &&
      Math.abs(warpState.spring.velocity) < WARP_PHASE_EPSILON

    if (warpState.phase === 'idle') {
      if (rising) {
        warpState.phase = 'attack'
        warpState.peak = warpState.spring.value
      }
    } else if (warpState.phase === 'attack') {
      // Always track the high-water mark. Doing this only inside a conditional
      // was the bug that flattened the recoil: `peak` got frozen near whatever
      // the value happened to be at hand-over, so the release swing seeded from
      // ~0.17 instead of the real peak of ~0.6 and produced a dip of just −0.04.
      if (warpState.spring.value > warpState.peak) warpState.peak = warpState.spring.value
      // Require the signal to settle clearly BELOW the stretch before releasing.
      // A bare `!rising` test chatters: near equilibrium `raw` and `value` keep
      // swapping places frame to frame, so the phase flipped back and forth and
      // the release oscillation was cut short repeatedly (visible as a jumpy
      // trace and a much shallower dip than the constants allow).
      if (rawWarp < warpState.spring.value - WARP_RELEASE_TRIGGER) {
        warpState.phase = 'release'
        warpState.needsSeed = true
        warpState.releaseFrames = 0
      }
    } else {
      warpState.releaseFrames += 1

      if (settled) {
        warpState.phase = 'idle'
        // NOTE: `peak` is intentionally NOT cleared here. It is the seed for the
        // next release and is re-initialised when attack is entered.
      } else if (
        newEnergy &&
        rawWarp > warpState.prevRaw + WARP_ACCELERATION_EPSILON &&
        warpState.releaseFrames > WARP_MIN_RELEASE_FRAMES
      ) {
        // A genuinely NEW scroll: the signal is actively accelerating again, and
        // the recoil has had time to play out.
        //
        // Testing `raw > prevRaw` (rather than `raw > value`) is what makes this
        // correct. During release `raw` decays slowly and stays above the falling
        // stretch for many frames; comparing against `value` therefore reads as
        // "rising" and restarts the attack mid-swing, truncating the recoil.
        // Comparing successive samples detects real acceleration instead.
        warpState.phase = 'attack'
      }
    }

    warpState.prevRaw = rawWarp

    if (warpState.phase === 'attack') {
      stepSpring(warpState.spring, rawWarp, dt, WARP_ATTACK)
    } else {
      // On the FIRST frame of release, snap the spring to the recorded peak with
      // zero velocity. That is the correct initial condition for a step release,
      // and it is what gives the oscillation its full amplitude — at hand-over
      // the live value has already fallen a little below the peak, so the swing
      // would otherwise be too shallow to see.
      //
      // The seed is applied exactly once (guarded by `needsSeed`) rather than
      // every frame; re-seeding continuously would pin the spring against the
      // peak and prevent it from ever falling at all.
      if (warpState.needsSeed) {
        warpState.spring.value = warpState.peak
        warpState.spring.velocity = 0
        warpState.needsSeed = false
      }
      stepSpring(warpState.spring, 0, dt, WARP_RELEASE)
    }

    // Signed spring value: negative here means "recoiling past rest".
    const warpSigned = warpState.spring.value

    // The stretch the shader draws: only the positive half. Negative values are
    // handled below as the recoil pulse rather than being silently discarded.
    let warp = warpSigned
    if (warp > 1) warp = 1
    else if (warp < 0) warp = 0

    uniforms.uWarp.value = warp

    /*
     * Audio-reactive glow.
     *
     * The raw RMS envelope is far too spiky to drive emissive brightness
     * directly: a single click would flash the whole nebula for one frame and
     * read as a dropped frame rather than as a response. Two different time
     * constants keep it musical — a fast attack so the flash starts on the same
     * frame as the sound, and a slower release so it decays like a lit object
     * cooling rather than snapping off.
     */
    const audioTarget = soundEngine.readEnergy()
    const attack = 1 - Math.exp(-dt * 26)
    const release = 1 - Math.exp(-dt * 5.5)
    const smoothed = uniforms.uAudioSmooth.value
    uniforms.uAudioSmooth.value =
      smoothed + (audioTarget - smoothed) * (audioTarget > smoothed ? attack : release)
    uniforms.uAudioEnergy.value = uniforms.uAudioSmooth.value

    /**
     * Recoil pulse — the visible half of the spring-back.
     *
     * The release spring swings below zero on its way back. A stretch shader
     * cannot draw a negative length, so that excursion would otherwise be
     * invisible: the streaks would simply shrink and stop, with no sense of
     * elastic energy. Mapping |negative| onto a short bright pulse instead makes
     * the overshoot legible as a single flash as the streaks snap in.
     *
     * The pulse also fires on the POSITIVE local rebounds (the small bounces
     * visible in the trace as the value dips and recovers while still above
     * zero), by measuring the upward velocity of the spring during release.
     * Together these two contributions read as one continuous elastic recoil.
     */
    let recoil = 0

    if (warpSigned < 0) {
      recoil = -warpSigned * WARP_RECOIL_GAIN
    } else if (warpState.phase === 'release' && warpState.spring.velocity > 0) {
      // Rising back toward rest while still positive: the first elastic bounce.
      recoil = (warpState.spring.velocity / warpState.peak) * 0.55
    }

    if (recoil > 1) recoil = 1
    else if (recoil < 0) recoil = 0
    uniforms.uRecoil.value = recoil

    /* 2. Project the cursor onto the z = 0 plane via a Raycaster. */
    let mouseValid = false

    if (transient.mouse.active) {
      // Normalized device coordinates straight from the transient store: it is
      // already in [-1, 1] with +y up, which is exactly NDC.
      ndc.set(transient.mouse.x, transient.mouse.y)

      // The camera's inverse projection must be current before raycasting, or
      // the ray skews after a resize. CameraRig keeps the aspect and projection
      // matrix in sync; refreshing here is a cheap belt-and-braces guard.
      camera.updateMatrixWorld()
      ray.setFromCamera(ndc, camera)
      mouseValid = ray.ray.intersectPlane(plane, mouseWorld) !== null
    }

    /* 2. Group rotation — the whole knot turns slowly. */
    const rotY = time * 0.055
    const rotX = Math.sin(time * 0.19) * 0.16
    points.rotation.y = rotY
    points.rotation.x = rotX

    // Pre-compute the rotation for the home transform rather than using the
    // matrix per particle (cheaper: 6 multiplies vs 9, and no Vector3.applyAxisAngle
    // allocation).
    const cosY = Math.cos(rotY)
    const sinY = Math.sin(rotY)
    const cosX = Math.cos(rotX)
    const sinX = Math.sin(rotX)

    const mx = mouseWorld.x
    const my = mouseWorld.y
    const mouseRadiusSq = MOUSE_RADIUS * MOUSE_RADIUS

    // Spring constants from the damping ratio: c = 2ζ√k (unit mass).
    const damping = 2 * SPRING_DAMPING_RATIO * Math.sqrt(SPRING_STIFFNESS)

    /* 3. Integrate every particle. */
    for (let i = 0; i < count; i++) {
      const i3 = i * 3

      // ── Home position, rotated into world space by hand ──────────────
      // All scalar math: no Vector3 allocation, no matrix multiply.
      const hx = home[i3]
      const hy = home[i3 + 1]
      const hz = home[i3 + 2]

      const hx1 = hx * cosY + hz * sinY
      const hz1 = -hx * sinY + hz * cosY
      const hy2 = hy * cosX - hz1 * sinX
      const hz2 = hy * sinX + hz1 * cosX

      // ── Current state ────────────────────────────────────────────────
      const px = position[i3]
      const py = position[i3 + 1]
      const pz = position[i3 + 2]
      let vx = velocity[i3]
      let vy = velocity[i3 + 1]
      let vz = velocity[i3 + 2]

      // ── Force 1: curl-noise flow (divergence-free) ────────────────────
      // Sample in unrotated space so the flow field appears to stay put while
      // the knot rotates through it, like smoke drifting through a sculpture.
      sampleCurl(curlVolume, px, py + time * 0.16, pz, curlOut, 0)
      vx += curlOut[0] * dt
      vy += curlOut[1] * dt
      vz += curlOut[2] * dt

      // ── Force 2: under-damped spring back to home ─────────────────────
      //   F = -k·x  -  c·v      (unit mass)
      const dxh = px - hx1
      const dyh = py - hy2
      const dzh = pz - hz2

      vx += (-SPRING_STIFFNESS * dxh - damping * vx) * dt
      vy += (-SPRING_STIFFNESS * dyh - damping * vy) * dt
      vz += (-SPRING_STIFFNESS * dzh - damping * vz) * dt

      // ── Force 3: inverse-square repulsion from the cursor ─────────────
      let pushMag = 0

      if (mouseValid) {
        const dx = px - mx
        const dy = py - my
        const dz = pz // cursor plane is z = 0
        const distSq = dx * dx + dy * dy + dz * dz

        if (distSq < mouseRadiusSq) {
          // Clamp the denominator so a particle exactly under the cursor gets a
          // large but finite push instead of Infinity.
          const safeDistSq = Math.max(distSq, 0.0225) // 0.15²
          const dist = Math.sqrt(safeDistSq)

          // Inverse-square magnitude, smoothly faded to zero at the radius so
          // particles do not visibly "snap" when crossing the boundary.
          const falloff = 1 - dist / MOUSE_RADIUS
          const smoothFalloff = falloff * falloff
          const accel = (MOUSE_STRENGTH / safeDistSq) * smoothFalloff * 0.06

          const invDist = 1 / dist
          vx += dx * invDist * accel * dt
          vy += dy * invDist * accel * dt
          vz += dz * invDist * accel * dt

          pushMag = accel
        }
      }

      // ── Integrate ─────────────────────────────────────────────────────
      // Light drag keeps the curl velocity from accumulating without bound.
      const drag = 1 - Math.min(1.4 * dt, 0.25)
      vx *= drag
      vy *= drag
      vz *= drag

      // clamp velocity so a fast swipe cannot fling particles into infinity
      const speedSq = vx * vx + vy * vy + vz * vz
      const MAX_SPEED = 26
      if (speedSq > MAX_SPEED * MAX_SPEED) {
        const scale = MAX_SPEED / Math.sqrt(speedSq)
        vx *= scale
        vy *= scale
        vz *= scale
      }

      const nx = px + vx * dt
      const ny = py + vy * dt
      const nz = pz + vz * dt

      position[i3] = nx
      position[i3 + 1] = ny
      position[i3 + 2] = nz
      velocity[i3] = vx
      velocity[i3 + 1] = vy
      velocity[i3 + 2] = vz

      // ── Colour ────────────────────────────────────────────────────────
      // Graduated response to the CURSOR, using the active spectral palette:
      //   untouched / far        → palette.particleCore
      //   inside the push radius → palette.particleEdge
      //   fast or hard push      → pure white highlight (palette-independent)
      //
      // Colour is driven by mouse influence (pushMag) rather than by total
      // displacement from home. Displacement seemed like a natural proxy, but
      // the curl flow constantly nudges particles off their home positions, so
      // displacement alone painted large regions in the edge hue even with no
      // cursor anywhere near — the field lost its core-colour base and the whole
      // interaction transition stopped reading as an interaction.
      const speed = Math.sqrt(speedSq)

      // `pushMag` is 0 outside the radius, so neutral particles keep the core hue.
      let influence = pushMag > 0 ? pushMag * 2.6 : 0
      if (influence > 1) influence = 1

      // Speed adds a secondary edge-hue push, so a fast flick still registers
      // even for a particle just outside the radius.
      const speedInfluence = (speed - 1.2) / SPEED_VIOLET
      if (speedInfluence > influence) {
        influence = speedInfluence > 1 ? 1 : speedInfluence
      }

      // White-hot only for genuinely fast motion or very close to the cursor.
      let hot = (speed - SPEED_VIOLET) / (SPEED_WHITE - SPEED_VIOLET)
      if (hot < 0) hot = 0
      else if (hot > 1) hot = 1
      if (pushMag > 0) {
        const near = pushMag / 2.5
        hot += near > 1 ? 1 - hot : near * (1 - hot)
      }

      // core → edge → white, lerped in linear RGB.
      colorOut.copy(paletteColors.core).lerp(paletteColors.edge, influence).lerp(COLOR_HOT, hot)

      color[i3] = colorOut.r
      color[i3 + 1] = colorOut.g
      color[i3 + 2] = colorOut.b
    }

    /* 4. Upload the two dynamic attributes. */
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
    const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
  })

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
    />
  )
}

export default FlowFieldParticles
