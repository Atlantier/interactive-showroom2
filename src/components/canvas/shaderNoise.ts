/**
 * The one noise library the WebGL shaders share (SH-13).
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 * Three shaders had each grown their own hash: the architecture plasma and the stage-light cones
 * both used the classic `fract(sin(dot(p, k)) * 43758.5453)` construction, and the aurora had a
 * trig-free 2D hash of its own. Two problems with that:
 *
 *   1. The sin-hash is expensive exactly where it matters. The cones evaluate three octaves of
 *      eight taps per fragment, i.e. 24 `sin()` calls per pixel over a large part of the frame; the
 *      plasma's march is 3 steps x 2 lookups x 8 taps.
 *   2. `sin()` on a large argument is the classic precision failure on mobile GPUs, where the
 *      fragment shader runs at mediump: dots of a few hundred times 43758 exceed the representable
 *      range, the fractional part quantises, and the noise breaks into visible bands.
 *
 * The replacement is the integer-free multiply-xor hash popularised by Dave Hoskins: no
 * transcendentals at all, a few multiplies and a `fract` per tap, and it stays well-behaved at
 * mediump because every intermediate is kept near unit scale.
 *
 * ── What changes visually ──────────────────────────────────────────────────
 * The noise FIELD changes -- a different hash draws a different random lattice -- while its
 * statistics (mean, amplitude, frequency) do not. That is a real, visible-if-you-look change, which
 * is why it was only done after `verify:shader` existed (§5.40): the gate fails on the old baseline
 * and the new one is captured deliberately, with the before/after frames compared by eye.
 *
 * ── Why a GLSL string and not a shader chunk loader ────────────────────────
 * These shaders are plain template literals in components; interpolating one constant adds no
 * bundler machinery and keeps each shader readable end to end. Note the project rule: no backticks
 * inside these strings.
 */

/** 3D hash: Dave Hoskins' multiply-xor construction. No `sin`, no textures. */
export const NOISE_HASH_3D = /* glsl */ `
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
`

/** 2D hash, same construction. Used by the aurora's fibres and its dither. */
export const NOISE_HASH_2D = /* glsl */ `
  float hash12(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
`

/**
 * 3D value noise with smoothstep interpolation.
 *
 * Eight hash taps and a trilinear blend. This is the shape both 3D users want; the stage lights
 * wanted "gradient noise" but were already sampling a scalar hash per corner, which IS value noise.
 */
export const NOISE_VALUE_3D = /* glsl */ `
  float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x);
    float b = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x);
    float c = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x);
    float d = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x);
    return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
  }
`

/** 2D value noise, same interpolation. */
export const NOISE_VALUE_2D = /* glsl */ `
  float vnoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
`
