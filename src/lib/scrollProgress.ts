/**
 * Scroll progress, with Lenis's zero-limit edge case handled.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * Lenis reports `progress === 1` when the document has nothing to scroll (`limit === 0`), not 0.
 * That is defensible in isolation -- there is no scrollable distance, so "the whole thing" is
 * visible -- but this app feeds `progress` to a scroll-driven camera, layer separation and the
 * progress rails, all of which read 1 as "the visitor has scrolled to the end".
 *
 * The result is a short page (or a long page measured before its content has laid out, which is
 * the first frame or two of every load) starting with the camera parked at the end of its path and
 * then easing backwards. Zero scrollable distance should mean zero progress.
 *
 * Kept as its own module so it can be tested without pulling in Lenis, the store or the DOM.
 */
export function resolveProgress(rawProgress: number, limit: number): number {
  // `Number.isFinite` rather than a truthiness check: NaN must not become "no limit".
  if (!Number.isFinite(limit) || limit <= 0) return 0
  if (!Number.isFinite(rawProgress)) return 0
  return Math.min(1, Math.max(0, rawProgress))
}
