/**
 * Touch input verification, run at DESKTOP width so the telemetry HUD (which is
 * `hidden md:block`) is visible — that HUD is how we read the transient mouse
 * coordinates back out of the DOM without adding any test-only app code.
 *
 * Touch events are dispatched synthetically; the app cannot tell them apart from
 * real ones (same TouchEvent interface, same window target).
 *
 * Run: node scripts/verify-touch.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
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

// Desktop viewport so the HUD is visible; touch emulation still enabled.
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

await send('Page.navigate', { url: URL_TO_TEST })
await sleep(5000)

const helpers = await evaluate(`
window.__t = {
  mk(type, pts) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    const make = p => new Touch({ identifier: p.id ?? 1, target: document.body, clientX: p.x, clientY: p.y });
    const list = pts.map(make);
    const ended = type === 'touchend' || type === 'touchcancel';
    Object.defineProperty(ev, 'touches', { value: ended ? [] : list });
    Object.defineProperty(ev, 'changedTouches', { value: list });
    Object.defineProperty(ev, 'targetTouches', { value: ended ? [] : list });
    return ev;
  },
  fire(type, pts) { window.dispatchEvent(window.__t.mk(type, pts)); return true; },
  read() {
    const t = document.body.innerText;
    const m = t.match(/([-]?\\d+\\.\\d+) \\/ ([-]?\\d+\\.\\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { raw: t.slice(0, 100) };
  },
  hudOn() {
    const b = [...document.querySelectorAll('button[aria-label]')]
      .find(x => (x.getAttribute('aria-label') || '').includes('FPS'));
    if (b && (b.getAttribute('aria-label') || '').includes('开启')) b.click();
    return true;
  }
};
true
`)
if (helpers && helpers.__error) console.error('inject failed:', helpers.__error)

await evaluate('window.__t.hudOn()')
await sleep(1500)

// Confirm the HUD actually exposes the mouse pair before trusting any reading.
const hudReady = await evaluate(`
(() => {
  const t = document.body.innerText;
  return { hasTransient: t.includes('transient') || t.includes('TRANSITIVE') || t.includes('mouse'),
           snippet: t.match(/mouse[\\s\\S]{0,40}/)?.[0] ?? null };
})()
`)

const report = { hudReady, steps: [] }

/** Fire a touch gesture and read back the normalized pair. */
const step = async (label, fn) => {
  await evaluate(fn)
  await sleep(500)
  const value = await evaluate('window.__t.read()')
  report.steps.push({ label, ...value })
  return value
}

// Corners: normalized x,y must approach ±1 with y flipped (+1 at the top).
await step('touch top-left (4,4)', `window.__t.fire('touchstart',[{x:4,y:4}]); window.__t.fire('touchmove',[{x:4,y:4}])`)
await step('touch top-right (1596,4)', `window.__t.fire('touchmove',[{x:1596,y:4}])`)
await step('touch bottom-right (1596,996)', `window.__t.fire('touchmove',[{x:1596,y:996}])`)
await step('touch bottom-left (4,996)', `window.__t.fire('touchmove',[{x:4,y:996}])`)
await step('touch centre (800,500)', `window.__t.fire('touchmove',[{x:800,y:500}])`)

// Multi-touch rejection: a second finger must not shift the parallax.
const beforePinch = await evaluate('window.__t.read()')
await evaluate(`window.__t.fire('touchmove',[{id:1,x:200,y:300},{id:2,x:1400,y:900}])`)
await sleep(500)
const afterPinch = await evaluate('window.__t.read()')
report.multiTouch = {
  before: beforePinch,
  after: afterPinch,
  unchanged:
    Number.isFinite(beforePinch.x) &&
    Number.isFinite(afterPinch.x) &&
    Math.abs(beforePinch.x - afterPinch.x) < 0.02 &&
    Math.abs(beforePinch.y - afterPinch.y) < 0.02,
}

// touchend must relax the transient mouse to centre.
await evaluate(`window.__t.fire('touchmove',[{x:120,y:820}])`)
await sleep(450)
const beforeEnd = await evaluate('window.__t.read()')
await evaluate(`window.__t.fire('touchend',[{x:120,y:820}])`)
await sleep(550)
const afterEnd = await evaluate('window.__t.read()')
report.touchEnd = {
  before: beforeEnd,
  after: afterEnd,
  relaxedToCentre:
    Number.isFinite(afterEnd.x) &&
    Math.abs(afterEnd.x) < 0.05 &&
    Math.abs(afterEnd.y) < 0.05,
}

// touchcancel must relax too.
await evaluate(`window.__t.fire('touchstart',[{x:1300,y:200}]); window.__t.fire('touchmove',[{x:1300,y:200}])`)
await sleep(450)
const beforeCancel = await evaluate('window.__t.read()')
await evaluate(`window.__t.fire('touchcancel',[{x:1300,y:200}])`)
await sleep(550)
const afterCancel = await evaluate('window.__t.read()')
report.touchCancel = {
  before: beforeCancel,
  after: afterCancel,
  relaxedToCentre:
    Number.isFinite(afterCancel.x) &&
    Math.abs(afterCancel.x) < 0.05 &&
    Math.abs(afterCancel.y) < 0.05,
}

// Mouse must still work (no regression after the refactor).
await evaluate(`
(() => {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 250, bubbles: true, pointerType: 'mouse' }));
  return true;
})()
`)
await sleep(500)
report.mouse = await evaluate('window.__t.read()')

// Lenis touch scrolling should not be broken by our listeners (all passive).
report.scrollStillWorks = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const before = window.scrollY;
  window.scrollTo(0, 600);
  await wait(900);
  const after = window.scrollY;
  return { before, after, moved: after > before };
})()
`)

report.exceptions = exceptions
mkdirSync('screenshots', { recursive: true })
writeFileSync('screenshots/touch-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

finish({ label: 'touch', exceptions, report })
ws.close()
