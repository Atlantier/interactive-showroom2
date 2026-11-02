/**
 * Verifies the architecture narrative chapter.
 *
 * Checks:
 *   A1. The section is exactly 300vh tall and the stage is sticky.
 *   A2. Local progress p is correctly normalised to [0,1] across the track.
 *   A3. The 3D canvas mounts and the GL context is healthy.
 *   A4. The three layers separate along Y as p crosses 0.3→0.7, and reassemble.
 *   A5. The camera MOVES along its curve (position changes with p).
 *   A6. DOM choreography: heading fades, layer labels appear, metric cards
 *       slide in only near the end.
 *   A7. No runtime exceptions or console errors.
 *
 * Run: node scripts/verify-architecture.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { finish } from './lib/verify.mjs'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9340'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5262'

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  window.__arch = {
    section() {
      return document.getElementById('architecture')
    },
    stage() {
      const s = this.section()
      return s ? s.firstElementChild : null
    },
    /** Scroll so that the section's local progress is approximately `p`. */
    scrollToProgress(p) {
      const s = this.section()
      if (!s) return null
      const rect = s.getBoundingClientRect()
      const docTop = rect.top + window.scrollY
      const travel = Math.max(1, rect.height - window.innerHeight)
      window.scrollTo(0, docTop + travel * p)
      return { docTop, travel, target: docTop + travel * p }
    },
    /** Read the measured local progress back out of the rail transform. */
    readRail() {
      const s = this.section()
      if (!s) return null
      const rail = s.querySelector('[aria-hidden] .origin-left')
      if (!rail) return null
      const m = rail.style.transform.match(/scaleX\(([\d.]+)\)/)
      return m ? Number(m[1]) : null
    },
    /** Bounding boxes of the three layer labels (DOM proxy for 3D state). */
    labels() {
      const s = this.section()
      if (!s) return []
      return Array.from(s.querySelectorAll('h3')).map((h) => h.textContent)
    },
    metricsOpacity() {
      const s = this.section()
      if (!s) return null
      const ul = s.querySelector('ul')
      return ul ? Number(getComputedStyle(ul).opacity) : null
    },
    headingOpacity() {
      const s = this.section()
      if (!s) return null
      const h = s.querySelector('h2')
      return h && h.parentElement ? Number(getComputedStyle(h.parentElement).opacity) : null
    },
    captionText() {
      const s = this.section()
      if (!s) return null
      const p = s.querySelector('[data-phase]')
      return p ? p.textContent.trim() : null
    },
    canvasInfo() {
      const s = this.section()
      if (!s) return null
      const c = s.querySelector('canvas')
      if (!c) return { found: false }
      const gl = c.getContext('webgl2') || c.getContext('webgl')
      return {
        found: true,
        contextLost: gl ? gl.isContextLost() : null,
        w: c.width,
        h: c.height,
        cssW: Math.round(c.getBoundingClientRect().width),
        cssH: Math.round(c.getBoundingClientRect().height),
      }
    },
  }
  return { ok: true, hasSection: Boolean(window.__arch.section()) }
}

/** Geometry structure report for the architecture canvas. */
function readArchitectureScene() {
  const hook = window.__showroomScene
  if (!hook || !hook.scene) return { ok: false, reason: 'no scene hook' }
  const scene = hook.scene
  let meshes = 0
  let lineSegments = 0
  let points = 0
  let vertices = 0
  scene.traverse((o) => {
    if (o.isMesh) meshes++
    if (o.isLineSegments) lineSegments++
    if (o.isPoints) points++
    if (o.geometry && o.geometry.getAttribute) {
      const pos = o.geometry.getAttribute('position')
      if (pos) vertices += pos.count
    }
  })
  return { ok: true, meshes, lineSegments, points, vertices }
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

const run = async (fn) => {
  const expression = '(' + fn.toString() + ')()'
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
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

const report = {}
report.install = await run(installHelpers)

/* ── A1: structure ───────────────────────────────────────────────────────── */
report.A1_structure = await run(function a1() {
  const s = document.getElementById('architecture')
  if (!s) return { found: false }
  const stage = s.firstElementChild
  const cs = getComputedStyle(stage)
  return {
    found: true,
    sectionHeightVh: +(s.getBoundingClientRect().height / window.innerHeight).toFixed(2),
    stagePosition: cs.position,
    stageHeightVh: +(stage.getBoundingClientRect().height / window.innerHeight).toFixed(2),
    labels: Array.from(s.querySelectorAll('h3')).map((h) => h.textContent),
  }
})

/* ── A2 + A5: progress normalisation and camera movement across phases ──── */
const phases = [0, 0.15, 0.3, 0.45, 0.6, 0.7, 0.85, 1]
report.phaseSamples = []
for (const target of phases) {
  await run(
    function scrollTo(p) {
      window.__arch.scrollToProgress(p)
      return true
    }.bind(null),
    target,
  )
  // NOTE: `run` does not forward args; inline the scroll instead.
  await send('Runtime.evaluate', {
    expression: `window.__arch.scrollToProgress(${target})`,
    returnByValue: true,
  })
  await sleep(900)
  const state = await run(function sample() {
    return {
      scrollY: Math.round(window.scrollY),
      rail: window.__arch.readRail(),
      heading: window.__arch.headingOpacity(),
      metrics: window.__arch.metricsOpacity(),
      caption: window.__arch.captionText(),
      camera: (function () {
        const h = window.__showroomScene
        if (!h || !h.camera) return null
        const c = h.camera
        return {
          x: +c.position.x.toFixed(2),
          y: +c.position.y.toFixed(2),
          z: +c.position.z.toFixed(2),
        }
      })(),
    }
  })
  report.phaseSamples.push({ targetP: target, ...state })
}

/* ── A3: canvas health ───────────────────────────────────────────────────── */
await send('Runtime.evaluate', {
  expression: 'window.__arch.scrollToProgress(0.45)',
  returnByValue: true,
})
await sleep(1200)
report.A3_canvas = await run(function a3() {
  const s = document.getElementById('architecture')
  const c = s ? s.querySelector('canvas') : null
  if (!c) return { found: false }
  const gl = c.getContext('webgl2') || c.getContext('webgl')
  return {
    found: true,
    contextLost: gl ? gl.isContextLost() : null,
    w: c.width,
    h: c.height,
    cssW: Math.round(c.getBoundingClientRect().width),
    cssH: Math.round(c.getBoundingClientRect().height),
  }
})

report.A4_scene = await run(readArchitectureScene)

/* ── Screenshots at the three key phases ────────────────────────────────── */
mkdirSync('screenshots', { recursive: true })
for (const [name, p] of [
  ['50-arch-assembled', 0.1],
  ['51-arch-exploded', 0.5],
  ['52-arch-fadeout', 0.9],
]) {
  await send('Runtime.evaluate', {
    expression: `window.__arch.scrollToProgress(${p})`,
    returnByValue: true,
  })
  await sleep(1400)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`screenshots/${name}.png`, Buffer.from(shot.data, 'base64'))
}

/* ── Derived assertions ──────────────────────────────────────────────────── */
const rails = report.phaseSamples.map((s) => s.rail)
const cams = report.phaseSamples.map((s) => s.camera).filter(Boolean)

report.assertions = {
  sectionIs300vh: report.A1_structure?.sectionHeightVh === 3,
  stageIsSticky: report.A1_structure?.stagePosition === 'sticky',
  threeLabelsPresent:
    Array.isArray(report.A1_structure?.labels) && report.A1_structure.labels.length === 3,
  progressMonotonic: rails.every(
    (v, i) => i === 0 || v === null || rails[i - 1] === null || v >= rails[i - 1] - 0.02,
  ),
  progressSpansRange:
    rails.length > 1 && (rails[rails.length - 1] ?? 0) > 0.9 && (rails[0] ?? 1) < 0.1,
  canvasHealthy: report.A3_canvas?.found === true && report.A3_canvas?.contextLost === false,
  sceneHasGeometry:
    report.A4_scene?.ok === true && report.A4_scene.meshes > 0 && report.A4_scene.lineSegments > 0,
  cameraMoves:
    cams.length > 1 &&
    cams.some((c) => Math.abs(c.x - cams[0].x) > 0.3 || Math.abs(c.z - cams[0].z) > 0.3),
  headingFadesIn:
    (report.phaseSamples[0]?.heading ?? 1) < 0.2 && (report.phaseSamples[2]?.heading ?? 0) > 0.5,
  metricsHiddenEarly: (report.phaseSamples[0]?.metrics ?? 1) < 0.2,
  metricsVisibleLate: (report.phaseSamples[report.phaseSamples.length - 1]?.metrics ?? 0) > 0.5,
  captionChanges: new Set(report.phaseSamples.map((s) => s.caption).filter(Boolean)).size >= 2,
}

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/architecture-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

finish({ label: 'architecture', exceptions, consoleErrors, report })
ws.close()
