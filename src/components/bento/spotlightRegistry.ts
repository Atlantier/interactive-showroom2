import { createContext, useContext } from 'react'

/**
 * Registration channel between `BentoGrid` and the `SpotlightCard`s it owns.
 *
 * The grid needs to drive every card from ONE `mousemove` listener, and it needs
 * to mutate each card's CSS custom properties plus its tilt `MotionValue`s
 * imperatively. Passing callbacks down as props would mean re-rendering every
 * child whenever the grid re-renders, so instead each card publishes a small
 * imperative handle into this registry on mount and removes it on unmount.
 *
 * Style note: this is deliberately not state. A registry that never triggers a
 * render is exactly what keeps cursor tracking at display-refresh rate.
 */

export interface SpotlightHandle {
  /**
   * Update the card's spotlight position and tilt.
   *
   * @param localX Cursor X relative to the card's top-left corner, in px.
   *               May fall outside `[0, width]` — that is what lets the border
   *               glow light up before the cursor actually enters the card.
   * @param localY Cursor Y relative to the card's top-left corner, in px.
   * @param width  Card width in px.
   * @param height Card height in px.
   */
  update: (localX: number, localY: number, width: number, height: number) => void
  /** Return the card to rest (pointer left the grid). */
  reset: () => void
}

export interface SpotlightRegistry {
  register: (element: HTMLElement, handle: SpotlightHandle) => void
  unregister: (element: HTMLElement) => void
}

export const SpotlightContext = createContext<SpotlightRegistry | null>(null)

/**
 * Access the spotlight registry.
 *
 * Returns `null` when a `SpotlightCard` is rendered outside a `BentoGrid`, in
 * which case the card simply renders without motion — a deliberate degradation
 * rather than a crash, so the component stays usable standalone.
 */
export function useSpotlightRegistry(): SpotlightRegistry | null {
  return useContext(SpotlightContext)
}
