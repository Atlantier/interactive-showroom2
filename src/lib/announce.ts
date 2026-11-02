/**
 * Screen-reader announcements.
 *
 * ── Why a module-level singleton instead of a component ─────────────────────
 * Announcements are fired from event handlers (a language switch, a command
 * execution, a renderer downgrade) that are not in a position to render anything.
 * A single live region that lives for the whole session keeps that call site a
 * one-liner, and — more importantly — guarantees there is exactly ONE polite region
 * on the page. Two of them means the reader announces everything twice, which is a
 * common and very annoying bug in apps that add one per feature.
 *
 * ── Why the text is cleared first ───────────────────────────────────────────
 * A live region only speaks when its content CHANGES. Setting the same string twice
 * (two language switches back and forth, say) would be silent the second time, so the
 * node is blanked and the new text written on the next frame.
 *
 * The region is created lazily on first use: a page that never announces anything
 * pays nothing for it, and nothing runs during SSR.
 */

const REGION_ID = 'a11y-announcer'

function ensureRegion(): HTMLElement | null {
  if (typeof document === 'undefined') return null

  const existing = document.getElementById(REGION_ID)
  if (existing) return existing

  const region = document.createElement('div')
  region.id = REGION_ID
  // `polite`: never interrupts what the reader is currently saying. `role="status"`
  // rather than a bare `aria-live` so older readers honour it too.
  region.setAttribute('role', 'status')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'true')
  // Visually hidden but still in the accessibility tree — `display:none` or
  // `visibility:hidden` would remove it from that tree entirely.
  region.style.position = 'absolute'
  region.style.width = '1px'
  region.style.height = '1px'
  region.style.margin = '-1px'
  region.style.padding = '0'
  region.style.overflow = 'hidden'
  region.style.clip = 'rect(0 0 0 0)'
  region.style.whiteSpace = 'nowrap'
  region.style.border = '0'
  document.body.appendChild(region)
  return region
}

let pending: number | null = null

/**
 * Announce a short message to assistive technology.
 *
 * Call it from the handler that caused the change — the text should describe what
 * just happened, in the language the interface is currently in.
 */
export function announce(message: string): void {
  if (typeof window === 'undefined' || !message) return
  const region = ensureRegion()
  if (!region) return

  // Cancel a queued write so rapid successive announcements collapse to the latest,
  // instead of the reader queueing five strings and falling behind the interface.
  if (pending !== null) window.clearTimeout(pending)
  region.textContent = ''

  pending = window.setTimeout(() => {
    region.textContent = message
    pending = null
  }, 60)
}

/** Remove the region and any queued write (used by tests and hot reload). */
export function resetAnnouncer(): void {
  if (typeof window === 'undefined') return
  if (pending !== null) window.clearTimeout(pending)
  pending = null
  document.getElementById(REGION_ID)?.remove()
}
