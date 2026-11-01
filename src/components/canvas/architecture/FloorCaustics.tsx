import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * FloorCaustics — a procedural caustic web projected on a virtual floor.
 *
 * Sits under the architecture stack and tracks its lowest layer, so it stays
 * underneath the model as the stack explodes apart rather than being sliced
 * through by the bottom wireframe matrix.
 *
 * ── The pattern ─────────────────────────────────────────────────────────────
 * Two independent Voronoi fields run at different scales and drift in opposite
 * directions. A single Voronoi already produces cell walls; the caustic look
 * comes from the INTERFERENCE between the two: multiplying their soft edge masks
 * leaves only the places where both bisectors nearly coincide, which is the
 * branching, filament-like structure that real refracted light forms.
 *
 * ── Allocation ──────────────────────────────────────────────────────────────
 * One plane, one shader, no per-frame allocation. The only thing the CPU does
 * each frame is age the time uniform and follow the bottom layer's Y.
 */

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

/** Extent of the projection plane, in world units. */
const PLANE_SIZE = 20

/**
 * How far below the bottom layer the floor sits.
 *
 * The first value was 1.15, which put the plane entirely below the camera's
 * frame during the exploded phase — the caustics existed but nobody could see
 * them. 0.45 keeps the web reading as light cast onto the floor just under the
 * wireframe matrix, close enough that it glows through the gaps in the grid.
 */
export const CAUSTICS_DROP = 0.45

/**
 * Voronoi cell counts for the two interfering layers.
 *
 * The ratio is deliberately irrational-ish: at 3:4 or 2:3 the two fields align
 * periodically and the interference resolves into a repeating tile that reads
 * as wallpaper instead of as light.
 */
const LAYER_A_SCALE = 5.3
const LAYER_B_SCALE = 8.7

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/**
 * Voronoi returns `F2 - F1`, the gap between the nearest and second-nearest
 * feature point. That difference is zero exactly on a cell boundary and grows
 * toward a cell centre, which makes it the right quantity for drawing thin
 * cracks: `1 - smoothstep(0, w, F2-F1)` gives a crisp edge with a controllable
 * softness, without needing to reconstruct edge segments.
 */
const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec3 uColorCore;
  uniform vec3 uColorEdge;
  uniform float uIntensity;

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453123);
  }

  float voronoiGap(vec2 p, float phase, float seed) {
    vec2 n = floor(p);
    vec2 f = fract(p);

    float f1 = 8.0;
    float f2 = 8.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash2(n + g + seed);
        // Each cell point orbits its own tiny circle. This is what animates the
        // pattern without any texture or per-frame buffer work.
        o = 0.5 + 0.5 * sin(phase + 6.2831853 * o);
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }

    return sqrt(f2) - sqrt(f1);
  }

  void main() {
    vec2 centred = vUv - 0.5;
    float radius = length(centred) * 2.0;

    // Two fields, different scales, drifting apart.
    float gapA = voronoiGap(vUv * ${LAYER_A_SCALE.toFixed(2)} + vec2(uTime * 0.031, uTime * 0.017), uTime * 0.9, 0.0);
    float gapB = voronoiGap(vUv * ${LAYER_B_SCALE.toFixed(2)} + vec2(-uTime * 0.023, uTime * 0.039), uTime * 0.7, 7.31);

    // Soft edge masks, then interference: the product keeps only where both
    // fields are near a boundary. The mask width is tight (0.14 rather than the
    // 0.30 of the first pass) because the plane is seen at a grazing angle, where
    // a wide mask just smears into a violet haze instead of forming filaments.
    float maskA = 1.0 - smoothstep(0.0, 0.14, gapA);
    float maskB = 1.0 - smoothstep(0.0, 0.12, gapB);

    float interference = pow(maskA * maskB, 1.15);
    // A dimmer single-layer contribution keeps the web from looking sparse.
    float single = max(maskA, maskB) * 0.30;

    float caustic = interference + single;

    // Brighter at the centre of the projection, smooth falloff outward, plus a
    // hard cut at the plane's edge so the quad never shows its own boundary.
    float radial = 1.0 - smoothstep(0.05, 0.95, radius);
    radial *= radial;
    float edgeCut = 1.0 - smoothstep(0.88, 1.0, radius);

    vec3 col = mix(uColorCore, uColorEdge, smoothstep(0.1, 0.95, radius));

    float alpha = caustic * radial * edgeCut * uIntensity;
    if (alpha < 0.002) discard;

    gl_FragColor = vec4(col * (0.9 + caustic * 1.8), alpha);
  }
`

export interface FloorCausticsProps {
  /**
   * The lowest layer of the model. The floor positions itself relative to this
   * every frame, so it follows the stack as it explodes instead of being
   * intersected by it.
   */
  bottomRef: React.RefObject<THREE.Object3D | null>
  /** Overall brightness. */
  intensity?: number
}

export function FloorCaustics({ bottomRef, intensity = 1 }: FloorCausticsProps) {
  const meshRef = useRef<THREE.Mesh>(null)

  const geometry = useMemo(() => new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, 1, 1), [])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColorCore: { value: new THREE.Color('#7ff3ff') },
      uColorEdge: { value: new THREE.Color('#8b5cf6') },
      uIntensity: { value: intensity },
    }),
    [intensity],
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
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [uniforms],
  )

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime

    const mesh = meshRef.current
    const bottom = bottomRef.current
    if (mesh && bottom) {
      mesh.position.y = bottom.position.y - CAUSTICS_DROP
    }
  })

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -2.1, 0]}
      frustumCulled={false}
    />
  )
}

export default FloorCaustics
