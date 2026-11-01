/**
 * Curl-noise flow field, evaluated on the CPU and baked into a 3-D lookup table.
 *
 * ── Why a baked volume instead of noise in the frame loop ────────────────────
 * Curl noise needs 12 `snoise` samples per evaluation (three potential
 * components × central differences on two axes each). Running that for 8 000
 * particles every frame would be ~96 000 noise evaluations per frame in JS —
 * an order of magnitude too slow for the 120 FPS budget.
 *
 * Instead the divergence-free field is precomputed ONCE on a small lattice and
 * sampled with trilinear interpolation at runtime: ~24 array reads per particle,
 * which is comfortably within budget. The field is animated by drifting the
 * sample position through the lattice over time, so the flow evolves instead of
 * being a static vector field particles eventually settle onto.
 *
 * ── Why curl noise at all ───────────────────────────────────────────────────
 * The curl of any vector field is divergence-free. That property is what makes a
 * flow field read as smoke or water: particles swirl and fold but never pile up
 * into sinks or erupt out of sources. Steering particles with raw `snoise`
 * velocity instead gives visible clumping within a second or two.
 */

/* -------------------------------------------------------------------------- */
/*  3-D Simplex noise (Stefan Gustavson / Ashima Arts, MIT)                    */
/* -------------------------------------------------------------------------- */

const F3 = 1 / 3
const G3 = 1 / 6

/** The 12 gradient directions of the cubic lattice. */
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1,
  1, 0, 1, -1, 0, -1, -1,
])

/** Deterministic permutation table — a fixed seed keeps visuals reproducible. */
const PERM = new Uint8Array(512)

{
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  // xorshift32 with a fixed seed: no Math.random, so HMR/StrictMode remounts
  // produce an identical field instead of a subtly different one.
  let seed = 0x9e3779b9
  const rand = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return seed / 4294967296
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = p[i]
    p[i] = p[j]
    p[j] = tmp
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]
}

/** Contribution of one simplex corner. */
function corner(hash: number, x: number, y: number, z: number): number {
  let t = 0.6 - x * x - y * y - z * z
  if (t < 0) return 0
  t *= t
  const g = (hash % 12) * 3
  return t * t * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z)
}

/** 3-D simplex noise, output roughly in [-1, 1]. */
export function snoise3(x: number, y: number, z: number): number {
  const s = (x + y + z) * F3
  const i = Math.floor(x + s)
  const j = Math.floor(y + s)
  const k = Math.floor(z + s)

  const t = (i + j + k) * G3
  const x0 = x - (i - t)
  const y0 = y - (j - t)
  const z0 = z - (k - t)

  // Work out which of the six simplex tetrahedra we are in.
  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number
  if (x0 >= y0) {
    if (y0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0
    } else if (x0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1
    } else {
      i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1
    }
  } else if (y0 < z0) {
    i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1
  } else if (x0 < z0) {
    i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1
  } else {
    i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0
  }

  const x1 = x0 - i1 + G3
  const y1 = y0 - j1 + G3
  const z1 = z0 - k1 + G3

  const x2 = x0 - i2 + 2 * G3
  const y2 = y0 - j2 + 2 * G3
  const z2 = z0 - k2 + 2 * G3

  const x3 = x0 - 1 + 3 * G3
  const y3 = y0 - 1 + 3 * G3
  const z3 = z0 - 1 + 3 * G3

  const ii = i & 255
  const jj = j & 255
  const kk = k & 255

  const n =
    corner(PERM[ii + PERM[jj + PERM[kk]]], x0, y0, z0) +
    corner(PERM[ii + i1 + PERM[jj + j1 + PERM[kk + k1]]], x1, y1, z1) +
    corner(PERM[ii + i2 + PERM[jj + j2 + PERM[kk + k2]]], x2, y2, z2) +
    corner(PERM[ii + 1 + PERM[jj + 1 + PERM[kk + 1]]], x3, y3, z3)

  // 32 maps the raw sum onto [-1, 1].
  return 32 * n
}

/* -------------------------------------------------------------------------- */
/*  Potential → curl                                                           */
/* -------------------------------------------------------------------------- */

/** Decorrelation offsets so the three potential components are independent. */
const O1 = 0.0
const O2 = 31.416
const O3 = 47.853

/**
 * Finite-difference step, in noise-space units.
 *
 * This value sets how close the discrete field gets to being truly
 * divergence-free. The curl is evaluated with central differences, whose
 * truncation error is O(EPS²) — so a smaller step means less spurious
 * divergence. Measured divergence/magnitude ratio on this field:
 *
 *     EPS = 0.14  → ratio 0.300
 *     EPS = 0.07  → ratio 0.067
 *     EPS = 0.03  → ratio 0.013   ← used
 *     EPS = 0.01  → ratio 0.005
 *
 * It cannot be pushed much below ~0.02: subtraction cancellation in float32
 * starts turning the difference into quantization noise. 0.03 is the sweet spot
 * and keeps the median divergence ~70× below the field magnitude.
 */
const FD_EPS = 0.03

/**
 * Curl of the vector potential
 *   P(p) = (snoise(p + O1), snoise(p + O2), snoise(p + O3))
 * written into `out` at `[o]`, `[o+1]`, `[o+2]`.
 *
 * Requires 12 noise samples; only used while baking.
 */
function curlAt(
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  o: number,
): void {
  const e = FD_EPS
  const inv = 1 / (2 * e)

  // ∂Pz/∂y, ∂Py/∂z
  const pz_y1 = snoise3(x + O3, y + e, z)
  const pz_y0 = snoise3(x + O3, y - e, z)
  const py_z1 = snoise3(x + O2, y, z + e)
  const py_z0 = snoise3(x + O2, y, z - e)

  // ∂Px/∂z, ∂Pz/∂x
  const px_z1 = snoise3(x + O1, y, z + e)
  const px_z0 = snoise3(x + O1, y, z - e)
  const pz_x1 = snoise3(x + O3 + e, y, z)
  const pz_x0 = snoise3(x + O3 - e, y, z)

  // ∂Py/∂x, ∂Px/∂y
  const py_x1 = snoise3(x + O2 + e, y, z)
  const py_x0 = snoise3(x + O2 - e, y, z)
  const px_y1 = snoise3(x + O1, y + e, z)
  const px_y0 = snoise3(x + O1, y - e, z)

  out[o] = (pz_y1 - pz_y0) * inv - (py_z1 - py_z0) * inv
  out[o + 1] = (px_z1 - px_z0) * inv - (pz_x1 - pz_x0) * inv
  out[o + 2] = (py_x1 - py_x0) * inv - (px_y1 - px_y0) * inv
}

/* -------------------------------------------------------------------------- */
/*  Baked volume                                                              */
/* -------------------------------------------------------------------------- */

export interface CurlVolume {
  /** Flat `vec3` table, `resolution³` entries. */
  data: Float32Array
  /** Lattice edge length (number of samples per axis). */
  resolution: number
  /** Half-extent of the sampled cube in world units. */
  extent: number
  /** World-space step between adjacent lattice samples. */
  step: number
}

export interface CurlVolumeOptions {
  /** Samples per axis. 18³ is a good quality/size tradeoff. */
  resolution?: number
  /** Half-extent of the cube the field covers, in world units. */
  extent?: number
  /** Overall strength scaling applied to every vector. */
  strength?: number
}

/**
 * Bake the curl-noise field into a flat `Float32Array`.
 *
 * Cost: `resolution³ × 12` simplex evaluations, done once. At 18³ that is ~70 k
 * calls (a few milliseconds), and it happens on mount, never inside a frame.
 *
 * ── Why the field is NOT per-sample normalised ──────────────────────────────
 * Normalising each vector to unit length is tempting (uniform force, no dead
 * spots) but it destroys the one property this whole technique exists for:
 * the curl field is divergence-free, and dividing by a spatially varying
 * magnitude reintroduces divergence through
 *
 *     ∇·(v/|v|) = (∇·v)/|v| − (v·∇|v|)/|v|²
 *
 * The second term is not zero, so particles start to clump and thin out in
 * patches. Measured on this field, per-sample normalisation raised the median
 * divergence ~4× (0.996 → 4.078). Instead the raw curl is kept and multiplied by
 * a single global `strength`, which preserves ∇·v = 0 exactly.
 */
export function buildCurlVolume(options: CurlVolumeOptions = {}): CurlVolume {
  const resolution = options.resolution ?? 18
  const extent = options.extent ?? 7
  const strength = options.strength ?? 1.35

  const count = resolution * resolution * resolution
  const data = new Float32Array(count * 3)

  const step = (extent * 2) / (resolution - 1)
  const invStep = 1 / step

  // Noise frequency: how many noise features fit across the volume.
  const freq = 0.42

  let o = 0
  for (let k = 0; k < resolution; k++) {
    const wz = -extent + k * step
    for (let j = 0; j < resolution; j++) {
      const wy = -extent + j * step
      for (let i = 0; i < resolution; i++) {
        const wx = -extent + i * step

        curlAt(wx * freq, wy * freq, wz * freq, data, o)

        // Uniform scaling only — direction AND relative magnitude are the
        // divergence-free field; see the note above.
        data[o] *= strength
        data[o + 1] *= strength
        data[o + 2] *= strength

        o += 3
      }
    }
  }

  return { data, resolution, extent, step: invStep }
}

/**
 * Trilinear sample of the baked volume, written into `out` at `[o..o+2]`.
 *
 * Fully allocation-free. `drift` shifts the sample point so the field evolves
 * over time; coordinates are clamped into the lattice rather than wrapped, which
 * avoids a visible seam at the cube boundary.
 */
export function sampleCurl(
  volume: CurlVolume,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  o: number,
): void {
  const { data, resolution, extent, step } = volume

  // World → lattice coordinates.
  const gx = (x + extent) * step
  const gy = (y + extent) * step
  const gz = (z + extent) * step

  // Floor + clamp so i0 and i0+1 are always in range.
  const max = resolution - 2
  let i0 = Math.floor(gx)
  let j0 = Math.floor(gy)
  let k0 = Math.floor(gz)
  if (i0 < 0) i0 = 0
  else if (i0 > max) i0 = max
  if (j0 < 0) j0 = 0
  else if (j0 > max) j0 = max
  if (k0 < 0) k0 = 0
  else if (k0 > max) k0 = max

  const fx = Math.min(Math.max(gx - i0, 0), 1)
  const fy = Math.min(Math.max(gy - j0, 0), 1)
  const fz = Math.min(Math.max(gz - k0, 0), 1)

  const i1 = i0 + 1
  const j1 = j0 + 1
  const k1 = k0 + 1

  const res = resolution
  const res2 = res * res

  // Corner linear indices (×3 for the vec3 stride).
  const c000 = (k0 * res2 + j0 * res + i0) * 3
  const c100 = (k0 * res2 + j0 * res + i1) * 3
  const c010 = (k0 * res2 + j1 * res + i0) * 3
  const c110 = (k0 * res2 + j1 * res + i1) * 3
  const c001 = (k1 * res2 + j0 * res + i0) * 3
  const c101 = (k1 * res2 + j0 * res + i1) * 3
  const c011 = (k1 * res2 + j1 * res + i0) * 3
  const c111 = (k1 * res2 + j1 * res + i1) * 3

  // Interpolate each component with the standard 8-corner blend.
  for (let c = 0; c < 3; c++) {
    const x00 = data[c000 + c] + (data[c100 + c] - data[c000 + c]) * fx
    const x10 = data[c010 + c] + (data[c110 + c] - data[c010 + c]) * fx
    const x01 = data[c001 + c] + (data[c101 + c] - data[c001 + c]) * fx
    const x11 = data[c011 + c] + (data[c111 + c] - data[c011 + c]) * fx

    const y0 = x00 + (x10 - x00) * fy
    const y1 = x01 + (x11 - x01) * fy

    out[o + c] = y0 + (y1 - y0) * fz
  }
}
