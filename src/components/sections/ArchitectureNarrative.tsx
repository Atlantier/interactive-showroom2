import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { useSectionProgress } from '@/hooks/useSectionProgress'
import { useInViewAnimation } from '@/hooks/useInViewAnimation'
import { LAYERS, findLayer } from '@/components/canvas/architecture/layers'
import { getDictionary, useI18n } from '@/i18n/useI18n'
import type { Dictionary } from '@/i18n/locales/en'

/**
 * ArchitectureNarrative — the Apple-keynote-style chapter.
 *
 * ── Structure ─────────────────────────────────────────────────────────────
 *   <section height:300vh>          the scroll track
 *     <div position:sticky top:0>   the pinned stage, exactly 100vh
 *       <canvas layer>              the 3D model (absolute, full stage)
 *       <DOM overlays>              headline, layer labels, metric cards
 *
 * The sticky panel is what "locks" the viewport: for 300vh of scrolling the stage
 * stays put while the content inside it transforms. Local progress is
 * `-rect.top / (300vh - 100vh)`, computed in `useSectionProgress`.
 *
 * ── Text choreography ─────────────────────────────────────────────────────
 * All overlays are driven by the SAME local progress, via CSS custom properties
 * written imperatively from the progress callback. No React state is involved in
 * the scroll path, so a 300vh scrub costs zero renders.
 *
 *   p 0.00–0.08  chapter title fades in
 *   p 0.10–0.30  three layer labels, bottom to top
 *   p 0.30–0.70  labels track their layers apart; caption swaps to "explode"
 *   p 0.70–1.00  metric cards slide in from the right, model dims out
 */

const ScrollArchitecture3D = lazy(() =>
  import('@/components/canvas/ScrollArchitecture3D').then((m) => ({
    default: m.ScrollArchitecture3D,
  })),
)

/* -------------------------------------------------------------------------- */
/*  Content                                                                   */
/* -------------------------------------------------------------------------- */

/** Metric cards revealed in the final phase. */
interface Metric {
  value: string
  unit: string
  label: string
  note: string
}

/**
 * The four telemetry counters.
 *
 * Built per locale rather than declared once: the numbers and units are data, but
 * the labels and the explanatory notes are copy, and a module-level constant would
 * freeze whichever language was active when the bundle evaluated.
 */
function buildMetrics(dict: Dictionary): Metric[] {
  const m = dict.architecture.metrics
  return [
    { value: '12.4k', unit: 'tok/s', label: m.throughputLabel, note: m.throughputNote },
    { value: '99.98', unit: '%', label: m.availabilityLabel, note: m.availabilityNote },
    { value: '38', unit: 'ms', label: m.latencyLabel, note: m.latencyNote },
    { value: '8 000', unit: 'agents', label: m.agentsLabel, note: m.agentsNote },
  ]
}

/* -------------------------------------------------------------------------- */
/*  Layer HUD                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * LayerHud — the technical stack popover shown when a 3D layer is clicked.
 *
 * ── Why it is a DOM overlay and not drei `Html` ───────────────────────────
 * drei's `Html` renders into a portal managed by the canvas, which means its
 * typography inherits the WebGL layout context and it cannot use this app's
 * Tailwind tokens reliably. A plain absolutely-positioned overlay sits in the
 * normal document flow, participates in the app's design system, and is
 * trivially keyboard-accessible — a 3D-space popover is not focusable.
 *
 * ── Interaction ───────────────────────────────────────────────────────────
 * Slides in from the right, matching the metric cards' choreography. Clicking
 * the close button (or pressing Escape) clears the focus, which also returns
 * the camera to its scroll-driven path.
 */
function LayerHud({ layerId, onClose }: { layerId: string | null; onClose: () => void }) {
  const { t } = useI18n()
  const layer = findLayer(layerId)

  // Escape closes the HUD. Registered only while a layer is open.
  useEffect(() => {
    if (!layerId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layerId, onClose])

  return (
    <div
      // `pointer-events-none` on the wrapper keeps the rest of the stage
      // click-through; only the panel itself re-enables them.
      className={cn(
        'pointer-events-none absolute inset-y-0 right-0 z-40 flex items-center pr-4 sm:pr-8 lg:pr-14',
        'transition-opacity duration-300',
        layer ? 'opacity-100' : 'opacity-0',
      )}
      aria-hidden={!layer}
    >
      <div
        role="dialog"
        aria-label={layer ? `${layer.title} — ${t.architecture.layerStack}` : undefined}
        aria-hidden={!layer}
        className={cn(
          'pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-panel',
          'border bg-void-950/95',
          'shadow-[0_32px_80px_-32px_rgba(0,0,0,0.95)]',
          'transition-all duration-400',
          layer
            ? 'translate-x-0 scale-100 opacity-100'
            : 'pointer-events-none translate-x-8 scale-95 opacity-0',
        )}
        style={{ borderColor: layer ? `${layer.accent}55` : undefined }}
      >
        {layer && (
          <>
            {/* Header */}
            <div
              className="flex items-start justify-between gap-3 border-b px-4 py-3"
              style={{ borderColor: `${layer.accent}33` }}
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span
                    className="font-mono text-[0.55rem] tracking-[0.2em]"
                    style={{ color: layer.accent }}
                  >
                    {layer.index}
                  </span>
                  <h3 className="truncate text-sm font-medium text-ink-100">{layer.title}</h3>
                </div>
                <p className="mt-0.5 font-mono text-[0.55rem] tracking-wider text-ink-500 uppercase">
                  {layer.subtitle}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t.architecture.layerDetailClose}
                className="grid size-6 shrink-0 place-items-center rounded border border-void-600/70 text-ink-500 transition-colors hover:border-signal-cyan/60 hover:text-signal-cyan"
              >
                <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
                  <path
                    d="M1 1l10 10M11 1L1 11"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {/* Summary */}
            <p className="px-4 pt-3 text-[0.72rem] leading-relaxed text-ink-300">
              {t.architecture.layers[layer.id].summary}
            </p>

            {/* Tech stack rows */}
            <ul className="mt-2 space-y-0 divide-y divide-void-600/40 px-4 pb-4">
              {layer.tech.map((tech, index) => (
                <li key={tech.name} className="flex items-baseline gap-3 py-2">
                  <span
                    aria-hidden
                    className="mt-1 size-1 shrink-0 rounded-full"
                    style={{ backgroundColor: layer.accent }}
                  />
                  <div className="min-w-0">
                    <p className="font-mono text-[0.68rem] text-ink-100">{tech.name}</p>
                    <p className="mt-0.5 text-[0.66rem] leading-relaxed text-ink-500">
                      {t.architecture.layers[layer.id].details[index]}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

            <p className="border-t border-void-600/40 px-4 py-2 font-mono text-[0.5rem] tracking-wider text-ink-700 uppercase">
              {t.architecture.layerDetailHint}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function ArchitectureNarrative() {
  const { t } = useI18n()
  const metrics = buildMetrics(t)

  /** Which layer is focused, or null for the overview. */
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null)
  /**
   * Host for the 3D canvas, observed so the rig can sleep while this chapter is
   * off screen. The canvas is mounted for the whole session and is expensive —
   * transmission material, particle conduits, four animated layers — so gating it
   * is worth more than gating any other module on the page.
   */
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const cardsRef = useRef<HTMLUListElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const captionRef = useRef<HTMLParagraphElement>(null)
  const layerRefs = useRef<Array<HTMLDivElement | null>>([])

  const { sectionRef, store } = useSectionProgress({
    onProgress: (p) => {
      /* ── Heading: fade in over the first 8%, hold, fade at the end ────── */
      const head = headingRef.current
      if (head) {
        const inn = Math.min(1, Math.max(0, p / 0.06))
        const out = 1 - Math.min(1, Math.max(0, (p - 0.62) / 0.12))
        head.style.opacity = String(inn * out)
        // A slight upward drift as it fades, which is the keynote "lift" move.
        head.style.transform = `translate3d(0, ${(1 - inn) * 18 - (1 - out) * 24}px, 0)`
      }

      /* ── Layer labels: staggered entrance, then track the separation ─── */
      for (let i = 0; i < layerRefs.current.length; i++) {
        const el = layerRefs.current[i]
        if (!el) continue
        // Each label enters 0.03 later than the previous one.
        const start = 0.1 + i * 0.03
        const appear = Math.min(1, Math.max(0, (p - start) / 0.08))
        const leave = 1 - Math.min(1, Math.max(0, (p - 0.66) / 0.1))
        const alpha = appear * leave
        el.style.opacity = String(alpha)
        el.style.transform = `translate3d(${(1 - appear) * -22}px, 0, 0)`
      }

      /* ── Caption: swaps between phases ───────────────────────────────── */
      const cap = captionRef.current
      if (cap) {
        const phase = p < 0.3 ? 'interlocked' : p < 0.7 ? 'exploded' : 'reassembled'
        if (cap.dataset.phase !== phase) {
          cap.dataset.phase = phase
          const copy = getDictionary().architecture
          cap.textContent =
            phase === 'interlocked'
              ? copy.subtitleIdle
              : phase === 'exploded'
                ? copy.subtitleExplode
                : copy.subtitleFinal
        }
      }

      /* ── Metric cards: slide in from the right ───────────────────────── */
      const cards = cardsRef.current
      if (cards) {
        const reveal = Math.min(1, Math.max(0, (p - 0.7) / 0.14))
        cards.style.opacity = String(reveal)
        cards.style.transform = `translate3d(${(1 - reveal) * 64}px, 0, 0)`
        cards.style.pointerEvents = reveal > 0.6 ? 'auto' : 'none'
      }
    },
  })

  /**
   * Viewport gating for the 3D canvas.
   *
   * A generous 60% margin on purpose: the section is 300vh tall and its sticky
   * stage is pinned for the middle of that, so the canvas must be awake well
   * before the pin begins or the visitor would watch it start up mid-scroll.
   *
   * `canvasAwake` mirrors the ref as React state. The ref alone is not enough
   * here: the rig AND the EffectComposer that renders it have to leave the
   * tree, not merely stop drawing. A composer owns the render pass for its
   * canvas, so unmounting the rig without it would leave an empty scene being
   * bloomed every frame. Doing this 60% early means the procedural geometry
   * rebuilds while still off screen.
   *
   * `initial: false` on both means a chapter that starts off screen never mounts
   * its rig at all; the observer flips it on the first crossing.
   */
  const [canvasAwake, setCanvasAwake] = useState(false)
  const inViewRef = useInViewAnimation(canvasHostRef, {
    // Fixed distance rather than a percentage: the section is 300vh tall, so a 60%
    // margin woke the canvas more than a full screen early and kept it alive while
    // the visitor was still two chapters away.
    rootMargin: '600px 0px 600px 0px',
    initial: false,
    onChange: setCanvasAwake,
  })

  return (
    <section
      ref={sectionRef}
      id="architecture"
      aria-labelledby="architecture-title"
      // The 300vh track. `relative` so it establishes the containing block the
      // sticky stage positions against.
      className="relative z-20 h-[300vh] w-full"
    >
      {/* The pinned stage. */}
      <div ref={stageRef} className="sticky top-0 flex h-dvh w-full items-center overflow-hidden">
        {/* 3D layer, behind the text. Receives clicks for layer picking. */}
        <div ref={canvasHostRef} className="absolute inset-0 z-0">
          <Suspense fallback={null}>
            <ScrollArchitecture3D
              progress={store}
              inViewRef={inViewRef}
              awake={canvasAwake}
              selectedLayer={selectedLayer}
              onSelectLayer={setSelectedLayer}
            />
          </Suspense>
        </div>

        {/* Soft radial vignette so text stays legible over the model.
            `pointer-events-none` is essential: the canvas underneath must
            receive clicks for layer picking. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_60%_50%_at_50%_50%,transparent_10%,rgba(4,6,11,0.72)_100%)]"
        />

        {/* ── Chapter heading, upper left ────────────────────────────────── */}
        <div
          ref={headingRef}
          className="absolute top-[16vh] left-6 z-20 max-w-md will-change-transform sm:left-10 lg:left-16"
          style={{ opacity: 0 }}
        >
          <div className="flex items-center gap-2 font-mono text-[0.6rem] tracking-[0.3em] text-ink-700 uppercase">
            <span className="text-signal-cyan">03</span>
            <span aria-hidden className="h-px w-8 bg-void-600" />
            <span>architecture</span>
          </div>
          <h2
            id="architecture-title"
            className="mt-4 text-[clamp(1.75rem,3.6vw,2.75rem)] leading-[1.1] font-medium tracking-tight text-ink-100"
          >
            {t.architecture.headingLead}
            <br />
            <span className="text-signal-cyan">{t.architecture.headingAccent}</span>
            {t.architecture.headingTail}
          </h2>
          <p
            ref={captionRef}
            className="mt-4 font-mono text-[0.7rem] tracking-wide text-ink-500"
            data-phase="interlocked"
          >
            {t.architecture.subtitleIdle}
          </p>
        </div>

        {/* ── Layer labels, right side, bottom-to-top order ──────────────── */}
        <div className="pointer-events-none absolute top-1/2 right-6 z-20 hidden -translate-y-1/2 flex-col gap-5 sm:right-10 lg:right-16 lg:flex">
          {LAYERS.map((layer, i) => (
            <div
              key={layer.id}
              ref={(el) => {
                layerRefs.current[i] = el
              }}
              className="w-56 text-right will-change-transform"
              style={{ opacity: 0 }}
            >
              <div className="flex items-baseline justify-end gap-2">
                <span className="font-mono text-[0.55rem] tracking-[0.2em] text-signal-cyan/70">
                  {layer.index}
                </span>
                <h3 className="text-sm font-medium text-ink-100">{layer.title}</h3>
              </div>
              <p className="mt-0.5 font-mono text-[0.6rem] tracking-wider text-ink-500 uppercase">
                {layer.subtitle}
              </p>
              <p className="mt-1 text-[0.7rem] leading-relaxed text-ink-700">
                {t.architecture.layers[layer.id].summary}
              </p>
            </div>
          ))}
        </div>

        {/* ── Layer HUD: appears when a layer is clicked ──────────────────── */}
        <LayerHud layerId={selectedLayer} onClose={() => setSelectedLayer(null)} />

        {/* ── Metric cards, revealed in the final phase ──────────────────── */}
        <ul
          ref={cardsRef}
          className={cn(
            'absolute inset-x-6 bottom-[12vh] z-30 grid grid-cols-2 gap-3 will-change-transform',
            'sm:inset-x-10 lg:inset-x-auto lg:right-16 lg:bottom-1/2 lg:w-80 lg:translate-y-1/2 lg:grid-cols-1',
          )}
          style={{ opacity: 0, pointerEvents: 'none' }}
        >
          {metrics.map((m) => (
            <li
              key={m.label}
              className="rounded-panel border border-void-600/70 bg-void-950/88 p-3"
            >
              <div className="flex items-baseline gap-1">
                <span className="font-mono text-lg tabular-nums text-ink-100">{m.value}</span>
                <span className="font-mono text-[0.55rem] text-signal-cyan">{m.unit}</span>
              </div>
              <p className="mt-1 text-[0.72rem] text-ink-300">{m.label}</p>
              <p className="mt-0.5 font-mono text-[0.55rem] text-ink-700">{m.note}</p>
            </li>
          ))}
        </ul>

        {/* ── Progress rail, bottom centre ───────────────────────────────── */}
        <div className="absolute inset-x-0 bottom-6 z-20 flex justify-center">
          <ProgressRail store={store} />
        </div>
      </div>
    </section>
  )
}

/**
 * A thin rail showing the chapter's own 0→1 progress.
 *
 * Subscribes to the progress store directly and writes `scaleX` to the DOM, so
 * scrubbing never re-renders the chapter.
 */
function ProgressRail({ store }: { store: ReturnType<typeof useSectionProgress>['store'] }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      store.subscribe((p) => {
        const el = ref.current
        if (el) el.style.transform = `scaleX(${p.toFixed(4)})`
      }),
    [store],
  )

  return (
    <div aria-hidden className="flex w-40 flex-col items-center gap-2">
      <div className="h-px w-full bg-void-600/60">
        <div
          ref={ref}
          className="h-full origin-left bg-gradient-to-r from-signal-cyan to-signal-violet will-change-transform"
          style={{ transform: 'scaleX(0)' }}
        />
      </div>
      <span className="font-mono text-[0.5rem] tracking-[0.3em] text-ink-700 uppercase">
        architecture
      </span>
    </div>
  )
}

export default ArchitectureNarrative
