import { ArrowUpRight, Sparkles } from 'lucide-react'
import { scrollToTarget } from '@/lib/scrollEngine'
import { StatusDot } from '@/components/ui/primitives'
import { BentoShowcase } from '@/components/bento/BentoShowcase'
import { FabrikCreature } from '@/components/sandbox/FabrikCreature'
import { VerletLanyard } from '@/components/sandbox/VerletLanyard'
import { cn } from '@/lib/cn'
import { useI18n } from '@/i18n/useI18n'

/* -------------------------------------------------------------------------- */
/*  Section shell — every chapter shares this frame                           */
/* -------------------------------------------------------------------------- */
export function SectionShell({
  id,
  index,
  eyebrow,
  title,
  description,
  className,
  children,
}: {
  id: string
  index: string
  eyebrow: string
  title: string
  description?: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        'relative mx-auto flex min-h-[100svh] w-full max-w-[104rem] flex-col justify-center px-4 py-28 sm:px-6 lg:px-10',
        className,
      )}
    >
      <div className="pointer-events-none absolute top-28 left-4 hidden items-center gap-2 font-mono text-[0.6rem] tracking-[0.3em] text-ink-700 uppercase sm:left-6 lg:left-10 lg:flex">
        <span className="text-signal-cyan">§{index}</span>
        <span className="h-px w-10 bg-void-600" />
        <span>{eyebrow}</span>
      </div>

      <div className="max-w-3xl">
        <h2
          id={`${id}-title`}
          className="text-[clamp(2rem,5.5vw,3.75rem)] leading-[1.05] font-medium tracking-tight text-ink-100"
        >
          {title}
        </h2>
        {description && (
          <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-500 sm:text-lg">
            {description}
          </p>
        )}
      </div>

      {children}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  HERO                                                                      */
/* -------------------------------------------------------------------------- */
export function HeroSection() {
  const { t } = useI18n()

  return (
    <section
      id="hero"
      aria-labelledby="hero-title"
      className="relative mx-auto flex min-h-[100svh] w-full max-w-[104rem] flex-col justify-center px-4 pt-24 pb-20 sm:px-6 lg:px-10"
    >
      {/* Status strip */}
      <div className="mb-8 flex items-center gap-2.5 font-mono text-[0.62rem] tracking-[0.28em] text-ink-500 uppercase">
        <StatusDot tone="cyan" />
        <span>{t.hero.statusOnline}</span>
        <span aria-hidden className="h-px w-8 bg-void-600" />
        <span className="text-ink-700">{t.hero.stackStack}</span>
      </div>

      <h1
        id="hero-title"
        className="max-w-5xl text-[clamp(2.75rem,9vw,7rem)] leading-[0.92] font-medium tracking-[-0.03em] text-ink-100"
      >
        <span className="block text-ink-500">{t.hero.titleLead}</span>
        <span className="block text-glow">{t.hero.titleMain}</span>
      </h1>

      <p className="mt-8 max-w-xl text-base leading-relaxed text-ink-500 sm:text-lg">
        {t.hero.body}
        <span className="text-ink-300"> {t.hero.bodyAccent}</span>
      </p>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => scrollToTarget('#gallery', -16)}
          className="group inline-flex items-center gap-2 rounded-lg border border-signal-cyan/45 bg-signal-cyan/10 px-5 py-3 text-sm font-medium tracking-wide text-signal-cyan transition-all duration-300 hover:border-signal-cyan hover:bg-signal-cyan/18 hover:shadow-[0_0_32px_-8px_var(--color-signal-cyan)]"
        >
          <Sparkles className="size-4" aria-hidden />
          {t.hero.ctaEnter}
          <ArrowUpRight
            className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            aria-hidden
          />
        </button>

        <button
          type="button"
          onClick={() => scrollToTarget('#archive', -16)}
          className="rounded-lg border border-void-600 px-5 py-3 text-sm tracking-wide text-ink-300 transition-colors hover:border-void-500 hover:text-ink-100"
        >
          {t.hero.ctaArchive}
        </button>
      </div>

      {/* Scroll hint */}
      <div className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-2">
        <span className="font-mono text-[0.55rem] tracking-[0.4em] text-ink-700 uppercase">
          {t.hero.scrollHint}
        </span>
        <span aria-hidden className="relative h-10 w-px overflow-hidden bg-void-600">
          <span className="absolute inset-x-0 top-0 h-4 animate-scan bg-signal-cyan" />
        </span>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  GALLERY                                                                   */
/* -------------------------------------------------------------------------- */
export function GallerySection() {
  const { t } = useI18n()

  return (
    <SectionShell
      id="gallery"
      index={t.sections.gallery.index}
      eyebrow={t.sections.gallery.eyebrow}
      title={t.sections.gallery.title}
      description={t.sections.gallery.description}
    >
      <BentoShowcase />
    </SectionShell>
  )
}

/* -------------------------------------------------------------------------- */
/*  PLAYGROUND                                                                */
/* -------------------------------------------------------------------------- */
export function PlaygroundSection() {
  const { t } = useI18n()

  return (
    <SectionShell
      id="playground"
      index={t.sections.playground.index}
      eyebrow={t.sections.playground.eyebrow}
      title={t.sections.playground.title}
      description={t.sections.playground.description}
    >
      <VerletLanyard className="mt-12 h-[clamp(24rem,52vh,34rem)] w-full" />
      <FabrikCreature className="mt-6 h-[clamp(22rem,48vh,30rem)] w-full" />
    </SectionShell>
  )
}

/* -------------------------------------------------------------------------- */
/*  ARCHIVE                                                                   */
/* -------------------------------------------------------------------------- */
export function ArchiveSection() {
  const { t } = useI18n()

  return (
    <SectionShell
      id="archive"
      index={t.sections.archive.index}
      eyebrow={t.sections.archive.eyebrow}
      title={t.sections.archive.title}
      description={t.sections.archive.description}
    >
      <ul className="mt-14 divide-y divide-void-600/60 border-y border-void-600/60">
        {[
          { year: '2026', title: t.archive.rows.graphics, type: 'WebGL' },
          { year: '2025', title: t.archive.rows.narrative, type: 'Installation' },
          { year: '2024', title: t.archive.rows.generative, type: 'Generative' },
        ].map((row) => (
          <li key={row.title}>
            <button
              type="button"
              className="group flex w-full items-center gap-4 py-5 text-left transition-colors sm:gap-8"
            >
              <span className="w-12 shrink-0 font-mono text-[0.65rem] tabular-nums text-ink-700">
                {row.year}
              </span>
              <span className="flex-1 text-base text-ink-300 transition-colors group-hover:text-signal-cyan sm:text-lg">
                {row.title}
              </span>
              <span className="hidden font-mono text-[0.6rem] tracking-widest text-ink-700 uppercase sm:block">
                {row.type}
              </span>
              <ArrowUpRight
                className="size-4 shrink-0 text-ink-700 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-signal-cyan"
                aria-hidden
              />
            </button>
          </li>
        ))}
      </ul>
    </SectionShell>
  )
}

/* -------------------------------------------------------------------------- */
/*  CONTACT                                                                   */
/* -------------------------------------------------------------------------- */
export function ContactSection() {
  const { t } = useI18n()

  return (
    <SectionShell
      id="contact"
      index={t.sections.contact.index}
      eyebrow={t.sections.contact.eyebrow}
      title={t.sections.contact.title}
      description={t.sections.contact.description}
      className="min-h-[80svh]"
    >
      <div className="mt-12 flex flex-wrap items-center gap-3">
        <a
          href="mailto:hello@showroom.dev"
          className="group inline-flex items-center gap-2 rounded-lg border border-signal-cyan/45 bg-signal-cyan/10 px-5 py-3 text-sm font-medium text-signal-cyan transition-all duration-300 hover:border-signal-cyan hover:bg-signal-cyan/18"
        >
          hello@showroom.dev
          <ArrowUpRight
            className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            aria-hidden
          />
        </a>
      </div>

      <footer className="mt-24 flex flex-col gap-4 border-t border-void-600/60 pt-6 font-mono text-[0.6rem] tracking-[0.2em] text-ink-700 uppercase sm:flex-row sm:items-center sm:justify-between">
        <span>{t.footer.copyright}</span>
        <span className="flex items-center gap-2">
          <StatusDot tone="teal" pulse={false} />
          {t.footer.builtWith}
        </span>
      </footer>
    </SectionShell>
  )
}
