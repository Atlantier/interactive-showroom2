import * as THREE from 'three'

/**
 * Procedural geometry builders for the three-layer architecture model.
 *
 * Every builder returns a freshly constructed `BufferGeometry` and is called at
 * most once per layer, inside `useMemo`. None of them run inside a frame loop —
 * the whole point is that the shapes are generated from parameters at mount and
 * then reused for the lifetime of the scene.
 */

/* -------------------------------------------------------------------------- */
/*  Layer 1 — Infrastructure / CUDA kernel grid                              */
/* -------------------------------------------------------------------------- */

export interface KernelGridOptions {
  /** Cells per side on the XZ plane. */
  divisions?: number
  /** Total width and depth of the plate. */
  size?: number
  /** Height of the tallest pillar. */
  maxHeight?: number
}

/**
 * A dense matrix of square cells with vertical pillars of varying height.
 *
 * The silhouette is meant to read as silicon: a regular lattice where each cell
 * is a kernel, and the pillar height encodes load. Heights follow a deterministic
 * hash of the cell coordinates so the shape is stable across reloads (a random
 * grid would look different every mount, which is distracting for a narrative
 * section that the camera slowly tours).
 */
export function buildKernelGrid(options: KernelGridOptions = {}): THREE.BufferGeometry {
  const divisions = options.divisions ?? 22
  const size = options.size ?? 6
  const maxHeight = options.maxHeight ?? 0.55

  const positions: number[] = []
  const indices: number[] = []

  const step = size / divisions
  const half = size / 2

  /** Deterministic 0..1 hash of a cell coordinate pair. */
  const hash = (i: number, j: number): number => {
    let h = i * 374761393 + j * 668265263
    h = (h ^ (h >>> 13)) * 1274126177
    h = h ^ (h >>> 16)
    return ((h >>> 0) % 10000) / 10000
  }

  for (let i = 0; i < divisions; i++) {
    for (let j = 0; j < divisions; j++) {
      const x0 = -half + i * step
      const z0 = -half + j * step
      const x1 = x0 + step
      const z1 = z0 + step

      // Height with a radial falloff so the plate reads as a peaked die.
      const cx = (i + 0.5) / divisions - 0.5
      const cz = (j + 0.5) / divisions - 0.5
      const radial = 1 - Math.min(1, Math.sqrt(cx * cx + cz * cz) * 2.1)
      const h = maxHeight * (0.12 + radial * 0.88) * (0.55 + hash(i, j) * 0.45)

      // Pillar side walls: 4 quads, but only the top face and two visible sides
      // are needed — the plate is viewed from above, and skipping hidden faces
      // halves the triangle count on a 22x22 grid.
      const base = positions.length / 3

      // Top face
      positions.push(x0, h, z0, x1, h, z0, x1, h, z1, x0, h, z1)
      // +X side
      positions.push(x1, 0, z0, x1, 0, z1, x1, h, z1, x1, h, z0)
      // +Z side
      positions.push(x1, 0, z1, x0, 0, z1, x0, h, z1, x1, h, z1)

      indices.push(
        base + 0, base + 1, base + 2, base + 0, base + 2, base + 3,
        base + 4, base + 5, base + 6, base + 4, base + 6, base + 7,
        base + 8, base + 9, base + 10, base + 8, base + 10, base + 11,
      )
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

/** Wireframe overlay for the kernel plate: just the top-face lattice lines. */
export function buildKernelWireframe(options: KernelGridOptions = {}): THREE.BufferGeometry {
  const divisions = options.divisions ?? 22
  const size = options.size ?? 6
  const maxHeight = options.maxHeight ?? 0.55

  const points: number[] = []
  const step = size / divisions
  const half = size / 2

  const hash = (i: number, j: number): number => {
    let h = i * 374761393 + j * 668265263
    h = (h ^ (h >>> 13)) * 1274126177
    h = h ^ (h >>> 16)
    return ((h >>> 0) % 10000) / 10000
  }
  const heightAt = (i: number, j: number): number => {
    const cx = (i + 0.5) / divisions - 0.5
    const cz = (j + 0.5) / divisions - 0.5
    const radial = 1 - Math.min(1, Math.sqrt(cx * cx + cz * cz) * 2.1)
    return maxHeight * (0.12 + radial * 0.88) * (0.55 + hash(i, j) * 0.45)
  }

  for (let i = 0; i < divisions; i++) {
    for (let j = 0; j < divisions; j++) {
      const x = -half + (i + 0.5) * step
      const z = -half + (j + 0.5) * step
      const y = heightAt(i, j) + 0.004 // lift slightly to avoid z-fighting

      // A small square outline per cell.
      const r = step * 0.34
      points.push(
        x - r, y, z - r, x + r, y, z - r,
        x + r, y, z - r, x + r, y, z + r,
        x + r, y, z + r, x - r, y, z + r,
        x - r, y, z + r, x - r, y, z - r,
      )
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  geo.computeBoundingSphere()
  return geo
}

/* -------------------------------------------------------------------------- */
/*  Layer 2 — Multi-agent orchestration nodes                                */
/* -------------------------------------------------------------------------- */

export interface AgentNodeSpec {
  /** Position in layer-local space. */
  position: THREE.Vector3Tuple
  /** Relative radius of the octahedron. */
  scale: number
}

/**
 * Node layout for the orchestration layer.
 *
 * Hand-placed rather than random: the narrative needs a recognisable,
 * balanced constellation, and a random layout would change on every mount.
 * Positions are on two staggered rings so the layer has depth when viewed at
 * the camera's 3/4 angle.
 */
export const AGENT_NODES: AgentNodeSpec[] = [
  { position: [0, 0, 0], scale: 1 },
  { position: [1.55, 0.28, 0.35], scale: 0.62 },
  { position: [-1.45, -0.22, 0.55], scale: 0.58 },
  { position: [0.75, -0.3, -1.5], scale: 0.55 },
  { position: [-0.8, 0.34, -1.35], scale: 0.5 },
  { position: [1.75, -0.34, -0.7], scale: 0.44 },
  { position: [-1.8, 0.2, -0.4], scale: 0.42 },
]

/** Which node pairs are connected. Node 0 is the hub. */
export const AGENT_EDGES: Array<[number, number]> = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6],
  [1, 2], [3, 4], [5, 1], [6, 2],
]

/**
 * Build a single edge line as a `LineSegments`-ready position buffer, with an
 * extra attribute carrying normalised distance along the line.
 *
 * The `aAlong` attribute is what lets the shader animate pulses travelling down
 * each connection — the connections must look like they are carrying data, not
 * just sitting there.
 */
export function buildEdgeGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const along: number[] = []

  for (const [ai, bi] of AGENT_EDGES) {
    const a = AGENT_NODES[ai]
    const b = AGENT_NODES[bi]
    if (!a || !b) continue
    positions.push(...a.position, ...b.position)
    along.push(0, 1)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1))
  geo.computeBoundingSphere()
  return geo
}

/* -------------------------------------------------------------------------- */
/*  Inter-layer vertical data conduits                                        */
/* -------------------------------------------------------------------------- */

export interface ConduitOptions {
  /** How many vertical lines are arranged around the Y axis. */
  count?: number
  /** Radius of the ring the lines sit on. */
  radius?: number
  /**
   * Ring radius as a fraction, for the lower and upper gap. The conduits are
   * tapered so the lower gap is wider than the upper one, following the model's
   * silhouette (a wide silicon plate, a narrower prism on top).
   */
  radiusLower?: number
  radiusUpper?: number
}

/**
 * Unit-height vertical ribbon strips that carry the travelling data pulses.
 *
 * ── Why ribbons and not lines ─────────────────────────────────────────────
 * WebGL ignores `linewidth` on virtually every platform: `LineSegments` draws
 * exactly one device pixel regardless. At a 1600px viewport those pulses were
 * effectively invisible. A ribbon is a quad, which has real width, can be
 * camera-facing (billboarded in the shader), and looks the same at any zoom.
 *
 * Each conduit contributes two triangles. The quad is emitted in the XZ plane at
 * zero height and the vertex shader expands it into a billboard, so the buffer
 * never needs rewriting as the layers separate:
 *
 *   aAlong — 0 at the bottom of the gap, 1 at the top
 *   aGap   — 0 for the lower conduit, 1 for the upper one
 *   aSide  — -1 / +1, which edge of the ribbon
 *   aAngle — the ribbon's angle around Y, used to build the billboard basis
 */
export function buildInterLayerConduits(options: ConduitOptions = {}): THREE.BufferGeometry {
  const count = options.count ?? 14
  const radiusLower = options.radiusLower ?? 2.35
  const radiusUpper = options.radiusUpper ?? 1.85

  const positions: number[] = []
  const along: number[] = []
  const gap: number[] = []
  const side: number[] = []
  const angleAttr: number[] = []
  const indices: number[] = []

  // Golden-angle placement avoids the visible spokes an even division produces.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5))

  let vertexBase = 0

  /** Emit one ribbon quad (2 triangles) for a given angle / gap slot. */
  const emitRibbon = (angle: number, radius: number, gapIndex: 0 | 1): void => {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // Four corners: (along, side) = (0,-1), (0,+1), (1,-1), (1,+1)
    const corners: Array<[number, number]> = [
      [0, -1],
      [0, 1],
      [1, -1],
      [1, 1],
    ]
    for (const [a, s] of corners) {
      positions.push(cos * radius, 0, sin * radius)
      along.push(a)
      gap.push(gapIndex)
      side.push(s)
      angleAttr.push(angle)
    }
    indices.push(
      vertexBase, vertexBase + 2, vertexBase + 1,
      vertexBase + 1, vertexBase + 2, vertexBase + 3,
    )
    vertexBase += 4
  }

  for (let i = 0; i < count; i++) {
    emitRibbon(i * GOLDEN, radiusLower, 0)
    // Upper ring is narrower and interleaved by half a golden step.
    emitRibbon(i * GOLDEN + GOLDEN * 0.5, radiusUpper, 1)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1))
  geo.setAttribute('aGap', new THREE.Float32BufferAttribute(gap, 1))
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1))
  geo.setAttribute('aAngle', new THREE.Float32BufferAttribute(angleAttr, 1))
  geo.setIndex(indices)
  // Bounding sphere from a real extent: the quads are repositioned in the shader.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6)
  return geo
}

export interface DataStreamOptions {
  /** Particles per gap. */
  count?: number
  /** Vertical extent of the gap the particles travel through. */
  height?: number
  /** Radius of the cylindrical shell they occupy. */
  radius?: number
}

/**
 * Vertical laser particles that appear between layers when the stack explodes.
 *
 * Each particle carries a random phase so the stream is not a synchronised wall
 * of dots; the shader offsets travel by that phase to produce continuous flow.
 */
export function buildDataStreamGeometry(
  options: DataStreamOptions = {},
): THREE.BufferGeometry {
  const count = options.count ?? 900
  const height = options.height ?? 6
  const radius = options.radius ?? 2.6

  const positions = new Float32Array(count * 3)
  const phase = new Float32Array(count)
  const radiusJitter = new Float32Array(count)

  let seed = 0x1a2b3c4d
  const rand = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return seed / 4294967296
  }

  for (let i = 0; i < count; i++) {
    const i3 = i * 3
    const angle = rand() * Math.PI * 2
    // Bias toward the rim so the streams read as a curtain around the stack.
    const r = radius * (0.55 + Math.pow(rand(), 0.6) * 0.45)

    positions[i3] = Math.cos(angle) * r
    positions[i3 + 1] = (rand() - 0.5) * height
    positions[i3 + 2] = Math.sin(angle) * r

    phase[i] = rand()
    radiusJitter[i] = rand()
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
  geo.setAttribute('aJitter', new THREE.BufferAttribute(radiusJitter, 1))
  geo.computeBoundingSphere()
  return geo
}
