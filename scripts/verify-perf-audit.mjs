/**
 * Verifies the performance audit: viewport culling, adaptive quality and the
 * developer telemetry HUD.
 *
 * ── Measuring "did it actually sleep?" ────────────────────────────────────
 * The meaningful proof is that GPU work STOPS, not that a flag flipped. For the
 * R3F canvas that is `gl.info.render.frame` —a counter three.js increments on
 * every `gl.render()` call. Scrolling the section away must freeze it; scrolling
 * back must resume it. That cannot be faked by an early-returning `useFrame`,
 * which is exactly why it is the right thing to measure.
 *
 * The 2D sandboxes are checked the same way, against the physics clock they
 * publish.
 *
 * Checks:
 *   P1. Culling: the architecture canvas' render counter freezes off screen.
 *   P2. Culling: it resumes when scrolled back, with no stall.
 *   P3. Culling: the 2D sandboxes stop advancing their simulation clocks.
 *   P4. Adaptive: particle count is 8000 on 'high' and 4000 on 'medium'.
 *   P5. Adaptive: DPR is capped at 1.0 on 'medium'.
 *   P6. Adaptive: ChromaticAberration is present on 'high', absent on 'medium'.
 *   P7. Adaptive: the store's auto-downgrade respects a manual tier choice.
 *   P8. HUD: Shift+D opens and closes the telemetry panel.
 *   P9. HUD: it reports live FPS, frame time, particles and heap.
 *   P10. No exceptions.
 *
 * Run: node scripts/verify-perf.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { findMissing, finish } from './lib/verify.mjs'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9355'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5275'

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  window.__pf = {
    async load() {
      window.__pfStore = await import('/src/store/useAppStore.ts')
      window.__pfMetrics = await import('/src/lib/perfMetrics.ts')
      return { ok: true }
    },

    /**
     * The ARCHITECTURE canvas' frame counter.
     *
     * Must be `__archScene`, not `__showroomScene`: the latter belongs to the
     * fixed, full-viewport background nebula, which is on screen at every scroll
     * position and therefore renders unconditionally. Measuring it would report
     * "always rendering" no matter how well the culling worked —which is exactly
     * the false negative the first run of this check produced.
     */
    renderFrames() {
      const h = window.__archScene
      return h && h.gl ? h.gl.info.render.frame : null
    },

    quality() {
      const h = window.__showroomScene
      return h && h.quality ? h.quality : null
    },

    /** The architecture canvas' RenderGate decision, for diagnosis. */
    gate() {
      const h = window.__archScene
      return h && h.gate ? h.gate : null
    },

    /** Live pixel ratio of the drawing buffer. */
    pixelRatio() {
      const h = window.__showroomScene
      return h && h.gl ? h.gl.getPixelRatio() : null
    },

    tiers() {
      return window.__pfStore.useAppStore.getState().performanceTier
    },

    setTier(t) {
      window.__pfStore.useAppStore.getState().setPerformanceTier(t)
      return window.__pfStore.useAppStore.getState().performanceTier
    },

    /** Is the 2D sandbox simulation clock advancing? */
    sandboxClock() {
      // The Verlet sandbox exposes its sim; a sleeping sandbox stops stepping it.
      const sim = window.__lanyardSim
      if (!sim) return null
      return sim.lanyards[0].points[5].x + sim.lanyards[0].points[5].y
    },

    /** Scroll so a section is centred, or far away. */
    scrollTo(selector, mode) {
      const el = document.querySelector(selector)
      if (!el) return false
      if (mode === 'far') {
        // Scroll to the very top or bottom, well away from this section.
        const rect = el.getBoundingClientRect()
        const away = rect.top > window.innerHeight / 2 ? 0 : document.body.scrollHeight
        window.scrollTo(0, away)
      } else {
        el.scrollIntoView({ block: 'center' })
      }
      return true
    },

    /** Sample a value repeatedly with rAF, returning first/last/min/max. */
    async sample(fn, ms) {
      const getter = new Function('return (' + fn + ')()')
      const values = []
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const v = getter()
        if (typeof v === 'number') values.push(v)
        await new Promise((r) => requestAnimationFrame(r))
      }
      if (!values.length) return null
      return {
        first: values[0],
        last: values[values.length - 1],
        delta: values[values.length - 1] - values[0],
        min: Math.min(...values),
        max: Math.max(...values),
        samples: values.length,
      }
    },

    /** Shift+D via a real key event, so the app's own listener runs. */
    pressShortcut() {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'D',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      return window.__pfStore.useAppStore.getState().perfHudOpen
    },

    hudOpen() {
      return window.__pfStore.useAppStore.getState().perfHudOpen
    },

    hudText() {
      const el = document.querySelector('[aria-label="性能遥测面板"]')
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
    },

    hudMetric(name) {
      const el = document.querySelector('[aria-label="性能遥测面板"]')
      if (!el) return null
      // Rows come in two shapes: a semantic <dt>/<dd> pair, and a header div
      // whose label is a plain <span> (the HEAP row, which also holds the
      // sparkline canvas). Match either, or the heap row reads as missing.
      for (const dt of Array.from(el.querySelectorAll('dt'))) {
        if (dt.textContent?.trim() === name) {
          const dd = dt.parentElement?.querySelector('dd')
          return dd ? dd.textContent.trim() : null
        }
      }
      for (const span of Array.from(el.querySelectorAll('span'))) {
        if (span.textContent?.trim() === name && span.parentElement) {
          return span.parentElement.textContent.replace(/\s+/g, ' ').trim()
        }
      }
      return null
    },

    counters() {
      const c = window.__pfMetrics.performanceCounters
      return {
        particles: c.particles,
        physicsSolveMs: Number(c.physicsSolveMs.toFixed(3)),
        physicsSolveAvgMs: Number(c.physicsSolveAvgMs.toFixed(3)),
        ikSolveMs: Number(c.ikSolveMs.toFixed(3)),
        heapMB: Number(c.heapMB.toFixed(1)),
        heapAvailable: c.heapAvailable,
        heapCount: c.heapCount,
        sleepingCanvases: c.sleepingCanvases,
      }
    },

    /** Make the monitor's arithmetic observable without waiting for a real stall. */
    degrade(reason) {
      window.__pfStore.useAppStore.getState().degradePerformanceTier(reason)
      return window.__pfStore.useAppStore.getState().performanceTier
    },

    armSetting() {
      return window.__pfStore.useAppStore.getState().autoDowngradeArmed
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
  width: 1600,
  height: 1000,
  deviceScaleFactor: 2, // emulate a retina / 4K-class display
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(8000)

const report = {}
report.install = await evalAsync('(' + installHelpers.toString() + ')()')
report.load = await evalAsync('window.__pf.load()')

/* ── P1/P2: canvas culling ──────────────────────────────────────────────── */
// Park the architecture section on screen and let it run.
await evalAsync('window.__pf.scrollTo("#architecture", "center")')
await sleep(2500)
report.P1_beforeScrollAway = await evalAsync('window.__pf.renderFrames()')

await evalAsync(`(async () => {
  window.scrollTo(0, 0)
  await new Promise((r) => setTimeout(r, 900))
  return true
})()`)
await sleep(600)
report.P1_offscreenSample = await evalAsync(
  'window.__pf.sample(function () { return window.__pf.renderFrames() }, 900)',
)
report.P1_gateWhileOffscreen = await evalAsync('window.__pf.gate()')
report.P1_qualityWhileOffscreen = await evalAsync('window.__pf.counters()')

// Back on screen: the counter must move again.
await evalAsync('window.__pf.scrollTo("#architecture", "center")')
await sleep(1200)
report.P2_onscreenSample = await evalAsync(
  'window.__pf.sample(function () { return window.__pf.renderFrames() }, 900)',
)

/* ── P3: 2D sandbox culling ─────────────────────────────────────────────── */
await evalAsync('window.__pf.scrollTo("#playground", "center")')
await sleep(1800)
report.P3_sandboxAwake = await evalAsync(
  'window.__pf.sample(function () { return window.__pf.sandboxClock() }, 800)',
)
await evalAsync(`(async () => {
  window.scrollTo(0, 0)
  await new Promise((r) => setTimeout(r, 900))
  return true
})()`)
await sleep(500)
report.P3_sandboxAsleep = await evalAsync(
  'window.__pf.sample(function () { return window.__pf.sandboxClock() }, 800)',
)

/* ── P4/P5/P6: tier levers ──────────────────────────────────────────────── */
await evalAsync('window.__pf.scrollTo("#hero", "center")')
await sleep(1200)

// Force a medium -> high transition so the tier effect definitely runs; setting
// a value that is already current produces no render and therefore no probe
// update.
await evalAsync(`(async () => {
  const store = window.__pfStore.useAppStore
  store.setState({ performanceTier: 'medium', autoDowngradeArmed: true })
  await new Promise((r) => setTimeout(r, 500))
  store.setState({ performanceTier: 'high', autoDowngradeArmed: true })
  await new Promise((r) => setTimeout(r, 700))
  return store.getState().performanceTier
})()`)
await sleep(900)
report.P4_high = await evalAsync(`({
  quality: window.__pf.quality(),
  pixelRatio: window.__pf.pixelRatio(),
  counters: window.__pf.counters(),
})`)

await evalAsync('window.__pf.degrade("verification")')
await sleep(1800)
report.P4_medium = await evalAsync(`({
  quality: window.__pf.quality(),
  pixelRatio: window.__pf.pixelRatio(),
  counters: window.__pf.counters(),
  tier: window.__pf.tiers(),
  notice: document.body.innerText.includes('已切换至性能模式'),
})`)

/* ── P7: a manual choice disarms the automatic monitor ──────────────────── */
report.P7_armAfterManual = await evalAsync(`(async () => {
  window.__pfStore.useAppStore.setState({ performanceTier: 'medium', autoDowngradeArmed: true })
  await new Promise((r) => setTimeout(r, 200))
  window.__pf.setTier('high')       // manual choice
  const armedAfterManual = window.__pf.armSetting()
  window.__pf.degrade('should be ignored')
  await new Promise((r) => setTimeout(r, 300))
  return {
    armedAfterManual,
    tierAfterIgnoredDegrade: window.__pf.tiers(),
  }
})()`)

/* ── P8/P9: telemetry HUD ───────────────────────────────────────────────── */
report.P8_closed = await evalAsync('window.__pf.hudOpen()')
report.P8_afterShortcut = await evalAsync('window.__pf.pressShortcut()')
await sleep(900)
report.P9_hudText = await evalAsync('window.__pf.hudText()')
report.P9_metrics = await evalAsync(`(async () => {
  await new Promise((r) => setTimeout(r, 1200))
  return {
    fps: window.__pf.hudMetric('FPS'),
    frame: window.__pf.hudMetric('FRAME'),
    particles: window.__pf.hudMetric('PARTICLES'),
    physSolve: window.__pf.hudMetric('PHYS SOLVE'),
    ikSolve: window.__pf.hudMetric('IK SOLVE'),
    heap: window.__pf.hudMetric('HEAP'),
    canvas: window.__pf.hudMetric('CANVAS a/s'),
    counters: window.__pf.counters(),
  }
})()`)

mkdirSync('screenshots', { recursive: true })
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/102-perf-telemetry.png', Buffer.from(shot.data, 'base64'))

report.P8_afterSecondShortcut = await evalAsync('window.__pf.pressShortcut()')

report.exceptions = exceptions
report.consoleErrors = consoleErrors

/* ── Assertions ─────────────────────────────────────────────────────────── */
const off = report.P1_offscreenSample ?? {}
const on = report.P2_onscreenSample ?? {}
const awake = report.P3_sandboxAwake ?? {}
const asleep = report.P3_sandboxAsleep ?? {}
const high = report.P4_high ?? {}
const medium = report.P4_medium ?? {}
const hud = report.P9_metrics ?? {}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

report.assertions = {
  /* P1 —the canvas genuinely stops rendering while off screen */
  renderFrozenOffscreen: (num(off.delta) ?? 1) === 0,
  renderFramesObserved: (off.samples ?? 0) > 20,

  /* P2 —and resumes, without a stall */
  renderResumesOnscreen: (num(on.delta) ?? 0) > 10,

  /* P3 —the 2D physics loop stops too */
  // A rope point oscillates, so the delta can legitimately be negative; what
  // matters is that the value MOVED. Comparing `delta > 0` would fail on any
  // sample window that happened to end lower than it started.
  sandboxRanWhileVisible: (num(awake.max) ?? 0) - (num(awake.min) ?? 0) > 0.001,
  sandboxFrozenWhileOffscreen: (num(asleep.max) ?? 1) - (num(asleep.min) ?? 0) === 0,

  /* P4 —both particle systems halve on the medium tier.
   *
   * Asserted per system AND as a total. The aggregate alone (8000 -> 4000) was
   * what this check used to test, and it silently kept passing when a second
   * producer was added: the sum doubled, the assertion went red for the right
   * reason but pointed at the wrong thing. Checking `particleCounts` names the
   * system that regressed; the total still catches arithmetic drift between
   * them. Medium is nebula 4000 + trail 2000, so the halves are 8000/4000 and
   * 4000/2000.
   */
  highParticles:
    high.counters?.particleCounts?.nebula === 8000 &&
    high.counters?.particleCounts?.trail === 4000 &&
    high.counters?.particles === 12000,
  mediumParticles:
    medium.counters?.particleCounts?.nebula === 4000 &&
    medium.counters?.particleCounts?.trail === 2000 &&
    medium.counters?.particles === 6000,

  /* P5 —DPR pinned to exactly 1.0 on medium */
  mediumDprIsOne: num(medium.pixelRatio) === 1,

  /* P6 —ChromaticAberration is dropped on medium */
  highHasChromaticAberration:
    Array.isArray(high.quality?.effects) && high.quality.effects.includes('ChromaticAberration'),
  mediumDropsChromaticAberration:
    Array.isArray(medium.quality?.effects) &&
    !medium.quality.effects.includes('ChromaticAberration'),
  mediumKeepsVignette:
    Array.isArray(medium.quality?.effects) && medium.quality.effects.includes('Vignette'),

  /* The user is told about the downgrade */
  downgradeNoticeShown: medium.notice === true,

  /* P7 —a manual tier choice is never overridden */
  manualChoiceDisarmsMonitor: report.P7_armAfterManual?.armedAfterManual === false,
  ignoredDegradeAfterManual: report.P7_armAfterManual?.tierAfterIgnoredDegrade === 'high',

  /* P8 —Shift+D toggles the panel */
  hudStartsClosed: report.P8_closed === false,
  shortcutOpensHud: report.P8_afterShortcut === true,
  shortcutClosesHud: report.P8_afterSecondShortcut === false,

  /* P9 —the panel reports live values, not placeholders */
  hudShowsFps: num(parseFloat(hud.fps ?? '')) !== null && parseFloat(hud.fps) > 0,
  hudShowsFrameTime: num(parseFloat(hud.frame ?? '')) !== null && parseFloat(hud.frame) > 0,
  // The displayed count must match the live counter, so a hard-coded string
  // could not pass.
  hudShowsParticles: hud.particles === (hud.counters?.particles ?? 0).toLocaleString('en-US'),
  // The physics sandbox is on screen in this state, so its solver must be timed.
  hudShowsPhysicsSolve: num(hud.counters?.physicsSolveMs) !== null,
  hudShowsHeap:
    (hud.counters?.heapAvailable ?? false)
      ? num(parseFloat((hud.heap ?? '').replace(/^HEAP/, ''))) !== null
      : true,
}

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/perf-report.json', JSON.stringify(report, null, 2))

const failed = Object.entries(report.assertions)
  .filter(([, v]) => !v)
  .map(([k]) => k)

console.log(
  JSON.stringify(
    {
      assertions: report.assertions,
      failed,
      metrics: {
        offscreen: off,
        gateWhileOffscreen: report.P1_gateWhileOffscreen,
        onscreen: on,
        sandboxAwake: awake,
        sandboxAsleep: asleep,
        high: {
          effects: high.quality?.effects,
          particles: high.counters?.particles,
          dpr: high.pixelRatio,
        },
        medium: {
          effects: medium.quality?.effects,
          particles: medium.counters?.particles,
          dpr: medium.pixelRatio,
        },
        hud,
        arm: report.P7_armAfterManual,
      },
      hudText: report.P9_hudText,
      exceptions,
      consoleErrors,
    },
    null,
    2,
  ),
)

finish({ failures: findMissing(report), label: 'perf-audit', exceptions, consoleErrors, report })
ws.close()
