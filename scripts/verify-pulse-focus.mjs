/**
 * Verifies the travelling-pulse conduits and click-to-focus interaction.
 *
 * Checks:
 *   P1. Conduit geometry exists with aAlong/aGap attributes.
 *   P2. The conduit shader is a real ShaderMaterial with uTime advancing.
 *   P3. Pulse intensity ramps in only during the exploded phase.
 *   P4. Clicking a layer sets a selection and the camera moves to a focus pose.
 *   P5. The HUD appears with the matching layer's tech stack.
 *   P6. Escape / close clears the selection and the camera returns.
 *
 * Run: node scripts/verify-pulse-focus.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9341'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5263'

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  window.__p = {
    section: () => document.getElementById('architecture'),
    scrollToProgress(p) {
      const s = this.section()
      if (!s) return null
      const rect = s.getBoundingClientRect()
      const docTop = rect.top + window.scrollY
      const travel = Math.max(1, rect.height - window.innerHeight)
      window.scrollTo(0, docTop + travel * p)
      return docTop + travel * p
    },
    canvas: () => {
      const s = this.section()
      return s ? s.querySelector('canvas') : null
    },
    hud() {
      const s = this.section()
      if (!s) return null
      const dialog = s.querySelector('[role="dialog"]')
      if (!dialog) return { present: false }
      const cs = getComputedStyle(dialog)
      return {
        present: true,
        ariaHidden: dialog.getAttribute('aria-hidden'),
        opacity: Number(cs.opacity),
        title: (dialog.querySelector('h3') || {}).textContent || null,
        subtitle: (dialog.querySelector('p') || {}).textContent || null,
        techRows: dialog.querySelectorAll('li').length,
      }
    },
    camera() {
      const h = window.__archScene
      if (!h || !h.camera) return null
      const c = h.camera
      return {
        x: +c.position.x.toFixed(3),
        y: +c.position.y.toFixed(3),
        z: +c.position.z.toFixed(3),
      }
    },
    /** Find the architecture canvas' scene and report conduit state. */
    conduits() {
      // The architecture canvas is the one whose scene contains a lineSegments
      // with an aGap attribute.
      const canvases = Array.from(document.querySelectorAll('canvas'))
      for (const c of canvases) {
        const hook = c.__showroomScene
        void hook
      }
      return null
    },
  }
  return { ok: true, hasSection: Boolean(window.__p.section()) }
}

/** Scan every R3F root for the conduit object and report its material state. */
function readConduit() {
  const hooks = []
  if (window.__showroomScene) hooks.push(window.__showroomScene)
  if (window.__archScene) hooks.push(window.__archScene)

  for (const h of hooks) {
    if (!h || !h.scene) continue
    let found = null
    h.scene.traverse((o) => {
      if (found) return
      const g = o.geometry
      if (g && g.getAttribute && g.getAttribute('aGap') && g.getAttribute('aAlong')) {
        found = o
      }
    })
    if (found) {
      const m = found.material
      return {
        ok: true,
        type: found.type,
        hasAlong: Boolean(found.geometry.getAttribute('aAlong')),
        hasGap: Boolean(found.geometry.getAttribute('aGap')),
        vertexCount: found.geometry.getAttribute('position').count,
        materialType: m.type,
        hasTimeUniform: Boolean(m.uniforms && m.uniforms.uTime),
        time: m.uniforms?.uTime?.value ?? null,
        intensity: m.uniforms?.uIntensity?.value ?? null,
        gapBottom: m.uniforms?.uGapBottom?.value ?? null,
        gapTop: m.uniforms?.uGapTop?.value ?? null,
        vertexShaderHasAAlong: (m.vertexShader || '').includes('aAlong'),
        fragmentShaderHasPulse: (m.fragmentShader || '').includes('fract'),
      }
    }
  }
  return { ok: false }
}

/** Click the centre of the stage at a given normalized position. */
function clickStage(nx, ny) {
  const s = window.__p.section()
  if (!s) return { ok: false }
  const canvas = s.querySelector('canvas')
  if (!canvas) return { ok: false }
  const r = canvas.getBoundingClientRect()
  const x = r.left + r.width * nx
  const y = r.top + r.height * ny
  const opts = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts))
  canvas.dispatchEvent(new PointerEvent('pointerup', opts))
  canvas.dispatchEvent(new MouseEvent('click', opts))
  return { ok: true, x: Math.round(x), y: Math.round(y) }
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
await sleep(8000)

const report = {}
report.install = await run(installHelpers)

/* 閳光偓閳光偓 Scroll to the exploded phase and let the canvas mount 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓 */
await send('Runtime.evaluate', {
  expression: 'window.__p.scrollToProgress(0.5)',
  returnByValue: true,
})
await sleep(2500)

/* 閳光偓閳光偓 P1 + P2: conduit geometry and shader 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓 */
report.P1P2_conduit = await run(readConduit)

/* 閳光偓閳光偓 P3: intensity ramps with the phase, and uTime advances 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓 */
const intensityAt = async (p) => {
  await send('Runtime.evaluate', {
    expression: `window.__p.scrollToProgress(${p})`,
    returnByValue: true,
  })
  await sleep(1200)
  const c = await run(readConduit)
  return c?.intensity ?? null
}
report.P3_intensityAssembled = await intensityAt(0.12)
report.P3_intensityExploded = await intensityAt(0.5)
report.P3_intensityFaded = await intensityAt(0.95)

const t1 = await run(readConduit)
await sleep(700)
const t2 = await run(readConduit)
report.P3_timeAdvances = t1?.time !== null && t2?.time !== null && t2.time > t1.time

/* 閳光偓閳光偓 P4: click a layer, confirm camera moves 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓 */
await send('Runtime.evaluate', {
  expression: 'window.__p.scrollToProgress(0.5)',
  returnByValue: true,
})
await sleep(1500)

const camBefore = await run(function cam() {
  const h = window.__archScene
  if (!h || !h.camera) return null
  const c = h.camera
  return { x: +c.position.x.toFixed(2), y: +c.position.y.toFixed(2), z: +c.position.z.toFixed(2) }
})

// Click several points; the middle of the stage should hit the agent layer.
let clicked = null
for (const [nx, ny] of [[0.5, 0.5], [0.5, 0.42], [0.5, 0.58], [0.45, 0.5]]) {
  await run(clickStage, nx, ny)
  await sleep(700)
  const hud = await run(function hud() {
    const s = document.getElementById('architecture')
    const d = s ? s.querySelector('[role="dialog"]') : null
    return d ? { title: (d.querySelector('h3') || {}).textContent } : null
  })
  if (hud?.title) {
    clicked = { nx, ny, title: hud.title }
    break
  }
}

// The focus blend is a frame-rate independent exponential approach with a
// ~3/s lambda; it needs roughly 1.2s to reach 95% of the goal. Wait generously
// so the assertion measures the settled pose, not a frame mid-transition.
await sleep(3200)
const camAfter = await run(function cam() {
  const h = window.__archScene
  if (!h || !h.camera) return null
  const c = h.camera
  return { x: +c.position.x.toFixed(2), y: +c.position.y.toFixed(2), z: +c.position.z.toFixed(2) }
})

/* 閳光偓閳光偓 P5: HUD content 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓 */
report.P5_hud = await run(function hud() {
  const s = document.getElementById('architecture')
  const d = s ? s.querySelector('[role="dialog"]') : null
  if (!d) return { present: false }
  return {
    present: true,
    title: (d.querySelector('h3') || {}).textContent,
    techRows: d.querySelectorAll('li').length,
    ariaLabel: d.getAttribute('aria-label'),
  }
})

mkdirSync('screenshots', { recursive: true })
const shotFocus = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/60-focus-hud.png', Buffer.from(shotFocus.data, 'base64'))

/* 閳光偓閳光偓 P6: Escape clears the focus 閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓閳光偓 */
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(2200)

const camRestored = await run(function cam() {
  const h = window.__archScene
  if (!h || !h.camera) return null
  const c = h.camera
  return { x: +c.position.x.toFixed(2), y: +c.position.y.toFixed(2), z: +c.position.z.toFixed(2) }
})
const hudAfterEsc = await run(function hud() {
  const s = document.getElementById('architecture')
  const d = s ? s.querySelector('[role="dialog"]') : null
  return d ? d.getAttribute('aria-hidden') : null
})

const dist = (a, b) =>
  a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null

report.assertions = {
  conduitExists: report.P1P2_conduit?.ok === true,
  conduitHasAttributes:
    report.P1P2_conduit?.hasAlong === true && report.P1P2_conduit?.hasGap === true,
  conduitIsShaderMaterial: report.P1P2_conduit?.materialType === 'ShaderMaterial',
  conduitShaderUsesAlong: report.P1P2_conduit?.vertexShaderHasAAlong === true,
  conduitShaderHasPulse: report.P1P2_conduit?.fragmentShaderHasPulse === true,
  timeAdvances: report.P3_timeAdvances === true,
  intensityOffWhenAssembled: (report.P3_intensityAssembled ?? 1) < 0.05,
  intensityOnWhenExploded: (report.P3_intensityExploded ?? 0) > 0.3,
  intensityOffWhenFaded: (report.P3_intensityFaded ?? 1) < 0.1,
  layerClickable: clicked !== null,
  cameraMovedOnFocus: dist(camBefore, camAfter) !== null && dist(camBefore, camAfter) > 0.4,
  hudShowsTech: (report.P5_hud?.techRows ?? 0) >= 3,
  escapeClearsHud: hudAfterEsc === 'true',
  cameraRestored: dist(camBefore, camRestored) !== null && dist(camBefore, camRestored) < 2.5,
}

report.raw = { camBefore, camAfter, camRestored, clicked, hudAfterEsc }
report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/pulse-focus-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
ws.close()
