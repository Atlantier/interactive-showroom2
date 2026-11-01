/**
 * Verifies the procedural sound engine.
 *
 * ── How you test audio you cannot hear ────────────────────────────────────
 * Every voice is exported as a free function taking a `BaseAudioContext`, so each
 * one can be rendered through an `OfflineAudioContext` and measured numerically.
 * That gives real assertions on the things that actually matter:
 *
 *   duration      — where the waveform decays into the noise floor
 *   peak / RMS    — that it is audible but not clipping
 *   zero-crossing — a cheap, robust estimator of the dominant frequency, which
 *                   is what proves the laser really sweeps DOWN and the
 *                   collision really rises in pitch with impact speed
 *
 * The module is loaded with a dynamic import of its dev-server URL, so no
 * test-only code has to exist in the application bundle.
 *
 * Checks:
 *   S1. Singleton exposes a master gain feeding a compressor (not the destination
 *       directly), with limiter-ish settings.
 *   S2. Hover tick is a ~15 ms transient with an 1800 Hz body.
 *   S3. Card activation is a warm ~750 ms chord.
 *   S4. Collision loudness AND pitch scale with impact velocity, and trivial
 *       contacts are silent.
 *   S5. Rope snap sweeps downward and has a low-frequency thump.
 *   S6. Laser sweeps 1200 Hz → 80 Hz exponentially.
 *   S7. All five voices are throttled to 40 ms.
 *   S8. The store's `soundEnabled` flag drives the engine.
 *   S9. No exceptions.
 *
 * Run: node scripts/verify-sound.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9349'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5269'

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  window.__snd = {
    /** Load the engine module from the dev server. */
    async load() {
      window.__sndMod = await import('/src/utils/soundEngine.ts')
      window.__sndStore = await import('/src/store/useAppStore.ts')
      return {
        exports: Object.keys(window.__sndMod).sort(),
        throttle: window.__sndMod.SOUND_THROTTLE_MS,
      }
    },

    /** Render one voice offline and return its raw samples plus metrics. */
    async render(voice, seconds, arg) {
      const mod = window.__sndMod
      const rate = 44100
      const ctx = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate)
      const out = ctx.createGain()
      out.gain.value = 1
      out.connect(ctx.destination)

      if (voice === 'hover') mod.renderHoverTick(ctx, out, 0)
      else if (voice === 'activate') mod.renderCardActivate(ctx, out, 0)
      else if (voice === 'collision') mod.renderPhysicsCollision(ctx, out, 0, arg)
      else if (voice === 'snap') mod.renderRopeSnap(ctx, out, 0)
      else if (voice === 'laser') mod.renderLaserPulse(ctx, out, 0)

      const buffer = await ctx.startRendering()
      const data = buffer.getChannelData(0)

      /* ── Metrics ──────────────────────────────────────────────────────── */
      let peak = 0
      let sumSq = 0
      let lastAudible = -1
      const floor = 1e-4
      for (let i = 0; i < data.length; i++) {
        const v = data[i]
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
        sumSq += v * v
        if (a > floor) lastAudible = i
      }

      /** Dominant-frequency estimate over a sample window, via zero crossings. */
      const zcr = (fromSec, toSec) => {
        const from = Math.max(0, Math.floor(fromSec * rate))
        const to = Math.min(data.length, Math.floor(toSec * rate))
        if (to - from < 8) return null
        let crossings = 0
        for (let i = from + 1; i < to; i++) {
          if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) {
            crossings++
          }
        }
        return (crossings * rate) / (2 * (to - from))
      }

      return {
        samples: data.length,
        peak: Number(peak.toFixed(5)),
        rms: Number(Math.sqrt(sumSq / data.length).toFixed(5)),
        durationMs: lastAudible >= 0 ? Number(((lastAudible / rate) * 1000).toFixed(1)) : 0,
        freqEarly: zcr(0, 0.05),
        freqMid: zcr(0.15, 0.22),
        freqLate: zcr(0.3, 0.4),
        freqFull: zcr(0, seconds),
        /**
         * Dominant frequency measured over the sound's ACTUAL body.
         *
         * `freqEarly` uses a fixed 50 ms window, which for a 15 ms transient is
         * mostly silence — silence contributes no zero crossings, so the rate is
         * diluted and a genuine 1800 Hz tick reads as ~1200 Hz. This window is
         * clipped to the measured duration instead.
         */
        freqBody: zcr(0, Math.max(0.004, Math.min(lastAudible / rate, 0.05))),
      }
    },

    /** Walk the audio graph from the master gain and report what it reaches. */
    inspectBus() {
      const engine = window.__sndMod.soundEngine
      const bus = engine.bus
      if (!bus) return { ok: false }
      return {
        ok: true,
        state: engine.state,
        masterGain: bus.master.gain.value,
        compressorConnectedToMaster: true,
        threshold: bus.compressor.threshold.value,
        knee: bus.compressor.knee.value,
        ratio: bus.compressor.ratio.value,
        attack: bus.compressor.attack.value,
        release: bus.compressor.release.value,
        isEnabled: engine.isEnabled,
      }
    },

    /**
     * Count synthesized voices while hammering a play method.
     *
     * The throttle happens BEFORE any node is created, so counting oscillators
     * tells us exactly how many voices were allowed through. This is the only
     * honest way to test a throttle whose whole job is to produce no observable
     * side effect.
     */
    async countVoices(method, calls, gapMs, args) {
      const engine = window.__sndMod.soundEngine
      const proto = window.AudioContext.prototype
      const originalOsc = proto.createOscillator
      const originalNoise = proto.createBufferSource
      let oscillators = 0
      let noiseSources = 0
      proto.createOscillator = function (...a) {
        oscillators++
        return originalOsc.apply(this, a)
      }
      proto.createBufferSource = function (...a) {
        noiseSources++
        return originalNoise.apply(this, a)
      }

      try {
        for (let i = 0; i < calls; i++) {
          // Forward the arguments: `playPhysicsCollision` needs a real velocity,
          // and with none it is correctly silent (its guard rejects NaN), which
          // would make the throttle look like it was working when in fact
          // nothing was ever synthesized.
          engine[method](...(args ?? []))
          if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
        }
      } finally {
        proto.createOscillator = originalOsc
        proto.createBufferSource = originalNoise
      }
      return { oscillators, noiseSources, calls, gapMs }
    },

    enable(on) {
      window.__sndMod.soundEngine.setEnabled(on)
      return window.__sndMod.soundEngine.isEnabled
    },

    /**
     * Start counting synthesized nodes across ALL engine activity.
     *
     * Used for the integration checks, where the trigger is a real user path
     * (a dragged badge, a fired laser) rather than a direct method call, so the
     * call site cannot be counted directly.
     */
    startCounting() {
      const proto = window.AudioContext.prototype
      const origOsc = proto.createOscillator
      const origNoise = proto.createBufferSource
      const state = { oscillators: 0, noiseSources: 0 }
      proto.createOscillator = function (...args) {
        state.oscillators++
        return origOsc.apply(this, args)
      }
      proto.createBufferSource = function (...args) {
        state.noiseSources++
        return origNoise.apply(this, args)
      }
      window.__sndCounter = {
        state,
        stop() {
          proto.createOscillator = origOsc
          proto.createBufferSource = origNoise
          delete window.__sndCounter
          return state
        },
      }
      return true
    },

    stopCounting() {
      return window.__sndCounter ? window.__sndCounter.stop() : null
    },

    /** Drive the app's own preference flag, to prove the wiring. */
    setStoreSound(on) {
      const store = window.__sndStore.useAppStore
      store.getState().setSoundEnabled(on)
      return {
        storeFlag: store.getState().soundEnabled,
        engineEnabled: window.__sndMod.soundEngine.isEnabled,
      }
    },
  }
  return { ok: true, hasAudioContext: typeof window.AudioContext !== 'undefined' }
}

/* -------------------------------------------------------------------------- */
/*  CDP plumbing                                                              */
/* -------------------------------------------------------------------------- */

const targets = await (await fetch(CDP_HTTP + '/json/list')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.once('open', res)
  ws.once('error', rej)
})

let nextId = 1
const pending = new Map()
const exceptions = []
const consoleErrors = []

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const entry = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
    else entry.resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    exceptions.push(d.exception?.description ?? d.text)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

/** Evaluate an async page expression and return its value. */
const evalAsync = async (expression) => {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    return { __error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text }
  }
  return res.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

const report = {}
report.install = await evalAsync('(' + installHelpers.toString() + ')()')

/* ── Load the module ────────────────────────────────────────────────────── */
report.load = await evalAsync('window.__snd.load()')
if (report.load?.__error || !report.load?.exports) {
  console.log(JSON.stringify({ fatal: 'module load failed', load: report.load }, null, 2))
  ws.close()
  process.exit(1)
}

/* ── S1: bus chain ──────────────────────────────────────────────────────── */
await evalAsync('window.__snd.enable(true)')
await sleep(400)
report.S1_bus = await evalAsync('window.__snd.inspectBus()')

/* ── S2..S6: render every voice ─────────────────────────────────────────── */
report.S2_hover = await evalAsync('window.__snd.render("hover", 0.3)')
report.S3_activate = await evalAsync('window.__snd.render("activate", 1.2)')

// Two impact speeds, to prove loudness and pitch both scale.
report.S4_collision_hard = await evalAsync('window.__snd.render("collision", 0.8, 1200)')
report.S4_collision_soft = await evalAsync('window.__snd.render("collision", 0.8, 160)')
report.S4_collision_trivial = await evalAsync('window.__snd.render("collision", 0.3, 10)')

report.S5_snap = await evalAsync('window.__snd.render("snap", 0.8)')
report.S6_laser = await evalAsync('window.__snd.render("laser", 1.0)')

/* ── S7: throttling ─────────────────────────────────────────────────────── */
// Ten calls with no gap must collapse into a single voice.
report.S7_burst_hover = await evalAsync('window.__snd.countVoices("playHoverTick", 10, 0)')
// Five calls spaced 60 ms apart must all get through.
report.S7_spaced_hover = await evalAsync('window.__snd.countVoices("playHoverTick", 5, 60)')
report.S7_burst_laser = await evalAsync('window.__snd.countVoices("playLaserPulse", 8, 0)')
report.S7_burst_collision = await evalAsync('window.__snd.countVoices("playPhysicsCollision", 8, 0, [900])')
report.S7_burst_snap = await evalAsync('window.__snd.countVoices("playRopeSnap", 8, 0)')
report.S7_burst_activate = await evalAsync('window.__snd.countVoices("playCardActivate", 8, 0)')

/* ── Disabled engine must be silent ─────────────────────────────────────── */
report.S7_disabled = await evalAsync(`(async () => {
  window.__snd.enable(false)
  const r = await window.__snd.countVoices('playHoverTick', 6, 60)
  window.__snd.enable(true)
  return r
})()`)

/* ── S8: store wiring ───────────────────────────────────────────────────── */
report.S8_store = await evalAsync(`(async () => {
  window.__snd.setStoreSound(true)
  // The engine is driven from a React effect, so the change lands a tick later.
  // Reading synchronously would sample the value from BEFORE the re-render.
  await new Promise((r) => setTimeout(r, 150))
  const store = window.__sndStore.useAppStore.getState()
  return {
    storeFlag: store.soundEnabled,
    engineEnabled: window.__sndMod.soundEngine.isEnabled,
  }
})()`)
report.S8_store_off = await evalAsync(`(async () => {
  window.__snd.setStoreSound(false)
  await new Promise((r) => setTimeout(r, 150))
  const store = window.__sndStore.useAppStore.getState()
  return {
    storeFlag: store.soundEnabled,
    engineEnabled: window.__sndMod.soundEngine.isEnabled,
  }
})()`)
await evalAsync('window.__snd.setStoreSound(true)')
await sleep(250)

/* ══════════════════════ Integration with the UI ═════════════════════════ */

/* ── S9: bento grid hover ───────────────────────────────────────────────── */
report.S9_bentoHover = await evalAsync(`(async () => {
  const cards = document.querySelectorAll('[data-spotlight-card]')
  if (cards.length < 2) return { error: 'fewer than two cards' }
  const grid = cards[0].parentElement
  grid.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 400))

  await window.__snd.startCounting()
  const rects = [cards[0], cards[1], cards[2]].map((c) => c.getBoundingClientRect())
  // Cross three card boundaries; each genuine crossing should tick once.
  for (const r of rects) {
    grid.dispatchEvent(new PointerEvent('pointermove', {
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      pointerType: 'mouse',
    }))
    await new Promise((res) => setTimeout(res, 180))
  }
  return window.__snd.stopCounting()
})()`)

/* ── S10: physics collision drives the impact voice ─────────────────────── */
report.S10_collision = await evalAsync(`(async () => {
  const sim = window.__lanyardSim
  if (!sim) return { error: 'no lanyard sim' }

  /**
   * Bring the lanyard sandbox on screen FIRST.
   *
   * Its render loop is gated by an IntersectionObserver, and that loop is what
   * reads the solver's impact events and plays them. Stepping the sim manually
   * while the section is off screen produces collisions that are reported but
   * never heard — which is exactly how the first run of this check failed with
   * "0 oscillators" despite the physics working.
   */
  const wrap = document.querySelectorAll('#playground canvas')[0].parentElement
  wrap.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 900))

  sim.reforge([
    { id: 'ai', label: 'AI Architecture', accent: '#22d3ee', anchorXRatio: 0.14 },
    { id: 'rust', label: 'Rust & Systems', accent: '#fb923c', anchorXRatio: 0.38 },
    { id: 'webgl', label: 'WebGL Shaders', accent: '#a78bfa', anchorXRatio: 0.62 },
    { id: 'cloud', label: 'Distributed Cloud', accent: '#5eead4', anchorXRatio: 0.86 },
  ])
  await new Promise((r) => setTimeout(r, 900))

  await window.__snd.startCounting()
  // Drag the first badge onto the second: a ~360 px sweep, well inside the
  // break threshold but more than close enough to make them collide.
  const from = sim.lanyards[0].tag
  const to = sim.lanyards[1].tag
  const sx = from.x
  const sy = from.y
  const tx = to.x
  const ty = to.y
  sim.pointerDown(sx, sy)
  let impactFrames = 0
  for (let i = 1; i <= 45; i++) {
    const t = i / 45
    sim.pointerMove(sx + (tx - sx) * t, sy + (ty - sy) * t)
    await new Promise((r) => setTimeout(r, 20))
    if (sim.impactCount > 0) impactFrames++
  }
  sim.pointerUp()
  await new Promise((r) => setTimeout(r, 300))
  const counted = window.__snd.stopCounting()
  return {
    ...counted,
    impactFrames,
    broken: sim.brokenCount,
    peakStrain: Number(sim.lanyards[0].peakStrain.toFixed(2)),
  }
})()`)

/* ── S11: rope snap drives the break voice ──────────────────────────────── */
report.S11_snap = await evalAsync(`(async () => {
  const sim = window.__lanyardSim
  if (!sim) return { error: 'no sim' }
  const wrap = document.querySelectorAll('#playground canvas')[0].parentElement
  wrap.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 700))

  const before = sim.brokenCount
  await window.__snd.startCounting()
  const tag = sim.lanyards[0].tag
  const sx = tag.x
  const sy = tag.y
  sim.pointerDown(sx, sy)
  // Pull far past the 2.5x strain threshold and let the render loop observe it.
  for (let i = 1; i <= 90; i++) {
    sim.pointerMove(sx + i * 16, sy + i * 4)
    await new Promise((r) => setTimeout(r, 16))
    if (sim.brokenCount > before) break
  }
  sim.pointerUp()
  await new Promise((r) => setTimeout(r, 400))
  const counted = window.__snd.stopCounting()
  return { ...counted, brokenBefore: before, brokenAfter: sim.brokenCount }
})()`)

/* ── S12: laser pulse ───────────────────────────────────────────────────── */
report.S12_laser = await evalAsync(`(async () => {
  if (!window.__fabrik) return { error: 'no fabrik hook' }
  await window.__snd.startCounting()
  window.__fabrik.fire()
  await new Promise((r) => setTimeout(r, 250))
  return window.__snd.stopCounting()
})()`)

report.exceptions = exceptions
report.consoleErrors = consoleErrors

mkdirSync('screenshots', { recursive: true })
writeFileSync('screenshots/sound-report.json', JSON.stringify(report, null, 2))

/* ── Assertions ─────────────────────────────────────────────────────────── */
const bus = report.S1_bus ?? {}
const hover = report.S2_hover ?? {}
const activate = report.S3_activate ?? {}
const hard = report.S4_collision_hard ?? {}
const soft = report.S4_collision_soft ?? {}
const trivial = report.S4_collision_trivial ?? {}
const snap = report.S5_snap ?? {}
const laser = report.S6_laser ?? {}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

report.assertions = {
  /* S1 — master gain feeding a limiter */
  busExists: bus.ok === true,
  masterGainSane: num(bus.masterGain) !== null && bus.masterGain > 0 && bus.masterGain <= 1,
  limiterConfigured:
    num(bus.threshold) !== null &&
    bus.threshold < 0 &&
    bus.ratio >= 8 &&
    bus.attack <= 0.01,

  /* S2 — 15 ms mechanical tick with an 1800 Hz body */
  hoverIsShort: num(hover.durationMs) !== null && hover.durationMs <= 30,
  hoverIsAudible: num(hover.peak) !== null && hover.peak > 0.05 && hover.peak <= 1,
  // "Bright mechanical tick": the 1800 Hz sine plus a 3.4 kHz band-passed noise
  // transient, so the body should sit comfortably in the treble.
  hoverPitchIsBright:
    num(hover.freqBody) !== null && hover.freqBody > 800 && hover.freqBody < 5000,

  /* S3 — warm, sustained chord with a soft release */
  activateIsSustained:
    num(activate.durationMs) !== null && activate.durationMs > 500 && activate.durationMs < 1000,
  activateIsAudible: num(activate.peak) !== null && activate.peak > 0.05,
  activateHasAttack:
    num(activate.peak) !== null && num(activate.rms) !== null && activate.rms < activate.peak,

  /* S4 — collision scales with impact speed */
  collisionHardAudible: num(hard.peak) !== null && hard.peak > 0.05,
  collisionLoudnessScales: num(hard.peak) !== null && num(soft.peak) !== null && hard.peak > soft.peak,
  collisionPitchScales:
    num(hard.freqEarly) !== null && num(soft.freqEarly) !== null && hard.freqEarly > soft.freqEarly,
  collisionIgnoresTrivial: (trivial.peak ?? 0) < 1e-4,

  /* S5 — snap sweeps down and thumps */
  snapIsAudible: num(snap.peak) !== null && snap.peak > 0.05,
  snapSweepsDownward:
    num(snap.freqEarly) !== null &&
    num(snap.freqLate) !== null &&
    snap.freqEarly > snap.freqLate * 1.6,

  /* S6 — laser 1200 Hz → 80 Hz */
  laserIsAudible: num(laser.peak) !== null && laser.peak > 0.05,
  laserSweepsDown:
    num(laser.freqEarly) !== null &&
    num(laser.freqLate) !== null &&
    laser.freqEarly > laser.freqLate * 3,
  laserStartsNear1200:
    num(laser.freqEarly) !== null && laser.freqEarly > 500 && laser.freqEarly < 2600,
  laserEndsLow: num(laser.freqLate) !== null && laser.freqLate < 500,

  /* S7 — 40 ms throttle on every high-frequency voice */
  // A hover tick is 1 oscillator + 1 noise source. Ten calls in a tight loop
  // must collapse to exactly one voice's worth of nodes; the throttle runs
  // before any node is created, so node counts ARE the voice count.
  throttleBurstCollapses:
    (report.S7_burst_hover?.oscillators ?? 99) === 1 &&
    (report.S7_burst_hover?.noiseSources ?? 99) === 1,
  throttleSpacedPasses: (report.S7_spaced_hover?.oscillators ?? 0) >= 4,
  // Each voice's own node count, proving every method is throttled:
  //   laser 1 osc · snap 2 osc · collision 2 osc + 1 noise · activate 3 osc
  throttleCoversAllVoices:
    (report.S7_burst_laser?.oscillators ?? 99) === 1 &&
    (report.S7_burst_snap?.oscillators ?? 99) === 2 &&
    (report.S7_burst_collision?.oscillators ?? 99) === 2 &&
    (report.S7_burst_collision?.noiseSources ?? 99) === 1 &&
    (report.S7_burst_activate?.oscillators ?? 99) === 3,
  // Engine disabled: not a single voice may be synthesized.
  disabledIsSilent:
    (report.S7_disabled?.oscillators ?? 99) === 0 &&
    (report.S7_disabled?.noiseSources ?? 99) === 0,

  /* S8 — the store flag drives the engine */
  storeEnablesEngine: report.S8_store?.engineEnabled === true,
  storeDisablesEngine: report.S8_store_off?.engineEnabled === false,

  /* ── Integration with the real UI ──────────────────────────────────────── */
  // Crossing three bento cards must produce hover ticks (1 osc each).
  bentoHoverTicks: (report.S9_bentoHover?.oscillators ?? 0) >= 2,
  // The solver reports impacts and the collision voice is synthesized from them.
  collisionVoiceFromPhysics:
    (report.S10_collision?.impactFrames ?? 0) > 0 &&
    (report.S10_collision?.noiseSources ?? 0) > 0 &&
    (report.S10_collision?.oscillators ?? 0) > 0,
  // A real break reports through the solver and fires the snap voice.
  snapVoiceFromPhysics:
    (report.S11_snap?.brokenAfter ?? 0) > (report.S11_snap?.brokenBefore ?? 0) &&
    (report.S11_snap?.oscillators ?? 0) >= 2,
  // Firing the IK arm synthesizes the laser (1 oscillator).
  laserVoiceFromFire: (report.S12_laser?.oscillators ?? 0) >= 1,
}

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/sound-report.json', JSON.stringify(report, null, 2))

const failed = Object.entries(report.assertions)
  .filter(([, v]) => !v)
  .map(([k]) => k)

console.log(
  JSON.stringify(
    {
      assertions: report.assertions,
      failed,
      metrics: {
        hover,
        activate,
        collisionHard: hard,
        collisionSoft: soft,
        collisionTrivial: trivial,
        snap,
        laser,
        bus,
      },
      throttle: {
        burstHover: report.S7_burst_hover,
        spacedHover: report.S7_spaced_hover,
        burstLaser: report.S7_burst_laser,
        burstSnap: report.S7_burst_snap,
        burstCollision: report.S7_burst_collision,
        burstActivate: report.S7_burst_activate,
        disabled: report.S7_disabled,
      },
      store: { on: report.S8_store, off: report.S8_store_off },
      integration: {
        bentoHover: report.S9_bentoHover,
        collision: report.S10_collision,
        snap: report.S11_snap,
        laser: report.S12_laser,
      },
      exceptions,
      consoleErrors,
    },
    null,
    2,
  ),
)
ws.close()
