import { useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'

/**
 * Observe the page sections and mirror the most-visible one into the store so
 * the navbar can highlight the current chapter.
 *
 * Uses a single IntersectionObserver with viewport-center-biased thresholds and
 * only writes to the store when the section actually changes, so scrolling
 * remains render-free.
 */
export function useSectionObserver(sectionIds: readonly string[], enabled = true): void {
  const setActiveSection = useAppStore((state) => state.setActiveSection)

  useEffect(() => {
    if (!enabled || sectionIds.length === 0) return

    const elements = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)

    if (elements.length === 0) return

    // Track visibility ratios ourselves: the active section is the one with the
    // largest intersection, not simply the first entry of a callback batch.
    const ratios = new Map<string, number>()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0)
        }

        let bestId = ''
        let bestRatio = 0
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio
            bestId = id
          }
        }

        if (bestId && bestRatio > 0.15) setActiveSection(bestId)
      },
      {
        // Bias the detection band toward the middle of the viewport.
        rootMargin: '-20% 0px -35% 0px',
        threshold: [0, 0.15, 0.35, 0.6, 0.85, 1],
      },
    )

    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [sectionIds, enabled, setActiveSection])
}
