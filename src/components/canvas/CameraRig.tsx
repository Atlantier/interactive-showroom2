import { useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { createSpring, stepSpring } from '@/lib/math'
import { getTransient, useAppStore } from '@/store/useAppStore'

/**
 * CameraRig — scroll- and pointer-driven cinematic camera.
 *
 * Performance contract (AGENTS.md rule 3):
 *   • zero `useState` / `setState` inside the frame loop;
 *   • zero allocations per frame — every Vector3, spring and scalar is
 *     pre-allocated with `useMemo` / module scope;
 *   • motion is a critically damped Hooke spring, never a linear lerp.
 *
 * The rig reads the *transient* store directly, so moving the mouse or
 * scrolling never re-renders a single React component.
 *
 * ── Resize correctness ─────────────────────────────────────────────────────
 * Two things must stay in lockstep with the canvas box, and this component is
 * the one that can break both:
 *
 *  1. `camera.aspect` must equal the canvas' real aspect ratio. R3F updates this
 *     itself on resize, but only if the camera is the default one and nothing
 *     else has taken ownership of the projection. We therefore never touch
 *     `aspect` ourselves — we only verify it, and re-sync defensively if a
 *     resize slipped past (e.g. a container-size change that did not fire a
 *     window resize event).
 *
 *  2. `camera.updateProjectionMatrix()` must be called after any aspect change,
 *     or the raycaster (which reads `projectionMatrixInverse`) keeps using stale
 *     values and the cursor/plane alignment drifts — the exact symptom reported.
 *
 * Keeping both checks here means the raycaster in `FlowFieldParticles` always
 * sees a current frustum, without that component needing to know about resize.
 */

/** Resting camera placement. */
const BASE_POSITION = { x: 0, y: 0, z: 6 }

/** Travel ranges for a full mouse deflection / scroll. */
const MOUSE_TRAVEL_X = 0.55
const MOUSE_TRAVEL_Y = 0.32
const SCROLL_TRAVEL_Z = 1.1
const SCROLL_TRAVEL_Y = -0.45

/** Spring feel: soft and heavy, critically damped (ζ = 1), no overshoot. */
const SPRING = { stiffness: 46, damping: 1 } as const

/** Aspect drift beyond this is treated as a missed resize. */
const ASPECT_EPSILON = 1e-3

export function CameraRig() {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)

  // Pre-allocated, reused every single frame — never recreated in the loop.
  const lookAt = useMemo(() => new THREE.Vector3(0, 0, 0), [])
  const springs = useMemo(
    () => ({
      x: createSpring(BASE_POSITION.x),
      y: createSpring(BASE_POSITION.y),
      z: createSpring(BASE_POSITION.z),
    }),
    [],
  )

  /*
   * Read reactively, not inside `useFrame`.
   *
   * The preference changes at most a few times per session, so a re-render is free --
   * and reading it here keeps the per-frame path free of store lookups.
   */
  const reducedMotion = useAppStore((state) => state.reducedMotion)

  useFrame((_, rawDelta) => {
    // Defensive clamp: a backgrounded tab must never teleport the camera.
    const dt = Math.min(rawDelta, 1 / 20)
    if (!(dt > 0)) return

    /* ── Frustum integrity check ─────────────────────────────────────────
     * `size` is R3F's live canvas size in CSS pixels. If it disagrees with the
     * camera's aspect, the projection matrix is stale and every raycast from
     * `setFromCamera` is skewed. Detecting it here (cheap: two numbers) keeps
     * the fix local and also covers container resizes that never fired a window
     * `resize` event.
     *
     * Guarded on `isPerspectiveCamera` because an orthographic camera has no
     * meaningful `aspect`.
     */
    if (size.width > 0 && size.height > 0 && 'aspect' in camera) {
      const perspective = camera as THREE.PerspectiveCamera
      const expected = size.width / size.height
      if (Math.abs(perspective.aspect - expected) > ASPECT_EPSILON) {
        perspective.aspect = expected
        perspective.updateProjectionMatrix()
      }
    }

    const { mouse, scroll } = getTransient()
    const progress = scroll.progress

    /*
     * Reduced motion: no pointer parallax and no aim offset.
     *
     * Scroll still drives the dolly (it is the page's own motion, and the chapters are
     * authored around it), but the camera stops chasing the cursor -- which is the part
     * that produces vestibular discomfort. The springs keep easing toward the unmodified
     * target, so the change is a glide rather than a snap.
     */
    const sway = reducedMotion ? 0 : 1

    // Smoothed target for each axis.
    const targetX = BASE_POSITION.x + mouse.x * MOUSE_TRAVEL_X * sway
    const targetY = BASE_POSITION.y + mouse.y * MOUSE_TRAVEL_Y * sway + progress * SCROLL_TRAVEL_Y
    const targetZ = BASE_POSITION.z - progress * SCROLL_TRAVEL_Z

    stepSpring(springs.x, targetX, dt, SPRING)
    stepSpring(springs.y, targetY, dt, SPRING)
    stepSpring(springs.z, targetZ, dt, SPRING)

    camera.position.set(springs.x.value, springs.y.value, springs.z.value)

    // Gentle aim offset so the scene parallaxes instead of feeling locked.
    lookAt.set(mouse.x * 0.18 * sway, mouse.y * 0.14 * sway, 0)
    camera.lookAt(lookAt)
  })

  return null
}

export default CameraRig
