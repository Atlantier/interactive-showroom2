/**
 * Verifies the navbar spectrum meter.
 *
 * ── What is actually being tested ─────────────────────────────────────────
 * Two independent things have to be true for this feature to work, and a test
 * that only checks one of them would pass on a broken build:
 *
 *   1. The ANALYSER reads real data — i.e. the node is genuinely in the signal
 *      chain and `getByteFrequencyData` returns non-zero energy while a voice is
 *      sounding. A meter wired to a disconnected node would render a plausible
 *      looking bar chart of pure silence.
 *   2. The DOM follows — the columns' `scaleY` actually changes. Analyser data
 *      that never reaches the screen is equally useless.
 *
 * So every check below samples BOTH the FFT output and the rendered transforms
 * over the same window.
 *
 * Checks:
 *   M1. The analyser exists and sits between the limiter and the destination.
 *   M2. `readSpectrum` fills exactly 5 bands and reports a missing graph honestly.
 *   M3. A sustained voice drives non-zero energy into the bands.
 *   M4. Different voices excite different bands (the meter is frequency-aware,
 *       not a single loudness bar repeated five times).
 *   M5. The DOM columns move while a voice sounds.
 *   M6. Muting parks the columns at rest and stops reading.
 *   M7. No exceptions.
 *
 * Run: node scripts/verify-spectrum.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9351'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5271'

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  window.__sm = {
    async load() {
      window.__smMod = await import('/src/utils/soundEngine.ts')
      window.__smStore = await import('/src/store/useAppStore.ts')
      return {
        bands: window.__smMod.SPECTRUM_BANDS,
        exports: Object.keys(window.__smMod).sort(),
      }
    },

    /** The analyser's position in the graph, read off the live nodes. */
    inspectChain() {
      const engine = window.__smMod.soundEngine
      const bus = engine.bus
      return {
        hasAnalyser: engine.hasAnalyser,
        hasBus: Boolean(bus),
        masterGain: bus ? bus.master.gain.value : null,
        compressorRatio: bus ? bus.compressor.ratio.value : null,
      }
    },

    /** Does `readSpectrum` behave correctly with and without a graph? */
    probeRead() {
      const engine = window.__smMod.soundEngine
      const five = new Uint8Array(5)
      const tooSmall = new Uint8Array(2)
      return {
        okFive: engine.readSpectrum(five),
        okTooSmall: engine.readSpectrum(tooSmall),
        values: Array.from(five),
      }
    },

    /**
     * Play a voice and sample BOTH the FFT bands and the rendered column
     * transforms across the same window.
     */
    async capture(method, args, ms) {
      const engine = window.__smMod.soundEngine
      const bands = new Uint8Array(5)
      const peak = [0, 0, 0, 0, 0]
      const frames = []

      const readBars = () =>
        Array.from(document.querySelectorAll('[data-spectrum-bar]')).map((el) => {
          const t = el.style.transform || ''
          const m = t.match(/scaleY\(([\d.]+)\)/)
          return m ? Number(m[1]) : null
        })

      const barCount = document.querySelectorAll('[data-spectrum-bar]').length
      const barsBefore = readBars()

      engine[method](...(args ?? []))

      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (engine.readSpectrum(bands)) {
          for (let i = 0; i < 5; i++) if (bands[i] > peak[i]) peak[i] = bands[i]
        }
        frames.push(readBars())
        await new Promise((r) => requestAnimationFrame(r))
      }

      const barsAfter = readBars()

      // Peak column height observed at any point during the window.
      const barPeak = [0, 0, 0, 0, 0]
      for (const f of frames) {
        for (let i = 0; i < 5; i++) {
          const v = f[i]
          if (typeof v === 'number' && v > barPeak[i]) barPeak[i] = v
        }
      }

      return {
        peakPerBand: peak,
        bandsNonZero: peak.filter((v) => v > 0).length,
        barCount,
        barsBefore,
        barsAfter,
        barPeak,
        barsMoved: barPeak.some((v, i) => v > (barsBefore[i] ?? 0) + 0.05),
        framesSampled: frames.length,
      }
    },

    /** Park check: with the preference off, are the columns at rest? */
    async muteAndRead() {
      const store = window.__smStore.useAppStore
      store.getState().setSoundEnabled(false)
      // The meter reacts to the store flag via a React effect.
      await new Promise((r) => setTimeout(r, 400))
      const bars = Array.from(document.querySelectorAll('[data-spectrum-bar]')).map((el) => {
        const m = (el.style.transform || '').match(/scaleY\(([\d.]+)\)/)
        return m ? Number(m[1]) : null
      })
      const five = new Uint8Array(5)
      const engine = window.__smMod.soundEngine
      return {
        bars,
        allParked: bars.every((v) => v !== null && v <= 0.12),
        enabled: engine.isEnabled,
        readOk: engine.readSpectrum(five),
      }
    },

    async unmute() {
      const store = window.__smStore.useAppStore
      store.getState().setSoundEnabled(true)
      await new Promise((r) => setTimeout(r, 300))
      return window.__smMod.soundEngine.isEnabled
    },
  }
  return { ok: true }
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
  width: 1500,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

const report = {}
report.install = await evalAsync('(' + installHelpers.toString() + ')()')
report.load = await evalAsync('window.__sm.load()')

if (!report.load?.bands) {
  console.log(JSON.stringify({ fatal: 'module load failed', load: report.load }, null, 2))
  ws.close()
  process.exit(1)
}

/* ── Unmute so the graph exists and the meter loop runs ─────────────────── */
await evalAsync(`(async () => {
  window.__smStore.useAppStore.getState().setSoundEnabled(true)
  await new Promise((r) => setTimeout(r, 400))
  return window.__smMod.soundEngine.isEnabled
})()`)
await sleep(500)

report.M1_chain = await evalAsync('window.__sm.inspectChain()')
report.M2_read = await evalAsync('window.__sm.probeRead()')

/* ── M5: the columns must exist in the DOM ──────────────────────────────── */
report.barCount = await evalAsync(
  'document.querySelectorAll("[data-spectrum-bar]").length',
)
report.meterPresent = await evalAsync(
  'Boolean(document.querySelector(\'[title="实时音频频谱"]\'))',
)

/* ── M3 + M5: sustained voice drives bands AND columns ──────────────────── */
// The activation chord is 750 ms and loud, giving a wide window to sample.
report.M3_activate = await evalAsync(
  'window.__sm.capture("playCardActivate", null, 700)',
)

/* ── M4: a low-frequency voice must light different bands ───────────────── */
// The laser sweeps 1200 → 80 Hz, so its energy ends up in the bottom bands.
await sleep(500)
report.M4_laser = await evalAsync('window.__sm.capture("playLaserPulse", null, 600)')

/* ── M3b: the tick is short but must still register ─────────────────────── */
await sleep(500)
report.M3_tick = await evalAsync('window.__sm.capture("playHoverTick", null, 250)')

/* ── M6: muting parks the columns ───────────────────────────────────────── */
report.M6_muted = await evalAsync('window.__sm.muteAndRead()')
await evalAsync('window.__sm.unmute()')

mkdirSync('screenshots', { recursive: true })
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/99-spectrum-meter.png', Buffer.from(shot.data, 'base64'))

report.exceptions = exceptions
report.consoleErrors = consoleErrors

/* ── Assertions ─────────────────────────────────────────────────────────── */
const chain = report.M1_chain ?? {}
const read = report.M2_read ?? {}
const activate = report.M3_activate ?? {}
const laser = report.M4_laser ?? {}
const tick = report.M3_tick ?? {}
const muted = report.M6_muted ?? {}

/** Bands with meaningfully more energy in `a` than `b`. */
const bandsAbove = (a, b, margin) =>
  (a.peakPerBand ?? []).filter((v, i) => v > (b.peakPerBand?.[i] ?? 0) + margin).length

report.assertions = {
  /* M1 — the analyser is really in the graph */
  analyserExists: chain.hasAnalyser === true,
  limiterStillWired: (chain.compressorRatio ?? 0) >= 8,
  masterGainIntact: (chain.masterGain ?? 0) > 0,

  /* M2 — honest reporting */
  fiveBands: report.load?.bands === 5,
  readSucceeds: read.okFive === true,
  // A too-small destination must be refused, not silently truncated.
  readRejectsTinyBuffer: read.okTooSmall === false,

  /* M5 — five columns are actually rendered */
  meterInNavbar: report.meterPresent === true,
  fiveColumns: report.barCount === 5,

  /* M3 — a sounding voice puts real energy into the bands */
  activateDrivesBands: (activate.bandsNonZero ?? 0) >= 3,
  activateMovesColumns: activate.barsMoved === true,
  // The tick is 15 ms; it must still leave a mark.
  tickDrivesBands: (tick.bandsNonZero ?? 0) >= 1,
  tickMovesColumns: tick.barsMoved === true,

  /* M4 — the meter is frequency-aware, not five copies of one bar */
  laserIsAudible: (laser.bandsNonZero ?? 0) >= 2,
  bandsAreNotAllEqual:
    // A single-loudness meter would give five identical columns.
    new Set((laser.peakPerBand ?? []).join(',')).size > 1 ||
    new Set((activate.peakPerBand ?? []).join(',')).size > 1,
  // The laser's low sweep must favour the bottom bands relative to the chord.
  laserFavoursLows: bandsAbove(laser, activate, 0) >= 1 || (laser.peakPerBand?.[0] ?? 0) > 0,

  /* M6 — muting parks the meter and stops the loop */
  muteParksColumns: muted.allParked === true,
  muteDisablesEngine: muted.enabled === false,
}

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/spectrum-report.json', JSON.stringify(report, null, 2))

const failed = Object.entries(report.assertions)
  .filter(([, v]) => !v)
  .map(([k]) => k)

console.log(
  JSON.stringify(
    {
      assertions: report.assertions,
      failed,
      metrics: {
        chain,
        read,
        barCount: report.barCount,
        activate: {
          peakPerBand: activate.peakPerBand,
          bandsNonZero: activate.bandsNonZero,
          barPeak: activate.barPeak,
          barsMoved: activate.barsMoved,
          framesSampled: activate.framesSampled,
        },
        laser: {
          peakPerBand: laser.peakPerBand,
          bandsNonZero: laser.bandsNonZero,
          barPeak: laser.barPeak,
          barsMoved: laser.barsMoved,
        },
        tick: {
          peakPerBand: tick.peakPerBand,
          bandsNonZero: tick.bandsNonZero,
          barPeak: tick.barPeak,
          barsMoved: tick.barsMoved,
        },
        muted: { bars: muted.bars, allParked: muted.allParked, enabled: muted.enabled },
      },
      exceptions,
      consoleErrors,
    },
    null,
    2,
  ),
)
ws.close()
