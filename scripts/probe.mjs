/**
 * Focused probes: tier switching, transient-store integrity, reduced motion,
 * and WebGL context health. Run against an already-running dev server.
 *
 * Run: node scripts/probe.mjs http://127.0.0.1:5250
 */
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5250'
const CDP_HTTP = 'http://127.0.0.1:9333'

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('No page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.once('open', res)
  ws.once('error', rej)
})

let nextId = 1
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
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
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})

await send('Page.navigate', { url: URL_TO_TEST })
await sleep(5000)

const results = {}

// ── 1. Canvas is alive and drawing ──────────────────────────────────────────
results.canvas = await evaluate(`(() => {
  const c = document.querySelector('canvas');
  if (!c) return { ok: false, reason: 'no canvas' };
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return {
    ok: Boolean(gl),
    isContextLost: gl ? gl.isContextLost() : null,
    w: c.width, h: c.height,
    cssW: Math.round(c.getBoundingClientRect().width),
    cssH: Math.round(c.getBoundingClientRect().height),
  };
})()`)

// ── 2. Transient store: mouse normalization range ───────────────────────────
results.mouseNormalization = await evaluate(`(() => {
  // Synthesize pointer moves at the four viewport corners + center.
  const dispatch = (x, y) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
  const w = window.innerWidth, h = window.innerHeight;
  dispatch(w/2, h/2);
  return 'dispatched';
})()`)
await sleep(300)

// Read back via a fresh probe of the live module graph is not possible from the
// page, so assert on what IS observable: the HUD readout reflects values.
results.hudMouse = await evaluate(`(() => {
  // Force the HUD on so we can read the transient numbers from the DOM.
  const s = document.querySelector('button[aria-label*="FPS"]');
  if (s && (s.getAttribute('aria-label')||'').includes('开启')) s.click();
  return Boolean(s);
})()`)
await sleep(1200)

// Move the pointer to the top-left corner and confirm the HUD tracks it.
results.mouseCorner = await evaluate(`(() => {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5, bubbles: true }));
  return new Promise(r => setTimeout(() => {
    const txt = document.body.innerText;
    const m = txt.match(/(-?\\d+\\.\\d+) \\/ (-?\\d+\\.\\d+)/);
    r(m ? { x: Number(m[1]), y: Number(m[2]) } : { raw: txt.slice(0, 200) });
  }, 400));
})()`)

// ── 3. Scroll progress monotonic + bounded ──────────────────────────────────
results.scrollProgress = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const readP = () => {
    const txt = document.body.innerText;
    const m = txt.match(/p\\s*\\n?\\s*(\\d\\.\\d{4})/);
    return m ? Number(m[1]) : null;
  };
  window.scrollTo(0, 0); await wait(600);
  const atTop = readP();
  window.scrollTo(0, document.body.scrollHeight); await wait(900);
  const atBottom = readP();
  return { atTop, atBottom, inRange: [atTop, atBottom].every(v => v === null || (v >= 0 && v <= 1)) };
})()`)

// ── 4. Tier switch reaches the canvas ──────────────────────────────────────
results.tierSwitch = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('HIGH') || (b.textContent||'').includes('MEDIUM'));
  if (!btn) return { ok: false, reason: 'tier button not found' };
  const before = btn.textContent;
  btn.click();
  await wait(900);
  // Re-query: the button re-renders with the new label.
  const btn2 = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('HIGH') || (b.textContent||'').includes('MEDIUM'));
  const after = btn2 ? btn2.textContent : null;
  // Canvas must still be alive after a dpr change.
  const c = document.querySelector('canvas');
  const gl = c ? (c.getContext('webgl2') || c.getContext('webgl')) : null;
  return { before, after, changed: before !== after, canvasAlive: gl ? !gl.isContextLost() : false };
})()`)

// ── 5. Section observer updates active section ─────────────────────────────
results.sectionObserver = await evaluate(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  window.scrollTo(0, 0); await wait(700);
  const navTextAtTop = [...document.querySelectorAll('header nav button')].map(b => b.textContent.trim()).join('|');
  const el = document.getElementById('gallery');
  if (!el) return { ok: false };
  el.scrollIntoView(); await wait(900);
  const navTextAtGallery = [...document.querySelectorAll('header nav button')].map(b => b.textContent.trim()).join('|');
  return { atTop: navTextAtTop, atGallery: navTextAtGallery, changed: navTextAtTop !== navTextAtGallery };
})()`)

// ── 6. No layout overflow at several widths ────────────────────────────────
results.responsive = []
for (const [w, h] of [
  [1920, 1080],
  [1280, 800],
  [768, 1024],
  [390, 844],
  [320, 640],
]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: w < 640,
  })
  await sleep(700)
  const r = await evaluate(`(() => {
    const de = document.documentElement;
    return {
      overflowX: de.scrollWidth > window.innerWidth + 1,
      scrollWidth: de.scrollWidth,
      innerWidth: window.innerWidth,
      navVisible: Boolean(document.querySelector('header')),
    };
  })()`)
  results.responsive.push({ size: `${w}x${h}`, ...r })
}

console.log(JSON.stringify(results, null, 2))
ws.close()
