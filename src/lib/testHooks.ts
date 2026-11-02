/**
 * A test seam for the visual regression gate.
 *
 * ── Why production code has a testing flag in it ────────────────────────────
 * `scripts/verify-visual.mjs` compares screenshots of the built output, and this page is
 * never still: 8000 nebula particles, a plasma core, choreographed camera easing and seven
 * animated canvases. Two captures of the same scroll position differ by 60-120 levels in
 * the worst blocks, which makes a pixel gate impossible — the first version of the gate
 * failed on unchanged code for exactly that reason.
 *
 * The alternative to a seam is a gate nobody trusts, so the app exposes one tiny, read-only
 * flag: when `window.__still` is true, animation clocks stop advancing and the last rendered
 * frame stays on the canvas. Nothing else changes — layout, styles, focus, scroll position
 * and every DOM node are untouched, so a screenshot still describes the real page.
 *
 * It is not a user-facing feature and it cannot be enabled by accident: it is only ever set
 * by the test script after navigation, and reading it costs one property lookup per frame.
 * A production visitor never sets it, so every call below returns false.
 */

/** The window flag, declared once so the reads are typed rather than cast everywhere. */
declare global {
  interface Window {
    /** Set only by `scripts/verify-visual.mjs`. Freezes animation clocks. */
    __still?: boolean
    /** Set only by `scripts/verify-visual.mjs`. Pins the R3F clock to this many seconds. */
    __stillAt?: number
  }
}

/**
 * True when the visual gate has frozen the page.
 *
 * Call this at the top of any loop that advances a clock or mutates simulated state: if it
 * returns true, keep the last frame and skip the work.
 */
export function isStill(): boolean {
  return typeof window !== 'undefined' && window.__still === true
}

/**
 * A fixed clock value, in seconds, or null.
 *
 * Freezing the animation is not enough to make two runs comparable: the frame you freeze on
 * is whatever phase the animation happened to be in, so the first version of the gate still
 * differed by 100-240 levels between runs. Pinning the clock to a constant means every
 * time-driven shader evaluates the same phase on every run, which is what makes the
 * comparison mean something.
 */
export function stillClock(): number | null {
  if (typeof window === 'undefined') return null
  const value = window.__stillAt
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
