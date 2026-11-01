import type { SectionLink } from '@/components/layout/Navbar.parts'

/**
 * The showroom's chapters, in scroll order.
 *
 * Lives in its own module (rather than inside `Navbar.tsx`) so the component
 * file exports only components — that keeps React Fast Refresh working.
 */
export const SHOWROOM_SECTIONS: SectionLink[] = [
  { id: 'hero', label: '入口', index: '01' },
  { id: 'gallery', label: '展厅', index: '02' },
  { id: 'architecture', label: '架构', index: '03' },
  { id: 'playground', label: '沙盒', index: '04' },
  { id: 'archive', label: '档案', index: '05' },
  { id: 'contact', label: '通讯', index: '06' },
]

/** Convenience: the ordered section ids, used by the IntersectionObserver. */
export const SECTION_IDS: string[] = SHOWROOM_SECTIONS.map((section) => section.id)
