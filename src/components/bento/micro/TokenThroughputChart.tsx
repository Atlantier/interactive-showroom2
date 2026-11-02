import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'

import { useInViewAnimation } from '@/hooks/useInViewAnimation'
/**
 * TokenThroughputChart — a live sparkline of token throughput.
 *
 * ── Why canvas and not SVG ─────────────────────────────────────────────────
 * The chart redraws ~8×/s forever. With SVG that means rebuilding a `points`
 * string and re-parsing it every tick, plus a DOM node per marker. A single
 * `<canvas>` path redraw is one imperative call and leaves the DOM untouched.
 *
 * ── Why a ref-driven ring buffer ───────────────────────────────────────────
 * History lives in a pre-allocated `Float32Array` used as a ring buffer, so the
 * component produces no garbage per tick — the same discipline the WebGL scene
 * follows. React state is used ONLY for the current numeric readout, and that
 * updates 4×/s rather than every frame.
 *
 * The value itself is a deterministic pseudo-random walk (seeded xorshift), so
 * the chart looks alive without depending on `Math.random`, and it renders
 * identically across StrictMode remounts.
 */

/** Number of samples kept in the ring buffer. */
const HISTORY = 64

/** How often a new sample is taken, in ms. */
const SAMPLE_INTERVAL = 120

/** How often the numeric readout is pushed into React state, in ms. */
const READOUT_INTERVAL = 260

interface TokenThroughputChartProps {
  className?: string
  /** Baseline throughput in tokens/s that the walk oscillates around. */
  baseline?: number
}

export function TokenThroughputChart({ className, baseline = 12_400 }: TokenThroughputChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const inViewRef = useInViewAnimation(wrapRef, { rootMargin: '120px 0px 120px 0px' })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bufferRef = useRef<Float32Array>(new Float32Array(HISTORY))
  const headRef = useRef(0)
  const seededRef = useRef(false)
  const [readout, setReadout] = useState(baseline)
  const [delta, setDelta] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const buffer = bufferRef.current

    /* ── Seed the history so the chart starts mid-flow, not empty ──────── */
    if (!seededRef.current) {
      seededRef.current = true
      let seed = 0x9e3779b9
      const rand = (): number => {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        seed >>>= 0
        return seed / 4294967296
      }
      let v = baseline
      for (let i = 0; i < HISTORY; i++) {
        v = Math.max(
          baseline * 0.55,
          Math.min(baseline * 1.35, v + (rand() - 0.5) * baseline * 0.16),
        )
        buffer[i] = v
      }
      headRef.current = 0
    }

    let rafId = 0
    let lastSample = 0
    let lastReadout = 0
    let running = true

    const draw = (): void => {
      // Match the backing store to the CSS box; done every frame because the
      // card can be resized by the grid, and it is a cheap no-op when unchanged.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Find the visible range so the line fills the box vertically.
      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < HISTORY; i++) {
        const v = buffer[i]
        if (v < min) min = v
        if (v > max) max = v
      }
      const span = max - min || 1
      // Pad the range so the line never touches the edges.
      const pad = canvas.height * 0.18
      const usableH = canvas.height - pad * 2
      const stepX = canvas.width / (HISTORY - 1)

      // ── Area fill under the line ───────────────────────────────────────
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
      gradient.addColorStop(0, 'rgba(16, 185, 129, 0.30)')
      gradient.addColorStop(0.6, 'rgba(16, 185, 129, 0.06)')
      gradient.addColorStop(1, 'rgba(16, 185, 129, 0)')

      ctx.beginPath()
      ctx.moveTo(0, canvas.height)
      for (let i = 0; i < HISTORY; i++) {
        const value = buffer[i]
        const x = i * stepX
        const y = pad + usableH * (1 - (value - min) / span)
        ctx.lineTo(x, y)
      }
      ctx.lineTo(canvas.width, canvas.height)
      ctx.closePath()
      ctx.fillStyle = gradient
      ctx.fill()

      // ── The line itself ────────────────────────────────────────────────
      ctx.beginPath()
      for (let i = 0; i < HISTORY; i++) {
        const value = buffer[i]
        const x = i * stepX
        const y = pad + usableH * (1 - (value - min) / span)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.lineWidth = 1.6 * dpr
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.95)'
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()

      // ── Leading-edge dot ───────────────────────────────────────────────
      const lastIndex = HISTORY - 1
      const lastValue = buffer[lastIndex]
      const lastX = lastIndex * stepX
      const lastY = pad + usableH * (1 - (lastValue - min) / span)
      ctx.beginPath()
      ctx.arc(lastX, lastY, 2.4 * dpr, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(110, 231, 183, 1)'
      ctx.fill()
    }

    const tick = (now: number) => {
      if (!running) return
      rafId = requestAnimationFrame(tick)

      /*
       * Off-screen gate.
       *
       * This loop is a live data feed: it redraws a canvas and calls setState for
       * the readout twice a second. Both are wasted when the card is two screens
       * away, and the setState in particular re-renders the card subtree on the
       * main thread during whatever the visitor is actually scrolling to.
       */
      if (!inViewRef.current) return

      // Sample on a fixed cadence rather than every frame, so the walk speed is
      // independent of the display refresh rate.
      if (now - lastSample >= SAMPLE_INTERVAL) {
        lastSample = now

        const prev = buffer[HISTORY - 1]
        // Mean-reverting random walk: pulls toward the baseline so the chart
        // cannot drift off-screen over a long session.
        const reversion = (baseline - prev) * 0.14
        const noise = (Math.random() - 0.5) * baseline * 0.19
        const next = Math.max(baseline * 0.45, prev + reversion + noise)

        // Shift left by one, append at the end.
        buffer.copyWithin(0, 1)
        buffer[HISTORY - 1] = next
        headRef.current = (headRef.current + 1) % HISTORY

        draw()

        if (now - lastReadout >= READOUT_INTERVAL) {
          lastReadout = now
          setReadout(Math.round(next))
          setDelta(next - prev)
        }
      }
    }

    // First paint without waiting for the first interval.
    draw()
    rafId = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(rafId)
    }
  }, [baseline])

  const isUp = delta >= 0

  return (
    <div ref={wrapRef} className={cn('flex h-full flex-col', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[0.6rem] tracking-[0.2em] text-ink-700 uppercase">
          tokens / s
        </span>
        <span
          className={cn(
            'font-mono text-[0.6rem] tabular-nums',
            isUp ? 'text-signal-teal' : 'text-signal-rose',
          )}
        >
          {isUp ? '▲' : '▼'} {Math.abs(Math.round(delta))}
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-mono text-2xl tabular-nums text-ink-100">
          {readout.toLocaleString('en-US')}
        </span>
        <span className="font-mono text-[0.6rem] text-ink-700">tok/s</span>
      </div>

      <canvas ref={canvasRef} className="mt-3 min-h-0 w-full flex-1" aria-hidden />
    </div>
  )
}

export default TokenThroughputChart
