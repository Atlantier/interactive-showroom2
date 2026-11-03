import { announce } from '@/lib/announce'
import { useAppStore } from '@/store/useAppStore'
import { getDictionary } from '@/i18n/useI18n'

/**
 * WebGL context loss (CR-12).
 *
 * ── What actually happens without this ──────────────────────────────────────
 * A driver reset, a GPU process crash, or a switch between integrated and discrete graphics takes
 * the GL context away. The canvas goes black, three.js stops drawing, and the page keeps scrolling
 * as if nothing happened: the visitor sees a dead background and an interface that gives no reason
 * for it. The review found no `webglcontextlost` handler anywhere in the repo.
 *
 * ── What the browser and three.js already do ────────────────────────────────
 * Restoration only happens if SOME listener calls `preventDefault()` on the lost event -- that is
 * the browser's signal that the app wants the context back. three.js does this inside its own
 * renderer, and it re-initialises everything on `webglcontextrestored`. So nothing here needs to
 * rebuild the scene; the app only needs to (a) make sure the default is prevented, and (b) tell the
 * visitor what happened while it is happening.
 *
 * ── Why capture phase on `document` ─────────────────────────────────────────
 * `webglcontextlost` does not bubble, and canvases are created by R3F at arbitrary depths (the
 * background scene, the architecture chapter). A capture-phase listener on `document` sees events
 * targeted at any descendant canvas without the app having to find and instrument each one, or to
 * re-instrument them when a canvas is recreated.
 */

/** Message shown while the context is gone; restored from the dictionary at event time. */
function contextLostMessage(): string {
  return getDictionary().hud.contextLost
}

export function installContextWatcher(): () => void {
  if (typeof document === 'undefined') return () => {}

  // The background and the architecture chapter own separate contexts. Restoring one must not
  // dismiss the notice while the other is still lost. WeakSet is insufficient: restoration needs
  // the count, and these canvases remain mounted while their contexts recover.
  const lostCanvases = new Set<HTMLCanvasElement>()

  const onLost = (event: Event): void => {
    if (!(event.target instanceof HTMLCanvasElement)) return
    // Ask the browser to attempt a restore. Without this the context is gone for good.
    event.preventDefault()
    if (lostCanvases.has(event.target)) return
    lostCanvases.add(event.target)
    if (lostCanvases.size > 1) return
    useAppStore.getState().setWebglContextLost(true)
    announce(contextLostMessage())
  }

  const onRestored = (event: Event): void => {
    if (!(event.target instanceof HTMLCanvasElement)) return
    if (!lostCanvases.delete(event.target) || lostCanvases.size > 0) return
    useAppStore.getState().setWebglContextLost(false)
    // three re-initialises the scene; announce without creating a second live region.
    announce(getDictionary().hud.contextRestored)
  }

  document.addEventListener('webglcontextlost', onLost, true)
  document.addEventListener('webglcontextrestored', onRestored, true)
  return () => {
    document.removeEventListener('webglcontextlost', onLost, true)
    document.removeEventListener('webglcontextrestored', onRestored, true)
    lostCanvases.clear()
    useAppStore.getState().setWebglContextLost(false)
  }
}

export default installContextWatcher
