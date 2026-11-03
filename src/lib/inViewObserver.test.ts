import { describe, expect, it } from 'vitest'
import { createInViewBinding, type InViewObserverLike } from '@/lib/inViewObserver'

/**
 * Assertions for CR-13's fix.
 *
 * The bug was lifecycle, not arithmetic: the observer was created once, when the element might not
 * exist yet, and nothing ever retried. These tests pin the retry semantics down without a DOM --
 * the binding takes its element getter, its margin and its observer factory as parameters.
 */

interface FakeObserver extends InViewObserverLike {
  readonly margin: string
  observed: Element[]
  disconnected: boolean
  deliver: (isIntersecting: boolean) => void
}

function harness() {
  const created: FakeObserver[] = []
  let element: Element | null = null
  let margin = '25% 0px 25% 0px'
  const seen: boolean[] = []

  const binding = createInViewBinding({
    getElement: () => element,
    getRootMargin: () => margin,
    onIntersect: (inView) => seen.push(inView),
    createObserver: (onEntries, rootMargin) => {
      const observer: FakeObserver = {
        margin: rootMargin,
        observed: [],
        disconnected: false,
        observe(target) {
          this.observed.push(target)
        },
        disconnect() {
          this.disconnected = true
        },
        deliver(isIntersecting) {
          onEntries([{ isIntersecting }])
        },
      }
      created.push(observer)
      return observer
    },
  })

  return {
    binding,
    created,
    seen,
    setElement: (next: Element | null) => {
      element = next
    },
    setMargin: (next: string) => {
      margin = next
    },
    live: () => created.filter((observer) => !observer.disconnected),
  }
}

const node = (): Element => ({}) as Element

describe('createInViewBinding', () => {
  it('does not observe anything while the element is missing, and retries when it appears', () => {
    const h = harness()

    h.binding.sync()
    expect(h.created).toHaveLength(0)

    const first = node()
    h.setElement(first)
    h.binding.sync()

    expect(h.created).toHaveLength(1)
    expect(h.created[0].observed).toEqual([first])
  })

  it('re-running sync with the same element and margin creates nothing new', () => {
    const h = harness()
    h.setElement(node())
    h.binding.sync()
    h.binding.sync()
    h.binding.sync()

    expect(h.created).toHaveLength(1)
    expect(h.created[0].observed).toHaveLength(1)
  })

  it('detaches the old observer when the element is replaced', () => {
    const h = harness()
    const first = node()
    h.setElement(first)
    h.binding.sync()

    const second = node()
    h.setElement(second)
    h.binding.sync()

    expect(h.created).toHaveLength(2)
    expect(h.created[0].disconnected).toBe(true)
    expect(h.live()).toHaveLength(1)
    expect(h.created[1].observed).toEqual([second])
  })

  it('re-creates the observer when the margin changes', () => {
    const h = harness()
    h.setElement(node())
    h.binding.sync()

    h.setMargin('600px 0px 600px 0px')
    h.binding.sync()

    expect(h.created).toHaveLength(2)
    expect(h.created[0].disconnected).toBe(true)
    expect(h.created[1].margin).toBe('600px 0px 600px 0px')
  })

  it('forwards every entry as a boolean', () => {
    const h = harness()
    h.setElement(node())
    h.binding.sync()

    h.created[0].deliver(true)
    h.created[0].deliver(false)

    expect(h.seen).toEqual([true, false])
  })

  it('tolerates an environment with no IntersectionObserver, then wires one when available', () => {
    const h = harness()
    const element = node()
    h.setElement(element)

    // A factory that reports "unsupported" must not throw or remember the attempt as success.
    const unsupported = createInViewBinding({
      getElement: () => element,
      getRootMargin: () => '0px',
      onIntersect: () => {},
      createObserver: () => null,
    })
    expect(() => {
      unsupported.sync()
      unsupported.sync()
    }).not.toThrow()

    h.binding.sync()
    expect(h.created).toHaveLength(1)
  })

  it('disconnect() detaches and allows a later sync to observe again', () => {
    const h = harness()
    h.setElement(node())
    h.binding.sync()
    h.binding.disconnect()

    expect(h.created[0].disconnected).toBe(true)
    expect(h.live()).toHaveLength(0)

    h.binding.sync()
    expect(h.created).toHaveLength(2)
    expect(h.live()).toHaveLength(1)
  })
})
