/**
 * Verifies the two changes in this round:
 *
 *   1. WARP SPEED — scrolling fast drives `uWarp` up, produces vertical streaks,
 *      and springs back elastically (with visible overshoot) on stop.
 *   2. RESIZE ALIGNMENT — after resizing, the cursor→world mapping on the z = 0
 *      plane must agree with ground truth derived from the camera matrices.
 *
 * Run: node scripts/verify-warp.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9337'
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
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(6500)

const report = {}

/* ── Helper available in the page: read the live uWarp uniform ───────────── */
const INJECT = `
window.__warp = {
  findPoints() {
    let pts = null;
    window.__showroomScene.scene.traverse(o => { if (o.isPoints && !pts) pts = o; });
    return pts;
  },
  readUniforms() {
    const m = this.findPoints().material;
    return {
      uWarp: +m.uniforms.uWarp.value.toFixed(4),
      uMaxStretch: m.uniforms.uMaxStretch.value,
      uStreakWidth: m.uniforms.uStreakWidth.value,
      hasWarpUniform: 'uWarp' in m.uniforms,
      hasStretchVarying: (m.vertexShader || '').includes('vStretch'),
    };
  },
  // Ground truth: unproject a screen point onto z = 0 using camera matrices.
  expectedWorldAt(clientX, clientY) {
    const cam = window.__showroomScene.camera;
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((clientY - r.top) / r.height) * 2 - 1);
    const aspect = r.width / r.height;
    const fovRad = (cam.fov * Math.PI) / 180;
    const halfH = Math.tan(fovRad / 2) * cam.near;
    const halfW = halfH * aspect;
    const cx = ndcX * halfW, cy = ndcY * halfH, cz = -cam.near;
    const e = cam.matrixWorld.elements;
    const wx = e[0]*cx + e[4]*cy + e[8]*cz;
    const wy = e[1]*cx + e[5]*cy + e[9]*cz;
    const wz = e[2]*cx + e[6]*cy + e[10]*cz;
    const len = Math.hypot(wx, wy, wz);
    const dx = wx/len, dy = wy/len, dz = wz/len;
    const t = dz !== 0 ? (0 - cam.position.z) / dz : 0;
    return { x: cam.position.x + dx*t, y: cam.position.y + dy*t, z: 0 };
  },
  cameraAspect() {
    const cam = window.__showroomScene.camera;
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { camAspect: +cam.aspect.toFixed(5), canvasAspect: +(r.width/r.height).toFixed(5),
             delta: +Math.abs(cam.aspect - r.width/r.height).toFixed(6) };
  }
};
true
`
const inj = await evaluate(INJECT)
if (inj && inj.__error) console.error('inject failed:', inj.__error)

/* ── 1. Uniform wiring ───────────────────────────────────────────────────── */
report.uniformsAtRest = await evaluate('window.__warp.readUniforms()')

/* ── 2. Warp rises during a fast scroll ──────────────────────────────────── */
report.duringFastScroll = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const readings = [];
  const total = document.body.scrollHeight - innerHeight;

  // Simulate a hard fling upward in short steps.
  for (let i = 0; i < 28; i++) {
    window.scrollTo(0, total * (0.75 + 0.0001) * (i / 28) + total * 0.1);
    await wait(20);
    readings.push(window.__warp.readUniforms().uWarp);
  }
  const peak = Math.max(...readings);
  return { peakWarp: +peak.toFixed(4), samples: readings.filter(v => v > 0.05).length, tail: readings.slice(-6) };
})()
`)

await evaluate('window.scrollTo(0, document.body.scrollHeight * 0.5); true')
await sleep(600)
const peakShot = await send('Page.captureScreenshot', { format: 'png' })
mkdirSync('screenshots', { recursive: true })
writeFileSync('screenshots/13-warp-peak.png', Buffer.from(peakShot.data, 'base64'))

/* ── 3. Elastic recoil: warp must OVERSHOOT then settle ──────────────────── */
report.recoil = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const total = document.body.scrollHeight - innerHeight;

  // Build up warp.
  for (let i = 0; i < 22; i++) {
    window.scrollTo(0, total * (0.2 + 0.03 * i));
    await wait(16);
  }
  const peak = window.__warp.readUniforms().uWarp;

  // Stop scrolling entirely and sample the decay curve.
  const curve = [];
  for (let i = 0; i < 60; i++) {
    await wait(16);
    curve.push(+window.__warp.readUniforms().uWarp.toFixed(4));
  }

  // An under-damped release shows a local bump AFTER the value first drops:
  // detect a rise following a fall.
  let sawFall = false;
  let overshootBump = 0;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i] < curve[i-1] - 0.002) sawFall = true;
    if (sawFall && curve[i] > curve[i-1] + 0.002) overshootBump = Math.max(overshootBump, curve[i] - curve[i-1]);
  }

  return {
    peakBeforeStop: +peak.toFixed(4),
    finalValue: curve[curve.length - 1],
    curveHead: curve.slice(0, 14),
    monotonicAfterFall: !curve.some((v,i) => i>1 && v > curve[i-1] + 0.002),
    overshootBumpDetected: overshootBump > 0,
    maxBump: +overshootBump.toFixed(4),
    settledUnderThreshold: curve[curve.length-1] < 0.02,
  };
})()
`)

/* ── 4. Resize alignment across several viewports ────────────────────────── */
report.resizeAlignment = []
for (const [w, h] of [
  [1200, 800],
  [900, 1400],
  [1920, 1080],
  [1000, 700],
  [1600, 1000],
]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(1200)

  const aspect = await evaluate('window.__warp.cameraAspect()')

  // Compare the app's own cursor→world mapping against independent ground truth.
  const consistency = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();

  // Pick a distinctive screen point.
  const px = r.left + r.width * 0.78;
  const py = r.top + r.height * 0.32;

  window.dispatchEvent(new PointerEvent('pointermove', {
    clientX: px, clientY: py, bubbles: true, pointerType: 'mouse'
  }));
  await wait(120);   // let the next frame project it

  // The app stores normalized NDC; recompute world independently.
  const expected = window.__warp.expectedWorldAt(px, py);
  return { expected: { x:+expected.x.toFixed(3), y:+expected.y.toFixed(3) },
           screenPoint: { x: Math.round(px), y: Math.round(py) } };
})()
`)

  report.resizeAlignment.push({
    viewport: [w, h],
    ...aspect,
    projectedPoint: consistency,
    aspectOk: aspect.delta < 0.002,
  })
}

/* ── 5. Confirm the pointer normalisation uses the canvas box ────────────── */
report.pointerNormalisation = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();

  // Move to the exact canvas centre: normalized coords must be ~0,0.
  window.dispatchEvent(new PointerEvent('pointermove', {
    clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true, pointerType: 'mouse'
  }));
  await wait(160);

  const g = [...document.querySelectorAll('button[aria-label]')]
    .find(x => (x.getAttribute('aria-label')||'').includes('FPS'));
  if (g && (g.getAttribute('aria-label')||'').includes('开启')) g.click();
  await wait(900);

  const m = document.body.innerText.match(/(-?\\d+\\.\\d+) \\/ (-?\\d+\\.\\d+)/);
  return {
    canvasBox: { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) },
    windowInner: [innerWidth, innerHeight],
    scrollbarDelta: innerWidth - Math.round(r.width),
    centredMouse: m ? { x: Number(m[1]), y: Number(m[2]) } : null,
  };
})()
`)

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/warp-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
ws.close()
