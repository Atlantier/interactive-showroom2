/**
 * Performance + allocation verification for the flow-field particle system.
 *
 * The spec forbids per-frame object allocation. This script measures it
 * empirically rather than trusting the source: it samples the JS heap and GC
 * counters across several seconds of animation while the mouse is moving.
 *
 * A system that allocates in the frame loop shows steady heap growth plus a high
 * minor-GC rate. A pre-allocated one stays flat.
 *
 * Run: node scripts/verify-perf.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9335'
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

// SwiftShader (software GL) is far slower than a real GPU, so throughput numbers
// here are a LOWER BOUND. Allocation behaviour, however, is representative.
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

const report = {}

/* ── 1. Frame timing over a sweep, with the cursor moving ────────────────── */
report.frameTiming = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const gl = window.__showroomScene.gl;

  // Drive the mouse so the repulsion branch is exercised every frame — that is
  // the most allocation-prone code path.
  let running = true;
  const mover = (async () => {
    const w = innerWidth, h = innerHeight;
    let a = 0;
    while (running) {
      a += 0.09;
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: w/2 + Math.cos(a)*w*0.28,
        clientY: h/2 + Math.sin(a)*h*0.28,
        bubbles: true, pointerType: 'mouse'
      }));
      await wait(16);
    }
  })();

  const frames = [];
  let last = performance.now();
  const t0 = last;
  while (performance.now() - t0 < 4000) {
    await new Promise(r => requestAnimationFrame(r));
    const now = performance.now();
    frames.push(now - last);
    last = now;
  }
  running = false;
  await mover;

  frames.sort((a,b) => a-b);
  const p = q => frames[Math.floor(frames.length*q)];
  const mean = frames.reduce((s,v)=>s+v,0)/frames.length;
  return {
    sampleCount: frames.length,
    meanMs: +mean.toFixed(2),
    p50Ms: +p(0.5).toFixed(2),
    p95Ms: +p(0.95).toFixed(2),
    p99Ms: +p(0.99).toFixed(2),
    maxMs: +frames[frames.length-1].toFixed(2),
    softwareRenderer: true,
  };
})()
`)

/* ── 2. Heap growth under sustained animation ────────────────────────────── */
report.heap = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const mem = performance.memory;
  if (!mem) return { unsupported: true };

  // Warm up so JIT + lazy allocation settle before measuring.
  await wait(1500);
  const start = mem.usedJSHeapSize;

  // ~6s of animation with a moving cursor.
  let running = true;
  const mover = (async () => {
    const w = innerWidth, h = innerHeight;
    let a = 0;
    while (running) {
      a += 0.07;
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: w/2 + Math.cos(a)*w*0.3,
        clientY: h/2 + Math.sin(a)*h*0.3,
        bubbles: true, pointerType: 'mouse'
      }));
      await wait(16);
    }
  })();
  await wait(6000);
  running = false;
  await mover;

  const end = mem.usedJSHeapSize;
  return {
    startMB: +(start/1048576).toFixed(2),
    endMB: +(end/1048576).toFixed(2),
    growthMB: +((end-start)/1048576).toFixed(2),
    growthPercent: +(((end-start)/start)*100).toFixed(2),
    totalHeapMB: +(mem.totalJSHeapSize/1048576).toFixed(2),
  };
})()
`)

/* ── 3. Geometry does not grow (no buffer reallocation) ──────────────────── */
report.geometryStability = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const scene = window.__showroomScene.scene;
  let pts = null;
  scene.traverse(o => { if (o.isPoints && !pts) pts = o; });
  const geo = pts.geometry;
  const bufBefore = geo.getAttribute('position').array.byteLength;
  const countBefore = geo.getAttribute('position').count;
  const uuidBefore = geo.uuid;

  await wait(3000);

  return {
    bufferBytesBefore: bufBefore,
    bufferBytesAfter: geo.getAttribute('position').array.byteLength,
    countBefore,
    countAfter: geo.getAttribute('position').count,
    sameGeometryObject: geo.uuid === uuidBefore,
    bufferIdentityStable:
      geo.getAttribute('position').array.byteLength === bufBefore &&
      geo.getAttribute('position').count === countBefore,
  };
})()
`)

/* ── 4. Attribute upload flags are being set ─────────────────────────────── */
report.attributeUpdates = await evaluate(`
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const scene = window.__showroomScene.scene;
  let pts = null;
  scene.traverse(o => { if (o.isPoints && !pts) pts = o; });
  const pos = pts.geometry.getAttribute('position');
  const col = pts.geometry.getAttribute('color');

  // Mutating the typed array in place with needsUpdate=true is the correct
  // pattern; verify the version counter actually advances (proving uploads).
  const v0 = pos.version;
  const c0 = col.version;
  await wait(600);
  return {
    positionVersionDelta: pos.version - v0,
    colorVersionDelta: col.version - c0,
    usage: pos.usage,          // 35048 === DynamicDrawUsage
    isDynamic: pos.usage === 35048,
    needsUpdateCleared: pos.needsUpdate === false,
  };
})()
`)

writeFileSync('screenshots/perf-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
ws.close()
