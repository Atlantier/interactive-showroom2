/**
 * GPU resource leak test.
 *
 * ── Why a runtime test and not just a code review ─────────────────────────
 * Reading every `useEffect` and confirming a `.dispose()` call tells you the
 * code *intends* to free things. It does not tell you the resource is actually
 * released, that the effect's dependency array is right, or that the churn path
 * the app really exercises (viewport culling remounting the rig, a tier switch
 * rebuilding the particle geometry) is covered.
 *
 * three.js maintains exactly the counters needed to answer that:
 *
 *   info.memory.geometries   live GPU geometry buffers
 *   info.memory.textures     live GPU textures / render targets
 *   info.programs.length     live compiled shader programs
 *
 * If a dispose is missing or mis-keyed, the corresponding counter grows on every
 * churn cycle. If disposal is correct, the counts return to their baseline. That
 * is a hard, falsifiable assertion — much stronger than "I saw a dispose call".
 *
 * Two churn loops are exercised, because they are the two the app performs:
 *   1. The architecture rig unmounting/remounting as the section leaves and
 *      re-enters the viewport (the `awake` gate added for the performance audit).
 *      Every mount builds 5 geometries + 1 ShaderMaterial + 1 transmission FBO.
 *   2. The particle system rebuilding its BufferGeometry when the quality tier
 *      changes, since the geometry is memoised on `count`.
 *
 * Run: node scripts/verify-leaks.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import { finish } from './lib/verify.mjs'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9359'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5279'

/** How many mount/unmount cycles to run. Each one leaks if disposal is broken. */
const CYCLES = 3

/* -------------------------------------------------------------------------- */
/*  Page probes                                                               */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  const counters = (handle) => {
    if (!handle || !handle.gl) return null
    const info = handle.gl.info
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
    }
  }

  window.__lk = {
    async load() {
      window.__lkStore = await import('/src/store/useAppStore.ts')
      return true
    },

    ready() {
      return Boolean(window.__archScene?.gl && window.__showroomScene?.gl)
    },

    /** Live GPU counters for both canvases. */
    memory() {
      return {
        arch: counters(window.__archScene),
        background: counters(window.__showroomScene),
      }
    },

    heap() {
      const mem = performance.memory
      return mem ? Math.round((mem.usedJSHeapSize / (1024 * 1024)) * 10) / 10 : null
    },

    async sleep(ms) {
      await new Promise((r) => setTimeout(r, ms))
      return true
    },

    /** Park the architecture section on screen (rig mounts). */
    async showArchitecture() {
      document.querySelector('#architecture')?.scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 1600))
      return true
    },

    /** Scroll far away so the rig's `awake` gate unmounts it. */
    async hideArchitecture() {
      window.scrollTo(0, 0)
      await new Promise((r) => setTimeout(r, 1400))
      return true
    },

    rigMounted() {
      // The prism only exists while the rig is mounted.
      const scene = window.__archScene?.scene
      if (!scene) return null
      let meshCount = 0
      scene.traverse((object) => {
        if (object.isMesh || object.isPoints || object.isLine) meshCount++
      })
      return meshCount
    },

    setTier(tier) {
      window.__lkStore.useAppStore.setState({ performanceTier: tier })
      return window.__lkStore.useAppStore.getState().performanceTier
    },

    async settle() {
      // Long enough for the renderer to upload newly created resources and for
      // three.js to decrement the counters for anything disposed.
      await new Promise((r) => setTimeout(r, 900))
      return true
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
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

const evalAsync = async (expression, attempt = 0) => {
  try {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      return {
        __error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
      }
    }
    return res.result?.value
  } catch (error) {
    if (attempt < 3) {
      await sleep(500)
      return evalAsync(expression, attempt + 1)
    }
    return { __error: String(error) }
  }
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(9000)

await evalAsync('(' + installHelpers.toString() + ')()')
await evalAsync('window.__lk.load()')

// Wait for both renderers to exist.
for (let i = 0; i < 20; i++) {
  const ready = await evalAsync('window.__lk.ready()')
  if (ready === true) break
  await sleep(500)
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Phase 1 — architecture rig mount / unmount churn                         */
/* ══════════════════════════════════════════════════════════════════════════ */

await evalAsync('window.__lk.showArchitecture()')
await evalAsync('window.__lk.settle()')
const baselineArch = await evalAsync('window.__lk.memory()')
const mountedMeshCount = await evalAsync('window.__lk.rigMounted()')

// One full cycle first, so lazily-created programs are compiled and counted
// before the baseline is taken. Otherwise the FIRST cycle legitimately adds
// programs and would read as a leak.
await evalAsync('window.__lk.hideArchitecture()')
const unmountedMeshCount = await evalAsync('window.__lk.rigMounted()')
await evalAsync('window.__lk.showArchitecture()')
await evalAsync('window.__lk.settle()')

const steadyArch = await evalAsync('window.__lk.memory()')
const heapBefore = await evalAsync('window.__lk.heap()')

for (let cycle = 0; cycle < CYCLES; cycle++) {
  await evalAsync('window.__lk.hideArchitecture()')
  await evalAsync('window.__lk.showArchitecture()')
  await evalAsync('window.__lk.settle()')
}

const afterArchChurn = await evalAsync('window.__lk.memory()')
const heapAfter = await evalAsync('window.__lk.heap()')

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Phase 2 — quality-tier churn rebuilds the particle geometry              */
/* ══════════════════════════════════════════════════════════════════════════ */

const baselineBg = await evalAsync('window.__lk.memory()')

for (let cycle = 0; cycle < CYCLES; cycle++) {
  await evalAsync('window.__lk.setTier("medium")')
  await sleep(700)
  await evalAsync('window.__lk.setTier("high")')
  await sleep(700)
}
await evalAsync('window.__lk.settle()')

const afterTierChurn = await evalAsync('window.__lk.memory()')
const exceptionsAfter = [...exceptions]

/* ══════════════════════════════════════════════════════════════════════════ */
/*  Assertions                                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

const delta = (a, b, key) =>
  a && b && typeof a[key] === 'number' && typeof b[key] === 'number' ? b[key] - a[key] : null

const archGeoDelta = delta(steadyArch?.arch, afterArchChurn?.arch, 'geometries')
const archTexDelta = delta(steadyArch?.arch, afterArchChurn?.arch, 'textures')
const archProgDelta = delta(steadyArch?.arch, afterArchChurn?.arch, 'programs')
const bgGeoDelta = delta(baselineBg?.background, afterTierChurn?.background, 'geometries')
const bgProgDelta = delta(baselineBg?.background, afterTierChurn?.background, 'programs')

const assertions = {
  /* Setup sanity: the rig really is mounting and unmounting. */
  rigMountsOnScreen: (mountedMeshCount ?? 0) > 10,
  rigUnmountsOffScreen: (unmountedMeshCount ?? 1) === 0,

  /* The rig genuinely allocated resources that had to be freed. */
  archHadGeometries: (steadyArch?.arch?.geometries ?? 0) > 5,
  archHadPrograms: (steadyArch?.arch?.programs ?? 0) > 0,

  /* No growth after N mount/unmount cycles. */
  archGeometryStable: archGeoDelta === 0,
  archTextureStable: archTexDelta === 0,
  archProgramStable: archProgDelta === 0,

  /* No growth after N particle-geometry rebuilds. */
  bgGeometryStable: bgGeoDelta === 0,
  bgProgramStable: bgProgDelta === 0,

  /* A crude JS-heap ceiling: catches Node-side/typed-array leaks the GPU
   * counters cannot see. Generous, because the V8 heap legitimately grows and
   * the GC may simply not have run. */
  heapBounded: heapBefore === null || heapAfter === null || heapAfter - heapBefore < 40,

  noExceptions: exceptionsAfter.length === 0,
}

const failed = Object.entries(assertions)
  .filter(([, value]) => !value)
  .map(([key]) => key)

const report = {
  assertions,
  failed,
  deltas: {
    archGeometries: archGeoDelta,
    archTextures: archTexDelta,
    archPrograms: archProgDelta,
    bgGeometries: bgGeoDelta,
    bgPrograms: bgProgDelta,
    heapMB: heapBefore === null ? null : Math.round((heapAfter - heapBefore) * 10) / 10,
  },
  samples: {
    baselineArch,
    steadyArch,
    afterArchChurn,
    baselineBg,
    afterTierChurn,
    mountedMeshCount,
    unmountedMeshCount,
  },
  exceptions: exceptionsAfter,
}

writeFileSync('screenshots/leak-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

finish({ label: 'leaks', exceptions, report })
ws.close()
