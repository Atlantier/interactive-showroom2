import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { VolumetricStageLights } from '@/components/canvas/VolumetricStageLights'
import { FloorCaustics } from '@/components/canvas/architecture/FloorCaustics'
import * as THREE from 'three'
import { preloadR3FAdvance, setCanvasActive } from '@/lib/frameBridge'
import { supportsWebGL } from '@/lib/device'
import { damp } from '@/lib/math'
import { useAppStore } from '@/store/useAppStore'
import {
  AGENT_NODES,
  buildDataStreamGeometry,
  buildEdgeGeometry,
  buildInterLayerConduits,
  buildKernelGrid,
  buildKernelWireframe,
} from '@/components/canvas/architecture/geometry'
import {
  LAYER_Y,
  PHASE,
  createCameraPath,
  ramp,
} from '@/components/canvas/architecture/cameraPath'
import { findLayer, focusPoseFor } from '@/components/canvas/architecture/layers'
import { soundEngine } from '@/utils/soundEngine'
import type { InViewRef } from '@/hooks/useInViewAnimation'
import type { ProgressStore } from '@/hooks/useSectionProgress'

/**
 * ScrollArchitecture3D —the keynote-style three-tier architecture narrative.
 *
 * ── What this renders ──────────────────────────────────────────────────────
 * A stack of three procedurally built layers, driven entirely by the section's
 * local scroll progress `p ∈[0,1]`:
 *
 *   p ∈[0.0, 0.3]  interlocked, slowly self-rotating
 *   p ∈[0.3, 0.7]  exploded along Y, vertical laser streams appear,
 *                   camera rides a Catmull-Rom path and settles on the middle
 *   p ∈[0.7, 1.0]  reassembles, fades out, hand-off to the DOM cards
 *
 * ── The three layers ──────────────────────────────────────────────────────
 *  1. INFRASTRUCTURE / CUDA KERNELS —a procedural cell grid with per-cell
 *     pillar heights, drawn solid + wireframe. Reads as silicon under load.
 *  2. MULTI-AGENT ORCHESTRATION —glowing octahedra with shader-driven pulses
 *     travelling along the edges between them.
 *  3. SPATIAL WEB / UI — a hard-edged geodesic cage (flat-shaded metal with a
 *     cyan edge lattice) around a glowing inner star that counter-rotates.
 *
 * ── Clock ─────────────────────────────────────────────────────────────────
 * `frameloop="never"`, like every other canvas in this app: the single Lenis RAF
 * advances every R3F root with one timestamp. See `lib/frameBridge.ts`.
 *
 * ── Allocation discipline ─────────────────────────────────────────────────
 * Every Vector3 and scratch object used per frame is created in `useMemo`.
 * The only per-frame allocations are inside three.js' own matrix updates.
 */

/* -------------------------------------------------------------------------- */
/*  Shaders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Edge pulse shader.
 *
 * Uses the `aAlong` attribute (0 at one endpoint, 1 at the other) plus a time
 * uniform to push a bright band down every connection. This is what makes the
 * orchestration layer look like live traffic rather than a static diagram.
 */
const EDGE_VERTEX = /* glsl */ `
  attribute float aAlong;
  varying float vAlong;
  void main() {
    vAlong = aAlong;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const EDGE_FRAGMENT = /* glsl */ `
  varying float vAlong;
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColorCore;
  uniform vec3 uColorEdge;

  void main() {
    // Three pulses spaced evenly, travelling toward increasing "along".
    float travel = fract(vAlong * 1.0 - uTime * 0.45);
    // Sharp leading edge: the band is bright at travel≈ and decays fast.
    // Wider band than before (8 instead of 14): at 14 only a few pixels of each
    // link ever lit up, which is why the network read as dim static wires.
    float pulse = pow(1.0 - travel, 8.0);

    vec3 col = mix(uColorEdge, uColorCore, pulse);
    // Resting alpha raised from 0.16 to 0.34 so the topology stays readable
    // between pulses, not only where the travelling band happens to be.
    float alpha = (0.34 + pulse * 0.9) * uIntensity;

    gl_FragColor = vec4(col, alpha);
  }
`

/**
 * Vertical laser stream shader.
 *
 * Particles are pre-distributed on a cylindrical shell; this shader scrolls them
 * along Y by their per-particle phase, so the curtain flows without any CPU work
 * per frame. `uSpread` is driven by the explode phase: zero while the stack is
 * closed, one when fully separated.
 */
const STREAM_VERTEX = /* glsl */ `
  attribute float aPhase;
  attribute float aJitter;
  uniform float uTime;
  uniform float uSpread;
  uniform float uHeight;
  varying float vFade;

  void main() {
    vec3 pos = position;

    // Scroll along Y. Each particle has a random phase, so the column never
    // appears to move as one rigid body.
    float travel = fract(aPhase + uTime * 0.28);
    pos.y = (travel - 0.5) * uHeight;

    // Squeeze the radius toward the axis while the stack is closed, so the
    // streams are invisible (and cost nothing to draw) at p < 0.3.
    pos.xz *= mix(0.15, 1.0, uSpread);

    // Fade the ends of each particle's travel so they do not pop in/out at the
    // clipping boundary.
    float endFade = smoothstep(0.0, 0.15, travel) * (1.0 - smoothstep(0.82, 1.0, travel));
    vFade = endFade * uSpread * (0.55 + aJitter * 0.45);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (2.2 + aJitter * 2.6) * (220.0 / max(-mv.z, 0.1));
  }
`

const STREAM_FRAGMENT = /* glsl */ `
  varying float vFade;
  uniform vec3 uColor;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;
    float core = pow(1.0 - d, 1.8);
    gl_FragColor = vec4(uColor * (0.7 + core * 0.9), core * vFade);
  }
`

/* -------------------------------------------------------------------------- */
/*  Layer 1 —Infrastructure                                                  */
/* -------------------------------------------------------------------------- */

function InfrastructureLayer({ groupRef }: { groupRef: React.RefObject<THREE.Group | null> }) {
  const solid = useMemo(() => buildKernelGrid({ divisions: 22, size: 6, maxHeight: 0.62 }), [])
  const wire = useMemo(() => buildKernelWireframe({ divisions: 22, size: 6, maxHeight: 0.62 }), [])

  useEffect(
    () => () => {
      solid.dispose()
      wire.dispose()
    },
    [solid, wire],
  )

  return (
    <group ref={groupRef}>
      <mesh geometry={solid}>
        <meshStandardMaterial
          color="#06202a"
          metalness={0.9}
          roughness={0.28}
          emissive="#052a33"
          emissiveIntensity={0.55}
        />
      </mesh>
      {/* Wireframe lattice: emissive so Bloom picks it up. */}
      <lineSegments geometry={wire}>
        <lineBasicMaterial color="#22d3ee" transparent opacity={0.5} toneMapped={false} />
      </lineSegments>
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/*  Layer 2 —Multi-agent orchestration                                       */
/* -------------------------------------------------------------------------- */

/**
 * The multi-agent layer: floating obsidian shards wired together by flowing
 * light.
 *
 * Each node is three nested objects rather than one mesh, because no single
 * material can be dark, translucent, rim-lit and self-lit at once:
 *
 *   shell   translucent metal — catches the environment, lets starlight through
 *   edges   twelve bright lines — this is what makes a shard legible at distance
 *   core    a small emissive point that breathes, seeding Bloom inside the shell
 *
 * The previous version was one flat-shaded octahedron per node with an emissive
 * tint; at this size it read as a matte coloured block, which is what the brief
 * asked to replace.
 */
/**
 * Design-time opacity of every material the exit fade touches, captured the
 * first time the traversal sees it. A WeakMap so materials stay collectable
 * along with the rig that owns them.
 */
const baseOpacity = new WeakMap<THREE.Material, number>()

/**
 * Global exit weight for the chapter: 1 while it is live, 0 once it has handed
 * over to the stat cards.
 *
 * Shared on purpose. Materials that render through `material.opacity` are faded
 * by the rig's traversal, but a `ShaderMaterial` computes its own alpha and
 * ignores that property entirely — which is exactly how the agent links and the
 * plasma core ended up as the only things still on screen at the end of the
 * chapter. Anything with a hand-written fragment shader has to multiply this in
 * itself.
 */
function sceneFade(p: number): number {
  return 1 - ramp(p, PHASE.fadeStart, 0.99)
}

function OrchestrationLayer({
  groupRef,
  progress,
}: {
  groupRef: React.RefObject<THREE.Group | null>
  progress: ProgressStore
}) {
  const edgeGeo = useMemo(() => buildEdgeGeometry(), [])
  const nodeGeo = useMemo(() => new THREE.OctahedronGeometry(0.34, 0), [])
  /** The octahedron's 12 hard edges — the neon outline. */
  const nodeEdgeGeo = useMemo(() => new THREE.EdgesGeometry(nodeGeo), [nodeGeo])

  const edgeUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 1.2 },
      uColorCore: { value: new THREE.Color('#a5f3ff') },
      uColorEdge: { value: new THREE.Color('#00e5ff') },
    }),
    [],
  )

  const linkRef = useRef<THREE.LineSegments>(null)
  const nodeRefs = useRef<Array<THREE.Group | null>>([])
  const coreRefs = useRef<Array<THREE.Mesh | null>>([])

  useEffect(
    () => () => {
      edgeGeo.dispose()
      nodeGeo.dispose()
      nodeEdgeGeo.dispose()
    },
    [edgeGeo, nodeGeo, nodeEdgeGeo],
  )

  useFrame((state) => {
    const t = state.clock.elapsedTime
    edgeUniforms.uTime.value = t

    const p = progress.get()
    const focus = ramp(p, 0.45, 0.72) // brighten as the camera arrives

    for (let i = 0; i < nodeRefs.current.length; i++) {
      const node = nodeRefs.current[i]
      if (!node) continue
      const spec = AGENT_NODES[i]
      if (!spec) continue

      /*
       * Per-node phase offset `index * 0.7`, as specified. Two shards sharing a
       * phase read as one rigid body; staggering them is the cheapest way to
       * make the constellation look independently suspended.
       *
       * Amplitudes are deliberately small. The layer sits at y = 0 while the
       * wireframe floor is at -0.95, and the lowest shard rests around -0.6, so
       * a ±0.085 drift keeps every node clear of the matrix at all times — no
       * clipping, and the hover gap survives the whole scroll range.
       */
      const offset = i * 0.7

      node.position.y = spec.position[1] + Math.sin(t * 0.9 + offset) * 0.085
      node.rotation.y = t * (0.32 + i * 0.05)
      node.rotation.x = Math.sin(t * 0.45 + offset) * 0.16
      node.rotation.z = Math.sin(t * 0.62 + offset) * 0.11

      const breathe = 1 + Math.sin(t * 1.6 + offset) * 0.06
      node.scale.setScalar(spec.scale * (breathe + focus * 0.14))

      // Inner core pulses on its own, faster cycle so the shard twinkles from
      // the inside rather than scaling as one rigid piece.
      const core = coreRefs.current[i]
      if (core) {
        const material = core.material as THREE.MeshStandardMaterial
        material.emissiveIntensity =
          1.4 + (0.5 + 0.5 * Math.sin(t * 2.1 + offset)) * 1.6
      }
    }

    /*
     * The links carry the global exit weight themselves. This is a ShaderMaterial,
     * so the rig's `material.opacity` traversal never reaches its alpha: before
     * this multiplier existed the network was the last thing on screen, and it
     * kept getting brighter as `focus` rose while everything else faded out.
     */
    const fade = sceneFade(p)
    edgeUniforms.uIntensity.value = (1.15 + focus * 0.7) * fade

    // At zero there is nothing left to see — drop the draw rather than leaving an
    // invisible line batch submitting work every frame.
    const links = linkRef.current
    if (links) links.visible = fade > 0.002
  })

  return (
    <group ref={groupRef}>
      {/*
       * Data links.
       *
       * Still a custom shader rather than `LineDashedMaterial`. This three
       * release has no `dashOffset` on that material — only scale, dashSize and
       * gapSize — so a marching pattern cannot be built by animating it. The
       * shader below produces the same travelling pulse via
       * `fract(along - time)`, as a soft gradient rather than hard dashes, which
       * also survives Bloom far better than a dashed line does.
       */}
      <lineSegments ref={linkRef} geometry={edgeGeo} renderOrder={2}>
        <shaderMaterial
          vertexShader={EDGE_VERTEX}
          fragmentShader={EDGE_FRAGMENT}
          uniforms={edgeUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>

      {AGENT_NODES.map((spec, i) => (
        <group
          key={i}
          ref={(el) => {
            nodeRefs.current[i] = el
          }}
          position={spec.position}
        >
          {/* Translucent obsidian shell. */}
          <mesh geometry={nodeGeo}>
            <meshPhysicalMaterial
              color="#04121d"
              metalness={0.9}
              roughness={0.1}
              transparent
              opacity={0.35}
              side={THREE.DoubleSide}
              /*
               * No depth write: the shell must not occlude the core sitting
               * inside it, and these shards overlap the links behind them.
               */
              depthWrite={false}
              envMapIntensity={1.5}
            />
          </mesh>

          {/* Neon edges: twelve lines per shard. */}
          <lineSegments geometry={nodeEdgeGeo} renderOrder={3}>
            <lineBasicMaterial
              color="#00f0ff"
              transparent
              opacity={0.9}
              toneMapped={false}
              depthWrite={false}
            />
          </lineSegments>

          {/*
           * Inner micro-core.
           *
           * Radius 0.1 against an octahedron of circumradius 0.34 — the
           * octahedron's inradius is 0.34 / sqrt(3) ~ 0.196, so the sphere sits
           * comfortably inside and never pokes through a facet.
           */}
          <mesh
            ref={(el) => {
              coreRefs.current[i] = el
            }}
          >
            <sphereGeometry args={[0.1, 16, 12]} />
            <meshStandardMaterial
              color="#bae6fd"
              emissive="#38bdf8"
              emissiveIntensity={2}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* Hub glow: a soft additive light behind node 0. */}
      <pointLight position={[0, 0, 0]} intensity={9} distance={7} color="#22d3ee" />
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/*  Layer 3 — Spatial web core                                                */
/* -------------------------------------------------------------------------- */

/**
 * Outer cage radius. Detail 0, so this is also the centre-to-vertex distance.
 *
 * Sized together with `CORE_HOVER_LIFT` so the requested hover gap (0.8x the
 * radius) can be met without pushing the top of the cage out of frame — at 1.8
 * the same gap lifted the cage past the top edge.
 */
const CORE_SHELL_RADIUS = 1.5

/** Inner plasma sphere: 45% of the cage, per the brief. */
const CORE_INNER_RADIUS = CORE_SHELL_RADIUS * 0.45

/**
 * Hover gap above the infrastructure matrix.
 *
 * `LAYER_Y.rest` parks this layer almost on top of the grid, so the cage reads
 * as sitting on it. The contents get their own raised parent group instead of
 * moving `LAYER_Y` itself — the camera path and the layer registry both read
 * that constant, and shifting it would desync the framing along the chapter.
 *
 * 0.8 x radius is exactly the gap the brief asks for: the grid sits at
 * `LAYER_Y.rest[0]`, so the clearance works out to `LIFT + 0.1`, which is 1.2
 * units for a 1.5-unit cage.
 */
const CORE_HOVER_LIFT = 0.8

/**
 * Plasma core shaders.
 *
 * The inner sphere is a live noise field rather than a lit surface: a solid
 * emissive ball reads as a sticker no matter how bright it is, because its
 * shading carries no information. Three octaves of 3D simplex noise scrolling at
 * different rates produce a surface that visibly churns, and the limb term keeps
 * the silhouette brighter than the centre — the signature of a volume glowing
 * edge-on rather than a flat disc.
 */
const PLASMA_VERTEX = `
varying vec3 vPos;
varying vec3 vNormalW;
varying vec3 vViewDir;

void main() {
  vPos = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormalW = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`

/**
 * Ashima Arts / Stefan Gustavson 3D simplex noise (MIT).
 *
 * Included rather than sampled from a texture: a noise texture would need a
 * loader, a UV unwrap and ~1 MB of assets, and this project ships no assets at
 * all. Roughly 60 lines of maths is the cheaper trade.
 */
const PLASMA_NOISE = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

const PLASMA_FRAGMENT = `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uHot;
uniform float uIntensity;

varying vec3 vPos;
varying vec3 vNormalW;
varying vec3 vViewDir;

${PLASMA_NOISE}

void main() {
  vec3 p = vPos * 2.4;
  float t = uTime * 0.32;

  // Three octaves scrolling at different rates and directions: a single octave
  // pulses in place instead of churning.
  float n1 = snoise(p + vec3(0.0, t, 0.0));
  float n2 = snoise(p * 2.1 + vec3(-t * 1.3, 0.0, t * 0.9));
  float n3 = snoise(p * 4.3 + vec3(t * 2.0, t * 1.1, 0.0));

  float plasma = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
  plasma = plasma * 0.5 + 0.5;

  // Limb brightening: a glowing volume is brighter edge-on than face-on.
  float facing = max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);
  float limb = pow(1.0 - facing, 1.8);

  // Bias the ramp so most of the surface is hot and only the noise troughs stay
  // deep. The first pass used a 0.32-0.82 ramp, which left the sphere reading as
  // a black marble with cyan blotches.
  vec3 col = mix(uDeep, uHot, smoothstep(0.18, 0.68, plasma));
  col += uHot * limb * 1.1;

  // Gamma lift on the midtones, then a white-hot term for the few cells that
  // clip above 1.0 — that is what gives Bloom something to grab onto.
  col = pow(col, vec3(0.82));
  col += uHot * pow(plasma, 4.0) * 0.9;
  col *= (0.95 + plasma * 0.6) * uIntensity;

  gl_FragColor = vec4(col, 1.0);
}
`

/**
 * Concentric "quantum core": a translucent titanium cage around a plasma sphere.
 *
 * ── Geometry is detail 0 on purpose ──────────────────────────────────────
 * An icosahedron at detail 0 is exactly twenty triangles. Subdividing it (detail
 * 1 is eighty, detail 2 is three hundred and twenty) turns the silhouette into a
 * ball and the edge lattice into visual noise — the exact failure mode of the
 * previous revision. Twenty large planes are what make it read as a machined
 * component.
 */
/* -------------------------------------------------------------------------- */
/*  Chromatic dispersion                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-channel refractive indices for the top-layer prism, per the brief.
 *
 * The spread is deliberately tiny — 0.06 across the visible spectrum — because
 * that is all real glass shows: a couple of pixels of colour fringing right at
 * the silhouette. Widening it further reads as a rendering artefact.
 */
const IOR_RED = 1.12
const IOR_GREEN = 1.15
const IOR_BLUE = 1.18

/**
 * Dispersion shell.
 *
 * The cage is a translucent metal with no transmission, so a literal per-channel
 * refraction has nothing to refract. What the eye actually reads as dispersion on
 * a lit edge is the three channels' Fresnel falloffs landing at slightly
 * different distances from the silhouette — a higher IOR bends more, so its rim
 * band sits further out. This shell reproduces that directly: the graze-angle
 * term is offset per channel by its IOR delta, then all three are raised to the
 * same falloff exponent so the separation comes from the IOR alone.
 */
const DISPERSION_VERTEX = `
  varying vec3 vN;
  varying vec3 vV;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const DISPERSION_FRAGMENT = `
  uniform vec3 uIOR;
  uniform float uBase;
  uniform float uSpread;
  uniform float uIntensity;

  varying vec3 vN;
  varying vec3 vV;

  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float graze = clamp(1.0 - facing, 0.0, 1.0);

    // Offset each channel by its IOR relative to green, which is the reference
    // axis: red bends less (band shifts inward), blue bends more (outward).
    vec3 shifted = clamp(vec3(graze) + (uIOR - vec3(uIOR.g)) * uSpread, 0.0, 1.0);

    vec3 spectrum = pow(shifted, vec3(uBase));

    gl_FragColor = vec4(spectrum * uIntensity, spectrum.g);
  }
`

function SpatialLayer({
  groupRef,
  progress,
}: {
  groupRef: React.RefObject<THREE.Group | null>
  progress: ProgressStore
}) {
  const shellGeo = useMemo(
    () => new THREE.IcosahedronGeometry(CORE_SHELL_RADIUS, 0),
    [],
  )

  /**
   * Feature edges only.
   *
   * A 15-degree threshold keeps every real crease on a detail-0 icosahedron (the
   * 30 edges all meet at roughly 138 degrees) and drops anything coplanar. No
   * `wireframe: true` anywhere: that flag draws triangle edges through the
   * rasteriser without depth-correct thickness, which is why it always looks
   * like graph paper rather than like an edge highlight.
   */
  const edgeGeo = useMemo(() => new THREE.EdgesGeometry(shellGeo, 15), [shellGeo])

  useEffect(
    () => () => {
      edgeGeo.dispose()
      shellGeo.dispose()
    },
    [shellGeo, edgeGeo],
  )

  const plasmaUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      // Troughs are a lit blue, not near-black: a very dark `uDeep` made the
      // whole sphere read as a black marble with cyan blotches on it.
      uDeep: { value: new THREE.Color('#0a3f66') },
      uHot: { value: new THREE.Color('#5ff2ff') },
      uIntensity: { value: 1.5 },
    }),
    [],
  )

  /**
   * Owned here rather than declared as `<shaderMaterial uniforms={...}>`.
   * R3F re-applies props on every render and `uniforms` is only honoured at
   * construction, which detaches the objects this component mutates in
   * `useFrame` from the ones the shader reads — the pulse then silently freezes.
   */
  const plasmaMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: plasmaUniforms,
        vertexShader: PLASMA_VERTEX,
        fragmentShader: PLASMA_FRAGMENT,
        toneMapped: false,
      }),
    [plasmaUniforms],
  )
  useEffect(() => () => plasmaMaterial.dispose(), [plasmaMaterial])

  const dispersionUniforms = useMemo(
    () => ({
      uIOR: { value: new THREE.Vector3(IOR_RED, IOR_GREEN, IOR_BLUE) },
      uBase: { value: 2.6 },
      /**
       * Screen-space separation per unit of IOR delta. The delta is only ±0.03
       * around green, so this multiplier is what turns it into a visible fringe;
       * 2.0 puts the three bands roughly two pixels apart at the chapter's
       * camera distance, which is the range real dispersion occupies.
       */
      uSpread: { value: 2.0 },
      uIntensity: { value: 1 },
    }),
    [],
  )

  const dispersionMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: dispersionUniforms,
        vertexShader: DISPERSION_VERTEX,
        fragmentShader: DISPERSION_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [dispersionUniforms],
  )
  useEffect(() => () => dispersionMaterial.dispose(), [dispersionMaterial])

  const shellRef = useRef<THREE.Group>(null)
  const coreRef = useRef<THREE.Mesh>(null)
  const lightRef = useRef<THREE.PointLight>(null)

  /**
   * Counter-rotation + breathing.
   *
   * The cage and the core turn on different axes in opposite directions, which
   * is what makes the assembly read as a mechanism rather than as one object
   * spinning. Rotation is integrated from `delta` so the speed stays
   * framerate-independent, and it is applied to child nodes — never to the group
   * — so it composes with the chapter's scroll choreography instead of fighting
   * it.
   */
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime
    plasmaUniforms.uTime.value = t

    const shell = shellRef.current
    if (shell) {
      shell.rotation.y += delta * 0.16
      shell.rotation.z += delta * 0.07
    }

    const core = coreRef.current
    if (core) {
      // Different axis, opposite direction: the core stays the calm centre.
      core.rotation.x -= delta * 0.05
      core.rotation.y -= delta * 0.09

      const breathe = 0.5 + 0.5 * Math.sin(t * 1.4)
      // 0.95 .. 1.05, per the brief.
      core.scale.setScalar(0.95 + breathe * 0.1)

      // Drives overall plasma brightness; the shader owns the colour mix.
      plasmaUniforms.uIntensity.value = 1.35 + breathe * 0.45

      /*
       * The dispersion shell is a ShaderMaterial, so the rig's `material.opacity`
       * fade traversal never reaches it — it has to apply the chapter's exit
       * weight itself, or it stays lit after everything else has faded.
       */
      dispersionUniforms.uIntensity.value = 1.05 * sceneFade(progress.get())

      if (lightRef.current) lightRef.current.intensity = 2.6 + breathe * 1.8
    }
  })

  return (
    <group ref={groupRef}>
      {/* Hover gap above the infrastructure matrix. */}
      <group position={[0, CORE_HOVER_LIFT, 0]}>
        {/*
         * ── Outer cage ─────────────────────────────────────────────────────
         * Twenty large translucent facets, highly metallic and very smooth so
         * that each plane throws one hard specular streak.
         *
         * `transparent` + `opacity 0.25` is what lets the plasma read through
         * the shell. `depthWrite: false` is load-bearing: with depth writes on,
         * the front faces claim the depth buffer and cull the core behind them.
         */}
        <group ref={shellRef}>
          <mesh geometry={shellGeo}>
            <meshPhysicalMaterial
              color="#031525"
              metalness={0.9}
              roughness={0.1}
              transparent
              opacity={0.25}
              side={THREE.DoubleSide}
              depthWrite={false}
              envMapIntensity={1.6}
            />
          </mesh>

          {/*
           * Feature edges, nested so they inherit the cage's rotation.
           *
           * `toneMapped={false}` keeps the cyan above the bloom threshold, and
           * `linewidth` is ignored by every mainstream WebGL implementation — so
           * the glow has to come from Bloom, not from stroke thickness.
           */}
          <lineSegments geometry={edgeGeo} renderOrder={4}>
            <lineBasicMaterial
              color="#00f0ff"
              toneMapped={false}
              transparent
              opacity={0.95}
              depthWrite={false}
            />
          </lineSegments>

          {/*
           * Dispersion fringe. A hair larger than the cage and parented to it,
           * so the three channel bands sit just outside the silhouette and
           * rotate with the prism.
           */}
          <mesh geometry={shellGeo} material={dispersionMaterial} scale={1.021} renderOrder={5} />
        </group>

        {/*
         * ── Plasma core ────────────────────────────────────────────────────
         * Opaque, so it lands in the opaque pass and the translucent cage blends
         * over it. Bloom then lifts the hot noise cells and the limb.
         */}
        <mesh ref={coreRef} material={plasmaMaterial}>
          <sphereGeometry args={[CORE_INNER_RADIUS, 64, 48]} />
        </mesh>

        {/*
         * ── Core light ─────────────────────────────────────────────────────
         * An emissive surface illuminates nothing by itself. Without a real light
         * the surrounding cubes and the wireframe floor stay unlit and the core
         * looks pasted on rather than sitting in the scene.
         */}
        <pointLight ref={lightRef} color="#00f0ff" intensity={3} distance={10} decay={2} />
      </group>
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/*  Data streams                                                              */
/* -------------------------------------------------------------------------- */

function DataStreams({ progress }: { progress: ProgressStore }) {
  const geo = useMemo(
    () => buildDataStreamGeometry({ count: 900, height: 7.5, radius: 2.5 }),
    [],
  )

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSpread: { value: 0 },
      uHeight: { value: 7.5 },
      uColor: { value: new THREE.Color('#22d3ee') },
    }),
    [],
  )

  useEffect(() => () => geo.dispose(), [geo])

  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime
    // Streams only exist during the exploded phase.
    const p = progress.get()
    uniforms.uSpread.value = ramp(p, 0.28, 0.42) * (1 - ramp(p, 0.72, 0.9))
  })

  return (
    <points geometry={geo}>
      <shaderMaterial
        vertexShader={STREAM_VERTEX}
        fragmentShader={STREAM_FRAGMENT}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  )
}

/* -------------------------------------------------------------------------- */
/*  Inter-layer conduits + travelling pulses                                  */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader for the vertical data conduits (ribbon strips).
 *
 * The geometry stores XZ, `aAlong` (0 = gap bottom, 1 = gap top), `aGap`
 * (0 = lower conduit, 1 = upper), `aSide` (卤1, which edge of the ribbon) and
 * `aAngle` (the ribbon's bearing). Y is rebuilt here from the live layer centres
 * so the strips stretch as the stack explodes —no buffer uploads per frame.
 *
 * Each quad is expanded into a camera-facing billboard: the ribbon's right vector
 * is the cross product of its radial direction and the view vector. Without this
 * a flat quad would disappear edge-on as the model rotates.
 */
const CONDUIT_VERTEX = /* glsl */ `
  attribute float aAlong;
  attribute float aGap;
  attribute float aSide;
  attribute float aAngle;

  varying float vAlong;
  varying float vGap;
  varying float vSide;

  uniform float uGapBottom;
  uniform float uGapMiddle;
  uniform float uGapTop;
  uniform float uWidth;

  void main() {
    vAlong = aAlong;
    vGap = aGap;
    vSide = aSide;

    // This conduit's vertical span, from the live layer centres.
    float yStart = mix(uGapBottom, uGapMiddle, aGap);
    float yEnd = mix(uGapMiddle, uGapTop, aGap);
    float y = mix(yStart, yEnd, aAlong);

    // The quad's centre on the ring.
    vec3 center = vec3(position.x, y, position.z);

    // Billboard basis: radial outward direction x view direction = screen-right.
    vec3 radial = normalize(vec3(position.x, 0.0, position.z) + vec3(0.0001));
    vec3 toCamera = normalize(cameraPosition - center);
    vec3 right = normalize(cross(radial, toCamera));

    // Offset the vertex along that right vector by half the ribbon width.
    vec3 pos = center + right * (aSide * uWidth * 0.5);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

/**
 * Fragment shader for the conduits: a dim rail plus bright travelling pulses.
 *
 * ── The pulse ─────────────────────────────────────────────────────────────
 * A sine-based pulse produces a soft glow that eases in and out; a data packet
 * needs a SHARP leading edge with a short tail. That is built from
 * `fract(along - time * speed)`: subtracting time from the along-coordinate makes
 * the bright band travel toward increasing `along`, i.e. bottom to top, which is
 * the direction data flows through this stack.
 *
 * `pow(1 - travel, 22)` concentrates almost all the energy in the first few
 * percent of the cycle, giving a hot head. A wider term adds a comet-like tail.
 *
 * ── Why the visible brightness relies on additive blending ─────────────────
 * WebGL cannot draw a line thicker than 1 device pixel (`linewidth` is ignored on
 * virtually every platform). To make the pulses actually read on screen, the
 * shader pushes far past 1.0 and lets ADDITIVE blending accumulate —several
 * overlapping 1px lines plus HDR values is what turns them into visible light
 * rather than a hairline.
 */
const CONDUIT_FRAGMENT = /* glsl */ `
  varying float vAlong;
  varying float vGap;
  varying float vSide;

  uniform float uTime;
  uniform float uIntensity;
  uniform float uSpeed;
  uniform vec3 uColorRail;
  uniform vec3 uColorPulse;

  void main() {
    // Soft edge across the ribbon's width so it reads as a glow, not a stripe.
    float edge = 1.0 - abs(vSide);
    edge = smoothstep(0.0, 1.0, edge);

    // Pulse travelling from the bottom of each gap to the top. Subtracting time
    // from the along coordinate moves the bright band toward increasing along.
    float cycle = fract(vAlong - uTime * uSpeed + vGap * 0.37);

    // Sharp head with a comet tail behind it.
    float head = pow(1.0 - cycle, 22.0);
    float tail = pow(1.0 - cycle, 4.0) * 0.35;

    // Gentle breathing shimmer keeps the conduit readable between pulses.
    float shimmer = 0.5 + 0.5 * sin(vAlong * 16.0 - uTime * 2.4);
    float rail = 0.10 + shimmer * 0.07;

    float energy = head + tail;

    vec3 col = mix(uColorRail, uColorPulse, clamp(energy * 1.8, 0.0, 1.0));
    // HDR boost so additive blending + Bloom turn the head into real light.
    col *= 1.0 + head * 2.6;

    gl_FragColor = vec4(col, (rail + energy) * uIntensity * edge);
  }
`

function DataConduits({
  progress,
  layerRefs,
  selectedRef,
}: {
  progress: ProgressStore
  layerRefs: React.RefObject<Array<THREE.Object3D | null>>
  selectedRef: React.RefObject<string | null>
}) {
  const geo = useMemo(() => buildInterLayerConduits({ count: 14 }), [])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uSpeed: { value: 0.85 },
      uGapBottom: { value: -1 },
      uGapMiddle: { value: 0 },
      uGapTop: { value: 1 },
      uColorRail: { value: new THREE.Color('#0e7490') },
      uColorPulse: { value: new THREE.Color('#a5f3fc') },
      /** World-space width of each ribbon. */
      uWidth: { value: 0.055 },
    }),
    [],
  )

  useEffect(() => () => geo.dispose(), [geo])

  /**
   * Material created imperatively, NOT via `<shaderMaterial uniforms={...} />`.
   *
   * R3F's declarative material element re-applies props on every render, and one
   * of those props is `uniforms`. Assigning `uniforms` to a ShaderMaterial is
   * only honoured at construction; on a later render three.js keeps the OLD
   * uniform objects, so the ones this component mutates in `useFrame` become
   * detached from the ones the shader actually reads. Measured symptom: the
   * frame callback ran ~350 times per second while `uTime` stayed pinned at 0
   * and the pulse never warmed up.
   *
   * Owning the instance removes that whole class of bug.
   */
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: CONDUIT_VERTEX,
        fragmentShader: CONDUIT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        // Billboards can end up wound either way depending on where the camera
        // sits, so both faces must be drawn or ribbons vanish from one side.
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [uniforms],
  )

  useEffect(
    () => () => {
      material.dispose()
    },
    [material],
  )

  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime

    const p = progress.get()
    // Conduits only make sense once the layers have started to separate. They
    // ramp in with the explode weight and disappear during the final fade.
    const appear = ramp(p, 0.24, 0.38) * (1 - ramp(p, 0.72, 0.9))
    // Selected-layer focus boosts them so the connection reads as live traffic.
    const focus = selectedRef.current ? 0.45 : 0
    uniforms.uIntensity.value = appear * (0.85 + focus)

    // Dev-only probe so the verification script can confirm this callback runs.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __conduitTicks?: number }
      w.__conduitTicks = (w.__conduitTicks ?? 0) + 1
    }

    // Feed the live layer centres so the lines stretch with the separation.
    const refs = layerRefs.current
    if (refs) {
      const bottom = refs[0]?.position.y ?? -1
      const middle = refs[1]?.position.y ?? 0
      const top = refs[2]?.position.y ?? 1
      uniforms.uGapBottom.value = bottom
      uniforms.uGapMiddle.value = middle
      uniforms.uGapTop.value = top
    }
  })

  return (
    <mesh geometry={geo} material={material} frustumCulled={false} renderOrder={2} />
  )
}

/* -------------------------------------------------------------------------- */
/*  Rig —the only thing that reads progress in the frame loop                */
/* -------------------------------------------------------------------------- */

function ArchitectureRig({
  progress,
  inViewRef,
  selectedLayer,
  onSelectLayer,
}: {
  progress: ProgressStore
  inViewRef: InViewRef
  selectedLayer: string | null
  onSelectLayer: (id: string | null) => void
}) {
  const camera = useThree((s) => s.camera)
  const rootRef = useRef<THREE.Group>(null)
  const infraRef = useRef<THREE.Group>(null)
  const agentRef = useRef<THREE.Group>(null)
  const spatialRef = useRef<THREE.Group>(null)

  /** Layer groups in bottom-to-top order, for the conduit shader and picking. */
  const layerRefs = useRef<Array<THREE.Object3D | null>>([null, null, null])
  const layerIdRef = useRef<Array<string | null>>(['infra', 'agents', 'spatial'])

  /** Selected layer id, mirrored into a ref so the frame loop reads it cheaply. */
  const selectedRef = useRef<string | null>(selectedLayer)

  /**
   * Sync the prop into the ref via an effect, NOT during render.
   *
   * The rig lives inside the R3F canvas, which is a separate reconciler root.
   * Writing `ref.current = prop` during render works inside the React tree, but
   * a prop change on a component whose render is deferred by the Canvas can be
   * missed entirely —measured symptom: clicking a layer updated the DOM HUD
   * (React state changed) while the camera never moved (the ref the frame loop
   * reads was still null). An effect guarantees the write happens after commit.
   */
  useEffect(() => {
    selectedRef.current = selectedLayer
    if (import.meta.env.DEV) {
      ;(window as unknown as { __focusSel?: string | null }).__focusSel = selectedLayer
    }
  }, [selectedLayer])

  /**
   * Goal pose for the current focus, or null when the overview is showing.
   *
   * Recomputed on selection rather than per frame: `focusPoseFor` builds three
   * Vector3s and is only needed when the target layer changes.
   */
  const focusGoal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null)
  useEffect(() => {
    const layer = findLayer(selectedLayer)
    if (!layer) {
      focusGoal.current = null
      return
    }
    const pose = focusPoseFor(layer)
    focusGoal.current = {
      pos: new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]),
      target: new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]),
    }
  }, [selectedLayer])

  /** Smoothed look-at target, persistent across frames so it can be damped. */
  const smoothedTarget = useRef(new THREE.Vector3(0, 0, 0))

  // Pre-allocated scratch: never constructed inside useFrame.
  const scratch = useMemo(
    () => ({
      camPos: new THREE.Vector3(),
      camTarget: new THREE.Vector3(),
      path: createCameraPath(),
      /** Goal pose for a layer close-up. */
      focusPos: new THREE.Vector3(),
      focusTarget: new THREE.Vector3(),
      /** Smoothed focus blend, 0 = scroll path, 1 = focused on a layer. */
      focusBlend: { value: 0 },
    }),
    [],
  )

  useFrame((state, delta) => {
    // Skip all work while the section is offscreen. The canvas stays mounted so
    // returning to it costs nothing, but an invisible model should not burn
    // frames —this section alone has ~40 objects, 10 animated edges and 900
    // stream particles.
    // Sleep while off screen: the rig is unmounted, so this callback only
    // guards the frames between observation and unmount.
    if (!inViewRef.current) return

    const t = state.clock.elapsedTime
    const p = progress.get()
    // Clamp dt: a backgrounded tab can hand us a huge delta.
    const dt = Math.min(delta, 1 / 20)

    /* ── Phase weights ─────────────────────────────────────────────────── */
    // Explode ramps in over 0.3→.55 and holds, then retracts at 0.7→.92.
    const explode = ramp(p, PHASE.assembleEnd, 0.55) * (1 - ramp(p, 0.7, 0.92))
    // Fade the whole model out at the very end, handing over to the DOM cards.
    const fade = sceneFade(p)

    /* ── Self-rotation ─────────────────────────────────────────────────────
     * Stops entirely while a layer is focused: a rotating subject under a
     * close-up camera is disorienting and makes the HUD readable only by luck.
     */
    const root = rootRef.current
    const focused = selectedRef.current !== null
    if (root) {
      const spin = focused ? 0 : 0.075 + 0.05 * (1 - explode)
      root.rotation.y += spin * dt
      root.rotation.x = -0.12 + explode * 0.16
      root.rotation.z = Math.sin(t * 0.16) * 0.02
    }

    /* ── Layer separation ──────────────────────────────────────────────── */
    const refs = [infraRef.current, agentRef.current, spatialRef.current]
    for (let i = 0; i < 3; i++) {
      const g = refs[i]
      if (!g) continue
      layerRefs.current[i] = g
      const rest = LAYER_Y.rest[i]
      const lifted = LAYER_Y.explode[i]
      g.position.y = rest + lifted * explode
      // Slight outward drift adds depth: the top and bottom read as pulling
      // apart in 3D rather than sliding on one axis.
      const drift = i === 1 ? 0 : (i === 0 ? -1 : 1) * explode * 0.12
      g.position.z = drift
    }

    /* ── Camera: scroll path blended with an optional layer close-up ────── */
    scratch.path.samplePosition(p, scratch.camPos)
    scratch.path.sampleTarget(p, scratch.camTarget)

    // Advance the focus blend toward its goal. A frame-rate independent
    // exponential approach, so the zoom feels the same at 60 and 144 Hz.
    const blendGoal = focused ? 1 : 0
    const blendLambda = focused ? 3.0 : 3.6
    scratch.focusBlend.value = damp(scratch.focusBlend.value, blendGoal, blendLambda, dt)
    const blend = scratch.focusBlend.value

    if (blend > 0.001) {
      const goal = focusGoal.current
      if (goal) {
        // The layer's LIVE centre (it moves as the stack explodes), so the
        // camera aims at where the layer actually is, not where it started.
        const layer = findLayer(selectedRef.current)
        const idx = layer?.id === 'infra' ? 0 : layer?.id === 'agents' ? 1 : 2
        const liveY = refs[idx]?.position.y ?? 0
        const liveZ = refs[idx]?.position.z ?? 0

        scratch.focusPos.set(goal.pos.x, goal.pos.y, goal.pos.z)
        scratch.focusTarget.set(goal.target.x, liveY, goal.target.z + liveZ)
      }
      // Blend the two camera goals. Blending the TARGET as well as the position
      // is what keeps the transition from swinging through the model.
      scratch.camPos.lerp(scratch.focusPos, blend)
      scratch.camTarget.lerp(scratch.focusTarget, blend)
    }

    // Ease the camera itself so scroll jitter and the blend never snap.
    // Uses a spring-like damp rather than a fixed lerp factor: a constant
    // factor is frame-rate dependent, so the camera would settle at different
    // speeds on 60 Hz and 144 Hz displays.
    const camLambda = 6.5
    camera.position.x = damp(camera.position.x, scratch.camPos.x, camLambda, dt)
    camera.position.y = damp(camera.position.y, scratch.camPos.y, camLambda, dt)
    camera.position.z = damp(camera.position.z, scratch.camPos.z, camLambda, dt)

    // Look-at is damped the same way via a persistent smoothed target.
    smoothedTarget.current.x = damp(smoothedTarget.current.x, scratch.camTarget.x, camLambda, dt)
    smoothedTarget.current.y = damp(smoothedTarget.current.y, scratch.camTarget.y, camLambda, dt)
    smoothedTarget.current.z = damp(smoothedTarget.current.z, scratch.camTarget.z, camLambda, dt)
    camera.lookAt(smoothedTarget.current)

    /* ── Selected-layer highlight ────────────────────────────────────────── */
    for (let i = 0; i < 3; i++) {
      const g = refs[i]
      if (!g) continue
      const id = layerIdRef.current[i]
      const isSelected = id === selectedRef.current
      // A focused layer rises slightly toward the camera and brightens; the
      // others recede. Only the scale is animated here —opacity is handled by
      // the global fade traversal below.
      const targetScale = isSelected ? 1.12 : focused ? 0.94 : 1
      const s = damp(g.scale.x, targetScale, 5, dt)
      g.scale.setScalar(s)
    }

    /* ── Global fade: scale the root down and cut the material opacity ─── */
    if (root) {
      const s = 1 - (1 - fade) * 0.12
      root.scale.setScalar(s)
    }

    // Adjust every material's opacity from the fade weight. Traversing on each
    // frame is acceptable here: the subtree is ~40 objects and the alternative
    // is threading a uniform through five different materials.
    root?.traverse((obj) => {
      const mat = (obj as THREE.Mesh).material
      if (!mat) return
      const list = Array.isArray(mat) ? mat : [mat]
      for (const m of list) {
        const anyMat = m as THREE.Material & { opacity: number; transparent: boolean }
        if (typeof anyMat.opacity !== 'number') continue
        /*
         * Scale the material's OWN opacity instead of overwriting it.
         *
         * Writing `opacity = fade` looks equivalent only because most materials
         * are opaque (1). For the deliberately translucent ones — the prism cage
         * at 0.25, the shard shells at 0.35 — it silently pushed them to fully
         * opaque, which hid the plasma core behind a black mass at close camera
         * ranges. An earlier `if (transmission) continue` guard masked this by
         * accident: it skipped the old transmission prism, and vanished with it.
         */
        let base = baseOpacity.get(m)
        if (base === undefined) {
          base = anyMat.opacity
          baseOpacity.set(m, base)
        }
        anyMat.transparent = true
        anyMat.opacity = base * fade
      }
    })
  })

  /* ── Click picking ─────────────────────────────────────────────────────
   * Each layer group gets its own pointer handler. Using R3F's built-in events
   * rather than a manual raycaster means the hover/click only fires when the
   * pointer is genuinely over that layer's geometry, and the handler receives
   * the already-computed intersection.
   */
  const handleSelect = (id: string) => (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    // Activation chord, then toggle the focus.
    soundEngine.playCardActivate()
    // Clicking the focused layer again clears the focus.
    onSelectLayer(selectedRef.current === id ? null : id)
  }

  /**
   * A dial tick when the pointer first enters a layer's geometry.
   *
   * R3F fires `onPointerOver` on the group when the ray first hits any of its
   * children, so this is a genuine enter event rather than a per-frame repeat —   * no extra "already hovering" bookkeeping is needed. The engine's 40 ms
   * throttle covers the case of the pointer skating along a boundary where the
   * ray crosses in and out repeatedly.
   */
  const handleHover = (event: ThreeEvent<PointerEvent>) => {
    // Stop the event bubbling up to the other layers' handlers, which would
    // otherwise tick once per layer under the ray.
    event.stopPropagation()
    soundEngine.playHoverTick()
  }

  return (
    <group ref={rootRef}>
      <group onClick={handleSelect('infra')} onPointerOver={handleHover}>
        <InfrastructureLayer groupRef={infraRef} />
      </group>
      <group onClick={handleSelect('agents')} onPointerOver={handleHover}>
        <OrchestrationLayer groupRef={agentRef} progress={progress} />
      </group>
      <group onClick={handleSelect('spatial')} onPointerOver={handleHover}>
        <SpatialLayer groupRef={spatialRef} progress={progress} />
      </group>
      <DataStreams progress={progress} />
      <DataConduits
        progress={progress}
        layerRefs={layerRefs}
        selectedRef={selectedRef}
      />

      {/*
       * Virtual floor beneath the stack. It follows the bottom layer every frame,
       * so the caustic web stays under the model as the stack explodes rather
       * than being sliced through by it.
       */}
      <FloorCaustics bottomRef={infraRef} intensity={1.5} />
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/*  Canvas                                                                    */
/* -------------------------------------------------------------------------- */

export interface ScrollArchitecture3DProps {
  progress: ProgressStore
  /**
   * Live viewport visibility. Read imperatively so a scroll crossing does not
   * re-render the canvas subtree.
   */
  inViewRef: InViewRef
  /**
   * Whether the rig should be mounted at all.
   *
   * Distinct from `inViewRef`: the ref gates RENDERING, this gates MOUNTING.
   *
   * This gate began as a workaround: the prism used drei's
   * `MeshTransmissionMaterial`, which ran its own FBO render inside a `useFrame`
   * callback that escaped `internal.priority` (measured: the frame counter kept
   * advancing at roughly half the on-screen rate while off screen).
   *
   * The prism is now a flat-shaded cage drawn through an EffectComposer, so the
   * gate serves a different purpose: it takes the whole subtree out of the
   * reconciler, stops its `useFrame` callbacks, and keeps the composer itself
   * out of the tree so an off-screen chapter never blooms an empty scene.
   */
  awake: boolean
  /** Currently focused layer id, or null for the overview. */
  selectedLayer: string | null
  /** Called when a layer is clicked (or re-clicked to clear). */
  onSelectLayer: (id: string | null) => void
}

/**
 * Suppresses R3F's own draw for this root while the chapter is off screen.
 *
 * Only mounted when the composer is NOT: while the chapter is awake the
 * `EffectComposer` registers a positive render priority and owns the render
 * pass entirely, so writing the priority here as well would make R3F draw the
 * scene a second time. Keeping the two mechanisms mutually exclusive is what
 * makes this safe.
 *
 * Without it, an off-screen chapter still pays one `gl.render()` per frame for
 * an empty scene — no draw calls, but a full clear plus a redundant submission.
 */
function OffscreenRenderGate() {
  const get = useThree((state) => state.get)

  useFrame(() => {
    const state = get()
    if (state.internal.priority !== 1) state.internal.priority = 1
  })

  return null
}

export function ScrollArchitecture3D({
  progress,
  inViewRef,
  awake,
  selectedLayer,
  onSelectLayer,
}: ScrollArchitecture3DProps) {
  const tier = useAppStore((s) => s.performanceTier)
  const [webgl, setWebgl] = useState(false)

  useEffect(() => {
    setWebgl(supportsWebGL())
    preloadR3FAdvance()
  }, [])

  useEffect(() => () => setCanvasActive(false), [])

  if (!webgl) return null

  return (
    <Canvas
      frameloop="never"
      dpr={tier === 'high' ? [1, 2] : [1, 1.5]}
      camera={{ position: [0, 1.1, 11.5], fov: 42, near: 0.1, far: 80 }}
      gl={{
        // The default framebuffer's MSAA is bypassed the moment the composer
        // renders into its own target, so leaving this on would pay for
        // multisampling twice and use neither. AA is handled by
        // `multisampling` on the EffectComposer instead.
        antialias: false,
        alpha: true,
        powerPreference: 'high-performance',
        stencil: false,
      }}
      onCreated={({ gl, scene, camera }) => {
        gl.setClearColor(0x000000, 0)
        setCanvasActive(true)

        // Dev-only inspection handle, mirroring SceneCanvas. Exposes the
        // architecture scene separately so verification scripts can drive the
        // conduit shader and camera without guessing which canvas is which.
        if (import.meta.env.DEV) {
          ;(window as unknown as { __archScene?: unknown }).__archScene = {
            scene,
            camera,
            gl,
          }
        }
      }}
      className="!absolute !inset-0 !h-full !w-full"
      // The canvas must receive pointer events for layer picking, even though
      // the DOM overlay sits above it. The overlay's own text blocks are
      // `pointer-events-none` so clicks fall through to the canvas.
      style={{ pointerEvents: 'auto', touchAction: 'pan-y' }}
    >
      {/* Procedural environment for the transmission material. */}
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={3} position={[0, 4, -6]} scale={[10, 4, 1]} color="#0ea5e9" />
        <Lightformer form="rect" intensity={2.2} position={[-6, 1, 2]} scale={[4, 8, 1]} color="#22d3ee" />
        <Lightformer form="rect" intensity={1.6} position={[6, -1, 1]} scale={[4, 8, 1]} color="#a78bfa" />
        <Lightformer form="circle" intensity={2} position={[0, -5, 3]} scale={6} color="#0f172a" />
      </Environment>

      <ambientLight intensity={0.28} />
      <directionalLight position={[4, 7, 5]} intensity={1.5} color="#bae6fd" />
      <directionalLight position={[-5, -3, -4]} intensity={0.7} color="#a78bfa" />

      {/*
       * Sleep strategy.
       *
       * The rig AND the composer are mounted only while the chapter is on
       * screen. With a composer present R3F's own draw is already suppressed —
       * the composer registers a positive render priority and takes over — so
       * the old `RenderGate` had to go: it would have written priority back to
       * 0 while awake and produced a double render (R3F's plus the composer's).
       *
       * Unmounting the rig as well is still worth it: it takes the whole subtree
       * out of the reconciler rather than relying on every `useFrame` callback to
       * early-return. Waking happens 60% of a viewport early, so the rebuild is
       * never visible.
       */}
      {/*
       * Mutually exclusive with the composer below: exactly one of them is in the
       * tree at any moment, so R3F's own draw and the post-processing pass can
       * never both run.
       */}
      {!awake && <OffscreenRenderGate />}

      {awake && (
        <>
          <ArchitectureRig
            progress={progress}
            inViewRef={inViewRef}
            selectedLayer={selectedLayer}
            onSelectLayer={onSelectLayer}
          />

          {/*
           * Stage lighting for the exploded stack. Mounted inside the `awake`
           * gate, so an off-screen chapter pays nothing for it — and no
           * `fadeWithScroll`, because the gate already owns its visibility.
           */}
          <VolumetricStageLights tier={tier} height={9} scale={0.85} intensity={0.85} />

          {/*
           * Bloom is what makes the cyan read as neon instead of as coloured
           * geometry: the edge lattice and the hot plasma cells sit above the
           * 0.15 threshold, so they bleed into everything around them.
           *
           * The parameters map one-to-one onto UnrealBloomPass (intensity is
           * strength, radius is spread, luminanceThreshold is the cutoff);
           * `postprocessing` implements the same unified bloom internally, so
           * this is the pass the brief asks for, wired the way R3F expects.
           *
           * multisampling is tier-gated: this canvas draws thin wireframe lines
           * that alias badly without MSAA, but the composer's MSAA buffer is the
           * most expensive thing in the pipeline on an integrated GPU.
           */}
          <EffectComposer
            multisampling={tier === 'high' ? 4 : 0}
            enableNormalPass={false}
          >
            <Bloom luminanceThreshold={0.15} intensity={1.6} radius={0.5} mipmapBlur />
          </EffectComposer>
        </>
      )}

      {/* Fog pulls the far edges of the grid into the void. */}
      <fog attach="fog" args={['#04060b', 9, 26]} />
    </Canvas>
  )
}

export default ScrollArchitecture3D
