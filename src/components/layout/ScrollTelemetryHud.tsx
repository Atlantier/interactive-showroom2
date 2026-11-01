import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { getTransient } from '@/store/useAppStore'
import { cn } from '@/lib/cn'
import { onScrollFrame } from '@/lib/scrollEngine'
import { StatusDot } from '@/components/ui/primitives'

/**
 * Bottom-left HUD: a live readout of the transient scroll/mouse values.
 *
 * This is the visual proof that the transient store works as designed — the
 * numbers change every frame while React renders nothing. Each value is written
 * directly to a DOM node inside the scroll-engine callback.
 */
export function ScrollTelemetryHud() {
  const fpsMonitorEnabled = useAppStore((state) => state.fpsMonitorEnabled)
  const progressRef = useRef<HTMLSpanElement>(null)
  const velocityRef = useRef<HTMLSpanElement>(null)
  const mouseRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!fpsMonitorEnabled) return

    let raf = 0
    let frame = 0

    const unsubscribe = onScrollFrame(({ progress, velocity }) => {
      // Throttle DOM text writes to ~10 Hz — reading is cheap, layout is not.
      if (frame++ % 6 !== 0) return

      if (progressRef.current) {
        progressRef.current.textContent = progress.toFixed(4)
      }
      if (velocityRef.current) {
        velocityRef.current.textContent = velocity.toFixed(3)
      }
    })

    const readMouse = () => {
      const { mouse } = getTransient()
      if (mouseRef.current) {
        mouseRef.current.textContent = `${mouse.x.toFixed(2)} / ${mouse.y.toFixed(2)}`
      }
      raf = requestAnimationFrame(readMouse)
    }
    raf = requestAnimationFrame(readMouse)

    return () => {
      unsubscribe()
      cancelAnimationFrame(raf)
    }
  }, [fpsMonitorEnabled])

  return (
    <div
      className={cn(
        'pointer-events-none fixed bottom-5 left-5 z-80 hidden transition-opacity duration-300 md:block',
        fpsMonitorEnabled ? 'opacity-100' : 'opacity-0',
      )}
      aria-hidden={!fpsMonitorEnabled}
    >
      <dl className="space-y-1 rounded-lg border border-void-600/60 bg-void-950/88 px-3 py-2 font-mono text-[0.62rem] tracking-wider text-ink-500">
        <div className="flex items-center gap-2">
          <StatusDot tone="cyan" />
          <dt className="uppercase">transient</dt>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 text-ink-700">p</dt>
          <dd className="tabular-nums text-signal-teal">
            <span ref={progressRef}>0.0000</span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 text-ink-700">v_scroll</dt>
          <dd className="tabular-nums text-signal-violet">
            <span ref={velocityRef}>0.000</span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 text-ink-700">mouse</dt>
          <dd className="tabular-nums text-ink-300">
            <span ref={mouseRef}>0.00 / 0.00</span>
          </dd>
        </div>
      </dl>
    </div>
  )
}
