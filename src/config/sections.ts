import type { SectionLink } from '@/components/layout/Navbar.parts'
import type { SectionId } from '@/types'

/**
 * The showroom's chapters, in scroll order.
 *
 * Lives in its own module (rather than inside `Navbar.tsx`) so the component
 * file exports only components — that keeps React Fast Refresh working.
 *
 * ── Why there are no labels here ────────────────────────────────────────────
 * The visible name of a chapter is copy, not configuration: it has to change with
 * the interface language. Each entry therefore carries only its id and index, and
 * every consumer resolves the title through `t.sections[id].title`. Storing the
 * Chinese labels inline made them the one piece of navigation text that could not
 * be translated, which is exactly what this refactor had to remove.
 */
export const SHOWROOM_SECTIONS: SectionLink[] = [
  { id: 'hero', index: '01' },
  { id: 'gallery', index: '02' },
  { id: 'architecture', index: '03' },
  { id: 'playground', index: '04' },
  { id: 'archive', index: '05' },
  { id: 'contact', index: '06' },
]

/** Convenience: the ordered section ids, used by the IntersectionObserver. */
export const SECTION_IDS: SectionId[] = SHOWROOM_SECTIONS.map((section) => section.id)
