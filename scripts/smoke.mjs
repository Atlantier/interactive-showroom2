/**
 * Headless-Chrome smoke test over the DevTools Protocol.
 * Captures console errors / page exceptions, then screenshots hero + mid-scroll.
 *
 * Run: node scripts/smoke.mjs http://127.0.0.1:5250
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5250'
const OUT_DIR = 'screenshots'
const CDP_HTTP = 'http://127.0.0.1:9333'

mkdirSync(OUT_DIR, { recursive: true })

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
let page = targets.find((t) => t.type === 'page')
if (!page) {
  const created = await (await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' })).json()
  page = created
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})

let nextId = 1
const pending = new Map()
const consoleLines = []
const exceptions = []
const failedRequests = []

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
      .join(' ')
    consoleLines.push({ level: msg.params.type, text })
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    exceptions.push(d.exception?.description ?? d.text)
  }
  if (msg.method === 'Network.loadingFailed') {
    failedRequests.push(`${msg.params.type} ${msg.params.errorText}`)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})

// Collect Log.entryAdded (browser-level warnings/errors)
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleLines.push({ level: 'error(log)', text: msg.params.entry.text })
  }
})

await send('Page.navigate', { url: URL_TO_TEST })
await sleep(6000)

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(data, 'base64'))
}

await shot('01-hero')

// Probe the runtime state that matters.
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  return res.result?.value
}

const diag = await evaluate(`(() => {
  const canvas = document.querySelector('canvas');
  const root = document.getElementById('root');
  const nav = document.querySelector('header');
  return {
    title: document.title,
    rootChildren: root ? root.children.length : -1,
    bodyHeight: document.body.scrollHeight,
    canvasCount: document.querySelectorAll('canvas').length,
    canvasSize: canvas ? [canvas.width, canvas.height] : null,
    canvasRect: canvas ? (() => { const r = canvas.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null,
    hasNav: Boolean(nav),
    sectionIds: [...document.querySelectorAll('section[id]')].map(s => s.id),
    lenisActive: Boolean(window.lenis),
    lenisVersion: window.lenis ? window.lenis.version : null,
    htmlClass: document.documentElement.className,
    fontsLoaded: document.fonts ? document.fonts.status : 'n/a',
  };
})()`)

// Scroll to the middle of the page and grab a second frame.
await evaluate(
  `window.lenis && window.lenis.scrollTo ? window.lenis.scrollTo(document.body.scrollHeight * 0.45, { immediate: false }) : window.scrollTo(0, document.body.scrollHeight * 0.45); true`,
)
await sleep(2500)
await evaluate(`window.scrollTo(0, document.body.scrollHeight * 0.42); true`)
await sleep(1200)
await shot('02-gallery')

const scrolledState = await evaluate(`(async () => {
  const mod = { scrollY: window.scrollY };
  return mod;
})()`)

// Toggle the FPS monitor via the store to verify the HUD renders.
// State is persisted between runs, so click only if it is currently OFF.
const fpsToggle = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button[aria-label]')];
  const fpsBtn = btns.find(b => (b.getAttribute('aria-label') || '').includes('FPS'));
  if (!fpsBtn) return 'button-not-found';
  const label = fpsBtn.getAttribute('aria-label') || '';
  const wasOff = label.includes('开启');
  if (wasOff) fpsBtn.click();
  return wasOff ? 'turned-on' : 'already-on';
})()`)
await sleep(1500)
await shot('03-fps-hud')

const hudDiag = await evaluate(`(() => {
  const txt = document.body.innerText;
  return {
    hasTelemetry: txt.includes('Telemetry') || txt.includes('FPS'),
    hasTransient: txt.includes('transient') || txt.includes('v_scroll'),
  };
})()`)

// Sound toggle
const soundToggle = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button[aria-label]')];
  const s = btns.find(b => (b.getAttribute('aria-label') || '').includes('音效'));
  if (s) { s.click(); return s.getAttribute('aria-label'); }
  return null;
})()`)
await sleep(500)

// Mobile viewport check
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await evaluate(`window.scrollTo(0, 0); true`)
await sleep(1200)
await shot('04-mobile')

const mobileDiag = await evaluate(`(() => {
  const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
  return { overflowX, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
})()`)

const report = {
  url: URL_TO_TEST,
  diag,
  scrolledState,
  fpsToggle,
  hudDiag,
  soundToggle,
  mobileDiag,
  exceptions,
  failedRequests,
  consoleErrors: consoleLines.filter((l) => l.level === 'error' || l.level === 'error(log)'),
  consoleWarnings: consoleLines.filter((l) => l.level === 'warning').slice(0, 12),
  consoleAll: consoleLines.slice(0, 25),
}

writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
ws.close()
