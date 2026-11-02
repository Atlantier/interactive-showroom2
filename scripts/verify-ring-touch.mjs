/**
 * Verifies the two things this turn added:
 *   1. touch input drives the normalized transient mouse coordinates, including
 *      multi-touch rejection, touchend relax, and corner normalization;
 *   2. the SVG progress ring updates strokeDashoffset with zero React renders.
 *
 * Run: node scripts/verify-ring-touch.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { PAGE_HELPERS, scrollTo } from './page-helpers.mjs'
import { finish } from './lib/verify.mjs'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9334'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5250'

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
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
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(
      msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
    )
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

const evaluate = async (expression) => {
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

/* ── Mobile emulation with touch enabled ─────────────────────────────────── */
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

await send('Page.navigate', { url: URL_TO_TEST })
await sleep(5500)

// Inject the in-page helper bundle once.
const injected = await evaluate(PAGE_HELPERS)
if (injected && injected.__error) console.error('helper injection failed:', injected.__error)

const report = {}

/* ── 1. Ring geometry ────────────────────────────────────────────────────── */
report.ring = await evaluate('window.__probe.ringInfo()')

/* ── 2. Progress journey: offset must decrease monotonically as p grows ──── */
const journey = []
for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
  await evaluate(scrollTo(frac))
  const ring = await evaluate('window.__probe.readRing()')
  journey.push({ frac, ...ring })
}
report.journey = journey

// The dash offset should fall from ~circumference to ~0.
const offsets = journey.map((j) => Number(j.offsetStyle)).filter((n) => Number.isFinite(n))
report.journeyAnalysis = {
  firstOffset: offsets[0],
  lastOffset: offsets[offsets.length - 1],
  monotonicDecreasing: offsets.every((v, i) => i === 0 || v <= offsets[i - 1] + 0.5),
  expectedCircumference: 2 * Math.PI * ((36 - 2) / 2),
}

/* ── 3. Zero React re-renders during a full scroll ───────────────────────── */
report.mutations = await evaluate('window.__probe.countRingMutations()')

/* ── 4. Touch → normalized coordinates at the viewport corners ───────────── */
await evaluate('window.__probe.enableHud()')
await sleep(900)

const touchSequence = []

await evaluate('window.__probe.touchAt(8, 8)')
await sleep(450)
touchSequence.push({ at: 'top-left (8,8)', ...(await evaluate('window.__probe.readMouseHud()')) })

await evaluate('window.__probe.touchAt(382, 836)')
await sleep(450)
touchSequence.push({
  at: 'bottom-right (382,836)',
  ...(await evaluate('window.__probe.readMouseHud()')),
})

await evaluate('window.__probe.touchAt(195, 422)')
await sleep(450)
touchSequence.push({ at: 'centre (195,422)', ...(await evaluate('window.__probe.readMouseHud()')) })

report.touchSequence = touchSequence

/* ── 5. touchend must relax the transient mouse back to centre ───────────── */
await evaluate('window.__probe.touchMove(40, 700)')
await sleep(450)
const beforeEnd = await evaluate('window.__probe.readMouseHud()')
await evaluate('window.__probe.touchEnd(40, 700)')
await sleep(500)
const afterEnd = await evaluate('window.__probe.readMouseHud()')
report.touchEnd = {
  before: beforeEnd,
  after: afterEnd,
  relaxedToCentre:
    typeof afterEnd.x === 'number' && Math.abs(afterEnd.x) < 0.05 && Math.abs(afterEnd.y) < 0.05,
}

/* ── 6. Multi-touch (pinch) must NOT move the parallax ───────────────────── */
await evaluate('window.__probe.touchMove(100, 300)')
await sleep(400)
const beforePinch = await evaluate('window.__probe.readMouseHud()')
await evaluate(`window.__probe.pinchAt({id:1,x:100,y:300},{id:2,x:350,y:800})`)
await sleep(450)
const afterPinch = await evaluate('window.__probe.readMouseHud()')
report.multiTouch = {
  before: beforePinch,
  after: afterPinch,
  unchanged:
    typeof beforePinch.x === 'number' &&
    typeof afterPinch.x === 'number' &&
    Math.abs(beforePinch.x - afterPinch.x) < 0.02 &&
    Math.abs(beforePinch.y - afterPinch.y) < 0.02,
}

/* ── 7. Desktop check: ring still tracks with mouse ──────────────────────── */
await send('Emulation.setTouchEmulationEnabled', { enabled: false })
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await sleep(1200)
await evaluate(scrollTo(0.6))
report.desktopRing = await evaluate('window.__probe.readRing()')

mkdirSync('screenshots', { recursive: true })
const desktopShot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/06-ring-desktop.png', Buffer.from(desktopShot.data, 'base64'))

/* ── 8. Mobile screenshot ────────────────────────────────────────────────── */
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await sleep(1200)
await evaluate(scrollTo(0.45))
const mobileShot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/07-ring-mobile.png', Buffer.from(mobileShot.data, 'base64'))

report.exceptions = exceptions
report.consoleErrors = consoleErrors

writeFileSync('screenshots/ring-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

finish({ label: 'ring-touch', exceptions, consoleErrors, report })
ws.close()
