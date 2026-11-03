/**
 * The IntersectionObserver lifecycle behind `useInViewAnimation`, as a testable unit.
 *
 * ── Why this exists (CR-13) ─────────────────────────────────────────────────
 * The hook used to create its observer inside a `useEffect` whose dependencies were `[ref,
 * rootMargin]`. A `RefObject` keeps its identity for the lifetime of the component, so that effect
 * ran exactly once -- at the first commit. If the observed element was not there yet (rendered
 * conditionally, behind Suspense, or replaced by a different node), `ref.current` was null at that
 * moment and the observer was **never attached**. The mutable `inView` flag then stayed at
 * `initial` for the rest of the session, which silently disabled the pause gate: off-screen
 * sandboxes kept simulating and off-screen canvases kept their rigs mounted. Nothing threw, so no
 * test noticed.
 *
 * A `RefObject` cannot notify anyone when its node attaches, so the hook has to re-check on every
 * render. That is cheap only if "re-check" means "compare and return", which is exactly what
 * `sync()` does: it is idempotent for an unchanged element and margin, and re-wires when either
 * moved.
 *
 * ── Why it is not a React hook itself ───────────────────────────────────────
 * The interesting behaviour is not React's -- it is "observe the right node exactly once, and
 * detach the old one when the node is replaced". Keeping it here means that sequence has assertions
 * in `inViewObserver.test.ts` instead of being trusted because it looks reasonable.
 */

/** Structural stand-in for `IntersectionObserver`, so tests need no DOM. */
export interface InViewObserverLike {
  observe(target: Element): void
  disconnect(): void
}

/** The only part of `IntersectionObserverEntry` this module reads. */
export interface InViewEntryLike {
  isIntersecting: boolean
}

export interface InViewBindingOptions {
  /** The element that should be observed *now*. Read on every `sync()`. */
  getElement: () => Element | null
  /** Current margin. Read on every `sync()` so a changed value re-creates the observer. */
  getRootMargin: () => string
  /** Forwarded for every entry. Deduplication is the hook's job. */
  onIntersect: (inView: boolean) => void
  /** Injected; returns null when the environment has no IntersectionObserver. */
  createObserver: (
    onEntries: (entries: InViewEntryLike[]) => void,
    rootMargin: string,
  ) => InViewObserverLike | null
}

export interface InViewBinding {
  /** Point the observer at whatever the ref holds now. Idempotent. */
  sync: () => void
  /** Detach and forget. Safe to call more than once. */
  disconnect: () => void
}

export function createInViewBinding(options: InViewBindingOptions): InViewBinding {
  let observer: InViewObserverLike | null = null
  let observed: Element | null = null
  let margin: string | null = null

  const teardown = (): void => {
    observer?.disconnect()
    observer = null
    observed = null
    margin = null
  }

  return {
    sync: (): void => {
      const element = options.getElement()
      const rootMargin = options.getRootMargin()

      /*
       * Same target, same margin: nothing to rewire.
       *
       * This guard is what makes "run on every render" cheap, and it is also a correctness
       * requirement: a fresh IntersectionObserver delivers its initial entry immediately, so
       * re-creating one per render would make an unchanged page report intersections forever.
       */
      if (
        element === observed &&
        rootMargin === margin &&
        (element === null || observer !== null)
      ) {
        return
      }

      teardown()
      if (!element) return

      const created = options.createObserver((entries) => {
        for (const entry of entries) options.onIntersect(entry.isIntersecting)
      }, rootMargin)
      if (!created) return

      observer = created
      observed = element
      margin = rootMargin
      created.observe(element)
    },

    disconnect: (): void => {
      teardown()
    },
  }
}
