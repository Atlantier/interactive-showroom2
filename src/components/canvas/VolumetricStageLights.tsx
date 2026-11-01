import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getTransient } from '@/store/useAppStore'
import type { PerformanceTier } from '@/types'

/**
 * VolumetricStageLights — three god-ray cones and the dust they illuminate.
 *
 * Mounted twice: once in the global background canvas for the hero screen, once
 * in the architecture canvas for the exploded-stack chapter. Both read the same
 * transient store, so neither needs a progress prop threaded through React —
 * `transient.scroll.progress` and `transient.mouse` are already live there.
 *
 * ── How the cones fake a volume ─────────────────────────────────────────────
 * There is no raymarching here. Each beam is an open-ended `ConeGeometry` shell
 * drawn additively with both faces, so a ray through the cone crosses the
 * surface twice and the two contributions stack. Edge softness comes from the
 * facing ratio `|N·V|`: where the shell turns away from the camera — the
 * silhouette — it contributes nothing, which removes the hard cone edge and
 * leaves the beam dissolving into the fog exactly as the brief asks.
 *
 * ── Why the dust is a separate Points system ────────────────────────────────
 * The motes have to be lit BY the beams, i.e. each mote must know how deep it
 * sits inside each cone. That per-vertex cone test lives in the dust vertex
 * shader (three unrolled cone tests), which is far cheaper than trying to make
 * the cone shader account for individual motes.
 */

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

/** Dust motes at full quality. Halved on the 'medium' tier. */
const BASE_DUST = 1500

/** Seconds for a mote to complete one Brownian step budget. */
const MAX_DT = 1 / 30

/**
 * Brownian step size, in world units per frame at 60 Hz.
 *
 * Real Brownian motion is scale-free and diverges, which is wrong for dust in a
 * bounded stage: the motes would drift out of the beams within seconds. This is
 * a random walk with wrapping at the volume bounds, sized so a mote crosses its
 * neighbourhood in a few seconds — slow enough to read as suspended dust,
 * lively enough not to look frozen.
 */
const BROWNIAN_STEP = 0.012

/** Half-extent of the mote volume, in world units. */
const DUST_BOUND = 7.5

/* -------------------------------------------------------------------------- */
/*  Beam definitions                                                          */
/* -------------------------------------------------------------------------- */

interface BeamSpec {
  /** Beam colour. */
  color: string
  /** X offset of the emitter. */
  offsetX: number
  /** Base tilt around X (the beams lean toward the viewer). */
  tiltX: number
  /** Base tilt around Z (the beams fan out left to right). */
  tiltZ: number
  /** How far the beam drifts sideways across the scroll progress. */
  scrollDrift: number
  /** Base shell opacity. */
  opacity: number
}

/**
 * Main beam is emerald cold, secondaries are deep-space indigo and cyber violet,
 * per the brief. The tilt and offset differences are what make the three read as
 * a raked stage rig rather than as one beam repeated.
 */
const BEAMS: BeamSpec[] = [
  { color: '#10b981', offsetX: -1.9, tiltX: 0.14, tiltZ: 0.2, scrollDrift: 1.6, opacity: 0.95 },
  { color: '#3b82f6', offsetX: 0.7, tiltX: -0.1, tiltZ: -0.12, scrollDrift: -1.1, opacity: 0.7 },
  { color: '#8b5cf6', offsetX: 2.6, tiltX: 0.2, tiltZ: 0.26, scrollDrift: 1.0, opacity: 0.55 },
]

/**
 * Cone shell geometry, shared by every beam.
 *
 * The radius/height ratio sets the beam's half-angle. 3.4 over 11 is 17°, which
 * at the hero camera's framing made each shaft ~4.3 world units wide across the
 * centre of the screen — three of those overlap into an even blue wash with no
 * readable shaft. 1.9 (10°) keeps each beam distinct while still spreading
 * enough to feel like stage haze rather than a laser.
 */
const CONE_RADIUS = 1.9
const CONE_HEIGHT = 11

/* -------------------------------------------------------------------------- */
/*  Noise                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Classic 3D gradient (Perlin) noise with a sin-hash.
 *
 * Value noise would be a third of the cost and, for fog, indistinguishable — but
 * the brief names Perlin specifically, and the cones cover a small enough part
 * of the frame that eight gradient dots per octave stays affordable. Quintic
 * interpolation is used because the cheaper cubic produces visible lattice
 * creases once the fog is stretched over 11 world units.
 */
const PERLIN = /* glsl */ `
  float hash31(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  float gradientNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    float n000 = hash31(i + vec3(0.0, 0.0, 0.0)) * 2.0 - 1.0;
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0)) * 2.0 - 1.0;
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0)) * 2.0 - 1.0;
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0)) * 2.0 - 1.0;
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0)) * 2.0 - 1.0;
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0)) * 2.0 - 1.0;
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0)) * 2.0 - 1.0;
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0)) * 2.0 - 1.0;

    return mix(
      mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
      mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
      u.z
    );
  }

  float fbm3(vec3 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
      total += amplitude * gradientNoise(p);
      p *= 2.02;
      amplitude *= 0.5;
    }
    return total;
  }
`

/* -------------------------------------------------------------------------- */
/*  Cone shaders                                                              */
/* -------------------------------------------------------------------------- */

const CONE_VERTEX = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vHeight;

  uniform float uHalfHeight;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);

    // Local y runs from +halfHeight (apex) to -halfHeight (base); normalise it
    // to 0 at the emitter and 1 at the floor.
    vHeight = clamp((uHalfHeight - position.y) / (uHalfHeight * 2.0), 0.0, 1.0);

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

/**
 * Facing ratio instead of a true fresnel term: `|N·V|` is 1 where the shell
 * faces the camera and 0 at the silhouette, so raising it to a power produces a
 * beam that is densest through its middle and dissolves at the edge. A classic
 * `1 - |N·V|` rim would do the opposite and outline the cone.
 */
const CONE_FRAGMENT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vHeight;

  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uEdgePower;
  uniform float uFalloffPower;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;

  ${PERLIN}

  void main() {
    // 1. Edge softening.
    float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
    float soft = pow(facing, uEdgePower);

    // 2. Vertical falloff: the beam is densest at the emitter and thins out as
    //    the cone opens. The upper smoothstep keeps the apex tip from flaring.
    float falloff = pow(1.0 - vHeight, uFalloffPower) * smoothstep(0.0, 0.1, vHeight);

    // 3. Flowing stage fog. The sample point slides upward and sideways so the
    //    turbulence reads as dry ice drifting through the beam rather than as a
    //    static texture.
    vec3 flow = vec3(
      vWorldPos.x * uNoiseScale,
      vWorldPos.y * uNoiseScale - uTime * uNoiseSpeed,
      vWorldPos.z * uNoiseScale + uTime * uNoiseSpeed * 0.35
    );
    float fog = fbm3(flow) * 0.5 + 0.5;
    // Keep a floor so the beam never punches through to pure black bands, but
    // leave a wide dynamic range: at a flat 0.42–1.18 the shafts read as even
    // fog with no visible dry-ice structure.
    fog = mix(0.28, 1.35, fog);

    float alpha = soft * falloff * fog * uOpacity;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(uColor * (0.85 + fog * 1.05), alpha);
  }
`

/* -------------------------------------------------------------------------- */
/*  Dust shaders                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Each mote is tested against the three cones in world space. Outside every cone
 * it renders at base brightness (which is deliberately near-black — the brief
 * wants unlit motes to disappear into the background), and inside one it is
 * scaled up to 4x with a per-mote twinkle.
 */
const DUST_VERTEX = /* glsl */ `
  attribute float aSeed;

  varying float vLight;
  varying float vSeed;
  varying float vDepth;

  uniform float uTime;
  uniform float uPixelRatio;

  uniform vec3 uApex0;
  uniform vec3 uApex1;
  uniform vec3 uApex2;
  uniform vec3 uAxis0;
  uniform vec3 uAxis1;
  uniform vec3 uAxis2;
  uniform float uTanHalf0;
  uniform float uTanHalf1;
  uniform float uTanHalf2;
  uniform float uConeHeight;

  // 1 inside the cone, 0 outside, with a soft margin so motes fade rather than
  // pop as they cross the boundary.
  float coneLight(vec3 p, vec3 apex, vec3 axis, float tanHalf) {
    vec3 d = p - apex;
    float axial = dot(d, axis);
    if (axial < 0.0 || axial > uConeHeight) return 0.0;

    float radial = length(d - axis * axial);
    float radius = axial * tanHalf;
    if (radius < 0.0001) return 0.0;

    return 1.0 - smoothstep(radius * 0.25, radius * 0.85, radial);
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);

    float lit =
      coneLight(world.xyz, uApex0, uAxis0, uTanHalf0) +
      coneLight(world.xyz, uApex1, uAxis1, uTanHalf1) +
      coneLight(world.xyz, uApex2, uAxis2, uTanHalf2);

    if (lit > 1.0) lit = 1.0;

    // Twinkle: two incommensurate rates so it never pulses in lockstep.
    float twinkle =
      0.65 +
      0.35 * sin(uTime * 3.1 + aSeed * 87.0) *
      sin(uTime * 1.7 + aSeed * 41.0);

    // 4x when fully inside a beam, per the brief; near-zero outside so unlit
    // motes sink into the dark instead of forming a uniform starfield.
    vLight = (0.04 + lit * 3.96) * twinkle;
    vSeed = aSeed;

    vec4 mvPosition = viewMatrix * world;
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;

    /*
     * Motes stay small on purpose. The first pass allowed 22 px sprites, which
     * at 4x brightness turned the whole volume into white bokeh discs that read
     * as a lens artefact rather than as dust suspended in light.
     */
    float size = (0.35 + aSeed * 0.65) * (1.0 + lit * 0.9);
    gl_PointSize = clamp(
      size * uPixelRatio * (22.0 / max(vDepth, 0.5)),
      0.0,
      7.0
    );
  }
`

const DUST_FRAGMENT = /* glsl */ `
  varying float vLight;
  varying float vSeed;
  varying float vDepth;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv) * 2.0;
    if (r > 1.0) discard;

    // Soft radial mote with a bright centre.
    float core = exp(-4.5 * r * r);
    float alpha = core * vLight;
    if (alpha < 0.004) discard;

    // Motes inside a beam pick up a slightly warmer white at their centre, which
    // is what sells them as illuminated by light rather than as self-lit.
    vec3 tint = mix(vec3(0.55, 0.85, 1.0), vec3(1.0), core * 0.6);
    gl_FragColor = vec4(tint * (1.0 + vLight * 0.8), alpha);
  }
`

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export interface VolumetricStageLightsProps {
  /** Quality tier — halves the dust on 'medium'. */
  tier?: PerformanceTier
  /** Vertical position of the cone apexes. */
  height?: number
  /** Uniform scale of the whole rig. */
  scale?: number
  /** Brightness multiplier for the beams and the dust they light. */
  intensity?: number
  /**
   * Fade the whole rig out as the page scrolls past the first screen.
   *
   * Set on the hero instance: that one lives in the always-mounted background
   * canvas, so without this the beams would shine through every later chapter.
   * The architecture instance sits inside its own `awake` gate and leaves this
   * off.
   */
  fadeWithScroll?: boolean
}

export function VolumetricStageLights({
  tier = 'high',
  height = 7.5,
  scale = 1,
  intensity = 1,
  fadeWithScroll = false,
}: VolumetricStageLightsProps) {
  const camera = useThree((state) => state.camera)
  const coneRefs = useRef<Array<THREE.Mesh | null>>([])
  const dustRef = useRef<THREE.Points>(null)

  const dustCount = tier === 'high' ? BASE_DUST : Math.round(BASE_DUST / 2)
  const beams = useMemo(() => (tier === 'high' ? BEAMS : BEAMS.slice(0, 2)), [tier])

  /* ── Cone geometry + per-beam uniforms ─────────────────────────────────── */
  const coneGeo = useMemo(
    () =>
      // openEnded: the caps would otherwise add a hard disc across the beam.
      new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 48, 1, true),
    [],
  )

  const coneUniforms = useMemo(
    () =>
      beams.map((beam) => ({
        uColor: { value: new THREE.Color(beam.color) },
        uTime: { value: 0 },
        uOpacity: { value: beam.opacity },
        uEdgePower: { value: 1.9 },
        uFalloffPower: { value: 1.35 },
        uNoiseScale: { value: 0.22 },
        uNoiseSpeed: { value: 0.16 },
        uHalfHeight: { value: CONE_HEIGHT / 2 },
      })),
    [beams],
  )

  const coneMaterials = useMemo(
    () =>
      coneUniforms.map(
        (uniforms) =>
          new THREE.ShaderMaterial({
            uniforms,
            vertexShader: CONE_VERTEX,
            fragmentShader: CONE_FRAGMENT,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            // Both faces: a ray through the shell crosses it twice and the two
            // additive contributions are what give the beam body.
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
          }),
      ),
    [coneUniforms],
  )

  /* ── Dust pool ─────────────────────────────────────────────────────────── */
  const dust = useMemo(() => {
    const position = new Float32Array(dustCount * 3)
    const seed = new Float32Array(dustCount)

    let s = 0x68e31da4
    const rand = (): number => {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      return s / 4294967296
    }

    for (let i = 0; i < dustCount; i++) {
      const i3 = i * 3
      // Cube-root bias so motes are spread by volume, not clustered at the
      // bounds.
      position[i3] = (rand() * 2 - 1) * DUST_BOUND
      position[i3 + 1] = (rand() * 2 - 1) * DUST_BOUND * 0.7 + 2
      position[i3 + 2] = (rand() * 2 - 1) * DUST_BOUND
      seed[i] = rand()
    }

    return { position, seed, rand, pulse: 0 }
  }, [dustCount])

  const dustGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(dust.position, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    geo.setAttribute('aSeed', new THREE.BufferAttribute(dust.seed, 1))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), DUST_BOUND * 2)
    return geo
  }, [dust])

  const dustUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uApex0: { value: new THREE.Vector3() },
      uApex1: { value: new THREE.Vector3() },
      uApex2: { value: new THREE.Vector3() },
      uAxis0: { value: new THREE.Vector3(0, -1, 0) },
      uAxis1: { value: new THREE.Vector3(0, -1, 0) },
      uAxis2: { value: new THREE.Vector3(0, -1, 0) },
      uTanHalf0: { value: 0 },
      uTanHalf1: { value: 0 },
      uTanHalf2: { value: 0 },
      uConeHeight: { value: CONE_HEIGHT * scale },
    }),
    [scale],
  )

  const dustMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: dustUniforms,
        vertexShader: DUST_VERTEX,
        fragmentShader: DUST_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [dustUniforms],
  )

  /* ── Scratch, allocated once ───────────────────────────────────────────── */
  const scratch = useMemo(
    () => ({
      apex: new THREE.Vector3(),
      base: new THREE.Vector3(),
      axis: new THREE.Vector3(),
    }),
    [],
  )

  /* ── Dispose ───────────────────────────────────────────────────────────── */
  useEffect(
    () => () => {
      coneGeo.dispose()
      for (const m of coneMaterials) m.dispose()
      dustGeometry.dispose()
      dustMaterial.dispose()
    },
    [coneGeo, coneMaterials, dustGeometry, dustMaterial],
  )

  /* ── Keep point sizes correct across DPR changes ───────────────────────── */
  useEffect(() => {
    dustUniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2)
  }, [dustUniforms])

  useFrame((state, rawDelta) => {
    const dt = Math.min(rawDelta, MAX_DT)
    if (!(dt > 0)) return

    const time = state.clock.elapsedTime
    const transient = getTransient()
    const p = transient.scroll.progress
    const mouse = transient.mouse
    camera.updateMatrixWorld()

    /* Hero instance: fade out once the first screen has scrolled away. */
    let heroFade = 1
    if (fadeWithScroll) {
      heroFade = 1 - Math.min(Math.max((p - 0.02) / 0.16, 0), 1)
    }

    /* 1. Beams: parallax sway from mouse + scroll, plus a slow breath. */
    for (let i = 0; i < beams.length; i++) {
      const mesh = coneRefs.current[i]
      if (!mesh) continue
      const beam = beams[i]
      const uniforms = coneUniforms[i]

      uniforms.uTime.value = time

      // Mouse parallax: the beams lean toward the pointer. Scroll adds a
      // counter-drift so the rig re-racks as the page moves.
      mesh.rotation.x =
        beam.tiltX + mouse.x * 0.09 + Math.sin(time * 0.37 + i * 1.7) * 0.022
      mesh.rotation.z =
        beam.tiltZ - mouse.y * 0.055 + Math.sin(time * 0.29 + i * 2.3) * 0.018

      // Local space: the parent group carries `scale`, so these must stay
      // unscaled or the rig would be scaled twice.
      mesh.position.x = beam.offsetX + p * beam.scrollDrift
      mesh.position.y = height

      // Colour breathing, per beam and slightly out of phase.
      const breath = 0.82 + 0.18 * Math.sin(time * 0.62 + i * 2.1)
      uniforms.uOpacity.value = beam.opacity * intensity * breath * heroFade

      mesh.visible = uniforms.uOpacity.value > 0.002

      /* Publish the cone's world-space frame for the dust test. */
      mesh.updateMatrixWorld()
      const half = CONE_HEIGHT / 2
      scratch.apex.set(0, half, 0).applyMatrix4(mesh.matrixWorld)
      scratch.base.set(0, -half, 0).applyMatrix4(mesh.matrixWorld)
      scratch.axis.subVectors(scratch.base, scratch.apex).normalize()

      const tanHalf = CONE_RADIUS / CONE_HEIGHT
      if (i === 0) {
        dustUniforms.uApex0.value.copy(scratch.apex)
        dustUniforms.uAxis0.value.copy(scratch.axis)
        dustUniforms.uTanHalf0.value = tanHalf
      } else if (i === 1) {
        dustUniforms.uApex1.value.copy(scratch.apex)
        dustUniforms.uAxis1.value.copy(scratch.axis)
        dustUniforms.uTanHalf1.value = tanHalf
      } else {
        dustUniforms.uApex2.value.copy(scratch.apex)
        dustUniforms.uAxis2.value.copy(scratch.axis)
        dustUniforms.uTanHalf2.value = tanHalf
      }
    }

    // Beams beyond the current tier keep their uniforms at zero opacity so the
    // dust shader never tests against a stale cone.
    for (let i = beams.length; i < 3; i++) {
      if (i === 1) {
        dustUniforms.uTanHalf1.value = 0
      } else {
        dustUniforms.uTanHalf2.value = 0
      }
    }

    dustUniforms.uTime.value = time
    dustUniforms.uConeHeight.value = CONE_HEIGHT * scale

    /* 2. Dust: Brownian random walk with wrap-around at the volume bounds. */
    const { position, rand } = dust
    const step = BROWNIAN_STEP * (dt * 60)
    const boundY = DUST_BOUND * 0.7

    for (let i = 0; i < dustCount; i++) {
      const i3 = i * 3

      let x = position[i3] + (rand() - 0.5) * step
      let y = position[i3 + 1] + (rand() - 0.5) * step * 0.6 - 0.0045 * (dt * 60)
      let z = position[i3 + 2] + (rand() - 0.5) * step

      // Wrapping rather than clamping: clamping would pile motes up on the
      // faces and produce visible planes of dust.
      if (x > DUST_BOUND) x -= DUST_BOUND * 2
      else if (x < -DUST_BOUND) x += DUST_BOUND * 2
      if (z > DUST_BOUND) z -= DUST_BOUND * 2
      else if (z < -DUST_BOUND) z += DUST_BOUND * 2

      const topY = 2 + boundY
      const bottomY = 2 - boundY
      if (y > topY) y = bottomY
      else if (y < bottomY) y = topY

      position[i3] = x
      position[i3 + 1] = y
      position[i3 + 2] = z
    }

    ;(dustGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true

    if (dustRef.current) dustRef.current.visible = heroFade > 0.002
  })

  return (
    <group scale={scale}>
      {beams.map((beam, i) => (
        <mesh
          key={beam.color}
          ref={(el) => {
            coneRefs.current[i] = el
          }}
          geometry={coneGeo}
          material={coneMaterials[i]}
          position={[beam.offsetX, height, 0]}
          frustumCulled={false}
        />
      ))}

      <points
        ref={dustRef}
        geometry={dustGeometry}
        material={dustMaterial}
        frustumCulled={false}
      />
    </group>
  )
}

export default VolumetricStageLights
