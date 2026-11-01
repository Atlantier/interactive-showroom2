/**
 * SoundEngine — a pure-code procedural synthesizer.
 *
 * ── No audio files ────────────────────────────────────────────────────────
 * Every sound here is generated from oscillators, noise buffers and biquad
 * filters at call time. That keeps the bundle free of binary assets, lets each
 * sound react to live values (collision velocity, for instance), and means there
 * is nothing to preload or decode.
 *
 * ── Signal chain ──────────────────────────────────────────────────────────
 *
 *   voice(s) ──▶ master GainNode ──▶ DynamicsCompressorNode ──▶ destination
 *
 * The compressor sits AFTER the master gain and acts as a safety limiter. This
 * matters because the app can fire several voices within the same 40 ms window —
 * a card activation while the hover tick is still ringing, or a burst of physics
 * collisions — and summed peaks would otherwise clip into audible crackle. With
 * a −14 dB threshold and a 12:1 ratio the stack is held together instead of
 * distorting.
 *
 * ── Autoplay policy ───────────────────────────────────────────────────────
 * Browsers refuse to start an AudioContext without a user gesture. The context is
 * therefore created lazily on the first `setEnabled(true)` or first play call,
 * and `resume()` is retried on every play. Scheduling while the context is still
 * "suspended" is harmless: events are queued against `currentTime`, which is
 * frozen until the context actually starts, so they fire the moment it does.
 *
 * ── Testability ───────────────────────────────────────────────────────────
 * The five voices are exported as free functions taking a `BaseAudioContext`, so
 * they can be rendered through an `OfflineAudioContext` and analysed offline
 * without a speaker or a running audio clock. The singleton class is a thin
 * wrapper: enablement, throttling, and the shared bus.
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Minimum gap between two triggers of the SAME sound.
 *
 * A high-polling mouse sweeping a bento grid fires `pointermove` far faster than
 * any useful audible rate; without this the hover tick becomes a buzz. 40 ms is
 * below the ~50 ms threshold at which repeated transients fuse into a tone, so
 * each tick still reads as a discrete click.
 */
export const SOUND_THROTTLE_MS = 40

/** Gain values below this are inaudible; used as the exponential-ramp floor. */
const SILENCE = 0.0001

/** Master bus level, before the limiter. */
const MASTER_GAIN = 0.85

/**
 * Bands reported by `readSpectrum`.
 *
 * The navbar meter has five columns, so the analyser is read in five buckets
 * rather than exposing raw FFT bins: the caller should not have to know the
 * sample rate or the fft size to draw a level meter.
 */
export const SPECTRUM_BANDS = 5

/**
 * Band edges in Hz, inclusive of the lower bound and exclusive of the upper.
 *
 * Spaced roughly logarithmically, because audio energy is distributed that way
 * perceptually — a linear split would put four of the five bands inside the top
 * octave and leave the bottom three covering bass, low-mid and nothing else.
 * These edges also line up with what the voices actually produce: the laser
 * sweep crosses bands 1-3, the activation chord sits in 2-3, and the tick's
 * 1.8 kHz body and 3.4 kHz noise land in 4-5.
 */
const BAND_EDGES = [20, 140, 400, 1200, 3500, 16000] as const

/**
 * FFT size. 512 gives 256 bins, i.e. ~86 Hz per bin at 44.1 kHz.
 *
 * A smaller window would resolve transients better but leave the lowest bands
 * with only one or two bins each; 256 samples (the next size down) would put the
 * entire 20-140 Hz band inside bin zero.
 */
const FFT_SIZE = 512

/* -------------------------------------------------------------------------- */
/*  Shared noise source                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-context white-noise buffer, created once and reused.
 *
 * White noise is the basis of every transient here (the tick, the collision
 * click, the snap). Generating it per call would mean allocating a few hundred
 * thousand floats each time a card is hovered, so it is cached per context in a
 * WeakMap — which keeps `OfflineAudioContext` renders independent of the live
 * context and lets the whole cache disappear with the context.
 */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>()

function noiseFor(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx)
  if (cached) return cached

  // 0.4 s is longer than any transient needs, so a single buffer can be reused
  // by every voice without audible repetition.
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.4))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1
  }
  noiseCache.set(ctx, buffer)
  return buffer
}

/* -------------------------------------------------------------------------- */
/*  Voices                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A very short, bright mechanical tick — a watch crown or a camera dial.
 *
 * Two layers: a band-passed white-noise transient for the "click" (broadband,
 * so it reads as metal on metal) and an 1800 Hz sine for the resonant "ping". The
 * noise is filtered at 3.4 kHz with a moderate Q so it stays crisp rather than
 * hissy, and both layers decay in 15 ms, which is at the edge of what the ear
 * resolves as a discrete event rather than a click.
 */
export function renderHoverTick(ctx: BaseAudioContext, out: AudioNode, at: number): void {
  const duration = 0.015

  /* Noise transient through a band-pass. */
  const noise = ctx.createBufferSource()
  noise.buffer = noiseFor(ctx)
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.setValueAtTime(3400, at)
  band.Q.setValueAtTime(1.1, at)

  const noiseGain = ctx.createGain()
  noiseGain.gain.setValueAtTime(SILENCE, at)
  noiseGain.gain.exponentialRampToValueAtTime(0.5, at + 0.0012)
  noiseGain.gain.exponentialRampToValueAtTime(SILENCE, at + duration)

  noise.connect(band).connect(noiseGain).connect(out)
  noise.start(at)
  noise.stop(at + duration + 0.01)

  /* 1800 Hz sine body with a fast decay. */
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(1800, at)

  const oscGain = ctx.createGain()
  oscGain.gain.setValueAtTime(SILENCE, at)
  oscGain.gain.exponentialRampToValueAtTime(0.3, at + 0.001)
  oscGain.gain.exponentialRampToValueAtTime(SILENCE, at + duration)

  osc.connect(oscGain).connect(out)
  osc.start(at)
  osc.stop(at + duration + 0.01)
}

/**
 * A warm two-note activation chord.
 *
 * G4 with its perfect fifth (D5) — the interval is consonant, so the pair reads
 * as "affirmative" rather than as an alarm. A triangle wave supplies odd and even
 * harmonics at a gentle slope, and a lowpass sweeping 2.6 kHz → 900 Hz rolls the
 * top off as the chord decays, which is what makes it sound warm instead of
 * brittle.
 *
 * Attack and release are both ramps rather than steps: 35 ms in, 750 ms out. An
 * instantaneous attack would produce a click at these amplitudes.
 */
export function renderCardActivate(ctx: BaseAudioContext, out: AudioNode, at: number): void {
  const duration = 0.75
  const root = 392.0 // G4
  const fifth = 587.33 // D5, a perfect fifth above

  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.setValueAtTime(2600, at)
  tone.frequency.exponentialRampToValueAtTime(900, at + duration)
  tone.Q.setValueAtTime(0.6, at)

  const env = ctx.createGain()
  env.gain.setValueAtTime(SILENCE, at)
  env.gain.exponentialRampToValueAtTime(0.26, at + 0.035)
  env.gain.exponentialRampToValueAtTime(SILENCE, at + duration)

  env.connect(tone).connect(out)

  /* Root, fifth, and a quiet octave for body. Explicit rather than a loop over
     an array literal so nothing is allocated per activation. */
  const partials = 3
  for (let i = 0; i < partials; i++) {
    const freq = i === 0 ? root : i === 1 ? fifth : root * 2
    const level = i === 0 ? 1 : i === 1 ? 0.55 : 0.18
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, at)
    // A few cents of detune keeps the chord from sounding like a test tone.
    osc.detune.setValueAtTime(i * 4, at)

    const levelGain = ctx.createGain()
    levelGain.gain.setValueAtTime(level, at)
    osc.connect(levelGain).connect(env)
    osc.start(at)
    osc.stop(at + duration + 0.05)
  }
}

/**
 * A weighty acrylic/steel knock, parameterised by impact speed.
 *
 * ── Mapping ───────────────────────────────────────────────────────────────
 * Both loudness and pitch scale with `|v_rel|`, because a hard hit on a real
 * object is not just louder — it excites higher resonances.
 *
 *   loudness ∝ sqrt(v)   — perceptual, not linear. A linear map makes light taps
 *                          inaudible and hard hits deafening; the square root
 *                          compresses that range.
 *   pitch    = 170…930 Hz — the modal frequency of the body.
 *
 * The spectrum is deliberately inharmonic: a root, a 2.76× partial (the classic
 * bar/plate ratio that gives metal its "clang" rather than a pitched note), and a
 * band-passed noise transient for the contact itself.
 *
 * @param impactVelocity Relative normal velocity of the two bodies, in px/s.
 *                       The sign is ignored.
 */
export function renderPhysicsCollision(
  ctx: BaseAudioContext,
  out: AudioNode,
  at: number,
  impactVelocity: number,
): void {
  const speed = Math.abs(impactVelocity)
  /**
   * Reject non-finite input as well as trivial contacts.
   *
   * The `Number.isFinite` check is not redundant: `NaN < 45` evaluates to
   * `false`, so a bare magnitude test lets NaN through, and the value then
   * reaches `setValueAtTime`, which throws. Verified: calling this method with no
   * argument propagated a TypeError out of the caller's event handler.
   */
  if (!Number.isFinite(speed) || speed < 45) return

  const norm = Math.min(1, Math.sqrt(speed / 1400))
  const duration = 0.15 + norm * 0.13
  const base = 170 + norm * 760

  /* Contact transient. */
  const noise = ctx.createBufferSource()
  noise.buffer = noiseFor(ctx)
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.setValueAtTime(base * 2.4, at)
  band.Q.setValueAtTime(0.9, at)
  const noiseGain = ctx.createGain()
  noiseGain.gain.setValueAtTime(SILENCE, at)
  noiseGain.gain.exponentialRampToValueAtTime(0.4 * norm, at + 0.002)
  noiseGain.gain.exponentialRampToValueAtTime(SILENCE, at + duration * 0.5)
  noise.connect(band).connect(noiseGain).connect(out)
  noise.start(at)
  noise.stop(at + duration + 0.02)

  /* Two resonant partials: the fundamental and an inharmonic metal ratio. */
  const partialCount = 2
  for (let i = 0; i < partialCount; i++) {
    const freq = i === 0 ? base : base * 2.76
    const level = (i === 0 ? 0.34 : 0.17) * (0.35 + norm * 0.65)
    const decay = i === 0 ? duration : duration * 0.6

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, at)
    // A slight downward glide mimics the pitch drop as the body settles.
    osc.frequency.exponentialRampToValueAtTime(freq * 0.86, at + decay)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(SILENCE, at)
    gain.gain.exponentialRampToValueAtTime(Math.max(SILENCE, level), at + 0.004)
    gain.gain.exponentialRampToValueAtTime(SILENCE, at + decay)

    osc.connect(gain).connect(out)
    osc.start(at)
    osc.stop(at + decay + 0.02)
  }
}

/**
 * A lanyard cord snapping under load.
 *
 * Two simultaneous layers, because a real break is both a whip-crack and a thud:
 *
 *   SWEEP  a band-passed sawtooth falling 2800 → 680 Hz in 160 ms. The fast
 *          downward glide is the "twang" of the released tension; the high Q on
 *          the band-pass gives it the whistling edge the ear associates with a
 *          string letting go.
 *   THUMP  a 68 → 42 Hz sine with a 260 ms decay: the mass of the badge dropping.
 *
 * The two together read as a failure rather than as a musical note.
 */
export function renderRopeSnap(ctx: BaseAudioContext, out: AudioNode, at: number): void {
  const sweepDuration = 0.16

  /* High sweeping whistle. */
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(2800, at)
  osc.frequency.exponentialRampToValueAtTime(680, at + sweepDuration)

  const whistle = ctx.createBiquadFilter()
  whistle.type = 'bandpass'
  whistle.frequency.setValueAtTime(2400, at)
  whistle.frequency.exponentialRampToValueAtTime(900, at + sweepDuration)
  whistle.Q.setValueAtTime(6, at)

  const whistleGain = ctx.createGain()
  whistleGain.gain.setValueAtTime(SILENCE, at)
  whistleGain.gain.exponentialRampToValueAtTime(0.34, at + 0.006)
  whistleGain.gain.exponentialRampToValueAtTime(SILENCE, at + 0.3)

  osc.connect(whistle).connect(whistleGain).connect(out)
  osc.start(at)
  osc.stop(at + 0.34)

  /* Low impact thump. */
  const thump = ctx.createOscillator()
  thump.type = 'sine'
  thump.frequency.setValueAtTime(68, at)
  thump.frequency.exponentialRampToValueAtTime(42, at + 0.26)

  const thumpGain = ctx.createGain()
  thumpGain.gain.setValueAtTime(SILENCE, at)
  thumpGain.gain.exponentialRampToValueAtTime(0.42, at + 0.01)
  thumpGain.gain.exponentialRampToValueAtTime(SILENCE, at + 0.3)

  thump.connect(thumpGain).connect(out)
  thump.start(at)
  thump.stop(at + 0.34)
}

/**
 * The IK arm's laser: a descending sci-fi sweep, 1200 Hz → 80 Hz.
 *
 * An exponential ramp is used rather than a linear one because pitch is perceived
 * logarithmically — a linear sweep from 1200 Hz spends almost all its time in the
 * top octave and then drops instantly, which sounds like a fault rather than a
 * discharge. The exponential ramp moves through equal musical intervals per unit
 * time, which is what gives the "pew" its characteristic shape.
 *
 * A lowpass tracks the pitch downward so the tail darkens instead of just
 * getting quieter, and the whole voice is a single 420 ms gesture.
 */
export function renderLaserPulse(ctx: BaseAudioContext, out: AudioNode, at: number): void {
  const duration = 0.42

  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(1200, at)
  osc.frequency.exponentialRampToValueAtTime(80, at + duration)

  const body = ctx.createBiquadFilter()
  body.type = 'lowpass'
  body.frequency.setValueAtTime(1200, at)
  body.frequency.exponentialRampToValueAtTime(240, at + duration)
  body.Q.setValueAtTime(7, at)

  const env = ctx.createGain()
  env.gain.setValueAtTime(SILENCE, at)
  env.gain.exponentialRampToValueAtTime(0.3, at + 0.012)
  env.gain.exponentialRampToValueAtTime(SILENCE, at + duration)

  osc.connect(body).connect(env).connect(out)
  osc.start(at)
  osc.stop(at + duration + 0.03)
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                   */
/* -------------------------------------------------------------------------- */

/** Identifier used for per-sound throttling. */
type SoundId = 'hover' | 'activate' | 'collision' | 'snap' | 'laser'

class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private analyser: AnalyserNode | null = null

  /**
   * Reused FFT buffer, so a 60 Hz meter read allocates nothing.
   *
   * Typed as `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: since
   * TypeScript 5.7 the typed-array generics distinguish a plain ArrayBuffer from
   * a SharedArrayBuffer, and `getByteFrequencyData` only accepts the former.
   */
  private spectrumScratch: Uint8Array<ArrayBuffer> | null = null

  private enabled = false

  /** Last trigger time per sound, in `performance.now()` milliseconds. */
  private readonly lastTriggeredAt = new Map<SoundId, number>()

  /** Bound once, so the unlock listener can be removed when it fires. */
  private readonly unlock = (): void => {
    if (!this.enabled) return
    const ctx = this.ctx
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }

  /**
   * Whether audio output is currently enabled by the user preference.
   * Note this is the preference, not the context state.
   */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** Context state, for diagnostics and tests. `'uninitialised'` before first use. */
  get state(): string {
    return this.ctx ? this.ctx.state : 'uninitialised'
  }

  /**
   * The shared output bus, or null before the context exists.
   *
   * Exposed so diagnostics and verification can assert the chain is actually
   * wired as documented — that the master gain feeds the limiter and not the
   * destination directly, which is the mistake that would let stacked transients
   * clip.
   */
  get bus(): { master: GainNode; compressor: DynamicsCompressorNode } | null {
    if (!this.master || !this.compressor) return null
    return { master: this.master, compressor: this.compressor }
  }

  /**
   * Turn sound on or off.
   *
   * Disabling suspends the context rather than merely muting the master gain:
   * a suspended context stops the audio thread entirely, so a page left open
   * with sound off costs nothing.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled

    if (!enabled) {
      // Clear throttling history so re-enabling does not start mid-window.
      this.lastTriggeredAt.clear()
      const ctx = this.ctx
      if (ctx && ctx.state === 'running') void ctx.suspend()
      return
    }

    const ctx = this.ensureContext()
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume()
  }

  /** Release the audio graph. Exposed for tests and teardown. */
  dispose(): void {
    this.enabled = false
    this.lastTriggeredAt.clear()
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', this.unlock)
      document.removeEventListener('keydown', this.unlock)
    }
    const ctx = this.ctx
    if (ctx) void ctx.close()
    this.ctx = null
    this.master = null
    this.compressor = null
    this.analyser = null
    this.spectrumScratch = null
  }

  /* ── Spectrum ─────────────────────────────────────────────────────────── */

  /** Whether a live analyser exists to read from. */
  get hasAnalyser(): boolean {
    return this.analyser !== null
  }

  /**
   * Fill `out` with `SPECTRUM_BANDS` magnitudes, each 0-255.
   *
   * Returns `false` when there is nothing to read — audio never enabled, or the
   * context torn down — so the caller can park its meter at rest rather than
   * treating a missing graph as silence.
   *
   * Each band reports the PEAK bin inside it rather than the mean. A mean would
   * bury a pure tone under the empty bins around it, so a 392 Hz chord would
   * barely lift its column; the peak makes tonal content read at its true level,
   * which is what a spectrum display is for.
   *
   * Allocation-free: the FFT buffer and the output are both supplied by the
   * caller (the buffer is cached here).
   *
   * @param out - Destination array; must be at least `SPECTRUM_BANDS` long.
   */
  /** Time-domain scratch for `readEnergy`; allocated on first use. */
  private timeScratch: Uint8Array<ArrayBuffer> | null = null

  /**
   * Instantaneous loudness envelope, normalised to 0..1.
   *
   * Uses the TIME-DOMAIN signal (RMS of the waveform), not the frequency
   * spectrum. For a visual envelope the question is "how loud is it right now",
   * and RMS answers exactly that; peak-per-band would make a single bright bin
   * read as a full-scale pulse. It is also cheaper: one pass over `fftSize`
   * samples with no per-band binning.
   *
   * The 3.2 gain maps a typical UI blip — which peaks well below full scale —
   * onto most of the range, so the visuals respond to ordinary interactions
   * rather than only to the loudest cue in the set.
   *
   * Returns 0 when audio is not running, which is what makes the whole
   * audio-reactive layer degrade silently rather than freezing at some value.
   */
  readEnergy(): number {
    const analyser = this.analyser
    if (!analyser) return 0

    const bins = analyser.fftSize
    if (!this.timeScratch || this.timeScratch.length !== bins) {
      this.timeScratch = new Uint8Array(bins)
    }
    analyser.getByteTimeDomainData(this.timeScratch)

    const data = this.timeScratch
    let sum = 0
    for (let i = 0; i < bins; i++) {
      // 128 is silence in unsigned 8-bit audio.
      const v = (data[i] - 128) / 128
      sum += v * v
    }

    const rms = Math.sqrt(sum / bins)
    const energy = rms * 3.2
    return energy > 1 ? 1 : energy
  }

  readSpectrum(out: Uint8Array): boolean {
    const analyser = this.analyser
    const ctx = this.ctx
    if (!analyser || !ctx) return false
    if (out.length < SPECTRUM_BANDS) return false

    const bins = analyser.frequencyBinCount
    if (!this.spectrumScratch || this.spectrumScratch.length !== bins) {
      this.spectrumScratch = new Uint8Array(bins)
    }
    analyser.getByteFrequencyData(this.spectrumScratch)
    const data = this.spectrumScratch

    // Bin width in Hz. Bins are LINEAR in frequency, which is exactly why the
    // band edges above are not.
    const binHz = ctx.sampleRate / 2 / bins

    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const loHz = BAND_EDGES[b]
      const hiHz = BAND_EDGES[b + 1]
      const lo = Math.min(bins - 1, Math.max(0, Math.floor(loHz / binHz)))
      const hi = Math.min(bins, Math.max(lo + 1, Math.ceil(hiHz / binHz)))

      let peak = 0
      for (let i = lo; i < hi; i++) {
        const v = data[i]
        if (v > peak) peak = v
      }
      out[b] = peak
    }
    return true
  }

  /* ── Public voices ───────────────────────────────────────────────────── */

  /** A dial-like tick. Safe to call on every pointermove; throttled internally. */
  playHoverTick(): void {
    const bus = this.begin('hover')
    if (!bus) return
    renderHoverTick(bus.ctx, bus.out, bus.at)
  }

  /** Warm two-note chord for a card or layer activation. */
  playCardActivate(): void {
    const bus = this.begin('activate')
    if (!bus) return
    renderCardActivate(bus.ctx, bus.out, bus.at)
  }

  /**
   * Acrylic/metal impact.
   *
   * @param impactVelocity Relative normal velocity in px/s; drives loudness and pitch.
   */
  playPhysicsCollision(impactVelocity: number): void {
    const bus = this.begin('collision')
    if (!bus) return
    renderPhysicsCollision(bus.ctx, bus.out, bus.at, impactVelocity)
  }

  /** Cord failure: sweep + thump. */
  playRopeSnap(): void {
    const bus = this.begin('snap')
    if (!bus) return
    renderRopeSnap(bus.ctx, bus.out, bus.at)
  }

  /** Laser discharge sweep. */
  playLaserPulse(): void {
    const bus = this.begin('laser')
    if (!bus) return
    renderLaserPulse(bus.ctx, bus.out, bus.at)
  }

  /* ── Internals ───────────────────────────────────────────────────────── */

  /**
   * Gate a trigger: check enablement, apply the throttle, ensure the graph, and
   * hand back what the voice needs to schedule itself.
   *
   * Returning `null` is the normal "do not play" path and covers three cases —
   * sound off, throttled, and no Web Audio support.
   */
  private begin(id: SoundId): { ctx: AudioContext; out: AudioNode; at: number } | null {
    if (!this.enabled) return null

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const last = this.lastTriggeredAt.get(id)
    if (last !== undefined && now - last < SOUND_THROTTLE_MS) return null
    this.lastTriggeredAt.set(id, now)

    const ctx = this.ensureContext()
    if (!ctx || !this.master) return null
    if (ctx.state === 'closed') return null

    // Scheduling while suspended is fine: `currentTime` is frozen, so the events
    // fire as soon as the resume lands.
    if (ctx.state === 'suspended') void ctx.resume()

    return { ctx, out: this.master, at: ctx.currentTime }
  }

  /**
   * Create the context and the shared bus on first use.
   *
   * Lazy rather than at module load because constructing an AudioContext during
   * page load logs a console warning in every browser that enforces the autoplay
   * policy, and it would be created even for visitors who never enable sound.
   */
  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    if (typeof window === 'undefined') return null

    const w = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const Ctor = w.AudioContext ?? w.webkitAudioContext
    if (!Ctor) return null

    const ctx = new Ctor()

    const master = ctx.createGain()
    master.gain.value = MASTER_GAIN

    // Safety limiter. Tuned for stacked short transients rather than for music:
    // a slow 3 ms attack would let a collision spike through, so it is fast, and
    // the 180 ms release lets the bus recover between rapid hits.
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -14
    compressor.knee.value = 6
    compressor.ratio.value = 12
    compressor.attack.value = 0.003
    compressor.release.value = 0.18

    /**
     * The meter tap.
     *
     * Placed AFTER the limiter so the display shows what is actually leaving the
     * bus. Tapping the master gain instead would let the meter show peaks that
     * the compressor had already tamed — the bars would claim a loudness the ear
     * never receives.
     *
     * An AnalyserNode passes its input through unchanged, so inserting it in the
     * chain costs one node and does not alter the signal.
     */
    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    // Faster than the 0.8 default: a 15 ms hover tick must still register as a
    // visible blip, and 0.8 would smear it across ~10 frames of decay.
    analyser.smoothingTimeConstant = 0.62

    master.connect(compressor).connect(analyser).connect(ctx.destination)

    this.ctx = ctx
    this.master = master
    this.compressor = compressor
    this.analyser = analyser
    this.spectrumScratch = null

    // Any gesture can unlock audio; both are cheap and one-shot in practice.
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', this.unlock, { passive: true })
      document.addEventListener('keydown', this.unlock)
    }

    return ctx
  }
}

/** The app-wide instance. Import this, not the class. */
export const soundEngine = new SoundEngine()

export default soundEngine
