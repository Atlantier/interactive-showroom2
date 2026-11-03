/**
 * GLSL for the architecture chapter.
 *
 * ── Why these live in their own module ──────────────────────────────────────
 * They were declared in the middle of a 1800-line component, between the rig code and the
 * React tree. A shader is the one part of this file that cannot be checked by the compiler
 * or by a type: it fails at runtime, on the GPU, usually as a black canvas with a console
 * warning nobody reads. Keeping them together means a change to one can be read next to
 * the others, and it gives the shader set a name (`architectureShaders`) instead of eleven
 * loose constants.
 *
 * Nothing here is transformed on the way out: these are moved verbatim, and the component
 * imports them. Splitting the component any further (D3 in the plan) stops here on purpose
 * — the remaining 1100 lines are one rig that shares state through refs, and cutting it
 * into "files" would only move the coupling around.
 */

import { NOISE_HASH_3D, NOISE_VALUE_3D } from '@/components/canvas/shaderNoise'

export const EDGE_VERTEX = /* glsl */ `
  attribute float aAlong;
  varying float vAlong;
  void main() {
    vAlong = aAlong;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const EDGE_FRAGMENT = /* glsl */ `
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

export const STREAM_VERTEX = /* glsl */ `
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

export const STREAM_FRAGMENT = /* glsl */ `
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

export const PLASMA_VERTEX = `
varying vec3 vViewPos;
varying vec3 vCenter;
varying vec3 vNormalW;
varying vec3 vViewDir;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

  // The raymarch below works entirely in view space, so the fragment needs the
  // eye-space position of the surface point and the eye-space centre of the
  // sphere. Both are free here; deriving the centre in the fragment shader would
  // mean uploading the model matrix instead.
  vViewPos = mvPosition.xyz;
  vCenter = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  vNormalW = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`

export const PLASMA_FRAGMENT = `
uniform float uTime;
uniform float uRadius;
uniform vec3 uDeep;
uniform vec3 uHot;
uniform float uIntensity;

varying vec3 vViewPos;
varying vec3 vCenter;
varying vec3 vNormalW;
varying vec3 vViewDir;

${NOISE_HASH_3D}
${NOISE_VALUE_3D}

// One cloud sample: a low-frequency field warps the lookup of a second one.
float cloudAt(vec3 p, float t) {
  float w = vnoise3(p * 1.35 + vec3(0.0, t, 0.0));
  return vnoise3(p * 1.8 + vec3(w * 1.6, t * 0.65, w * 1.1));
}

void main() {
  /*
   * VOLUMETRIC MARCH, not a surface texture.
   *
   * The previous shader sampled the cloud field with the SURFACE NORMAL. A pattern
   * driven by the normal is a texture map by construction: it sits on the sphere,
   * follows its curvature like wallpaper, and reads flat no matter how much detail
   * is added. That is the "looks like a texture" note.
   *
   * Here the view ray is intersected with the sphere and marched through its
   * INTERIOR, accumulating density along the chord. The same cloud field then
   * exists at different depths, the front and back halves of the volume both
   * contribute, and the silhouette is naturally thinner because the chord is short
   * there -- which is what actually produces volume rather than a painted ball.
   */
  vec3 rd = normalize(vViewPos);
  vec3 oc = -vCenter;
  float R = uRadius;

  float b = dot(rd, oc);
  float c = dot(oc, oc) - R * R;
  float disc = max(b * b - c, 0.0);
  float sq = sqrt(disc);

  // Entry and exit of this pixel's chord through the sphere, in view space.
  float tEnter = max(-b - sq, 0.0);
  float tExit = -b + sq;

  float spin = uTime * 0.18;
  float cs = cos(spin);
  float sn = sin(spin);
  float drift = uTime * 0.35;

  /*
   * Three steps, not five.
   *
   * Each step runs two 8-tap sin-hash noise lookups, i.e. ~16 sin() calls, and the
   * sphere covers a large part of the frame in this chapter -- five steps was up to
   * 80 sin() per fragment. Three still resolves the front/back halves of the volume
   * (the thing the march exists for) at 40% less cost; the difference is invisible
   * through the glass and under the contact glow.
   */
  float density = 0.0;
  const int STEPS = 3;

  for (int i = 0; i < STEPS; i++) {
    float u = (float(i) + 0.5) / float(STEPS);
    float dist = mix(tEnter, tExit, u);

    // Position along the chord, normalised into the unit sphere.
    vec3 sp = (rd * dist - vCenter) / R;

    // Slow rotation so the volume visibly turns rather than sitting still.
    vec3 rp = vec3(sp.x * cs - sp.z * sn, sp.y, sp.x * sn + sp.z * cs);

    density += cloudAt(rp * 1.6, drift + u * 0.6);
  }
  density /= float(STEPS);

  /*
   * Fresnel limb.
   *
   * The exponent controls how WIDE the white edge is: 2.2 confined it to a couple
   * of pixels at the very silhouette, which is why the sphere kept reading as a
   * uniform milky mass instead of the reference's bright-rimmed volume. 1.6 spreads
   * it inward so the edge actually carries light.
   */
  float facing = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);
  float limb = pow(1.0 - facing, 1.6);

  /*
   * Density contrast.
   *
   * The marching window was 0.22..0.95, i.e. almost the whole measured range, so
   * every fold mapped to nearly the same output value and the internal structure
   * washed out. Narrowing to 0.35..0.85 spends the full 0..1 range on the middle of
   * the distribution, which is where the wisps actually live.
   */
  float milk = smoothstep(0.35, 0.85, density);
  vec3 col = mix(uDeep, uHot, clamp(max(milk * 0.8, limb), 0.0, 1.0));

  // Carries the structure into the brightest areas, where the colour mix saturates.
  col *= 0.82 + 0.36 * density;

  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`

export const DISPERSION_VERTEX = `
  varying vec3 vN;
  varying vec3 vV;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`

export const DISPERSION_FRAGMENT = `
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

export const CONDUIT_VERTEX = /* glsl */ `
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

export const CONDUIT_FRAGMENT = /* glsl */ `
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

export const RIM_VERTEX = `
  varying vec3 vRimN;
  varying vec3 vRimV;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vRimN = normalize(normalMatrix * normal);
    vRimV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`

export const RIM_FRAGMENT = `
  varying vec3 vRimN;
  varying vec3 vRimV;

  void main() {
    float f = 1.0 - clamp(dot(normalize(vRimN), normalize(vRimV)), 0.0, 1.0);
    f = pow(f, 3.0);

    // Low-saturation pale cyan, matching the edge lattice. Additive, so the
    // silhouette gains a bright hair with no black outline.
    vec3 col = vec3(0.62, 0.86, 0.90);
    gl_FragColor = vec4(col * f * 0.6, 1.0);
  }
`

export const CONTACT_VERTEX = `
  varying vec2 vContactUv;

  void main() {
    vContactUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const CORE_GLOW_FRAGMENT = `
  varying vec2 vContactUv;

  void main() {
    float d = length(vContactUv - 0.5) * 2.0;

    // Wide bloom: reaches zero exactly at the quad's edge, so no border shows.
    float wide = pow(clamp(1.0 - d, 0.0, 1.0), 2.6);

    // Tight lift hugging the limb.
    float tight = pow(clamp(1.0 - d * 1.45, 0.0, 1.0), 3.2);

    /*
     * Levels are higher than before because this quad IS the bloom for this
     * canvas: the architecture chapter renders without an EffectComposer (it was
     * removed when it was darkening the scene), so there is no post-process glow to
     * fall back on. The core's brightness alone has nothing to bleed into.
     */
    float glow = wide * 0.85 + tight * 0.95;
    vec3 col = vec3(0.78, 0.95, 1.0);

    /*
     * Alpha MUST track the glow.
     *
     * It was hard-coded to 1.0 on the assumption that additive blending makes the
     * black corners irrelevant. It does not if the blend mode fails to take effect:
     * the quad then composites as an OPAQUE square, and its near-black corners were
     * the two dark rectangles that appeared beside the crystal's upper edges.
     * Binding alpha to the same value makes the primitive correct under either
     * blend mode instead of depending on one.
     */
    float alpha = clamp(glow, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
  }
`
