/**
 * Bridge to React Three Fiber's global `advance()`.
 *
 * The app runs exactly ONE animation clock: the Lenis loop in
 * `src/lib/scrollEngine.ts`. Each frame it calls `advanceR3F(rAF-timestamp)` so
 * WebGL renders with the very same tick that moved the page — the DOM scroll and
 * the 3D camera can never drift apart by a frame.
 *
 * The R3F runtime is imported dynamically: the HTML shell must paint before the
 * ~700 kB three.js graph is parsed, and a WebGL-less environment must still be
 * able to run the DOM experience.
 */
type AdvanceFn = (timestampSeconds: number) => void

let advanceFn: AdvanceFn | null = null
let loading: Promise<void> | null = null

/**
 * Number of mounted canvases.
 *
 * This MUST be a count, not a boolean. The app has a global background canvas
 * plus a per-section canvas for the architecture narrative, and R3F's `advance()`
 * drives every root at once. With a boolean, unmounting either canvas would
 * clear the flag and freeze the other one mid-scene — the background nebula
 * would silently stop while the architecture model kept working.
 */
let activeCanvases = 0

/**
 * Monotonic origin. R3F's `frameloop="never"` path computes
 * `delta = timestamp - clock.elapsedTime`, so the first call must be ~0 or the
 * scene receives a delta equal to the entire page uptime and visually jumps.
 */
let originMs: number | null = null

/** The last timestamp handed to R3F, in seconds since the clock origin. */
let lastSeconds = 0

/** Largest delta we will ever hand to R3F, in seconds (tab was backgrounded). */
const MAX_DELTA_SECONDS = 0.1

/** Begin loading the fiber runtime. Safe to call repeatedly. */
export function preloadR3FAdvance(): void {
  if (advanceFn || loading) return
  loading = import('@react-three/fiber')
    .then((mod) => {
      advanceFn = (timestampSeconds: number) => {
        // `runGlobalEffects` stays on: R3F's before/after effect flush is what
        // lets drei helpers (AdaptiveDpr, Preload, …) work in manual mode.
        mod.advance(timestampSeconds, true)
      }
    })
    .catch(() => {
      // No WebGL / blocked chunk: the DOM experience still runs perfectly.
      advanceFn = null
    })
}

/**
 * Register or release one canvas. Must be called in matched pairs — once from
 * each Canvas `onCreated`, and once from its unmount cleanup.
 *
 * @param active - `true` when a canvas mounts, `false` when it unmounts.
 */
export function setCanvasActive(active: boolean): void {
  if (active) {
    activeCanvases += 1
    // A newly mounted canvas must not inherit another canvas' clock origin.
    // Resetting here means the first delta after a mount is ~0 for every root.
    originMs = null
    lastSeconds = 0
  } else {
    // Never go negative: a double-unmount (StrictMode) would otherwise leave the
    // counter permanently below zero and freeze every future canvas.
    activeCanvases = Math.max(0, activeCanvases - 1)
  }
}

/** How many canvases are currently registered (diagnostics / tests). */
export function getActiveCanvasCount(): number {
  return activeCanvases
}

/**
 * Advance the whole R3F graph by one frame using the master clock timestamp.
 * No-ops until at least one canvas is mounted and the runtime has loaded.
 *
 * @param timestampMs - `requestAnimationFrame` timestamp in milliseconds.
 */
export function advanceR3F(timestampMs: number): void {
  if (activeCanvases <= 0 || !advanceFn) return

  if (originMs === null) {
    originMs = timestampMs
  }

  // Convert to seconds (three.js convention) and clamp the step so a long
  // suspension does not teleport every interpolated object in the scene.
  const elapsed = Math.max(0, (timestampMs - originMs) / 1000)
  const last = lastSeconds
  const clamped = Math.min(elapsed, last + MAX_DELTA_SECONDS)
  lastSeconds = clamped

  advanceFn(clamped)
}

/** Reset internal clock bookkeeping. Exposed for tests / hot reload. */
export function resetFrameBridge(): void {
  originMs = null
  lastSeconds = 0
  activeCanvases = 0
}
