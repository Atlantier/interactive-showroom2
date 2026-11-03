import type { PerformanceTier } from '@/types'

/**
 * Detect a sensible rendering budget once, on boot.
 * The result only seeds the store; the user (or AdaptiveDpr/FPS data later)
 * can switch tiers at runtime from the navbar.
 */
export function detectPerformanceTier(): PerformanceTier {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'high'

  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency ?? 4
  const memory = nav.deviceMemory ?? 8
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reducedMotion) return 'medium'
  if (cores <= 4 || memory <= 4) return 'medium'
  if (coarsePointer && cores <= 6) return 'medium'

  return 'high'
}

/**
 * Cached WebGL2 probe.
 *
 * ── Why cached ──────────────────────────────────────────────────────────────
 * This was called from three places, and `App` called it during *render* — so every
 * re-render of the shell created another `<canvas>` plus a real GL context. Browsers
 * cap live contexts at 8–16 and then start killing the oldest, and this app needs
 * two of them for its own canvases. That made the probe itself a way to lose the
 * rendering contexts it was testing for.
 *
 * ── Why WebGL2 only ─────────────────────────────────────────────────────────
 * three.js r186 dropped WebGL1 support entirely. Accepting a `webgl` context here
 * meant old hardware passed the check, mounted the canvases, and then rendered
 * nothing — a silent white/black page instead of the no-WebGL fallback.
 *
 * ── Why the context is released ─────────────────────────────────────────────
 * Even one leaked probe context is one of the eight. `WEBGL_lose_context` hands it
 * back immediately.
 */
let webglSupport: boolean | null = null

export function supportsWebGL(): boolean {
  if (webglSupport !== null) return webglSupport
  if (typeof window === 'undefined') return false

  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      webglSupport = false
      return false
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    webglSupport = true
  } catch {
    webglSupport = false
  }

  return webglSupport
}

/**
 * Clear the cached probe result.
 *
 * Only useful for tests and for a context-loss recovery path that wants to re-check
 * hardware after a driver reset.
 */
export function resetWebglSupport(): void {
  webglSupport = null
}

/**
 * Whether the visitor asked for reduced motion.
 *
 * Read on demand rather than cached: the preference can change mid-session (macOS
 * has a menu-bar toggle), and the consumers that care re-evaluate per frame or per
 * subscription anyway.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Subscribe to reduced-motion changes.
 *
 * The CSS side is handled by a media query in `index.css`; this exists for the 3D
 * consumers, which no media query can reach. Returns a disposer.
 */
export function onReducedMotionChange(handler: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  const listener = (event: MediaQueryListEvent): void => handler(event.matches)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/**
 * Canvas backing-store ratio for a quality tier.
 *
 * The 2D sandboxes size their own buffers (`devicePixelRatio` clamps), which is why they used to
 * ignore the adaptive downgrade entirely: the renderer dropped to DPR 1 while the two heaviest
 * canvases on the page kept filling 1.5x. One helper, used by both, so the policy cannot drift
 * between them.
 */
export function dprForTier(tier: PerformanceTier): number {
  // 'medium' is the downgraded state (`PerformanceTier` is 'high' | 'medium'; `low` never existed
  // and typing it here only produced a comparison TypeScript could prove impossible).
  return tier === 'medium' ? 1 : 1.5
}
