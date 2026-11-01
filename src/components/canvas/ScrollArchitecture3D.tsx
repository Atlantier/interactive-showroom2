import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Environment, Lightformer, MeshTransmissionMaterial } from '@react-three/drei'
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
  buildPrismGeometry,
} from '@/components/canvas/architecture/geometry'
import {
  LAYER_Y,
  PHASE,
  createCameraPath,
  ramp,
} from '@/components/canvas/architecture/cameraPath'
import { findLayer, focusPoseFor } from '@/components/canvas/architecture/layers'
import { RenderGate } from '@/components/canvas/RenderGate'
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
 *  3. SPATIAL WEB / UI —a faceted prism using `MeshTransmissionMaterial` so the
 *     layers beneath genuinely refract through it.
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
    float pulse = pow(1.0 - travel, 14.0);

    vec3 col = mix(uColorEdge, uColorCore, pulse);
    float alpha = (0.16 + pulse * 0.95) * uIntensity;

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

function OrchestrationLayer({
  groupRef,
  progress,
}: {
  groupRef: React.RefObject<THREE.Group | null>
  progress: ProgressStore
}) {
  const edgeGeo = useMemo(() => buildEdgeGeometry(), [])
  const nodeGeo = useMemo(() => new THREE.OctahedronGeometry(0.34, 0), [])

  const edgeUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uColorCore: { value: new THREE.Color('#a5f3fc') },
      uColorEdge: { value: new THREE.Color('#22d3ee') },
    }),
    [],
  )

  const nodeRefs = useRef<Array<THREE.Mesh | null>>([])

  useEffect(
    () => () => {
      edgeGeo.dispose()
      nodeGeo.dispose()
    },
    [edgeGeo, nodeGeo],
  )

  useFrame((state) => {
    const t = state.clock.elapsedTime
    edgeUniforms.uTime.value = t

    // Nodes breathe in scale, each on its own offset so the group does not
    // pulse in unison (which reads as a loading animation, not intelligence).
    const p = progress.get()
    const focus = ramp(p, 0.45, 0.72) // brighten as the camera arrives
    for (let i = 0; i < nodeRefs.current.length; i++) {
      const mesh = nodeRefs.current[i]
      if (!mesh) continue
      const spec = AGENT_NODES[i]
      if (!spec) continue
      const breathe = 1 + Math.sin(t * 1.6 + i * 1.7) * 0.09
      mesh.scale.setScalar(spec.scale * (breathe + focus * 0.18))
      mesh.rotation.y = t * (0.5 + i * 0.06)
      mesh.rotation.x = Math.sin(t * 0.7 + i) * 0.4
    }

    edgeUniforms.uIntensity.value = 0.85 + focus * 0.6
  })

  return (
    <group ref={groupRef}>
      {/* Connections, drawn beneath the nodes. */}
      <lineSegments geometry={edgeGeo}>
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

      {/* Octahedron nodes. */}
      {AGENT_NODES.map((spec, i) => (
        <mesh
          key={i}
          ref={(el) => {
            nodeRefs.current[i] = el
          }}
          geometry={nodeGeo}
          position={spec.position}
        >
          {/*
           * Emissive intensity is deliberately modest. At 2.4 with
           * `toneMapped: false` the facets saturated to a flat colour, so the
           * octahedra read as solid squares instead of faceted solids —the
           * shading that gives them their form was clipped away. A lower
           * emissive plus real metalness/roughness keeps the facet gradients.
           * Bloom still provides the glow, which is where the brightness belongs.
           */}
          <meshStandardMaterial
            color="#0e7490"
            emissive="#22d3ee"
            emissiveIntensity={i === 0 ? 0.85 : 0.55}
            metalness={0.75}
            roughness={0.18}
            flatShading
          />
        </mesh>
      ))}

      {/* Hub glow: a soft additive sprite behind node 0. */}
      <pointLight position={[0, 0, 0]} intensity={9} distance={7} color="#22d3ee" />
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/*  Layer 3 —Spatial web prism                                               */
/* -------------------------------------------------------------------------- */

function SpatialLayer({ groupRef }: { groupRef: React.RefObject<THREE.Group | null> }) {
  const prism = useMemo(() => buildPrismGeometry(1.5), [])

  useEffect(() => () => prism.dispose(), [prism])

  return (
    <group ref={groupRef}>
      {/*
       * MeshTransmissionMaterial needs an environment to refract. A procedural
       * Lightformer environment is used instead of an HDRI preset: it keeps the
       * bundle free of a multi-hundred-kB texture and matches the palette.
       */}
      <mesh geometry={prism}>
        <MeshTransmissionMaterial
          samples={6}
          resolution={256}
          thickness={1.1}
          roughness={0.12}
          transmission={1}
          ior={1.42}
          chromaticAberration={0.06}
          anisotropy={0.2}
          distortion={0.25}
          distortionScale={0.35}
          temporalDistortion={0.06}
          color="#bae6fd"
          attenuationColor="#22d3ee"
          attenuationDistance={2.2}
          background={undefined}
        />
      </mesh>

      {/* Inner core: a small emissive octahedron visible through the prism. */}
      <mesh>
        <octahedronGeometry args={[0.42, 0]} />
        <meshStandardMaterial
          color="#a5f3fc"
          emissive="#22d3ee"
          emissiveIntensity={3}
          toneMapped={false}
        />
      </mesh>
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
    // Sleep while off screen: the RenderGate skips the GPU work, this skips
    // the CPU work. Both read the same flag.
    if (!inViewRef.current) return

    const t = state.clock.elapsedTime
    const p = progress.get()
    // Clamp dt: a backgrounded tab can hand us a huge delta.
    const dt = Math.min(delta, 1 / 20)

    /* ── Phase weights ─────────────────────────────────────────────────── */
    // Explode ramps in over 0.3→.55 and holds, then retracts at 0.7→.92.
    const explode = ramp(p, PHASE.assembleEnd, 0.55) * (1 - ramp(p, 0.7, 0.92))
    // Fade the whole model out at the very end, handing over to the DOM cards.
    const fade = 1 - ramp(p, PHASE.fadeStart, 0.99)

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
        // Only drive materials we own; the transmission material keeps its own.
        if ((m as THREE.MeshPhysicalMaterial).transmission) continue
        anyMat.transparent = true
        anyMat.opacity = fade
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
        <SpatialLayer groupRef={spatialRef} />
      </group>
      <DataStreams progress={progress} />
      <DataConduits
        progress={progress}
        layerRefs={layerRefs}
        selectedRef={selectedRef}
      />
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
   * The prism's `MeshTransmissionMaterial` renders the scene into an FBO from its
   * own `useFrame` callback, and that pass is not subject to `internal.priority`.
   * Measured off screen, the frame counter still advanced at almost exactly half
   * its on-screen rate — one of the two renders per frame was still running.
   * Unmounting is the only way to stop it.
   */
  awake: boolean
  /** Currently focused layer id, or null for the overview. */
  selectedLayer: string | null
  /** Called when a layer is clicked (or re-clicked to clear). */
  onSelectLayer: (id: string | null) => void
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
        antialias: true,
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
       * Two layers of sleep, because one is not enough:
       *   RenderGate  stops R3F's own draw while keeping the GL context alive.
       *   {awake && …}  unmounts the rig, which is the only way to stop the
       *                 transmission material's own FBO render. The canvas
       *                 itself stays mounted, so there is no context teardown.
       */}
      <RenderGate inViewRef={inViewRef} />

      {awake && (
        <ArchitectureRig
          progress={progress}
          inViewRef={inViewRef}
          selectedLayer={selectedLayer}
          onSelectLayer={onSelectLayer}
        />
      )}

      {/* Fog pulls the far edges of the grid into the void. */}
      <fog attach="fog" args={['#04060b', 9, 26]} />
    </Canvas>
  )
}

export default ScrollArchitecture3D
