import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { InViewRef } from '@/hooks/useInViewAnimation'
import { setCanvasSleeping } from '@/lib/perfMetrics'

/**
 * RenderGate — stops an R3F canvas from submitting GPU work while off screen.
 *
 * ── Why `internal.priority` and not `internal.active` or `frameloop` ──────
 * This app advances R3F manually: `frameloop="never"` plus a single call to
 * `advance()` per frame from the Lenis clock. Reading R3F's source, the relevant
 * function in that path is `update()`, and it renders UNCONDITIONALLY:
 *
 *     subscribers.forEach(...)                       // every useFrame
 *     if (!state.internal.priority && state.gl.render)
 *       state.gl.render(state.scene, state.camera)   // ← no other guard
 *
 * So neither `internal.active` nor `frameloop: 'demand'` suppresses the draw:
 * both are only consulted by R3F's own `loop()`, which `frameloop="never"`
 * disables. The lone lever is `internal.priority`.
 *
 * Setting it non-zero is exactly the documented "I will drive the render myself"
 * signal — we simply choose to drive it to nothing while the canvas is hidden.
 *
 * ── Waking is seamless ───────────────────────────────────────────────────
 * `update()` runs subscribers BEFORE the render check, so on the first frame
 * back in view this gate has already cleared the priority by the time the check
 * happens — the canvas repaints on that very frame, with no stale flash.
 *
 * Note the subscribers keep running while asleep, which is why every rig in this
 * app also early-returns on the same flag: priority skips the GPU work, the
 * early-return skips the CPU work.
 */
export function RenderGate({ inViewRef }: { inViewRef: InViewRef }) {
  const get = useThree((state) => state.get)

  /** Last state we published to the metrics registry, so we only report edges. */
  const reported = useRef<boolean | null>(null)

  /** Reused DEV probe object, so the frame loop allocates nothing. */
  const devState = useRef<{
    paused: boolean
    inView: boolean
    priority: number
    frames: number
  } | null>(null)

  useFrame(() => {
    const state = get()
    const paused = !inViewRef.current
    const want = paused ? 1 : 0
    if (state.internal.priority !== want) {
      state.internal.priority = want
    }

    if (reported.current !== paused) {
      // Only count the transition, not every frame, or the registry would drift.
      if (reported.current !== null) setCanvasSleeping(paused)
      reported.current = paused
    }

    // Dev-only: expose the gate's decision so verification can tell "the gate is
    // not pausing" apart from "the gate pauses but something else still draws".
    // Only written on change — this runs inside the frame loop, and the project
    // rule is no per-frame allocation even for diagnostic objects.
    if (import.meta.env.DEV) {
      if (devState.current === null) devState.current = { paused, inView: false, priority: 0, frames: 0 }
      const probe = devState.current
      if (
        probe.paused !== paused ||
        probe.inView !== inViewRef.current ||
        probe.priority !== state.internal.priority
      ) {
        probe.paused = paused
        probe.inView = inViewRef.current
        probe.priority = state.internal.priority
        probe.frames = state.internal.frames
        const host = window as unknown as { __archScene?: Record<string, unknown> }
        if (host.__archScene) host.__archScene.gate = probe
      }
    }
  })

  useEffect(() => {
    return () => {
      // Never leave a root permanently un-rendered: an unmounting canvas that was
      // asleep would otherwise hand a priority > 0 back to R3F's store and the
      // next canvas to mount on that root would silently never draw.
      const state = get()
      state.internal.priority = 0
      if (reported.current === true) setCanvasSleeping(false)
      reported.current = null
    }
  }, [get])

  return null
}

export default RenderGate
