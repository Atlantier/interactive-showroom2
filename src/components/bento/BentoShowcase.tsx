import { ArrowUpRight, Boxes, Cpu, Radio, Terminal } from 'lucide-react'
import { BentoGrid } from '@/components/bento/BentoGrid'
import { SpotlightCard } from '@/components/bento/SpotlightCard'
import { TokenThroughputChart } from '@/components/bento/micro/TokenThroughputChart'
import { TopologyMini } from '@/components/bento/micro/TopologyMini'
import { TerminalTyper } from '@/components/bento/micro/TerminalTyper'
import { getVfxPalette, type VfxPalette } from '@/lib/vfxPalette'
import { useAppStore } from '@/store/useAppStore'
import { cn } from '@/lib/cn'
import { useI18n } from '@/i18n/useI18n'

/**
 * BentoShowcase — the five-card works matrix.
 *
 * Layout: a 4-column bento on large screens, collapsing to 2 on medium and 1 on
 * mobile. Sizes are deliberately uneven (2x2 hero, 2x1 wide, 1x2 tall, and two
 * 1x1) so the grid reads as an editorial composition rather than a uniform
 * product grid.
 *
 * ── Colour source ──────────────────────────────────────────────────────────
 * Every card's glow / ember field takes the active Visual Overdrive palette's
 * `glowRgb` triple, threaded down as a prop from the section. `SpotlightCard`
 * and `CardParticleCanvas` consume that triple as `rgba(<triple>, <alpha>)` on
 * the JS side, which is exactly why the palette pre-splits it instead of handing
 * them a hex string. One subscription here keeps all five cards in lockstep, and
 * the cards themselves stay palette-agnostic (they already accept the triple).
 */

/* -------------------------------------------------------------------------- */
/*  Shared card furniture                                                     */
/* -------------------------------------------------------------------------- */

function CardHeader({
  icon,
  eyebrow,
  tone = 'text-signal-cyan',
}: {
  icon: React.ReactNode
  eyebrow: string
  tone?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className={cn('flex items-center gap-1.5', tone)}>
        {icon}
        <span className="font-mono text-[0.6rem] tracking-[0.22em] uppercase">{eyebrow}</span>
      </span>
      <ArrowUpRight
        aria-hidden
        className="size-3.5 shrink-0 text-ink-700 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-signal-cyan"
      />
    </div>
  )
}

function CardFooter({ note, title }: { note: string; title: string }) {
  return (
    <div className="mt-auto pt-3">
      <h3 className="truncate text-sm font-medium text-ink-100">{title}</h3>
      <p className="mt-0.5 truncate text-[0.72rem] leading-relaxed text-ink-500">{note}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  1. Hero card — 2x2                                                        */
/* -------------------------------------------------------------------------- */
function ThroughputCard({ palette }: { palette: VfxPalette }) {
  const { t } = useI18n()

  return (
    <SpotlightCard
      spanClassName="md:col-span-2 md:row-span-2"
      label={t.bento.cardThroughputLabel}
      className="p-4"
      glowColor={palette.glowRgb}
    >
      <CardHeader icon={<Radio className="size-3.5" aria-hidden />} eyebrow="live telemetry" />

      <p className="mt-2 text-[0.72rem] leading-relaxed text-ink-500">
        {t.bento.cardThroughputBody}
      </p>

      <div className="mt-3 min-h-0 flex-1">
        <TokenThroughputChart baseline={12_400} />
      </div>

      <CardFooter note={t.bento.cardThroughputNote} title={t.bento.cardThroughputTitle} />
    </SpotlightCard>
  )
}

/* -------------------------------------------------------------------------- */
/*  2. Wide card — 2x1: topology                                              */
/* -------------------------------------------------------------------------- */
function TopologyCard({ palette }: { palette: VfxPalette }) {
  const { t } = useI18n()

  return (
    <SpotlightCard
      spanClassName="md:col-span-2"
      label={t.bento.cardTopologyLabel}
      className="p-4"
      glowColor={palette.glowRgb}
    >
      <CardHeader
        icon={<Boxes className="size-3.5" aria-hidden />}
        eyebrow="architecture"
        tone="text-signal-violet"
      />

      <div className="mt-2 min-h-0 flex-1">
        <TopologyMini />
      </div>

      <CardFooter note={t.bento.cardTopologyNote} title={t.bento.cardTopologyTitle} />
    </SpotlightCard>
  )
}

/* -------------------------------------------------------------------------- */
/*  3. Tall card — 1x2: terminal                                              */
/* -------------------------------------------------------------------------- */
function TerminalCard({ palette }: { palette: VfxPalette }) {
  const { t } = useI18n()

  return (
    <SpotlightCard
      spanClassName="md:row-span-2"
      label={t.bento.cardTerminalLabel}
      className="p-4"
      glowColor={palette.glowRgb}
    >
      <CardHeader icon={<Terminal className="size-3.5" aria-hidden />} eyebrow="terminal" />

      <div className="mt-2 min-h-0 flex-1">
        <TerminalTyper className="h-full" />
      </div>

      <CardFooter note={t.bento.cardTerminalNote} title={t.bento.cardTerminalTitle} />
    </SpotlightCard>
  )
}

/* -------------------------------------------------------------------------- */
/*  4. Small card — 1x1: render stats                                         */
/* -------------------------------------------------------------------------- */
function ShaderCard({ palette }: { palette: VfxPalette }) {
  const { t } = useI18n()

  const stats = [
    { label: t.bento.drawCalls, value: '1' },
    { label: t.bento.particles, value: '8 000' },
    { label: t.bento.frame, value: '4.0ms' },
  ]

  return (
    <SpotlightCard label={t.bento.cardRenderLabel} className="p-4" glowColor={palette.glowRgb}>
      <CardHeader
        icon={<Cpu className="size-3.5" aria-hidden />}
        eyebrow="render"
        tone="text-signal-teal"
      />

      <dl className="mt-3 grid grid-cols-1 gap-1">
        {stats.map((s) => (
          <div key={s.label} className="flex items-baseline justify-between gap-2">
            <dt className="font-mono text-[0.58rem] text-ink-700">{s.label}</dt>
            <dd className="font-mono text-[0.7rem] tabular-nums text-ink-300">{s.value}</dd>
          </div>
        ))}
      </dl>

      <CardFooter note={t.bento.cardRenderNote} title={t.bento.cardRenderTitle} />

      {/*
       * Action target for the card's ember field. Anything carrying
       * `data-card-action` becomes a gravity well — the rising embers abandon
       * their sway and collapse into it on hover, then burst outward on click.
       * The card does the lookup by attribute, so this is the only wiring needed.
       */}
      <button
        type="button"
        data-card-action="true"
        className="mt-2.5 inline-flex items-center gap-1.5 self-start rounded-full border border-signal-teal/30 bg-signal-teal/10 px-2.5 py-1 font-mono text-[0.6rem] tracking-wide text-signal-teal transition-colors duration-300 hover:border-signal-teal/70 hover:bg-signal-teal/20"
      >
        {t.bento.inspectArchitecture}
      </button>
    </SpotlightCard>
  )
}

/* -------------------------------------------------------------------------- */
/*  5. Small card — 1x1: uptime                                               */
/* -------------------------------------------------------------------------- */
function UptimeCard({ palette }: { palette: VfxPalette }) {
  const { t } = useI18n()

  // Deterministic bar heights: a random block would re-render on every pass and
  // carries no semantic meaning.
  const bars = [38, 52, 44, 61, 55, 70, 64, 78, 72, 86, 80, 92, 88, 96]

  return (
    <SpotlightCard label={t.bento.cardUptimeLabel} className="p-4" glowColor={palette.glowRgb}>
      <CardHeader
        icon={<Radio className="size-3.5" aria-hidden />}
        eyebrow="uptime"
        tone="text-signal-amber"
      />

      <p className="mt-3 font-mono text-xl tabular-nums text-ink-100">
        99.98<span className="text-xs text-ink-700">%</span>
      </p>

      <div className="mt-2 flex h-7 items-end gap-0.5" aria-hidden>
        {bars.map((h, i) => (
          <span
            key={i}
            className="flex-1 rounded-t-[1px] bg-gradient-to-t from-signal-teal/25 to-signal-teal/80"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>

      <CardFooter note={t.bento.cardUptimeNote} title={t.bento.cardUptimeTitle} />
    </SpotlightCard>
  )
}

/* -------------------------------------------------------------------------- */
/*  Section                                                                   */
/* -------------------------------------------------------------------------- */
export function BentoShowcase() {
  // One subscription for the whole section: a preset change re-renders this
  // component once and each card receives the new `glowRgb` triple as a prop.
  // Threading the palette down (rather than subscribing inside all five cards)
  // keeps a preset switch to a single store notification.
  const vfxPreset = useAppStore((state) => state.vfxPreset)
  const palette = getVfxPalette(vfxPreset)

  return (
    <BentoGrid className="mt-14">
      <ThroughputCard palette={palette} />
      <TopologyCard palette={palette} />
      <TerminalCard palette={palette} />
      <ShaderCard palette={palette} />
      <UptimeCard palette={palette} />
    </BentoGrid>
  )
}

export default BentoShowcase
