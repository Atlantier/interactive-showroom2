import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/store/useAppStore'
import { getActiveCanvasCount } from '@/lib/frameBridge'
import { useI18n } from '@/i18n/useI18n'
import { isVfxPreset, vfxLabelKey } from '@/lib/vfxPalette'
import {
  HEAP_HISTORY_SIZE,
  getActiveParticleCount,
  getShaderPassCount,
  performanceCounters,
  readHeapHistory,
  sampleHeap,
} from '@/lib/perfMetrics'

/**
 * PerfTelemetryHud — the developer performance overlay (Shift+D).
 *
 * ── Zero React renders ────────────────────────────────────────────────────
 * Every number here changes up to 60 times a second. The panel mounts once and
 * its loop writes `textContent` and `style` directly into refs, exactly like the
 * scroll HUD. Only two things ever re-render React: opening/closing the panel and
 * a change of tier.
 *
 * ── What is measured, and how ─────────────────────────────────────────────
 *   FPS / frame time   sampled in this panel's own rAF, so it reflects the
 *                      browser's compositor cadence rather than any one module.
 *   Particles          summed from every canvas that registers a count with
 *                      `lib/perfMetrics` (the nebula, and the stardust trail
 *                      once its canvas reports). The total is the app-wide live
 *                      count, not whichever producer ran last.
 *   Shader passes      published by `SceneCanvas`, which owns the
 *                      `EffectComposer`; it reads 0 until that composer mounts.
 *   VFX preset         the store's palette selection, read defensively: on a
 *                      build where the preset field does not exist yet the row
 *                      shows "—" instead of failing to type-check.
 *   Physics solve      reported by the Verlet sandbox, timed around the
 *                      constraint-relaxation batch — the part that actually
 *                      scales with iteration count.
 *   IK solve           reported by the FABRIK sandbox (arm chain or four legs).
 *   Heap curve         `performance.memory` where available, drawn as a
 *                      sparkline. Non-standard API: absent in Firefox/Safari, so
 *                      the panel shows "n/a" rather than a fake zero.
 */

/** Frame budget for 60 fps, in ms. Drives the budget bar's full scale. */
const FRAME_BUDGET_MS = 1000 / 60

/** How often the heap is sampled, in ms. Reading it is not free. */
const HEAP_SAMPLE_INTERVAL = 250

/** Sparkline dimensions, in CSS pixels. */
const SPARK_W = 216
const SPARK_H = 40

/** Shown for a reading whose source has not landed in this build yet. */
const NO_VALUE = '—'

/**
 * Optional view of the store's VFX palette preset.
 *
 * The preset field is owned by another module and may not exist on `AppState`
 * yet. Reading it through this shape keeps the HUD type-checking and rendering
 * (as a placeholder) both before and after that field lands, without weakening
 * the type of any other store access.
 */
interface MaybeVfxPreset {
  vfxPreset?: string
}

export function PerfTelemetryHud() {
  const { t } = useI18n()
  const open = useAppStore((state) => state.perfHudOpen)
  const setOpen = useAppStore((state) => state.setPerfHudOpen)
  const tier = useAppStore((state) => state.performanceTier)
  const vfxPreset = useAppStore((state) => (state as unknown as MaybeVfxPreset).vfxPreset)

  const fpsRef = useRef<HTMLSpanElement>(null)
  const frameMsRef = useRef<HTMLSpanElement>(null)
  const worstMsRef = useRef<HTMLSpanElement>(null)
  const particlesRef = useRef<HTMLSpanElement>(null)
  const shaderPassRef = useRef<HTMLSpanElement>(null)
  const solveRef = useRef<HTMLSpanElement>(null)
  const solveAvgRef = useRef<HTMLSpanElement>(null)
  const ikRef = useRef<HTMLSpanElement>(null)
  const heapRef = useRef<HTMLSpanElement>(null)
  const heapRangeRef = useRef<HTMLSpanElement>(null)
  const canvasCountRef = useRef<HTMLSpanElement>(null)
  const budgetBarRef = useRef<HTMLDivElement>(null)
  const sparkRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!open) return

    let raf = 0
    let frames = 0
    let worst = 0
    let windowStart = performance.now()
    let prevFrame = windowStart
    let lastHeapSample = 0

    // Reused across frames; the read fills at most HEAP_HISTORY_SIZE entries.
    const heapScratch = new Float32Array(HEAP_HISTORY_SIZE)

    const spark = sparkRef.current
    const ctx = spark ? spark.getContext('2d') : null
    if (spark && ctx) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      spark.width = Math.round(SPARK_W * dpr)
      spark.height = Math.round(SPARK_H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const drawSpark = (): void => {
      if (!ctx) return
      const count = readHeapHistory(heapScratch)
      ctx.clearRect(0, 0, SPARK_W, SPARK_H)

      // Baseline grid.
      ctx.strokeStyle = 'rgba(74, 86, 112, 0.35)'
      ctx.lineWidth = 1
      for (let i = 1; i < 3; i++) {
        const y = (SPARK_H / 3) * i
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(SPARK_W, y)
        ctx.stroke()
      }

      if (count < 2) return

      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < count; i++) {
        const v = heapScratch[i]
        if (v < min) min = v
        if (v > max) max = v
      }
      // A flat series would divide by zero; give it a nominal span so the line
      // draws through the middle instead of vanishing.
      const span = max - min < 0.5 ? 1 : max - min

      if (heapRangeRef.current) {
        heapRangeRef.current.textContent = `${min.toFixed(1)}–${max.toFixed(1)} MB`
      }

      const toX = (i: number): number => (i / (HEAP_HISTORY_SIZE - 1)) * SPARK_W
      const toY = (v: number): number => SPARK_H - ((v - min) / span) * (SPARK_H - 6) - 3

      // Filled area + stroke, so the curve reads at a glance.
      ctx.beginPath()
      ctx.moveTo(toX(0), SPARK_H)
      for (let i = 0; i < count; i++) ctx.lineTo(toX(i), toY(heapScratch[i]))
      ctx.lineTo(toX(count - 1), SPARK_H)
      ctx.closePath()
      ctx.fillStyle = 'rgba(34, 211, 238, 0.16)'
      ctx.fill()

      ctx.beginPath()
      for (let i = 0; i < count; i++) {
        const x = toX(i)
        const y = toY(heapScratch[i])
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = '#22d3ee'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Head marker.
      const headX = toX(count - 1)
      const headY = toY(heapScratch[count - 1])
      ctx.beginPath()
      ctx.arc(headX, headY, 2.2, 0, Math.PI * 2)
      ctx.fillStyle = '#a5f3fc'
      ctx.fill()
    }

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)

      const frameMs = now - prevFrame
      prevFrame = now
      frames += 1
      if (frameMs > worst) worst = frameMs

      // Heap sampling is throttled: `performance.memory` walks the heap metadata
      // and is measurably more expensive than reading the other counters.
      if (now - lastHeapSample > HEAP_SAMPLE_INTERVAL) {
        lastHeapSample = now
        sampleHeap()
      }

      const elapsed = now - windowStart
      if (elapsed >= 250 && frames > 0) {
        const fps = (frames * 1000) / elapsed
        const avgFrame = elapsed / frames

        if (fpsRef.current) fpsRef.current.textContent = fps.toFixed(1)
        if (frameMsRef.current) frameMsRef.current.textContent = avgFrame.toFixed(2)
        if (worstMsRef.current) worstMsRef.current.textContent = worst.toFixed(2)

        // Budget bar: full width at exactly 60 fps, overflowing past 2x budget.
        const bar = budgetBarRef.current
        if (bar) {
          const load = Math.min(1, avgFrame / FRAME_BUDGET_MS)
          bar.style.transform = `scaleX(${load.toFixed(4)})`
          bar.style.backgroundColor =
            avgFrame <= FRAME_BUDGET_MS
              ? 'var(--color-signal-teal)'
              : avgFrame <= FRAME_BUDGET_MS * 2
                ? 'var(--color-signal-amber)'
                : 'var(--color-signal-rose)'
        }

        // Headroom readout: how much of the 16.7 ms budget is left.
        if (fpsRef.current)
          fpsRef.current.dataset.health = fps >= 55 ? 'good' : fps >= 40 ? 'fair' : 'poor'

        // Consume this window.
        frames = 0
        worst = 0
        windowStart = now
      }

      /* Counters the producers write; cheap enough to read every frame. */
      const c = performanceCounters
      if (particlesRef.current) {
        // Sum of every registered canvas, not one producer's number.
        particlesRef.current.textContent = getActiveParticleCount().toLocaleString('en-US')
      }
      if (shaderPassRef.current) {
        // Published by the component that owns the EffectComposer.
        shaderPassRef.current.textContent = String(getShaderPassCount())
      }
      if (solveRef.current) solveRef.current.textContent = c.physicsSolveMs.toFixed(2)
      if (solveAvgRef.current) solveAvgRef.current.textContent = c.physicsSolveAvgMs.toFixed(2)
      if (ikRef.current) ikRef.current.textContent = c.ikSolveMs.toFixed(2)
      if (canvasCountRef.current) {
        /*
         * Live root count only.
         *
         * This used to print `active / sleeping`, but the sleeping counter's only writer
         * (`setCanvasSleeping`) had no callers and was removed as dead code -- so the panel was
         * showing a permanent, meaningless "/ 0". Sleeping in this app means "not mounted" or
         * "frameloop paused", which the active count already reflects; a second counter that
         * nobody increments is worse than no counter.
         */
        canvasCountRef.current.textContent = String(getActiveCanvasCount())
      }
      if (heapRef.current) {
        heapRef.current.textContent = c.heapAvailable ? c.heapMB.toFixed(1) : 'n/a'
      }

      drawSpark()
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open])

  if (!open) return null

  return (
    <div
      className={cn(
        'panel-glass fixed top-[calc(var(--nav-height)+0.75rem)] right-3 z-90 w-64',
        'rounded-panel border border-signal-cyan/30 bg-void-950/80 p-3',
        'font-mono text-[0.6rem] text-ink-300',
        'shadow-[0_24px_60px_-32px_rgba(0,0,0,0.95)]',
      )}
      role="dialog"
      aria-label={t.hud.panelAria}
    >
      {/* Corner brackets: the cyberpunk tell. */}
      {(
        [
          'left-0 top-0 border-l border-t',
          'right-0 top-0 border-r border-t',
          'left-0 bottom-0 border-l border-b',
          'right-0 bottom-0 border-r border-b',
        ] as const
      ).map((pos) => (
        <span
          key={pos}
          aria-hidden
          className={cn('pointer-events-none absolute size-2.5 border-signal-cyan/70', pos)}
        />
      ))}

      <div className="flex items-center justify-between border-b border-void-600/60 pb-2">
        <span className="flex items-center gap-1.5 tracking-[0.22em] text-signal-cyan uppercase">
          <span className="size-1 animate-pulse rounded-full bg-signal-cyan" aria-hidden />
          telemetry
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t.hud.closeAria}
          className="grid size-5 place-items-center rounded text-ink-500 transition-colors hover:text-signal-cyan"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>

      {/* Frame budget bar */}
      <div className="mt-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-ink-700">{t.hud.frameBudget}</span>
          <span className="text-ink-700">{FRAME_BUDGET_MS.toFixed(1)}ms</span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-void-700">
          <div
            ref={budgetBarRef}
            className="h-full origin-left rounded-full bg-signal-teal"
            style={{ transform: 'scaleX(0)', willChange: 'transform' }}
          />
        </div>
      </div>

      <dl className="mt-2.5 space-y-1">
        <Row label={t.hud.fps}>
          <span ref={fpsRef} className="tabular-nums text-signal-teal">
            --
          </span>
        </Row>
        <Row label={t.hud.frame}>
          <span ref={frameMsRef} className="tabular-nums text-ink-100">
            --
          </span>
          <span className="text-ink-700">ms</span>
        </Row>
        <Row label={t.hud.worst}>
          <span ref={worstMsRef} className="tabular-nums text-signal-amber">
            --
          </span>
          <span className="text-ink-700">ms</span>
        </Row>
        <Row label={t.hud.particles}>
          <span ref={particlesRef} className="tabular-nums text-signal-violet">
            0
          </span>
        </Row>
        <Row label={t.hud.shaderPass}>
          <span ref={shaderPassRef} className="tabular-nums text-signal-cyan">
            0
          </span>
        </Row>
        <Row label={t.hud.physSolve}>
          <span ref={solveRef} className="tabular-nums text-ink-100">
            0.00
          </span>
          <span className="text-ink-700">/ {t.hud.avg}</span>
          <span ref={solveAvgRef} className="tabular-nums text-ink-500">
            0.00
          </span>
        </Row>
        <Row label={t.hud.ikSolve}>
          <span ref={ikRef} className="tabular-nums text-ink-100">
            0.00
          </span>
          <span className="text-ink-700">ms</span>
        </Row>
        <Row label={t.hud.canvases}>
          <span ref={canvasCountRef} className="tabular-nums text-ink-500">
            0 / 0
          </span>
        </Row>
        <Row label={t.hud.tier}>
          <span
            className={cn('uppercase', tier === 'high' ? 'text-signal-teal' : 'text-signal-amber')}
          >
            {tier}
          </span>
        </Row>
        <Row label={t.hud.vfxPreset}>
          {/*
           * Defensive read: the palette preset is owned by another module and
           * may not exist on a given build yet. `vfxPreset` is `undefined`
           * until it lands, and the row then shows a placeholder rather than
           * calling `.toUpperCase()` on nothing.
           */}
          <span
            className={cn('uppercase', vfxPreset ? 'text-signal-violet' : 'text-ink-500')}
            title={vfxPreset}
          >
            {isVfxPreset(vfxPreset) ? t.palette[vfxLabelKey(vfxPreset)] : NO_VALUE}
          </span>
        </Row>
      </dl>

      {/* Memory curve */}
      <div className="mt-2.5 border-t border-void-600/60 pt-2">
        <div className="flex items-baseline justify-between">
          <span className="text-ink-700">{t.hud.heap}</span>
          <span className="tabular-nums text-signal-cyan">
            <span ref={heapRef}>n/a</span>
            <span className="ml-1 text-ink-700">
              <span ref={heapRangeRef}>—</span>
            </span>
          </span>
        </div>
        <canvas
          ref={sparkRef}
          className="mt-1 block rounded border border-void-600/50 bg-void-950/60"
          style={{ width: SPARK_W, height: SPARK_H }}
          aria-hidden
        />
      </div>

      <p className="mt-2 text-center text-[0.5rem] tracking-[0.18em] text-ink-700 uppercase">
        {t.hud.hint}
      </p>
    </div>
  )
}

/** One label/value row. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-700">{label}</dt>
      <dd className="flex items-baseline gap-1">{children}</dd>
    </div>
  )
}

/**
 * PerfNoticeToast — the elegant notice shown when the renderer degrades itself.
 *
 * Mounted permanently so a downgrade that happens while the user is scrolling
 * still surfaces; it renders nothing until the store carries a notice.
 */
export function PerfNoticeToast() {
  const { t } = useI18n()
  const notice = useAppStore((state) => state.perfNotice)
  const clear = useAppStore((state) => state.clearPerfNotice)

  useEffect(() => {
    if (!notice) return
    // Auto-dismiss. Keyed on `nonce` so a second downgrade restarts the timer
    // instead of inheriting the remainder of the first one.
    const timer = setTimeout(clear, 6000)
    return () => clearTimeout(timer)
  }, [notice, clear])

  if (!notice) return null

  return (
    <div
      className={cn(
        'panel-glass fixed top-[calc(var(--nav-height)+0.75rem)] right-3 z-90 w-64',
        'rounded-panel border border-signal-amber/40 bg-void-950/85 p-3',
        'font-mono text-[0.6rem] text-ink-300',
        'shadow-[0_24px_60px_-32px_rgba(0,0,0,0.95)]',
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1.5 tracking-[0.18em] text-signal-amber uppercase">
        <span className="size-1 rounded-full bg-signal-amber" aria-hidden />
        {t.hud.adaptiveQuality}
      </div>
      <p className="mt-1.5 text-ink-100">{notice.title}</p>
      <p className="mt-1 leading-relaxed text-ink-500">{notice.detail}</p>
    </div>
  )
}

export default PerfTelemetryHud
