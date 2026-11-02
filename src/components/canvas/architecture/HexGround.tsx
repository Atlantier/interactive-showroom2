import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

/**
 * HexGround — the floor of the architecture chapter.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * The previous floor was the infrastructure layer's solid kernel lattice: a 6x6
 * block of extrusions with a metal material, plus a separate 7x7 contact plane.
 * Read from the chapter's camera it was an opaque black board that covered the
 * procedural caustic web underneath it, and because the lattice's columns were
 * co-planar with the contact plane it also z-fought, which is where the horizontal
 * striping came from.
 *
 * ── Three layers, and why each is separate ─────────────────────────────────
 *   1. BASE   a very deep, translucent radial wash. Not a solid fill: its alpha
 *             peaks at ~0.42 in the centre and reaches zero at the rim, so the
 *             floor fades into space instead of ending on a rectangle.
 *   2. GRID   hex-lattice lines only, no fill. Width is derived from `fwidth`, so
 *             they stay ~1 px at any distance instead of aliasing into mush.
 *   3. GLOW   the contact pool under the crystal plus a faint vertical smear that
 *             stands in for a blurred reflection.
 *
 * They are three meshes at three different Y values rather than one shader with
 * three terms, because the layers need different blending (opaque-ish wash,
 * transparent lines, additive glow) and different depths. Offsetting them by
 * 0.012 units is what removes the z-fighting the old floor suffered from.
 *
 * ── Light ──────────────────────────────────────────────────────────────────
 * The crystal's core is a `pointLight` at y = 2.0. Rather than relying on the
 * renderer to light a custom shader (which it cannot do), the same falloff is
 * evaluated analytically here from `uCore`, so the floor brightens toward the
 * crystal and decays with distance exactly like a real light would.
 */

/** Where the floor sits in world space. */
export const GROUND_Y = -0.62

interface HexGroundProps {
  /** Local Y of the floor. Lets the caller place it inside an animated group. */
  y?: number
  /** Radius of the disc, in world units. */
  radius?: number
  /** World-space position of the light that drives the floor. */
  core?: [number, number, number]
  intensity?: number
}

/* -------------------------------------------------------------------------- */
/*  Shaders                                                                   */
/* -------------------------------------------------------------------------- */

const VERT = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vWorld;

  void main() {
    vLocal = position.xy;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

/**
 * The shared preamble: a disc mask with a long fade, and the analytic point-light
 * falloff. Both are needed by all three layers, so they are generated once.
 */
const COMMON = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vWorld;

  uniform vec3 uCore;
  uniform float uRadius;
  uniform float uTime;

  /** 1 at the centre, 0 at the rim, with the fade biased outward. */
  float discMask(vec2 p) {
    float r = length(p) / uRadius;
    return smoothstep(1.0, 0.34, r);
  }

  /** Inverse-square-ish falloff from the core, projected onto the floor. */
  float coreLight(vec2 p) {
    vec3 d = vec3(p.x, 0.0, p.y) - vec3(uCore.x, 0.0, uCore.z);
    float dist2 = dot(d, d);
    float h = uCore.y - 0.0;
    return 1.0 / (1.0 + (dist2 + h * h) * 0.14);
  }
`

/**
 * Layer 1 — the wash.
 *
 * Deliberately weak: `alpha` never exceeds ~0.42 and the colour is nearly black,
 * so this darkens the region under the crystal without ever reading as a slab.
 */
const BASE_FRAG = /* glsl */ `
  ${COMMON}

  uniform vec3 uBaseTint;

  void main() {
    float m = discMask(vLocal);
    if (m <= 0.001) discard;

    float light = coreLight(vLocal);

    // Deep base lifted slightly by the core's own light.
    vec3 cold = vec3(0.012, 0.024, 0.034);
    vec3 warm = uBaseTint * 1.15;
    vec3 col = mix(cold, warm, clamp(light * 1.4, 0.0, 1.0));

    gl_FragColor = vec4(col, m * 0.58);
  }
`

/**
 * Layer 2 — hex lattice lines.
 *
 * Three families of parallel lines at 60 degrees. Their intersections close into
 * hexagons, which is the lattice the brief asks for, and drawing line families is
 * far cheaper than establishing hex cell coordinates analytically.
 *
 * `fwidth` gives the screen-space derivative of the distance field, which is what
 * keeps the stroke one pixel wide whether the floor is near the camera or far:
 * a fixed world-space width would alias badly at this grazing angle.
 */
const GRID_FRAG = /* glsl */ `
  ${COMMON}

  uniform vec3 uLineColor;
  uniform float uCell;

  /** Distance to the nearest line of one family, in world units. */
  float family(vec2 p, float angle, float spacing) {
    float c = cos(angle);
    float s = sin(angle);
    vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    float v = r.y / spacing;
    return abs(fract(v + 0.5) - 0.5) * spacing;
  }

  void main() {
    float m = discMask(vLocal);
    if (m <= 0.001) discard;

    float d = min(
      family(vLocal, 0.0, uCell),
      min(family(vLocal, 1.0471976, uCell), family(vLocal, 2.0943951, uCell))
    );

    /*
     * Grazing fade.
     *
     * Toward the rim the floor is seen almost edge-on, so each pixel covers a huge
     * world-space area and the one-pixel stroke can no longer resolve the lattice:
     * the lines collapse into moire. Fading the whole layer out where the surface
     * is steep is both physically sensible (a floor at a grazing angle reflects
     * less) and the only way to keep the far edge clean.
     */
    vec3 toEye = normalize(cameraPosition - vWorld);
    float graze = clamp(abs(dot(toEye, vec3(0.0, 1.0, 0.0))), 0.0, 1.0);
    float grazeFade = smoothstep(0.05, 0.42, graze);

    /*
     * One-pixel stroke, plus an anti-moire fade.
     *
     * fwidth(d) is the world distance one pixel covers. Clamping it (the previous
     * approach) made distant lines progressively fatter, which turned the lattice
     * into a woven texture; fading the layer out once a pixel spans a sizeable
     * fraction of a cell is what makes the far field dissolve instead of alias.
     */
    float px = fwidth(d);
    float resolvable = 1.0 - smoothstep(0.035, 0.11, px);
    float w = px * 1.15;
    float line = (1.0 - smoothstep(0.0, w, d)) * resolvable;

    float light = coreLight(vLocal);

    float alpha = m * m * 0.62 * (0.62 + light * 1.25) * line * grazeFade;
    if (alpha <= 0.002) discard;

    gl_FragColor = vec4(uLineColor * (0.72 + light * 1.15), alpha);
  }
`

/**
 * Layer 3 — contact glow and the stand-in reflection.
 *
 * A real mirror pass is not an option here: `MeshReflectorMaterial` is a square
 * plane and this floor must have no rectangular edge, and masking it would need a
 * full-screen pass this canvas does not own. So the reflection is drawn instead:
 * a tight radial pool directly beneath the crystal plus a vertically stretched
 * smear that fades with distance, which is what a blurred reflection of a glowing
 * sphere actually looks like at this scale.
 */
const GLOW_FRAG = /* glsl */ `
  uniform vec3 uGlowColor;
  uniform float uRadius;

  varying vec2 vLocal;
  varying vec3 vWorld;

  void main() {
    vec2 p = vLocal / uRadius;

    // Tight pool: the branch that reads as the crystal sitting on the floor.
    float pool = pow(clamp(1.0 - length(p) * 1.9, 0.0, 1.0), 3.4);

    // Faint elongated smear below the core (squashed in x, stretched in z) so the
    // light appears to run down into the floor rather than sit on it as a decal.
    vec2 s = vec2(p.x * 3.1, (p.y + 0.10) * 0.85);
    float smear = pow(clamp(1.0 - length(s), 0.0, 1.0), 2.6) * 0.34;

    float a = (pool * 0.75 + smear) * smoothstep(1.0, 0.62, length(p));
    if (a <= 0.003) discard;

    gl_FragColor = vec4(uGlowColor, a * 0.95);
  }
`

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function HexGround({ radius = 6.4, core = [0, 2.0, 0], y = GROUND_Y }: HexGroundProps) {
  const glowRef = useRef<THREE.Mesh>(null)

  const shared = useMemo(
    () => ({
      uCore: { value: new THREE.Vector3(...core) },
      uRadius: { value: radius },
      uTime: { value: 0 },
    }),
    [core, radius],
  )

  const baseUniforms = useMemo(
    () => ({ ...shared, uBaseTint: { value: new THREE.Color('#1d5f6e') } }),
    [shared],
  )
  const gridUniforms = useMemo(
    () => ({
      ...shared,
      uLineColor: { value: new THREE.Color('#9fd9e6') },
      uCell: { value: 0.52 },
    }),
    [shared],
  )
  const glowUniforms = useMemo(
    () => ({ uGlowColor: { value: new THREE.Color('#7fe6f0') }, uRadius: { value: radius } }),
    [radius],
  )

  useFrame((state) => {
    const t = state.clock.elapsedTime
    shared.uTime.value = t
    // Slow breathing on the contact pool so the floor is not a dead decal.
    if (glowRef.current) {
      const s = 1 + Math.sin(t * 0.7) * 0.012
      glowRef.current.scale.set(s, s, 1)
    }
  })

  return (
    <group>
      {/* 1. Wash */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} renderOrder={1}>
        <circleGeometry args={[radius, 96]} />
        <shaderMaterial
          vertexShader={VERT}
          fragmentShader={BASE_FRAG}
          uniforms={baseUniforms}
          transparent
          depthWrite={false}
          blending={THREE.NormalBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {/*
       * (removed) A MeshReflectorMaterial mirror used to sit here.
       *
       * It was the wrong primitive for this canvas on three counts: drei's reflector
       * allocates two render targets plus a blur pass that are never disposed (≈8.9
       * MB leaked per mount, guaranteed under StrictMode), it re-renders the entire
       * scene every frame for a reflection that `mirror: 0.45` + heavy blur made
       * barely readable, and it directly contradicts the render gate above, whose
       * whole point is that this chapter draws nothing while off screen.
       *
       * The contact pool below already carries the grounding (bright under the
       * crystal, decaying outward), so this costs a little mirror sheen and buys
       * back two render targets and a full extra scene pass.
       */}

      {/* 3. Hex lattice. Offset 8 mm above the mirror so it can never z-fight. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y + 0.012, 0]} renderOrder={2}>
        <circleGeometry args={[radius, 96]} />
        <shaderMaterial
          vertexShader={VERT}
          fragmentShader={GRID_FRAG}
          uniforms={gridUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {/* 3. Contact glow / stand-in reflection. */}
      <mesh
        ref={glowRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, y + 0.024, 0]}
        renderOrder={3}
      >
        <circleGeometry args={[radius * 0.9, 96]} />
        <shaderMaterial
          vertexShader={VERT}
          fragmentShader={GLOW_FRAG}
          uniforms={glowUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}

export default HexGround
