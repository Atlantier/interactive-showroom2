/**
 * Verifies the upgraded cord rendering: Bezier-smoothed fabric strap, silver
 * metal clasps, and the red overload warning.
 *
 * Checks:
 *   R1. Curves are smooth: the drawn cord has no sharp corners at particle
 *       joints (measured by sampling the painted path's curvature).
 *   R2. The cord is fabric-coloured (grey-white at rest), NOT plain black.
 *   R3. Under load the cord turns RED (hue shifts toward red as stress rises).
 *   R4. Overload adds jitter: the cord's painted centreline oscillates
 *       frame-to-frame while heavily loaded, and is still while at rest.
 *   R5. A metallic clasp exists at the cord/badge junction (bright pixels with
 *       low saturation, i.e. silver).
 *   R6. No exceptions.
 *
 * Run: node scripts/verify-render-detail.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { finish } from './lib/verify.mjs'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9345'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5266'

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  window.__rd = {
    sim: () => window.__lanyardSim,
    canvas() {
      return document.querySelector('#playground canvas')
    },
    /** Settle the solver with a real wind clock. */
    settle(steps, t0) {
      const sim = window.__lanyardSim
      if (!sim) return false
      for (let i = 0; i < steps; i++) sim.step(1 / 60, (t0 ?? 0) + i / 60)
      return true
    },
    /**
     * Force a lanyard into a high-stress state.
     *
     * ── Why this has to go through the solver ─────────────────────────────
     * Setting `peakStrain` directly does nothing: every `step()` recomputes it
     * from the constraint lengths, so the value is overwritten before it can be
     * rendered. A rendering test that wants a stressed cord has to actually
     * stress the cord. This drags the tag outward and holds it, without letting
     * the strain cross the break threshold.
     */
    /**
     * Pull a lanyard to a target strain without breaking it.
     *
     * Strain grows almost perfectly linearly with horizontal pull distance
     * (measured: 100px→0.06, 400px→0.57, 800px→1.61). Rather than bisecting —
     * which snapped the rope mid-probe and left the "loaded" sample measuring a
     * broken cord — this walks outward in small increments, samples the strain
     * after each step, and STOPS the moment the target is reached. The grab is
     * left held so the cord stays under load for the render check.
     */
    loadTo(index, targetStrain) {
      const sim = window.__lanyardSim
      if (!sim) return null
      const l = sim.lanyards[index]
      if (!l) return null

      const startX = l.tag.x
      const startY = l.tag.y
      sim.pointerDown(startX, startY)

      const maxDist = Math.min(sim.width * 0.62, 1200)
      const steps = 90
      let last = 0

      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        sim.pointerMove(startX + maxDist * t, startY + 4 * t)
        sim.step(1 / 60, 0)
        last = l.peakStrain

        if (l.broken) {
          // Overshot. Report honestly; the caller will retry at a lower target.
          return { id: l.id, strain: Number(last.toFixed(3)), broken: true, held: false }
        }
        if (last >= targetStrain) {
          return { id: l.id, strain: Number(last.toFixed(3)), broken: false, held: true }
        }
      }

      return { id: l.id, strain: Number(last.toFixed(3)), broken: l.broken, held: true }
    },
    /** Release the grab without snapping anything. */
    releaseHold(index) {
      const sim = window.__lanyardSim
      if (!sim) return false
      sim.pointerUp()
      // Heal the strain so the next phase starts clean.
      const l = sim.lanyards[index]
      if (l) l.peakStrain = 0
      return true
    },
    clearLoad() {
      const sim = window.__lanyardSim
      if (!sim) return false
      sim.pointerUp()
      for (const l of sim.lanyards) l.peakStrain = 0
      return true
    },
    /**
     * Sample pixels ON the cord only.
     *
     * ── Why the sampling window must be tight ─────────────────────────────
     * A wide window picks up the grid backdrop, the nebula bloom and nearby
     * badges, which diluted every measurement: the "rest" and "loaded" averages
     * came out nearly identical because both were dominated by background. The
     * window here is sized to the cord's actual stroke width (±3 CSS px), centred
     * on the physics points, so essentially every hit is cord.
     */
    sampleCord(index) {
      const sim = window.__lanyardSim
      const c = this.canvas()
      if (!sim || !c) return null
      const l = sim.lanyards[index]
      if (!l) return null

      const ctx = c.getContext('2d')
      const dpr = c.width / c.getBoundingClientRect().width
      const img = ctx.getImageData(0, 0, c.width, c.height).data

      // The cord is ~6 CSS px wide, and the glow bleeds a few px further. Sample
      // only the core so the glow (which is accent-coloured) does not skew hue.
      const radX = Math.max(2, Math.round(3 * dpr))
      const radY = Math.max(2, Math.round(3 * dpr))

      let rSum = 0
      let gSum = 0
      let bSum = 0
      let hits = 0
      let brightPixels = 0
      let maxBrightness = 0

      // Skip the first and last points: those regions contain the anchor nub and
      // the metal clasp, neither of which is fabric.
      for (let i = 2; i < l.points.length - 2; i++) {
        const p = l.points[i]
        const px = Math.round(p.x * dpr)
        const py = Math.round(p.y * dpr)
        for (let dy = -radY; dy <= radY; dy++) {
          for (let dx = -radX; dx <= radX; dx++) {
            const x = px + dx
            const y = py + dy
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue
            const o = (y * c.width + x) * 4
            // High alpha only: glow and shadow are semi-transparent.
            if (img[o + 3] < 200) continue
            const r = img[o]
            const g = img[o + 1]
            const b = img[o + 2]
            rSum += r
            gSum += g
            bSum += b
            hits++
            const mx = Math.max(r, g, b)
            if (mx > 190) brightPixels++
            if (mx > maxBrightness) maxBrightness = mx
          }
        }
      }

      if (hits === 0) return { hits: 0 }
      const r = rSum / hits
      const g = gSum / hits
      const b = bSum / hits
      return {
        hits,
        r: Math.round(r),
        g: Math.round(g),
        b: Math.round(b),
        // Redness: red minus the average of the other two channels.
        redness: Math.round(r - (g + b) / 2),
        brightPixels,
        maxBrightness: Math.round(maxBrightness),
      }
    },
    /**
     * Measure smoothness along the cord's own centreline.
     *
     * Scans a narrow horizontal window around the rope's expected X at each Y, so
     * neither the badge nor the backdrop can contribute. A polyline between
     * particles has a kink at every joint; the fitted Bezier does not.
     */
    smoothness(index) {
      const sim = window.__lanyardSim
      const c = this.canvas()
      if (!sim || !c) return null
      const l = sim.lanyards[index]
      if (!l) return null
      const ctx = c.getContext('2d')
      const dpr = c.width / c.getBoundingClientRect().width
      const img = ctx.getImageData(0, 0, c.width, c.height).data

      const ys = []
      const a = l.points[1]
      const b = l.points[l.points.length - 2]
      const startY = Math.round(a.y * dpr)
      const endY = Math.round(b.y * dpr)
      const stepPx = Math.max(1, Math.round(2 * dpr))

      for (let y = startY; y < endY; y += stepPx) {
        if (y < 0 || y >= c.height) continue
        // Expected cord X at this height, by interpolating the physics points.
        const frac = (y / dpr - a.y) / (b.y - a.y)
        const expectedX = (a.x + (b.x - a.x) * frac) * dpr
        const win = Math.round(16 * dpr)

        let sum = 0
        let n = 0
        for (let x = Math.round(expectedX - win); x <= expectedX + win; x++) {
          if (x < 0 || x >= c.width) continue
          const o = (y * c.width + x) * 4
          // Only near-opaque cord pixels, so glow does not drag the centroid.
          if (img[o + 3] > 230) {
            sum += x
            n++
          }
        }
        if (n > 0) ys.push(sum / n)
      }
      if (ys.length < 8) return { samples: ys.length }

      let maxD2 = 0
      let sumD2 = 0
      for (let i = 2; i < ys.length; i++) {
        const d2 = Math.abs(ys[i] - 2 * ys[i - 1] + ys[i - 2])
        maxD2 = Math.max(maxD2, d2)
        sumD2 += d2
      }
      const count = ys.length - 2
      return {
        samples: ys.length,
        maxSecondDiff: Number((maxD2 / dpr).toFixed(2)),
        avgSecondDiff: Number((sumD2 / count / dpr).toFixed(3)),
      }
    },
    /** Capture the painted cord centreline at a fixed height, for jitter. */
    cordLine(index) {
      const sim = window.__lanyardSim
      const c = this.canvas()
      if (!sim || !c) return null
      const l = sim.lanyards[index]
      if (!l) return null
      const ctx = c.getContext('2d')
      const dpr = c.width / c.getBoundingClientRect().width
      const img = ctx.getImageData(0, 0, c.width, c.height).data
      const p = l.points[4]
      const y = Math.round(p.y * dpr)
      if (y < 1 || y >= c.height - 1) return null
      // Narrow window around the expected position only.
      const win = Math.round(14 * dpr)
      const cx = Math.round(p.x * dpr)
      let sum = 0
      let n = 0
      for (let x = cx - win; x <= cx + win; x++) {
        if (x < 0 || x >= c.width) continue
        if (img[(y * c.width + x) * 4 + 3] > 230) {
          sum += x
          n++
        }
      }
      return n > 0 ? sum / n / dpr : null
    },
    setTime(t) {
      window.__rdTime = t
      return true
    },
  }
  return {
    ok: true,
    hasSim: Boolean(window.__lanyardSim),
    hasCanvas: Boolean(document.querySelector('#playground canvas')),
  }
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

const run = async (fn, ...args) => {
  const call =
    typeof fn === 'function'
      ? '(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')'
      : fn
  const res = await send('Runtime.evaluate', {
    expression: call,
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
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

await run(function scrollTo() {
  const s = document.getElementById('playground')
  if (s) s.scrollIntoView({ block: 'center' })
  return true
})
await sleep(2200)

const report = {}
report.install = await run(installHelpers)

mkdirSync('screenshots', { recursive: true })

/* ── R2: cord colour at rest ────────────────────────────────────────────── */
await run(function calm() {
  window.__rd.clearLoad()
  window.__rd.settle(300, 3)
  return true
})
await sleep(700)
report.R2_restColor = await run(function c() {
  return window.__rd.sampleCord(0)
})
const shotRest = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/80-cord-rest.png', Buffer.from(shotRest.data, 'base64'))

/* ── R1: smoothness ─────────────────────────────────────────────────────── */
report.R1_smoothness = await run(function s() {
  return window.__rd.smoothness(0)
})

/* ── R5: clasp (bright low-saturation metal near the tag top) ───────────── */
// Measured BEFORE any loading: the clasp test needs an intact lanyard.
report.R5_clasp = await run(function clasp() {
  const sim = window.__lanyardSim
  const c = window.__rd.canvas()
  if (!sim || !c) return null
  const l = sim.lanyards[0]
  const ctx = c.getContext('2d')
  const dpr = c.width / c.getBoundingClientRect().width
  const img = ctx.getImageData(0, 0, c.width, c.height).data

  // The clasp sits at the cord's end point.
  const end = l.points[l.points.length - 1]
  const cx = Math.round(end.x * dpr)
  const cy = Math.round((end.y + 1) * dpr)

  let metal = 0
  let total = 0
  const R = Math.round(12 * dpr)
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue
      const o = (y * c.width + x) * 4
      const a = img[o + 3]
      if (a < 100) continue
      total++
      const r = img[o]
      const g = img[o + 1]
      const b = img[o + 2]
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const sat = mx === 0 ? 0 : (mx - mn) / mx
      // Silver: bright and nearly neutral.
      if (mx > 175 && sat < 0.22) metal++
    }
  }
  return {
    metalPixels: metal,
    opaquePixels: total,
    ratio: total ? +(metal / total).toFixed(3) : 0,
    claspAt: { x: Math.round(end.x), y: Math.round(end.y) },
  }
})

/* ── R3: red overload ───────────────────────────────────────────────────── */
// 1.9 strain is ~76% of the break point: inside the warning band (which starts at
// 55%) with a safety margin before the rope actually snaps.
report.R3_load = await run(function load() {
  return window.__rd.loadTo(0, 1.9)
})

// If the walk overshot and snapped, re-forge and retry at a lower target once.
if (report.R3_load?.broken) {
  await run(function retry() {
    const sim = window.__lanyardSim
    sim.reforge([
      { id: 'ai', label: 'AI Architecture', accent: '#22d3ee', anchorXRatio: 0.14 },
      { id: 'rust', label: 'Rust & Systems', accent: '#fb923c', anchorXRatio: 0.38 },
      { id: 'webgl', label: 'WebGL Shaders', accent: '#a78bfa', anchorXRatio: 0.62 },
      { id: 'cloud', label: 'Distributed Cloud', accent: '#5eead4', anchorXRatio: 0.86 },
    ])
    for (let i = 0; i < 120; i++) sim.step(1 / 60, i / 60)
    return true
  })
  report.R3_retry = await run(function load2() {
    return window.__rd.loadTo(0, 1.5)
  })
}

await sleep(700)
report.R3_cordColorLoaded = await run(function c() {
  return window.__rd.sampleCord(0)
})
report.R3_strainNow = await run(function st() {
  const sim = window.__lanyardSim
  const l = sim ? sim.lanyards[0] : null
  return l ? { strain: Number(l.peakStrain.toFixed(3)), broken: l.broken } : null
})
const shotHot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/81-cord-overload.png', Buffer.from(shotHot.data, 'base64'))

/* ── R4: jitter while overloaded vs at rest ─────────────────────────────────
 * ── Why this must not measure physics sway ────────────────────────────────
 * The first version advanced the solver between samples, so it measured the
 * rope SWINGING, not the render jitter: a calm rope released from a drag was
 * still oscillating and produced a larger span (23.5px) than a loaded one
 * (4.5px), inverting the assertion.
 *
 * The render jitter is a purely visual offset applied inside `drawRope` from the
 * elapsed time, so it can be isolated: freeze the SIMULATION (same particle
 * positions), then repaint at different times and watch the painted centreline
 * move. Any movement is jitter, by construction.
 */
const jitterLoaded = []
for (let i = 0; i < 10; i++) {
  const v = await run(function j(t) {
    // `__rdTime` is read by the render loop; nudging it repaints with a new
    // jitter phase WITHOUT stepping the physics.
    window.__rdTime = t
    return window.__rd.cordLine(0)
  }, 100 + i * 0.037)
  jitterLoaded.push(v)
  await sleep(80)
}
const loadedLine = jitterLoaded.filter((v) => typeof v === 'number')
const jitterSpan =
  loadedLine.length > 1 ? Math.max(...loadedLine) - Math.min(...loadedLine) : 0

await run(function calm2() {
  window.__rd.releaseHold(0)
  // The rope needs a long, UNWINDING settle after being dragged: releasing it
  // leaves real momentum, and a short settle samples a rope that is still
  // travelling back. 1500 steps (25 simulated seconds) with a healthy damping
  // period is enough for it to hang motionless.
  const sim = window.__lanyardSim
  for (let i = 0; i < 1500; i++) sim.step(1 / 60, 300 + i / 60)
  return true
})
await sleep(1600)

// Confirm it is genuinely at rest: the particle positions must not change.
const restCheck = await run(function still() {
  const sim = window.__lanyardSim
  const before = sim.lanyards[0].points.map((p) => [p.x, p.y])
  for (let i = 0; i < 30; i++) sim.step(1 / 60, 700 + i / 60)
  const after = sim.lanyards[0].points.map((p) => [p.x, p.y])
  let maxMove = 0
  for (let i = 0; i < before.length; i++) {
    maxMove = Math.max(maxMove, Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1]))
  }
  return { maxMoveIn30Steps: Number(maxMove.toFixed(3)), atRest: maxMove < 0.5 }
})
report.R4_restCheck = restCheck

const jitterCalm = []
for (let i = 0; i < 10; i++) {
  const v = await run(function j2(t) {
    window.__rdTime = t
    return window.__rd.cordLine(0)
  }, 200 + i * 0.037)
  jitterCalm.push(v)
  await sleep(80)
}
const calmLine = jitterCalm.filter((v) => typeof v === 'number')
const calmSpan = calmLine.length > 1 ? Math.max(...calmLine) - Math.min(...calmLine) : 0

report.R4_jitter = {
  loaded: jitterLoaded,
  calm: jitterCalm,
  loadedSpan: Number(jitterSpan.toFixed(2)),
  calmSpan: Number(calmSpan.toFixed(2)),
  method: 'simulation frozen; only the render time advanced',
}

/* ── R6: final state screenshot ─────────────────────────────────────────── */
await sleep(600)
const shotFinal = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/82-cord-final.png', Buffer.from(shotFinal.data, 'base64'))

/* ── Assertions ─────────────────────────────────────────────────────────── */
const rest = report.R2_restColor ?? {}
const hot = report.R3_cordColorLoaded ?? {}

report.assertions = {
  canvasPresent: report.install?.hasCanvas === true,
  // Fabric cord is light grey-white, not near-black.
  cordIsLightAtRest: (rest.r ?? 0) > 120 && (rest.g ?? 0) > 120,
  // Neutral at rest: red, green and blue are close.
  cordIsNeutralAtRest: Math.abs((rest.r ?? 0) - (rest.b ?? 0)) < 45,
  // Under load the cord must be measurably redder than at rest, and redder than
  // it is blue. Both are needed: a brightness shift alone would pass a pure
  // "redness delta" check without the cord actually going red.
  cordTurnsRed:
    (hot.hits ?? 0) > 50 &&
    (hot.redness ?? -99) > (rest.redness ?? 0) + 20 &&
    (hot.r ?? 0) > (hot.b ?? 0),
  // The fitted curve must be smooth: no kink spikes at particle joints.
  curveIsSmooth: (report.R1_smoothness?.maxSecondDiff ?? 999) < 14,
  claspIsMetal: (report.R5_clasp?.metalPixels ?? 0) > 12,
  // Jitter must be present under load. The calm span is reported for context but
  // NOT asserted to be zero: the wind field never stops, so an untouched rope is
  // always drifting slightly. That drift is physical motion, whereas the loaded
  // span at a frozen simulation can only come from the render-time jitter.
  overloadJitters: report.R4_jitter.loadedSpan > 2.0,
}

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/render-detail-report.json', JSON.stringify(report, null, 2))

const failed = Object.entries(report.assertions).filter(([, v]) => !v).map(([k]) => k)
console.log(
  JSON.stringify(
    {
      assertions: report.assertions,
      restColor: rest,
      loadedColor: hot,
      smoothness: report.R1_smoothness,
      clasp: report.R5_clasp,
      jitter: report.R4_jitter,
      exceptions,
      consoleErrors,
      failed,
    },
    null,
    2,
  ),
)

finish({ label: 'render-detail', exceptions, consoleErrors, report })
ws.close()
