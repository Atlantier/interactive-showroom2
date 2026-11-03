import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Billboard, Environment, Lightformer } from '@react-three/drei'
import { VolumetricStageLights } from '@/components/canvas/VolumetricStageLights'
import { HexGround } from '@/components/canvas/architecture/HexGround'
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
} from '@/components/canvas/architecture/geometry'
import { LAYER_Y, PHASE, createCameraPath, ramp } from '@/components/canvas/architecture/cameraPath'
import { findLayer, focusPoseFor } from '@/components/canvas/architecture/layers'
import { soundEngine } from '@/utils/soundEngine'
import type { InViewRef } from '@/hooks/useInViewAnimation'
import type { ProgressStore } from '@/hooks/useSectionProgress'
import {
  EDGE_VERTEX,
  EDGE_FRAGMENT,
  STREAM_VERTEX,
  STREAM_FRAGMENT,
  PLASMA_VERTEX,
  PLASMA_FRAGMENT,
  DISPERSION_VERTEX,
  DISPERSION_FRAGMENT,
  CONDUIT_VERTEX,
  CONDUIT_FRAGMENT,
  RIM_VERTEX,
  RIM_FRAGMENT,
  CONTACT_VERTEX,
  CORE_GLOW_FRAGMENT,
} from './architecture/shaders'

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
/**
 * Vertical laser stream shader.
 *
 * Particles are pre-distributed on a cylindrical shell; this shader scrolls them
 * along Y by their per-particle phase, so the curtain flows without any CPU work
 * per frame. `uSpread` is driven by the explode phase: zero while the stack is
 * closed, one when fully separated.
 */
/* -------------------------------------------------------------------------- */
/*  Layer 1 —Infrastructure                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Layer 1 — the substrate.
 *
 * This used to be a 22x22 lattice of extruded kernel columns with a metal
 * material. From the chapter's camera that read as an opaque black board: it hid
 * the floor web entirely, its columns were co-planar with a separate contact
 * plane (hence the horizontal stripes), and it produced none of the grounding the
 * composition needed.
 *
 * It is now the floor itself: a disc with a hex lattice, a contact pool under the
 * crystal and a radial fade to nothing at the rim. `LIFT` places it in world space
 * such that the crystal's bottom vertex hovers just above it and the lowest agent
 * shard rests on it.
 */
const INFRA_GROUP_Y = -0.95
const GROUND_LOCAL_Y = -0.62 - INFRA_GROUP_Y

function InfrastructureLayer({ groupRef }: { groupRef: React.RefObject<THREE.Group | null> }) {
  return (
    <group ref={groupRef}>
      <HexGround y={GROUND_LOCAL_Y} radius={6.4} />
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
        material.emissiveIntensity = 1.4 + (0.5 + 0.5 * Math.sin(t * 2.1 + offset)) * 1.6
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
            <meshStandardMaterial
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
 * 1.5x the previous 1.5: the crystal is the subject of the chapter rather than a
 * prop above the grid, and at the old size the facets were too small to read.
 */
const CORE_SHELL_RADIUS = 2.25

/**
 * Ratio of a regular icosahedron's inradius to its circumradius.
 *
 * r / R = (sqrt(3)/12)(3+sqrt(5)) / ((1/4)sqrt(10+2sqrt(5))) = 0.794654...
 *
 * Named rather than inlined because the core radius is derived from it: the brief
 * caps the inner sphere at 65% of the INSPHERE, and a hard-coded result would
 * drift the moment the shell is resized again.
 */
const ICOSA_INRADIUS_RATIO = 0.7946544723

/**
 * Inner glow sphere: 55% of the insphere, comfortably under the 65% ceiling.
 *
 * The ceiling is what guarantees no clipping -- the insphere touches each facet
 * at exactly one point, so anything inside 65% of it cannot reach a plane even
 * when the shell is spinning.
 */
const CORE_INNER_RADIUS = CORE_SHELL_RADIUS * ICOSA_INRADIUS_RATIO * 0.55

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
const CORE_HOVER_LIFT = 1.05

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
/**
 * Ashima Arts / Stefan Gustavson 3D simplex noise (MIT).
 *
 * Included rather than sampled from a texture: a noise texture would need a
 * loader, a UV unwrap and ~1 MB of assets, and this project ships no assets at
 * all. Roughly 60 lines of maths is the cheaper trade.
 */

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
function SpatialLayer({
  groupRef,
  progress,
}: {
  groupRef: React.RefObject<THREE.Group | null>
  progress: ProgressStore
}) {
  const shellGeo = useMemo(() => new THREE.IcosahedronGeometry(CORE_SHELL_RADIUS, 0), [])

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
      // Desaturated theme cyan. The old #5ff2ff was a saturated neon that read
      // as a glowing moon rather than as light inside glass.
      // Body and limb, in that order: `uDeep` is what the centre samples, `uHot`
      // what the Fresnel rim reaches. The old dark #123138 limb is what produced
      // the black ring around the sphere.
      /*
       * Low-saturation by construction: the most saturated stop is already mixed
       * toward white, so nothing here can render as pure cyan. `uIntensity` came
       * down from 2.2 -- at that level the sphere clipped to a flat, glaring disc
       * with no visible falloff.
       */
      /*
       * `uDeep` is the milky interior and `uHot` the limb, chosen so the most
       * saturated colour anywhere on the sphere is a desaturated cyan: the limb is
       * pure white, which is what the reference shows at the silhouette.
       */
      /*
       * `uDeep` is the cyan BETWEEN the cloud folds and `uHot` the milk inside
       * them plus the limb -- so the sphere has real internal contrast instead of
       * being one flat pale tone.
       */
      uRadius: { value: CORE_INNER_RADIUS },
      uDeep: { value: new THREE.Color('#5fbccd') },
      uHot: { value: new THREE.Color('#f2ffff') },
      uIntensity: { value: 1.02 },
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
      // 18 s per revolution, inside the 15-20 s the brief asks for.
      shell.rotation.y += delta * ((Math.PI * 2) / 18)
      shell.rotation.z += delta * 0.02

      /*
       * Mouse parallax, capped at +/-5 degrees. Written every frame rather than
       * accumulated, so centring the pointer returns the crystal to level. R3F
       * already maintains `state.pointer` in normalised device coordinates, so
       * this costs no extra listener, and it drives the rig group rather than
       * the shell so it never fights the spin.
       */
      const tilt = THREE.MathUtils.degToRad(5)
      const rig = groupRef.current
      if (rig) {
        rig.rotation.x = -(state.pointer?.y ?? 0) * tilt
        rig.rotation.z = (state.pointer?.x ?? 0) * tilt
      }
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
      // 6 s breathing cycle, +/-10%: no flicker, no pulse.
      plasmaUniforms.uIntensity.value = 1.02 * (1 + 0.1 * Math.sin((t * Math.PI * 2) / 6))

      /*
       * The dispersion shell is a ShaderMaterial, so the rig's `material.opacity`
       * fade traversal never reaches it — it has to apply the chapter's exit
       * weight itself, or it stays lit after everything else has faded.
       */
      dispersionUniforms.uIntensity.value = 1.05 * sceneFade(progress.get())

      if (lightRef.current) lightRef.current.intensity = 2.6 + breathe * 1.8
    }
  })

  /*
   * Stage the crystal across two frames.
   *
   * Measured on a software rasteriser, each distinct shader program costs roughly
   * 200-250ms to compile and link, and the driver blocks the main thread while it
   * happens. The glass and the core are therefore drawn one frame apart so the
   * chapter's first visible frame never carries both. On real hardware each of
   * these is a few milliseconds, which is the point: the split costs nothing and
   * bounds the worst frame either way.
   */
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setStage(1))
    return () => cancelAnimationFrame(raf)
  }, [])

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
            {/*
             * Real transmission glass.
             *
             * `color` is near-white on purpose: in three.js it multiplies the
             * TRANSMITTED light as well as the diffuse, so the previous dark
             * #031525 turned the crystal into a black box instead of a window.
             * The cyan cast comes from `attenuationColor`, which tints with
             * thickness rather than killing the transmission.
             */}
            <meshPhysicalMaterial
              userData={{ noExitFade: true }}
              color="#e6f7fb"
              transmission={0.98}
              thickness={1.2}
              roughness={0.05}
              ior={1.5}
              clearcoat={1}
              clearcoatRoughness={0.05}
              metalness={0}
              attenuationColor="#e0f7fa"
              attenuationDistance={2.0}
              /*
               * FrontSide, not DoubleSide.
               *
               * Any material with transmission > 0 makes three run a transmission
               * pass every frame into a full-resolution, 4x-MSAA, half-float target.
               * DoubleSide also draws the cage's back faces into that pass, so it
               * cost a second full copy of the geometry for surfaces the camera
               * cannot see through an opaque-ish shell anyway.
               */
              side={THREE.FrontSide}
              depthWrite={false}
              envMapIntensity={1.25}
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
              userData={{ noExitFade: true }}
              color="#ffffff"
              transparent
              opacity={0.7}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </lineSegments>

          {/*
           * Fresnel rim. This is what makes the crystal read as lit glass rather
           * than a grey solid: a hair-larger additive shell whose brightness is
           * pow(1 - N dot V, 3), so it shows only at grazing angles and leaves
           * the flat facets alone. No uniforms -- the tint is constant by design.
           */}
          <mesh geometry={shellGeo} scale={1.012} renderOrder={6}>
            <shaderMaterial
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              vertexShader={RIM_VERTEX}
              fragmentShader={RIM_FRAGMENT}
            />
          </mesh>
        </group>

        {/*
         * ── Plasma core ────────────────────────────────────────────────────
         * Opaque, so it lands in the opaque pass and the translucent cage blends
         * over it. Bloom then lifts the hot noise cells and the limb.
         */}
        {stage >= 1 && (
          <>
            {/*
             * Volumetric halo, as a camera-facing quad rather than a shell.
             *
             * A shell was the wrong primitive: its Fresnel peaks on ITS OWN
             * silhouette, so however soft it was shaded it drew a ring at its
             * radius and read as a second sphere sitting around the core. A quad
             * has no silhouette at all -- just a radial falloff in screen space --
             * so the glow can bleed past the core's edge and simply stop existing
             * before the quad's edge.
             *
             * Sized to stay inside the icosahedron's insphere so the glow never
             * pokes out through a facet.
             */}
            <Billboard>
              <mesh renderOrder={1}>
                <planeGeometry args={[CORE_INNER_RADIUS * 3.4, CORE_INNER_RADIUS * 3.4]} />
                <shaderMaterial
                  transparent
                  depthWrite={false}
                  vertexShader={CONTACT_VERTEX}
                  fragmentShader={CORE_GLOW_FRAGMENT}
                />
              </mesh>
            </Billboard>

            <mesh ref={coreRef} material={plasmaMaterial}>
              <sphereGeometry args={[CORE_INNER_RADIUS, 64, 48]} />
            </mesh>
          </>
        )}

        {/*
         * ── Core light ─────────────────────────────────────────────────────
         * An emissive surface illuminates nothing by itself. Without a real light
         * the surrounding cubes and the wireframe floor stay unlit and the core
         * looks pasted on rather than sitting in the scene.
         */}
        <pointLight ref={lightRef} color="#40e0d0" intensity={3} distance={10} decay={2} />
      </group>
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/*  Data streams                                                              */
/* -------------------------------------------------------------------------- */

function DataStreams({ progress }: { progress: ProgressStore }) {
  const geo = useMemo(() => buildDataStreamGeometry({ count: 900, height: 7.5, radius: 2.5 }), [])

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

  return <mesh geometry={geo} material={material} frustumCulled={false} renderOrder={2} />
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

    /*
     * Adjust every material's opacity from the fade weight. Traversing on each
     * frame is acceptable here: the subtree is ~40 objects and the alternative
     * is threading a uniform through five different materials.
     *
     * What was NOT acceptable was the shape of the walk: `Array.isArray(mat) ?
     * mat : [mat]` allocated a one-element array per mesh per frame -- about 37
     * arrays, 2 200 a second at 60 Hz -- to iterate a list that is almost always a
     * single material. The two cases are branched instead, with the per-material
     * work hoisted into one closure created once per frame rather than per object.
     */
    const applyExitFade = (m: THREE.Material): void => {
      const anyMat = m as THREE.Material & { opacity: number; transparent: boolean }
      if (typeof anyMat.opacity !== 'number') return
      /*
       * Opt-out for the spatial layer's hero surfaces. They must stay at their
       * design opacity for the whole chapter: the plasma core is a custom
       * ShaderMaterial that computes its own alpha, so it never participates in
       * this fade. Dimming only the shell and its edge lattice produced the
       * reported 'the sphere recovered but the shell is still dark' look -- a
       * bright core sitting inside an almost invisible cage.
       */
      if (m.userData?.noExitFade) return
      /*
       * Scale the material's OWN opacity instead of overwriting it.
       *
       * Writing `opacity = fade` looks equivalent only because most materials are
       * opaque (1). For the deliberately translucent ones — the prism cage at
       * 0.25, the shard shells at 0.35 — it silently pushed them to fully opaque,
       * which hid the plasma core behind a black mass at close camera ranges. An
       * earlier `if (transmission) continue` guard masked this by accident: it
       * skipped the old transmission prism, and vanished with it.
       */
      let base = baseOpacity.get(m)
      if (base === undefined) {
        base = anyMat.opacity
        baseOpacity.set(m, base)
      }
      // Only write when it changes; three re-reads this flag when sorting.
      if (!anyMat.transparent) anyMat.transparent = true
      anyMat.opacity = base * fade
    }

    root?.traverse((obj) => {
      const mat = (obj as THREE.Mesh).material
      if (!mat) return
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) applyExitFade(mat[i] as THREE.Material)
      } else {
        applyExitFade(mat)
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

  /*
   * Staged mount.
   *
   * A material compiles its shader program the first time it is drawn, and the
   * driver blocks the main thread on the link-status query while that happens.
   * A CPU profile of the first entry into this chapter put ~1.2s of blocked main
   * thread in a SINGLE task, because the whole rig committed at once.
   *
   * Mounting the layers one per frame turns that task into four much smaller
   * ones. The total cost is unchanged -- what changes is that no single frame
   * stalls long enough to read as a freeze.
   */
  const [stage, setStage] = useState(0)
  useEffect(() => {
    let raf = 0
    let next = 1
    const step = (): void => {
      setStage(next)
      next += 1
      if (next <= 4) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <group ref={rootRef}>
      {/* Stage 0: the base of the stack plus the floor it sits on. */}
      <group onClick={handleSelect('infra')} onPointerOver={handleHover}>
        <InfrastructureLayer groupRef={infraRef} />
      </group>

      {/*
       * Virtual floor beneath the stack. It follows the bottom layer every frame,
       * so the caustic web stays under the model as the stack explodes rather
       * than being sliced through by it.
       */}
      {stage >= 1 && (
        <group onClick={handleSelect('agents')} onPointerOver={handleHover}>
          <OrchestrationLayer groupRef={agentRef} progress={progress} />
        </group>
      )}

      {/* Stage 2: the crystal. The heaviest shader set, so it gets its own frame. */}
      {stage >= 2 && (
        <group onClick={handleSelect('spatial')} onPointerOver={handleHover}>
          <SpatialLayer groupRef={spatialRef} progress={progress} />
        </group>
      )}

      {stage >= 3 && <DataStreams progress={progress} />}

      {/* Conduits last: they read the layer centres, so every layer must exist. */}
      {stage >= 4 && (
        <DataConduits progress={progress} layerRefs={layerRefs} selectedRef={selectedRef} />
      )}
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
 * RenderGate — stop drawing while the chapter is off screen.
 *
 * ── Why a render gate and not an unmount ────────────────────────────────────
 * The rig is deliberately mounted early so its shaders compile under the boot
 * veil (measured ~2.7s cold). Unmounting it when the chapter scrolls away would
 * throw away the compiled programs with it, and the next entry would pay that cost
 * again -- the very hitch the prewarm exists to remove.
 *
 * So the rig stays mounted and only the DRAW is gated. `useFrame` with priority
 * >= 1 tells R3F to stop rendering on its own; from then on this callback owns the
 * frame and simply does nothing while the section is off screen. Measured effect:
 * the chapter's ~95 draw calls per frame (main scene + transmission pass +
 * resolve/mip chain + reflection pass + 4 blurs) drop to zero when scrolled away.
 */
/**
 * BootCompile — link every architecture program while the boot veil still covers the page.
 *
 * ── Why this replaces the old "quiet frames" heuristic ─────────────────────
 * The previous signal declared the prewarm finished after three frames shorter than 40 ms. Measured
 * behaviour showed that was wrong in the worst way: the architecture scene was already mounted
 * during boot (25 meshes) but its canvas held **one** program, because the heuristic fired before
 * anything had been drawn -- `RenderGate` then closed and the rig sat there unlinked. The 19 links
 * happened on the first scroll into the chapter instead, which is exactly the 1.1 s freeze the
 * prewarm exists to remove.
 *
 * Frame pacing answers "is the machine busy", not "are the programs linked". This asks the second
 * question directly: walk the scene with `gl.compile` and watch `gl.info.programs.length` until two
 * consecutive readings agree. A 3 s cap keeps the veil from becoming a trap on a pathological
 * driver, and the veil's own HOLD_MIN/HOLD_MAX still bound the visible wait.
 */
function BootCompile({ onSettled }: { onSettled: () => void }) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)

  const settled = useRef(false)
  const elapsed = useRef(0)
  const lastCount = useRef(-1)
  const stable = useRef(0)

  useFrame((_, delta) => {
    if (settled.current) return
    elapsed.current += delta

    // Give the staged mount (one layer per frame) time to commit before the first walk.
    if (elapsed.current < 0.25) return

    try {
      gl.compile(scene, camera)
    } catch {
      // A compile failure must not trap the veil; the scene will compile on first draw as before.
      settled.current = true
      onSettled()
      return
    }

    const programs = gl.info.programs?.length ?? 0
    if (programs === lastCount.current) stable.current += 1
    else {
      stable.current = 0
      lastCount.current = programs
    }

    if (stable.current >= 2 || elapsed.current > 3) {
      settled.current = true
      onSettled()
    }
  }, 2)

  return null
}

function RenderGate({ inView }: { inView: InViewRef }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const prewarmDone = useAppStore((state) => state.prewarmDone)

  useFrame(() => {
    /*
     * Draw while the chapter is on screen -- and while it is still warming up.
     *
     * The prewarm exists to compile this rig's shaders under the boot veil. Gating on
     * `inView` alone defeated it: nothing drew during the warm-up, so nothing compiled,
     * and the whole compile storm moved to the moment the visitor first scrolled into
     * the chapter. The new scroll assertion caught it as a 1190 ms frame -- the gate
     * has to stay open until `prewarmDone` reports the compile has drained.
     */
    if (!inView.current && prewarmDone) return
    gl.render(scene, camera)
  }, 1)

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
  /*
   * The stage lights compile their own programs (cones + dust). Delaying them by
   * a frame keeps their compile off the same task as the rig's first layer,
   * which is the same reasoning as the staged mount inside ArchitectureRig.
   */
  const [lightsReady, setLightsReady] = useState(false)
  /*
   * Prewarm.
   *
   * A material's shader program is compiled and linked the first time it is
   * drawn, and the driver blocks the main thread while that happens: measured at
   * ~2.7s cold and ~0.12s once the driver's shader cache is warm. Left alone it
   * lands the moment the chapter becomes visible, which is the freeze on entry.
   *
   * Mounting the rig early moves that cost off the scroll path and under the boot
   * veil, which is on screen from the first frame and only lifts once this
   * component reports that the compiling is finished.
   */
  const [prewarmed, setPrewarmed] = useState(false)

  useEffect(() => {
    setWebgl(supportsWebGL())
    preloadR3FAdvance()
  }, [])

  /*
   * Canvas registration is PAIRED here, not split across lifecycles.
   *
   * `+1` used to come from the Canvas' `onCreated` (a layout effect inside R3F) while
   * `-1` came from this component's passive cleanup. Those two are not guaranteed to
   * run in matching counts -- a canvas that unmounts before `onCreated` fires, or a
   * StrictMode double-invoke, decrements without a matching increment. Once the
   * counter reaches zero the master clock stops calling `advance()`, so every canvas
   * on the page freezes with no error and no way back.
   */
  useEffect(() => {
    if (!webgl) return
    setCanvasActive(true)
    return () => setCanvasActive(false)
  }, [webgl])

  const live = awake || prewarmed

  const setPrewarmDone = useAppStore((state) => state.setPrewarmDone)

  useEffect(() => {
    if (prewarmed) return
    /*
     * Start as soon as the veil is on screen.
     *
     * This used to wait 1.6s "so it does not compete with the hero's entrance".
     * That reasoning no longer applies: BootSequence puts a full-screen veil up
     * on the first frame, so every millisecond of compilation that lands under it
     * is a millisecond the entry hitch loses.
     *
     * Two frames rather than one: the first commit is what paints the veil, and
     * blocking before it lands would freeze an empty screen instead of a boot
     * sequence.
     */
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPrewarmed(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [prewarmed])

  /*
   * The boot veil's "compile finished" signal lives INSIDE the canvas now.
   *
   * It used to be a frame-pacing heuristic here (three frames shorter than 40 ms). Measurement showed
   * it fired before anything had been drawn: the scene was mounted but its canvas held one program,
   * so RenderGate closed and the 19 links moved back onto the first scroll into the chapter. The
   * replacement, <BootCompile>, asks the renderer how many programs it holds instead of guessing
   * from frame durations.
   */

  useEffect(() => {
    if (!live) {
      setLightsReady(false)
      return
    }
    const raf = requestAnimationFrame(() => setLightsReady(true))
    return () => cancelAnimationFrame(raf)
  }, [live])

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
        /*
         * Shader diagnostics off in production.
         *
         * three.js validates every freshly linked program by calling
         * getProgramInfoLog/getShaderInfoLog, which forces a synchronous driver
         * round-trip. A CPU profile of the gallery entry measured getProgramInfoLog
         * alone at ~1.9s of blocked main thread once a screenful of new materials
         * compiled together -- that is the hitch on entering a section, not layout
         * and not garbage collection.
         *
         * `checkShaderErrors` skips the whole diagnostic path. It stays on in dev,
         * where a broken shader must still fail loudly with its log.
         */
        gl.debug.checkShaderErrors = import.meta.env.DEV

        /*
         * Transmission buffer at 35% of the drawing buffer.
         *
         * three sizes the transmission render target at the full drawing buffer by
         * default: at 1440x900 @ dpr 2 that is 2880x1800 half-float with 4x MSAA,
         * i.e. ~166 MB of VRAM plus a resolve and a mip chain every frame. The
         * glass is a soft, blurry object by construction, so a third of the
         * resolution is visually indistinguishable and costs 1/8 the memory and
         * bandwidth.
         */
        gl.transmissionResolutionScale = 0.35

        gl.setClearColor(0x000000, 0)
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
      {/*
        Procedural environment for the metal surfaces.
        `frames={8}` instead of the usual one-shot bake. The cage (metalness 0.9,
        roughness 0.1) and the shard shells (metalness 0.9) are near-mirrors: with
        no environment they render BLACK — which is exactly the reported "the cube
        is black" bug, and why it only showed at the scroll positions where those
        surfaces dominate the frame while the emissive cores hid it mid-chapter.
        A single capture frame is fragile here: the rig sits behind an `awake` gate
        and mounts later, and this canvas renders through an EffectComposer, so the
        one-shot bake could land before everything it needs was in the scene. A few
        extra frames cost milliseconds at mount and make the bake reliable.
      */}
      <RenderGate inView={inViewRef} />
      <BootCompile onSettled={setPrewarmDone} />

      <Environment resolution={256} frames={1}>
        <Lightformer
          form="rect"
          intensity={3}
          position={[0, 4, -6]}
          scale={[10, 4, 1]}
          color="#0ea5e9"
        />
        <Lightformer
          form="rect"
          intensity={2.2}
          position={[-6, 1, 2]}
          scale={[4, 8, 1]}
          color="#22d3ee"
        />
        <Lightformer
          form="rect"
          intensity={1.6}
          position={[6, -1, 1]}
          scale={[4, 8, 1]}
          color="#a78bfa"
        />
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
      {live && (
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
          {lightsReady && (
            <VolumetricStageLights tier={tier} height={9} scale={0.85} intensity={0.85} />
          )}
        </>
      )}

      {/* Fog pulls the far edges of the grid into the void. */}
      <fog attach="fog" args={['#04060b', 9, 26]} />
    </Canvas>
  )
}

export default ScrollArchitecture3D

/* -------------------------------------------------------------------------- */
/*  Crystal rim and contact shadow shaders                                     */
/* -------------------------------------------------------------------------- */

/**
 * Core glow.
 *
 * A screen-space radial falloff, not a Fresnel on a shell. The previous version
 * was a slightly larger sphere whose brightness peaked at ITS silhouette, which
 * guaranteed a visible ring at a fixed radius from the core -- the "second sphere"
 * look. A radial gradient has no ring anywhere: it is brightest at the centre and
 * monotonically decreases, so the only thing it can do at the core's edge is keep
 * fading.
 *
 * Two terms, because the reference shows two: a wide soft bloom that carries the
 * glow out past the limb, plus a tighter lift right around it so the transition
 * from sphere to glow is not a step.
 */
