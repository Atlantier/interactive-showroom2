import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { soundEngine } from '@/utils/soundEngine'

/**
 * PB-12: the audio graph must not exist before a real gesture, and a suspended context must never
 * be used to schedule voices.
 *
 * These run in `node`, so the Web Audio API is a stand-in. That is the point: the behaviour under
 * test is the engine's POLICY (when to build the context, when to schedule), and a fake makes both
 * observable -- how many contexts were constructed, which triggers produced a voice, and whether
 * `resume()` was asked for instead of scheduling.
 */

class FakeNode {
  connect(): this {
    return this
  }
  disconnect(): void {}
}

class FakeParam {
  value = 0
  setValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
}

class FakeOscillator extends FakeNode {
  type = 'sine'
  frequency = new FakeParam()
  start = vi.fn()
  stop = vi.fn()
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []

  state: AudioContextState = 'suspended'
  /** Deliberately non-zero: a frozen clock at 0 is exactly what PB-12 is about. */
  currentTime = 3.5
  sampleRate = 48_000
  destination = new FakeNode()
  oscillators: FakeOscillator[] = []
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createGain(): FakeNode & { gain: FakeParam } {
    return Object.assign(new FakeNode(), { gain: new FakeParam() })
  }

  createDynamicsCompressor(): FakeNode & {
    threshold: FakeParam
    knee: FakeParam
    ratio: FakeParam
    attack: FakeParam
    release: FakeParam
  } {
    return Object.assign(new FakeNode(), {
      threshold: new FakeParam(),
      knee: new FakeParam(),
      ratio: new FakeParam(),
      attack: new FakeParam(),
      release: new FakeParam(),
    })
  }

  createAnalyser(): FakeNode & {
    fftSize: number
    smoothingTimeConstant: number
    getByteTimeDomainData: (data: Uint8Array) => void
    getByteFrequencyData: (data: Uint8Array) => void
  } {
    return Object.assign(new FakeNode(), {
      fftSize: 512,
      smoothingTimeConstant: 0,
      getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
      getByteFrequencyData: (data: Uint8Array) => data.fill(0),
    })
  }

  createBiquadFilter(): FakeNode & { type: string; frequency: FakeParam; Q: FakeParam } {
    return Object.assign(new FakeNode(), {
      type: 'lowpass',
      frequency: new FakeParam(),
      Q: new FakeParam(),
    })
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator
  }

  createBufferSource(): FakeNode & {
    buffer: unknown
    playbackRate: FakeParam
    loop: boolean
    start: () => void
  } {
    return Object.assign(new FakeNode(), {
      buffer: null,
      playbackRate: new FakeParam(),
      loop: false,
      start: () => {},
    })
  }
}

/** A document that records listeners so a test can "be" the gesture. */
function fakeDocument() {
  const listeners = new Map<string, EventListener[]>()
  return {
    listeners,
    addEventListener: (type: string, listener: EventListener) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      const list = listeners.get(type) ?? []
      listeners.set(
        type,
        list.filter((entry) => entry !== listener),
      )
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener(new Event(type))
    },
  }
}

let doc: ReturnType<typeof fakeDocument>

beforeEach(() => {
  FakeAudioContext.instances = []
  doc = fakeDocument()
  vi.stubGlobal('window', { AudioContext: FakeAudioContext })
  vi.stubGlobal('document', doc)
  soundEngine.dispose()
  soundEngine.setEnabled(false)
})

afterEach(() => {
  soundEngine.dispose()
  vi.unstubAllGlobals()
})

describe('soundEngine autoplay policy (PB-12)', () => {
  it('enabling sound from a persisted preference builds nothing, and waits for a gesture', () => {
    soundEngine.setEnabled(true)

    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(soundEngine.state).toBe('uninitialised')
    // The unlock listeners are the mechanism that replaces eager construction.
    expect(doc.listeners.get('pointerdown')?.length).toBe(1)
    expect(doc.listeners.get('keydown')?.length).toBe(1)
  })

  it('builds the context on the first gesture, and the clock it schedules against is running', () => {
    soundEngine.setEnabled(true)
    doc.fire('pointerdown')

    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(soundEngine.state).toBe('running')

    soundEngine.playLocaleConfirm()
    const ctx = FakeAudioContext.instances[0]
    expect(ctx.oscillators.length).toBeGreaterThan(0)
  })

  it('drops a trigger instead of scheduling it when the context is suspended', () => {
    soundEngine.setEnabled(true)
    doc.fire('pointerdown')

    const ctx = FakeAudioContext.instances[0]
    ctx.state = 'suspended'
    ctx.resume.mockClear()
    ctx.oscillators.length = 0

    soundEngine.playLocaleConfirm()

    // Nothing queued against a frozen clock, and a resume was requested instead.
    expect(ctx.oscillators).toHaveLength(0)
    expect(ctx.resume).toHaveBeenCalled()
  })

  it('does not build a context for a preference that is off', () => {
    soundEngine.setEnabled(false)
    doc.fire('pointerdown')

    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(soundEngine.state).toBe('uninitialised')
  })

  it('dispose() closes the graph and detaches the gesture listeners', () => {
    soundEngine.setEnabled(true)
    doc.fire('pointerdown')
    expect(doc.listeners.get('pointerdown')?.length).toBe(1)

    soundEngine.dispose()

    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled()
    expect(soundEngine.state).toBe('uninitialised')
    expect(doc.listeners.get('pointerdown')?.length).toBe(0)
  })
})
