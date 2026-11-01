import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { getVfxPalette } from '@/lib/vfxPalette'
import { useAppStore } from '@/store/useAppStore'
import { soundEngine } from '@/utils/soundEngine'
import type { PerformanceTier } from '@/types'

/**
 * AuroraCurtain — a procedural aurora borealis sky for the hero scene.
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 * A huge arc-shaped shell (a 225-degree, open-ended cylinder segment) placed
 * far behind the nebula. It carries no texture and no baked animation: every
 * fold, filament and colour transition is evaluated per fragment from a handful
 * of travelling sine waves plus fBm noise, so the curtain never tiles, never
 * repeats and never runs out of resolution.
 *
 * ── Why a cylinder segment and not a plane ──────────────────────────────────
 * The backdrop has to survive the camera rig's full travel (mouse sway, scroll
 * dolly of ~1.1 units) without ever showing a corner or an edge. A cylinder
 * whose axis is vertical wraps around the camera: as long as the radius exceeds
 * the camera's distance to the axis, the camera sits INSIDE the shell and every
 * upward ray hits the wall. The 225-degree sweep is centred on the far plane
 * (theta = PI in three's cylinder parameterisation), so the open ends of the
 * arc sit ~135 degrees off the far point — far outside the viewport — and no
 * side edge ever enters the frame. A flat plane would need to be either
 * enormous (depth precision, parallax) or fixed (edges drift into frame as the
 * camera moves).
 *
 * ── Why it reads as a backdrop, not as scenery ──────────────────────────────
 * The far wall sits at z = -36 while the camera rests near z = 6 and the
 * particles live around z = 0. That is ~42 units of separation against the
 * nebula's 6, so the sky moves ~14 percent as much as the foreground under the
 * same camera movement. That parallax ratio is the entire depth cue; anything
 * closer reads as a wall hanging in the same room.
 *
 * ── Shader structure (fragment, in evaluation order) ────────────────────────
 *   1. VALUE-NOISE fBm     4 octaves of sin-hash noise. One sample drives the
 *                          fold placement, the ribbon warp and the hem height.
 *   2. FILAMENTS           three incommensurate ribbon families summed, then
 *                          folded around zero: where they all cross zero they
 *                          leave thin bright rays, spaced irregularly.
 *   3. FOLDS               the noise field groups the rays into broad sheets,
 *                          leaving dark gaps between curtains.
 *   4. HEM                 a bright lower boundary that wanders with the folds;
 *                          rays rise from it and fade with height, which is
 *                          the aurora's defining silhouette.
 *   5. VERTICAL FIBRES     a second, vertically stretched fBm gives the rays
 *                          uneven length and brightness (woven, not combed).
 *   6. ENVELOPE            smoothstep mesh-edge falloff plus a top fade, so the
 *                          curtain dissolves at both ends of the geometry.
 *   7. COLOUR              palette primary as the body, secondary in the
 *                          filament cores, accent from the hem down through the
 *                          tail; emission is pushed above 1.0 only in the thin
 *                          cores so Bloom gets a halo without the whole sheet
 *                          turning to fog.
 *
 * ── Audio reactivity ─────────────────────────────────────────────────────────
 * `uAudioEnergy` is the SoundEngine's RMS envelope, smoothed asymmetrically on
 * the CPU (fast attack, slow release) — raw RMS is far too spiky to drive
 * visuals, and a click would otherwise flash the whole sky for a single frame.
 * The value lifts brightness directly AND speeds up the wave clock through
 * `uFlow`, an accumulated phase. Accumulating the phase on the CPU matters: the
 * obvious alternative, scaling `uTime` by the energy in the shader, multiplies
 * a per-frame energy delta by total page uptime, so after a few minutes the
 * pattern starts teleporting every frame instead of accelerating.
 *
 * ── Allocation discipline (AGENTS.md rule 3) ────────────────────────────────
 * Geometry, material, uniforms and colours are all built once in `useMemo`.
 * The frame loop writes four scalar uniform values and allocates nothing.
 */

/* -------------------------------------------------------------------------- */
/*  Placement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Radius of the shell, in world units.
 *
 * Must exceed the camera's distance to the axis (camera z ≈ 6, axis z ≈ -11, so
 * ~17 units) or the camera would end up in front of the backdrop instead of
 * inside it. 25 leaves a comfortable margin across the whole scroll dolly and
 * puts the far wall ~42 units from the camera.
 */
const CURTAIN_RADIUS = 25

/**
 * Height of the shell. The vertical half-extent of a 45-degree frame at the far
 * wall is 42 * tan(22.5 deg) ≈ 17.4 units, so 42 units of mesh centred at y = 3
 * covers the frame with several units to spare top and bottom. The shader
 * dissolves well inside the mesh, which is what keeps the extra height from
 * ever becoming a visible edge.
 */
const CURTAIN_HEIGHT = 42

/**
 * Arc swept by the shell. 225 degrees: visible horizontal half-angle from the
 * camera to the far wall is ~60 degrees at the 16:10 aspect, and the open ends
 * of the arc sit ~135 degrees off the far point — far outside the viewport.
 */
const CURTAIN_ARC = Math.PI * 1.25

/**
 * three's `CylinderGeometry` starts its sweep at +Z for theta = 0, so the far
 * plane is theta = PI. Centring the sweep on PI puts the middle of the curtain
 * directly behind the nebula.
 */
const CURTAIN_THETA_START = Math.PI - CURTAIN_ARC / 2

/** Centre of the shell. y lifts it so the band sits across the upper frame. */
const CURTAIN_POSITION: [number, number, number] = [0, 3, -11]

/**
 * Arc tessellation. The wall is straight vertically, so only the arc needs
 * subdivision; the chord error at 128 segments is under a pixel even at the
 * screen edges. 'medium' halves it — the band is mostly soft gradients, so the
 * polygon silhouette is not where the quality budget is worth spending.
 */
const RADIAL_SEGMENTS = { high: 128, medium: 64 } as const

/* -------------------------------------------------------------------------- */
/*  Audio                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Asymmetric envelope smoothing, per second.
 *
 * 26/s attack puts the visual lift within a frame of the sound; 5.5/s release
 * lets the sky fall back like a lit surface cooling. Both are exponential
 * approaches, so the response is frame-rate independent.
 */
const AUDIO_ATTACK_RATE = 26
const AUDIO_RELEASE_RATE = 5.5

/** Cap on the integration step: a backgrounded tab must not age the smoothing. */
const MAX_DT = 1 / 30

/**
 * Wave-clock speed, radians per second.
 *
 * The base rate keeps the curtain drifting even in silence; the audio term is
 * added on top whenever the mixer is producing sound, so a card activation or a
 * laser sweep visibly accelerates the folds rather than only brightening them.
 */
const FLOW_BASE_SPEED = 0.55
const FLOW_AUDIO_SPEED = 1.15

/* -------------------------------------------------------------------------- */
/*  Palette                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The curtain's three hues — body, filament core and lower fringe — come from
 * the active Visual Overdrive palette (`vfxPreset` in the store →
 * `@/lib/vfxPalette`). There are no colour literals in this file: the uniforms
 * are seeded from the live palette at mount and re-synced in place whenever the
 * preset changes, so the sky re-tints while its wave animation keeps running.
 */

/* -------------------------------------------------------------------------- */
/*  Shaders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Vertex stage. The curtain is a static shell — all of its shape is drawn by
 * the fragment shader, and displacing vertices here would only make the arc
 * silhouette lumpy at a distance where it is deliberately invisible.
 */
const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/**
 * Fragment stage.
 *
 * Written in GLSL 1.00 style (varying / gl_FragColor) like the rest of the
 * scene's custom shaders; three upgrades it for WebGL2 internally. Nothing here
 * samples a texture, so there is no colourspace include to worry about: the
 * output is a raw HDR-ish emissive value, and tone mapping is disabled on the
 * material so Bloom receives it untouched.
 *
 * NOTE: no backtick characters may appear in this comment block or anywhere
 * else inside the template literal — one would terminate the JS string and
 * break the build.
 */
const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;

  /** Free-running seconds, for the slow evolution of the noise field. */
  uniform float uTime;
  /** Audio-modulated wave phase, accumulated on the CPU. */
  uniform float uFlow;
  /** Smoothed audio envelope, 0..1. */
  uniform float uAudioEnergy;
  /** 1.0 on the high tier, 0.0 on medium: drops the finest octave and wave. */
  uniform float uDetail;

  uniform vec3 uColorPrimary;
  uniform vec3 uColorSecondary;
  uniform vec3 uColorAccent;

  // ── Hash ─────────────────────────────────────────────────────────────────
  // Sin-based 2D hash. The brief allows a cheap sin hash; at the scales the
  // noise is sampled here the difference to gradient noise is invisible, and
  // this is a handful of ALU ops instead of eight gradient dot products.
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    // Smoothstep interpolation. A plain linear blend between the four corners
    // exposes the lattice as diamond creases once the noise is stretched into
    // long vertical fibres, which is exactly how it is used below.
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  /**
   * Four octaves of value noise.
   *
   * The fourth octave is multiplied by the detail argument instead of being
   * skipped by a branch: it is the most fragment work for the least visible
   * texture, so the 'medium' tier fades it out (detail = 0) while keeping one
   * code path.
   */
  float fbm(vec2 p, float detail) {
    float sum = 0.0;
    float amp = 0.5;

    for (int i = 0; i < 4; i++) {
      float octave = (i == 3) ? detail : 1.0;
      sum += amp * octave * valueNoise(p);
      p = p * 2.03 + vec2(19.7, 7.3);
      amp *= 0.5;
    }

    return sum;
  }

  void main() {
    vec2 uv = vUv;

    // Wave clock. uFlow carries the audio-modulated travel; uTime only ever
    // appears unscaled, in the slow drift of the noise field.
    float t = uFlow;

    // ── 1. Large-scale field ──────────────────────────────────────────────
    // One fBm sample does three jobs: it decides where the folds sit, warps
    // the ribbons and sets the height of the lower hem. It is sampled with the
    // y axis stretched, so the folds are tall columns rather than blobs.
    float broad = fbm(
      vec2(uv.x * 3.4 + uTime * 0.022, uv.y * 0.95 + uTime * 0.008),
      uDetail
    );

    // ── 2. Ribbon coordinate ──────────────────────────────────────────────
    // The sway terms make the filaments snake as they rise. A ruler-straight
    // vertical stripe reads as a stripe; a stripe that bends reads as silk.
    float sway =
      sin(uv.y * 3.4 + t * 0.50) * 0.040 +
      sin(uv.y * 7.1 - t * 0.80 + 2.1) * 0.016;

    float x = uv.x + sway + (broad - 0.5) * 0.10;

    // ── 3. Filaments ──────────────────────────────────────────────────────
    // Three incommensurate ribbon families are SUMMED and only then folded
    // around zero. Folding after summing is what spaces the filaments
    // irregularly: bright lines appear where all three cross zero together,
    // which never settles into a repeat. (Folded first and summed, they would
    // just be three overlapping regular gratings.) The frequencies are
    // deliberately irrational multiples of one another for the same reason,
    // and the small uv.y terms give each family a slightly different DIRECTION
    // so the wavefronts lean against each other instead of stacking vertically.
    float r1 = sin(x * 34.0 + uv.y * 0.9 + t * 1.10);
    float r2 = sin(x * 21.0 - uv.y * 1.7 - t * 0.72 + 1.9);
    float r3 = sin(x * 53.0 + uv.y * 2.8 + t * 1.70 + 4.4);
    // Medium tier: the finest family is per-pixel shimmer, so it is faded out.
    r3 *= mix(0.35, 1.0, uDetail);

    float filament = 1.0 - abs(r1 * 0.48 + r2 * 0.34 + r3 * 0.18);
    // Sixth power: the exponent is the filament sharpness. Lower powers read
    // as soft fog bands, higher powers shatter into single-pixel speckle that
    // Bloom then turns into noise.
    filament = filament * filament;
    float squared = filament;
    filament = filament * filament;
    filament = filament * squared;

    // ── 4. Folds ──────────────────────────────────────────────────────────
    // Filaments are grouped into broad sheets by the noise field, leaving dark
    // gaps between curtains instead of a veil spread evenly across the sky.
    float fold = smoothstep(0.28, 0.74, broad + 0.16 * sin(x * 7.0 + t * 0.28));

    // ── 5. Hem and vertical profile ───────────────────────────────────────
    // The bright lower boundary of the curtain, wandering with the folds.
    // uv.y above the hem is the body of the curtain; below it, the tail.
    float hem = 0.40 + (broad - 0.5) * 0.30 + 0.035 * sin(x * 41.0 + t * 0.65);
    float aboveHem = uv.y - hem;

    // Rays rise from the hem and fade with height: that is the aurora shape.
    float raysUp = exp(-max(aboveHem, 0.0) * 3.1);
    // A thin, bright bead of light exactly on the hem — the curtain's edge,
    // and the line the eye follows to read the folds as depth.
    float hemLine = exp(-abs(aboveHem) * 90.0);
    // Below the hem a short accent-coloured tail leaks out before the curtain ends.
    float underHem = (1.0 - smoothstep(-0.07, 0.0, aboveHem)) * 0.45;

    // Mesh-edge falloff. The shell is taller than the frame, so these terms
    // never cut a visible line; they just guarantee the curtain is fully
    // dissolved before either end of the geometry.
    float envelope = smoothstep(0.0, 0.16, uv.y) * (1.0 - smoothstep(0.52, 0.92, uv.y));

    float profile = (raysUp * 0.78 + hemLine * 0.34 + underHem * 0.55) * envelope;

    // ── 6. Vertical fibre texture ─────────────────────────────────────────
    // Vertically stretched noise gives the rays uneven length and brightness,
    // which is what makes the curtain look woven instead of combed. The x
    // frequency is an order of magnitude above the y one: sampled
    // isotropically this noise reads as fog, stretched it reads as fibres.
    float fibre = fbm(
      vec2(uv.x * 22.0 + t * 0.06, uv.y * 2.6 - t * 0.03),
      uDetail
    );

    // ── 7. Density ────────────────────────────────────────────────────────
    // The sharp filament carries the light, and the wider squared copy gives
    // it a halo: an aurora ray is a bright core inside a soft sheath, and
    // stacking the two is what reads as silk rather than as a laser.
    float density =
      (filament + squared * 0.16) *
      (0.12 + 0.95 * fold) *
      (0.45 + 0.85 * fibre) *
      profile;

    // A little haze so the curtain keeps a body between its filaments.
    density += profile * fold * 0.06;

    // ── 8. Alpha ──────────────────────────────────────────────────────────
    // Semi-transparent additive: alpha is how much light this fragment adds.
    float alpha = density;

    // Audio lift. Applied to alpha as well as to emission so a loud moment
    // makes the sky visibly thicker, not merely brighter.
    alpha *= 1.0 + uAudioEnergy * 0.55;

    // Dither: a large additive gradient shows 8-bit banding. A fraction of a
    // percent of fragment-position noise breaks the contours; one hash is far
    // cheaper than the full-screen Noise pass the medium tier does not get.
    alpha += (hash21(gl_FragCoord.xy) - 0.5) * 0.010;

    if (alpha < 0.004) discard;

    // ── 9. Colour ─────────────────────────────────────────────────────────
    // Palette primary as the body, secondary in the brightest filament cores,
    // accent from the hem down through the tail. The accent is pinned to
    // aboveHem rather than to raw height so it follows the folds instead of
    // sitting on a level band.
    float hemMix = 1.0 - smoothstep(-0.02, 0.16, aboveHem);
    vec3 color = mix(uColorPrimary, uColorSecondary, smoothstep(0.35, 1.0, filament));
    color = mix(color, uColorAccent, clamp(hemMix * 0.92, 0.0, 1.0));

    // ── 10. Emission ──────────────────────────────────────────────────────
    // Above 1.0 in the ribbon cores so the Bloom threshold (0.15 luminance)
    // catches the curtain and gives it a halo, but only in the thin filaments:
    // if the whole sheet emitted this hard the sky would turn into flat fog.
    float emission = 0.55 + filament * 1.0 + squared * 0.20 + fibre * 0.22 + uAudioEnergy * 1.0;

    gl_FragColor = vec4(color * emission, clamp(alpha, 0.0, 0.92));
  }
`

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export interface AuroraCurtainProps {
  /**
   * Quality tier.
   *
   * 'medium' drops the finest shader wave and the fourth fBm octave through the
   * `uDetail` uniform, and halves the arc tessellation. The curtain is pure
   * fragment work, so those are the levers that actually pay: vertex count was
   * never the cost.
   */
  tier?: PerformanceTier
}

export function AuroraCurtain({ tier = 'high' }: AuroraCurtainProps) {
  /* ── Visual Overdrive palette ──────────────────────────────────────────── */
  // One selector subscription; a preset change re-renders this component once
  // and the effect below rewrites the three colour uniforms in place.
  const vfxPreset = useAppStore((state) => state.vfxPreset)
  const palette = getVfxPalette(vfxPreset)

  /* ── Geometry: an open-ended, vertically straight cylinder segment ─────── */
  const geometry = useMemo(
    () =>
      new THREE.CylinderGeometry(
        CURTAIN_RADIUS,
        CURTAIN_RADIUS,
        CURTAIN_HEIGHT,
        tier === 'high' ? RADIAL_SEGMENTS.high : RADIAL_SEGMENTS.medium,
        // The wall is vertical and purely fragment-shaded, so one ring of
        // height segments is all that is needed; UVs still interpolate
        // linearly bottom to top.
        1,
        // Open ended: caps would draw a solid ceiling and floor across the sky.
        true,
        CURTAIN_THETA_START,
        CURTAIN_ARC,
      ),
    [tier],
  )

  /* ── Uniforms, allocated exactly once ──────────────────────────────────── */
  const uniforms = useMemo(
    () => ({
      /** Free-running seconds; never scaled, so no phase discontinuity. */
      uTime: { value: 0 },
      /** Accumulated, audio-modulated wave travel phase, in radians. */
      uFlow: { value: 0 },
      /** Smoothed audio envelope, 0..1. */
      uAudioEnergy: { value: 0 },
      /** Set from the tier below; starts low so medium never flashes detail. */
      uDetail: { value: 0 },
      /*
       * Colour uniforms are raw THREE.Color values, like the neighbouring
       * shaders. A raw ShaderMaterial bypasses three's output colourspace
       * conversion (there is no colourspace include here), so the palette is
       * written to the framebuffer as-is; the emission multiplier above 1 is
       * what makes it read as light rather than paint.
       *
       * They are seeded from the live preset here but `palette` is deliberately
       * NOT a memo dependency: rebuilding the uniforms would rebuild the
       * material (and reset uTime/uFlow/uAudioEnergy, snapping the sky back to
       * its first frame). The sync effect below handles a preset change by
       * mutating these three colours only.
       */
      uColorPrimary: { value: new THREE.Color(palette.primary) },
      uColorSecondary: { value: new THREE.Color(palette.secondary) },
      uColorAccent: { value: new THREE.Color(palette.accent) },
    }),
    [],
  )

  /* ── Material ──────────────────────────────────────────────────────────── */
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        // Additive sky light: it must add to whatever is behind it, never
        // occlude it, and it must not touch the depth buffer — the nebula and
        // the stardust trail are drawn after it and are all depthWrite: false,
        // so ordering, not depth, is what layers this scene.
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        // The camera sits inside the shell, so only the inside faces are ever
        // visible; DoubleSide keeps that true across the whole camera dolly
        // without relying on the winding of the generated arc.
        side: THREE.DoubleSide,
        // Additive HDR glow must not be tone-mapped away, or the curtain turns
        // grey once the Bloom pass runs.
        toneMapped: false,
      }),
    [uniforms],
  )

  /* ── Keep the tier levers in sync without resetting the animation ──────── */
  // Deliberately an effect rather than putting `tier` in the uniforms useMemo:
  // rebuilding the uniforms on a tier change would reset uTime, uFlow and the
  // smoothed audio envelope, and the curtain would visibly snap back to its
  // first frame when the adaptive monitor degrades mid-session.
  useEffect(() => {
    uniforms.uDetail.value = tier === 'high' ? 1 : 0
  }, [tier, uniforms])

  /* ── Keep the palette in sync without rebuilding the material ──────────── */
  // Same reasoning as the tier sync above: a preset change is three RGB writes,
  // not a material rebuild. `Color.set` mutates the objects the uniforms already
  // reference, so the very next frame samples the new palette while uTime, uFlow
  // and the smoothed audio envelope continue uninterrupted.
  useEffect(() => {
    uniforms.uColorPrimary.value.set(palette.primary)
    uniforms.uColorSecondary.value.set(palette.secondary)
    uniforms.uColorAccent.value.set(palette.accent)
  }, [palette, uniforms])

  /* ── Dispose GPU resources ─────────────────────────────────────────────── */
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  /* ── Frame loop: four scalar writes, zero allocations ──────────────────── */
  useFrame((state, rawDelta) => {
    const dt = Math.min(rawDelta, MAX_DT)
    if (!(dt > 0)) return

    // Elapsed time is safe here because it is used unscaled: it only drifts
    // the noise field, where a slow evolution is all that is wanted.
    uniforms.uTime.value = state.clock.elapsedTime

    /*
     * Audio envelope.
     *
     * The raw RMS is far too spiky to drive visuals — one hover tick would
     * flash the whole sky for a frame and read as a dropped frame. So the
     * signal is smoothed asymmetrically: a fast attack tracks the transient,
     * a slow release lets the light cool. The coefficients are applied as
     * 1 - exp(-rate * dt) so the response is identical at any frame rate.
     */
    const target = soundEngine.readEnergy()
    const current = uniforms.uAudioEnergy.value
    const rate = target > current ? AUDIO_ATTACK_RATE : AUDIO_RELEASE_RATE
    uniforms.uAudioEnergy.value = current + (target - current) * (1 - Math.exp(-rate * dt))

    /*
     * Wave clock.
     *
     * Accumulated rather than derived from uTime: scaling elapsed time by the
     * energy in the shader multiplies the per-frame energy delta by total page
     * uptime, so a couple of minutes in every energy change becomes a huge
     * phase jump and the pattern strobes. Accumulating dt * speed here is
     * continuous for the whole session.
     */
    uniforms.uFlow.value +=
      dt * (FLOW_BASE_SPEED + FLOW_AUDIO_SPEED * uniforms.uAudioEnergy.value)
  })

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={CURTAIN_POSITION}
      /*
       * Drawn before the rest of the transparent scene. Every other visual in
       * this canvas is additive with depthWrite off, so the depth buffer cannot
       * order them and the draw order does: a negative render order guarantees
       * the sky is composited first, then the nebula, then the cursor trail.
       */
      renderOrder={-1}
      /*
       * The shell wraps around the camera, so its bounding sphere is always in
       * the frustum; the cull test can only ever return "visible". Skipping it
       * keeps a backdrop that is always on screen free of any pop risk at the
       * frustum boundary as the camera travels.
       */
      frustumCulled={false}
    />
  )
}

export default AuroraCurtain
