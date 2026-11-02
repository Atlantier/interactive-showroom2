import { useCallback, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { InterCardPulse, type InterCardPulseHandle } from '@/components/bento/InterCardPulse'
import { useSpotlightPointer } from '@/components/bento/useSpotlightPointer'
import { SpotlightContext } from '@/components/bento/spotlightRegistry'

/**
 * BentoGrid — the parent container that drives every card's spotlight.
 *
 * ── One listener, N cards ──────────────────────────────────────────────────
 * A single `mousemove` on the grid computes each card's LOCAL cursor position
 * from one `getBoundingClientRect()` per card and pushes it into that card via
 * its registered handle. Two reasons this beats a listener per card:
 *
 *  1. Cards must react while the cursor is OUTSIDE them. The border-glow effect
 *     depends on the gradient's centre being able to sit beyond the card edge,
 *     and a per-card `mousemove` simply does not fire there.
 *  2. It is one listener, one read pass, one frame-consistent update for the
 *     whole matrix instead of N independent event storms.
 *
 * ── Coordinate strategy ────────────────────────────────────────────────────
 * `getBoundingClientRect()` is only called when the pointer enters the grid and
 * after scroll/resize invalidate the cached rects — never inside the move
 * handler. Reading layout during a move handler would force a synchronous
 * reflow on every pointer event, which is the classic way these grids end up
 * janky on large screens.
 *
 * ── Throttling ─────────────────────────────────────────────────────────────
 * Moves are coalesced into one `requestAnimationFrame` callback. Pointer events
 * can fire faster than the display refreshes (and much faster on high-polling
 * mice); without coalescing, the tilt springs receive redundant samples and the
 * CSS variable writes exceed the frame budget for no visual gain.
 */

export interface BentoGridProps {
  children: ReactNode
  className?: string
}

export function BentoGrid({ children, className }: BentoGridProps) {
  /** Handle on the extracted discharge system (see InterCardPulse.tsx). */
  const pulseRef = useRef<InterCardPulseHandle>(null)

  /**
   * Cursor / gyroscope spotlight, extracted to its own hook (UI-19).
   *
   * The press callback is the only piece the grid itself owns: a click on the matrix fires a
   * discharge immediately instead of waiting for the next heartbeat.
   */
  const spotlight = useSpotlightPointer({
    onPress: useCallback(() => pulseRef.current?.emit(), []),
  })
  const { gridRef, registry, ambient, inViewRef, handlers } = spotlight

  return (
    <SpotlightContext.Provider value={registry}>
      <div
        ref={gridRef}
        onPointerMove={handlers.onPointerMove}
        onPointerLeave={handlers.onPointerLeave}
        onPointerEnter={handlers.onPointerEnter}
        onPointerDown={handlers.onPointerDown}
        // Consumed by the `[data-spotlight='ambient']` rules in index.css, which
        // lift the `group-hover` gate so the glow is visible without a cursor.
        data-spotlight={ambient ? 'ambient' : undefined}
        className={cn(
          'grid gap-4',
          // Rows track their content on phones, so the single-column layout reads
          // as a natural card flow instead of seven 17rem boxes with trapped
          // whitespace. The fixed rhythm returns at md, where the matrix is
          // actually a matrix.
          'auto-rows-[auto] md:auto-rows-[minmax(0,17rem)]',
          // One column on phones, two on medium, four on large — the bento rhythm.
          'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
          // Positioning context for the pulse overlay below. Harmless to the
          // grid itself — `relative` only creates the containing block.
          'relative',
          className,
        )}
      >
        {children}

        {/* The discharge system lives in its own module (UI-19). */}
        <InterCardPulse ref={pulseRef} targetRef={gridRef} inViewRef={inViewRef} />
      </div>
    </SpotlightContext.Provider>
  )
}

export default BentoGrid
