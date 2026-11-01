/**
 * Shared domain types for the showroom foundation.
 * Kept dependency-free so any module (store / lib / components) can import them
 * without creating circular references.
 */

/** Rendering budget tier, auto-detected on boot and adjustable at runtime. */
export type PerformanceTier = 'high' | 'medium'

/**
 * Mouse state written on every pointermove.
 * - `x` / `y`  : normalized viewport coordinates, origin at the viewport center,
 *                both in [-1, 1]. `y` is flipped so +1 points "up".
 * - `px` / `py`: raw pixel coordinates from the browser event.
 * - `active`   : whether a pointer is genuinely over the viewport. Consumers
 *                that project the cursor into 3D (raycasting) must check this,
 *                otherwise a reset coordinate of (0,0) would be indistinguishable
 *                from a cursor resting exactly at the screen centre.
 */
export interface MouseState {
  x: number
  y: number
  px: number
  py: number
  active: boolean
}

/**
 * Scroll state written once per animation frame.
 * - `progress`: smoothed global scroll progress, in [0, 1].
 * - `velocity`: scroll progress change per second (0 at rest, ±3 is fast).
 */
export interface ScrollState {
  progress: number
  velocity: number
}

/**
 * High-frequency state deliberately kept OUTSIDE React's render cycle:
 * one stable object, mutated in place, read by R3F's `useFrame` and DOM
 * animation loops. Never replace this object — only mutate its fields.
 */
export interface TransientState {
  mouse: MouseState
  scroll: ScrollState
}
