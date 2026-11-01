import { useEffect, useRef } from 'react'
import { onScrollFrame, scrollToTarget } from '@/lib/scrollEngine'
import { useAppStore } from '@/store/useAppStore'
import { useI18n } from '@/i18n/useI18n'
import type { SectionId } from '@/types'
import { cn } from '@/lib/cn'

export interface SectionLink {
  /** Closed union, so the label lookup below cannot miss. */
  id: SectionId
  /** Short mono index shown before the label, e.g. "01". */
  index: string
}

/**
 * ScrollProgressRail — a hairline progress indicator pinned to the very top of
 * the page. It subscribes to the scroll engine IMPERATIVELY and writes
 * `scaleX` straight to the DOM, so scrolling never triggers a React render.
 */
export function ScrollProgressRail() {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      onScrollFrame(({ progress }) => {
        const bar = barRef.current
        if (bar) bar.style.transform = `scaleX(${progress.toFixed(5)})`
      }),
    [],
  )

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-100 h-px bg-void-600/50"
    >
      <div
        ref={barRef}
        className="h-full origin-left bg-gradient-to-r from-signal-cyan via-signal-teal to-signal-violet will-change-transform"
        style={{ transform: 'scaleX(0)' }}
      />
    </div>
  )
}

/**
 * SectionNav — desktop index links. Clicking delegates to the Lenis engine so
 * programmatic navigation uses the same inertial curve as manual scrolling.
 */
export function SectionNav({
  sections,
  activeSection,
}: {
  sections: SectionLink[]
  activeSection: string
}) {
  const { t } = useI18n()

  return (
    <nav aria-label={t.nav.primarySectionsAria} className="hidden items-center gap-1 lg:flex">
      {sections.map((section) => {
        const isActive = section.id === activeSection
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => scrollToTarget(`#${section.id}`, -16)}
            aria-current={isActive ? 'true' : undefined}
            className={cn(
              'group relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[0.7rem] tracking-[0.12em] uppercase transition-colors duration-200',
              isActive ? 'text-signal-cyan' : 'text-ink-500 hover:text-ink-300',
            )}
          >
            <span
              className={cn(
                'text-[0.6rem] tabular-nums transition-colors',
                isActive ? 'text-signal-cyan/80' : 'text-ink-700 group-hover:text-ink-500',
              )}
            >
              {section.index}
            </span>
            <span>{t.sections[section.id].title}</span>
            {isActive && (
              <span
                aria-hidden
                className="absolute inset-x-2 -bottom-px h-px bg-gradient-to-r from-transparent via-signal-cyan to-transparent"
              />
            )}
          </button>
        )
      })}
    </nav>
  )
}

/**
 * Compact mobile section indicator (the full nav is hidden below `lg`).
 *
 * Must never wrap: the navbar is a fixed-height flex row, so a two-line badge
 * would push the bar out of its band and misalign every control. On the
 * narrowest screens the label is dropped entirely and only the index remains.
 */
export function ActiveSectionBadge({ sections }: { sections: SectionLink[] }) {
  const activeSection = useAppStore((state) => state.activeSection)
  const { t } = useI18n()
  const current = sections.find((section) => section.id === activeSection)
  return (
    <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-[0.65rem] tracking-[0.16em] whitespace-nowrap uppercase lg:hidden">
      <span className="text-signal-cyan">{current ? current.index : '--'}</span>
      <span className="hidden text-ink-500 xs:inline">
        {current ? t.sections[current.id].title : t.nav.fallbackSection}
      </span>
    </span>
  )
}
