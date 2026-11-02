import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * ClickRipple — the site's entire click feedback.
 *
 * ── What this replaced, and why ─────────────────────────────────────────────
 * Clicking used to fire a 150-spark sphere burst, an expanding holographic ring
 * AND a bright flash, all at once, from the WebGL stardust layer. On a dark page
 * that read as a game effect: the eye landed on the effect rather than on the
 * thing that had just been clicked. This is the Material-style alternative — one
 * thin ring, nothing else.
 *
 * ── The restraint rules this file encodes ───────────────────────────────────
 *   ONE AT A TIME   a new click cancels the running animation and replaces it, so
 *                   rapid clicking can never stack rings.
 *   ONE PIXEL       the stroke is 1px; no glow, no shadow, no second ring.
 *   BOUNDED SIZE    the final radius is capped at 1.2x the clicked element's
 *                   short side, so the feedback never balloons past the control
 *                   it belongs to.
 *   MUTED COLOUR    a desaturated reading of the signal cyan (about 45% less
 *                   saturated, and darker), never pure cyan and never white.
 *   LOW PEAK ALPHA  0.25 at the start, gone by 420ms.
 *   EASED           `cubic-bezier(0.22, 1, 0.36, 1)` — fast out, slow settle. No
 *                   linear motion anywhere.
 *   REDUCED MOTION  nothing is created at all.
 *
 * ── Why the Web Animations API ──────────────────────────────────────────────
 * The ripple has to be positioned at an arbitrary click point, so it cannot be
 * a CSS-only pseudo-element on the target. WAAPI animates it without touching
 * the element's inline styles or its layout, and `anim.cancel()` in the effect
 * cleanup guarantees exactly one live animation even under rapid clicking.
 */

/** Total lifetime, inside the 350-450ms window. */
const DURATION = 420

/**
 * Desaturated signal cyan: 34,211,238 pulled roughly 45% toward its own
 * luminance and darkened. Still recognisably the site's accent, deliberately not
 * the pure #22d3ee that made the old effect shout.
 */
const RIPPLE_RGB = '111, 158, 168'

/** Peak opacity. */
const PEAK_ALPHA = 0.25

/** Hard cap on the final radius, in px, so a huge target cannot fill the page. */
const MAX_RADIUS = 260

/** Radius used when the event target has no measurable box. */
const FALLBACK_RADIUS = 90

/** Whether the user has asked for reduced motion. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface RippleState {
  /** Monotonic id; a new click replaces the previous ripple. */
  key: number
  x: number
  y: number
  /** Final diameter, in px. */
  diameter: number
}

export function ClickRipple() {
  const nodeRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const [ripple, setRipple] = useState<RippleState | null>(null)

  const onPointerDown = useCallback((event: PointerEvent) => {
    // Left button only.
    if (event.button !== 0) return
    if (prefersReducedMotion()) return

    const target = event.target as HTMLElement | null
    const rect = target?.getBoundingClientRect()
    const shortSide = rect ? Math.min(rect.width, rect.height) : 0

    /*
     * The upper bound from the brief is 1.2x the element's short side. A target
     * with no box (a text node's parent, a zero-size hit area) falls back to a
     * fixed small radius rather than producing a degenerate circle.
     */
    const radius = shortSide > 0 ? Math.min(shortSide * 1.2, MAX_RADIUS) : FALLBACK_RADIUS

    seq.current += 1
    setRipple({
      key: seq.current,
      x: event.clientX,
      y: event.clientY,
      diameter: radius * 2,
    })
  }, [])

  useEffect(() => {
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [onPointerDown])

  /* Drive the animation for the current ripple only. */
  useEffect(() => {
    const node = nodeRef.current
    if (!node || !ripple) return

    const key = ripple.key
    const animation = node.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.18)', opacity: PEAK_ALPHA },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
      ],
      {
        duration: DURATION,
        // Fast out, slow settle. The brief forbids linear motion outright.
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
      },
    )

    animation.onfinish = () => {
      // Only clear if no newer click has taken over; otherwise the newer ripple
      // would be unmounted by the older animation's completion.
      setRipple((current) => (current && current.key === key ? null : current))
    }

    return () => {
      animation.onfinish = null
      animation.cancel()
    }
  }, [ripple])

  if (!ripple) return null

  return (
    <div
      ref={nodeRef}
      aria-hidden
      style={{
        position: 'fixed',
        left: ripple.x,
        top: ripple.y,
        width: ripple.diameter,
        height: ripple.diameter,
        border: `1px solid rgb(${RIPPLE_RGB})`,
        borderRadius: '50%',
        pointerEvents: 'none',
        // Above page content, below the command palette and toasts.
        zIndex: 60,
        opacity: PEAK_ALPHA,
        transform: 'translate(-50%, -50%) scale(0.18)',
        willChange: 'transform, opacity',
      }}
    />
  )
}

export default ClickRipple
