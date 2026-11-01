import { writePointer, resetMouseTransient } from '@/store/useAppStore'

/**
 * Pointer / touch input → transient store.
 *
 * Why a dedicated module instead of a few listeners in `SmoothScroll`:
 * touch input needs three coordinated behaviours (first contact, movement,
 * release) and two different event families, and getting the combination wrong
 * is invisible on desktop but shows up as stuck parallax on phones.
 *
 * ── Why BOTH pointer events and touch events ────────────────────────────────
 * `pointermove` covers mouse, pen and touch in one handler and is the modern
 * path. But on iOS, as soon as native scrolling starts the browser fires
 * `pointercancel` and stops emitting `pointermove` — while `touchmove` keeps
 * coming. So a pointer-only implementation freezes the parallax the moment the
 * user starts swiping, which is exactly when it matters.
 *
 * Both handlers therefore stay attached; duplicated coordinates are discarded
 * by a cheap last-point check, so the store is written at most once per
 * distinct finger/mouse position.
 *
 * ── Why no smoothing here ───────────────────────────────────────────────────
 * Events can arrive slower than the display refresh (especially `touchmove`),
 * but the consumer already applies a critically damped spring
 * (`CameraRig` / `CoreObject`). Smoothing the raw input on top of that would
 * only add latency and fight the spring. This module's job is to publish the
 * most recent true position as cheaply as possible.
 */

/** Ignore writes that land on essentially the same point as the last one. */
const EPSILON = 0.35

export interface PointerInputOptions {
  /** Called after every accepted pointer update (optional telemetry hook). */
  onChange?: (normalizedX: number, normalizedY: number) => void
}

/**
 * Attach mouse, pen and touch listeners to `window`.
 * Returns a disposer that removes every listener it added.
 *
 * All listeners are `passive`: input must never be able to block scrolling.
 */
export function attachPointerInput(options: PointerInputOptions = {}): () => void {
  const { onChange } = options

  let lastX = Number.NaN
  let lastY = Number.NaN

  /** Publish a viewport position, skipping duplicate consecutive points. */
  const push = (clientX: number, clientY: number): void => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return
    if (Math.abs(clientX - lastX) < EPSILON && Math.abs(clientY - lastY) < EPSILON) return

    lastX = clientX
    lastY = clientY
    writePointer(clientX, clientY)

    if (onChange) {
      onChange(
        (clientX / (window.innerWidth || 1)) * 2 - 1,
        -((clientY / (window.innerHeight || 1)) * 2 - 1),
      )
    }
  }

  /** Relax to center and forget the last point (so the next touch always writes). */
  const release = (): void => {
    lastX = Number.NaN
    lastY = Number.NaN
    resetMouseTransient()
  }

  /* ── Pointer events: mouse / pen / touch ─────────────────────────────── */
  const onPointerMove = (event: PointerEvent): void => {
    // Touch is also handled below; letting it through here is harmless because
    // `push` dedupes identical coordinates.
    push(event.clientX, event.clientY)
  }

  const onPointerDown = (event: PointerEvent): void => {
    push(event.clientX, event.clientY)
  }

  /* ── Touch events: iOS keeps these alive during native scrolling ──────── */
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0]
    if (touch) push(touch.clientX, touch.clientY)
  }

  const onTouchMove = (event: TouchEvent): void => {
    // A multi-touch gesture (pinch) should not drive parallax — that would make
    // the scene jitter between two fingers.
    if (event.touches.length > 1) return
    const touch = event.touches[0]
    if (touch) push(touch.clientX, touch.clientY)
  }

  const onTouchEnd = (event: TouchEvent): void => {
    // Only relax once the LAST finger is gone.
    if (event.touches.length === 0) release()
  }

  const onTouchCancel = (): void => {
    release()
  }

  /* ── Mouse leaving the viewport should relax the scene ────────────────── */
  const onPointerLeave = (event: PointerEvent): void => {
    // Touch fires pointerleave when the finger lifts; `onTouchEnd` handles that.
    if (event.pointerType === 'mouse') release()
  }

  const onWindowBlur = (): void => {
    release()
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('touchstart', onTouchStart, { passive: true })
  window.addEventListener('touchmove', onTouchMove, { passive: true })
  window.addEventListener('touchend', onTouchEnd, { passive: true })
  window.addEventListener('touchcancel', onTouchCancel, { passive: true })
  document.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('blur', onWindowBlur)

  return () => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('touchstart', onTouchStart)
    window.removeEventListener('touchmove', onTouchMove)
    window.removeEventListener('touchend', onTouchEnd)
    window.removeEventListener('touchcancel', onTouchCancel)
    document.removeEventListener('pointerleave', onPointerLeave)
    window.removeEventListener('blur', onWindowBlur)
    release()
  }
}
