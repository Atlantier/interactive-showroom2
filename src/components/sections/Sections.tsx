import { ArrowUpRight, Sparkles } from 'lucide-react'
import { scrollToTarget } from '@/lib/scrollEngine'
import { StatusDot } from '@/components/ui/primitives'
import { BentoShowcase } from '@/components/bento/BentoShowcase'
import { FabrikCreature } from '@/components/sandbox/FabrikCreature'
import { VerletLanyard } from '@/components/sandbox/VerletLanyard'
import { cn } from '@/lib/cn'

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
  return (
    <section
      id="hero"
      aria-labelledby="hero-title"
      className="relative mx-auto flex min-h-[100svh] w-full max-w-[104rem] flex-col justify-center px-4 pt-24 pb-20 sm:px-6 lg:px-10"
    >
      {/* Status strip */}
      <div className="mb-8 flex items-center gap-2.5 font-mono text-[0.62rem] tracking-[0.28em] text-ink-500 uppercase">
        <StatusDot tone="cyan" />
        <span>system online</span>
        <span aria-hidden className="h-px w-8 bg-void-600" />
        <span className="text-ink-700">webgl · lenis · r3f</span>
      </div>

      <h1
        id="hero-title"
        className="max-w-5xl text-[clamp(2.75rem,9vw,7rem)] leading-[0.92] font-medium tracking-[-0.03em] text-ink-100"
      >
        <span className="block text-ink-500">个人</span>
        <span className="block text-glow">数字展厅</span>
      </h1>

      <p className="mt-8 max-w-xl text-base leading-relaxed text-ink-500 sm:text-lg">
        一个由 WebGL、惯性滚动与实时状态编排构成的沉浸式空间。
        <span className="text-ink-300"> 在这里，滚动即是镜头运动。</span>
      </p>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => scrollToTarget('#gallery', -16)}
          className="group inline-flex items-center gap-2 rounded-lg border border-signal-cyan/45 bg-signal-cyan/10 px-5 py-3 text-sm font-medium tracking-wide text-signal-cyan transition-all duration-300 hover:border-signal-cyan hover:bg-signal-cyan/18 hover:shadow-[0_0_32px_-8px_var(--color-signal-cyan)]"
        >
          <Sparkles className="size-4" aria-hidden />
          进入展厅
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
          浏览档案
        </button>
      </div>

      {/* Scroll hint */}
      <div className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-2">
        <span className="font-mono text-[0.55rem] tracking-[0.4em] text-ink-700 uppercase">
          scroll
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
  return (
    <SectionShell
      id="gallery"
      index="02"
      eyebrow="gallery"
      title="展厅"
      description="每一件展品都是一段可被滚动与指针解读的实时图形。"
    >
      <BentoShowcase />
    </SectionShell>
  )
}

/* -------------------------------------------------------------------------- */
/*  PLAYGROUND                                                                */
/* -------------------------------------------------------------------------- */
export function PlaygroundSection() {
  return (
    <SectionShell
      id="playground"
      index="04"
      eyebrow="playground"
      title="沙盒"
      description="手写求解器：Verlet 绳索物理，与 FABRIK 逆向运动学驱动的机械生物。"
    >
      <VerletLanyard className="mt-12 h-[clamp(24rem,52vh,34rem)] w-full" />
      <FabrikCreature className="mt-6 h-[clamp(22rem,48vh,30rem)] w-full" />
    </SectionShell>
  )
}

/* -------------------------------------------------------------------------- */
/*  ARCHIVE                                                                   */
/* -------------------------------------------------------------------------- */
const ARCHIVE_ROWS = [
  { year: '2026', title: '实时图形实验', type: 'WebGL' },
  { year: '2025', title: '交互叙事装置', type: 'Installation' },
  { year: '2024', title: '生成式视觉系统', type: 'Generative' },
]

export function ArchiveSection() {
  return (
    <SectionShell
      id="archive"
      index="05"
      eyebrow="archive"
      title="档案"
      description="按时间索引的创作记录。"
    >
      <ul className="mt-14 divide-y divide-void-600/60 border-y border-void-600/60">
        {ARCHIVE_ROWS.map((row) => (
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
  return (
    <SectionShell
      id="contact"
      index="06"
      eyebrow="contact"
      title="通讯"
      description="如果你也在构建某种沉浸式的数字空间，我们可以聊聊。"
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
        <span>© 2026 digital showroom</span>
        <span className="flex items-center gap-2">
          <StatusDot tone="teal" pulse={false} />
          built with react 19 · three.js · lenis
        </span>
      </footer>
    </SectionShell>
  )
}
