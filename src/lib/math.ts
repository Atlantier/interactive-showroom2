/** Small, allocation-free math helpers shared by DOM and WebGL code. */

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value))

export const lerp = (from: number, to: number, t: number): number => from + (to - from) * t

/**
 * Frame-rate independent exponential damping.
 * Using `dt` keeps the motion identical at 60Hz, 120Hz or during frame drops,
 * which is what lets the DOM scroll loop and R3F's frame loop stay in sync.
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * Math.max(dt, 0)))

/** Remap `value` from [inMin, inMax] to [outMin, outMax], clamped at the edges. */
export const mapRange = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number => {
  if (inMax - inMin === 0) return outMin
  return outMin + ((clamp(value, inMin, inMax) - inMin) / (inMax - inMin)) * (outMax - outMin)
}

/** Guard against NaN/Infinity leaking into shaders or transforms. */
export const safeNumber = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback

/* -------------------------------------------------------------------------- */
/*  Spring dynamics (Hooke's law) — required for interactive motion quality    */
/* -------------------------------------------------------------------------- */

/**
 * Mutable 1-D spring state. Plain object on purpose: allocate ONCE per animated
 * property (outside the frame loop) and step it in place, so no garbage is
 * produced at 60/120 FPS.
 */
export interface Spring1D {
  value: number
  velocity: number
}

/** Create a spring at rest. Call during setup, never inside a frame callback. */
export const createSpring = (initial = 0): Spring1D => ({ value: initial, velocity: 0 })

/** Configuration for a critically-damped-by-default spring. */
export interface SpringConfig {
  /** Angular frequency ω (rad/s). Higher = snappier. */
  stiffness?: number
  /**
   * Damping ratio ζ.
   * < 1 → bouncy, 1 → critical (no overshoot), > 1 → sluggish.
   */
  damping?: number
  /**
   * Disable the at-rest snap. Default `false`.
   *
   * The snap exists to stop denormal churn once a spring has settled, but it
   * also destroys the ability to OSCILLATE THROUGH rest: a spring that reaches
   * zero with small velocity is pinned there instead of continuing into the
   * negative half of its swing. Any spring whose overshoot is the point (a
   * recoil, a bounce) must opt out.
   */
  allowOvershootPastRest?: boolean
}

/**
 * Advance a spring one step toward `target` using semi-implicit Euler with a
 * closed-form critically-damped solution fallback for large time steps.
 *
 * This is real Hooke's-law dynamics (F = -k·x − c·v) rather than a linear lerp,
 * which is what gives interaction its weight and settle.
 *
 * Mutates `spring` in place and returns its new value.
 */
export function stepSpring(
  spring: Spring1D,
  target: number,
  dt: number,
  config: SpringConfig = {},
): number {
  const stiffness = config.stiffness ?? 170
  const dampingRatio = config.damping ?? 1

  // Clamp the step: a background tab can hand us a huge dt and blow the spring up.
  const step = clamp(safeNumber(dt, 1 / 60), 0, 0.064)

  // Damping coefficient c = 2ζ√k  (unit mass), so ζ = 1 is critical damping.
  const damping = 2 * dampingRatio * Math.sqrt(stiffness)

  const displacement = spring.value - target
  const acceleration = -stiffness * displacement - damping * spring.velocity

  spring.velocity += acceleration * step
  spring.value += spring.velocity * step

  // Snap tiny residual motion to rest to avoid endless denormal churn.
  // Skipped when the caller needs the spring to carry on past rest — see
  // `SpringConfig.allowOvershootPastRest`.
  if (
    !config.allowOvershootPastRest &&
    Math.abs(spring.velocity) < 1e-4 &&
    Math.abs(spring.value - target) < 1e-4
  ) {
    spring.value = target
    spring.velocity = 0
  }

  return spring.value
}

/** Reset a spring instantly (e.g. on teardown or a hard jump). */
export function resetSpring(spring: Spring1D, value: number): void {
  spring.value = value
  spring.velocity = 0
}

/**
 * Cubic bezier eased 0→1 progress, matching CSS `cubic-bezier(x1,y1,x2,y2)`.
 * Used for UI entrance choreography where a pure spring is overkill.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const sampleCurveX = (t: number) =>
    3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
  const sampleCurveY = (t: number) =>
    3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
  const sampleCurveDerivativeX = (t: number) =>
    3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2)

  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // Newton–Raphson, then bisection fallback for monotonic safety.
    let t = x
    for (let i = 0; i < 8; i++) {
      const dx = sampleCurveX(t) - x
      if (Math.abs(dx) < 1e-6) return sampleCurveY(t)
      const derivative = sampleCurveDerivativeX(t)
      if (Math.abs(derivative) < 1e-6) break
      t -= dx / derivative
    }
    let low = 0
    let high = 1
    t = x
    for (let i = 0; i < 20; i++) {
      const currentX = sampleCurveX(t)
      if (Math.abs(currentX - x) < 1e-6) break
      if (currentX > x) high = t
      else low = t
      t = (low + high) / 2
    }
    return sampleCurveY(t)
  }
}
