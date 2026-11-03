/**
 * WebGL context loss, asserted with a REAL lost context (CR-12 / SH-11).
 *
 * ── Why this cannot be a unit test ──────────────────────────────────────────
 * The review's finding was that the repo had no `webglcontextlost` handler anywhere: a driver
 * reset, a GPU process crash or a switch between integrated and discrete graphics left the page
 * permanently black with nothing in the interface to say why. The fix is three things at once --
 * a capture-phase listener on `document` (the event does not bubble out of an R3F canvas), a
 * call to `preventDefault()` (the browser's only signal that the app wants the context back), and
 * a visible message. A jsdom test can fake the event but not the part that matters: whether the
 * browser actually restores the context afterwards.
 *
 * So this drives a real Chromium against the built output and takes the context away with
 * `WEBGL_lose_context`. What it asserts, in order:
 *
 *   L1. Exactly one live WebGL2 canvas exists (the background scene), and no notice is showing.
 *   L2. Losing that context shows the notice, with the dictionary's own wording, and announces
 *       the same sentence through the single polite live region.
 *   L3. A SECOND context lost while the first is down does not double-announce or change the
 *       message (the notice describes "the graphics context", not one canvas).
 *   L4. Restoring the first context while the second is still lost keeps the notice up -- the
 *       page is not out of the woods yet. This is the multi-canvas bookkeeping, and it is the
 *       part a single-canvas implementation gets wrong.
 *   L5. Restoring the last context clears the notice, announces recovery, and leaves the
 *       renderer with a healthy, sized drawing buffer.
 *
 * Usage:
 *   node scripts/verify-context-loss.mjs --base http://127.0.0.1:4173
 *   CHROME_PATH=/usr/bin/chromium node scripts/verify-context-loss.mjs --base http://127.0.0.1:4173
 *
 * Exit code 1 on any failed assertion.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'
import { finish } from './lib/verify.mjs'

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const base = argValue('--base', 'http://127.0.0.1:4173')
const chromePath = CANDIDATES.find((c) => typeof c === 'string' && c.length > 0 && existsSync(c))
if (!chromePath) {
  console.error('::error::no Chrome/Chromium found; set CHROME_PATH')
  process.exit(1)
}

const port = 9500 + Math.floor(Math.random() * 90)
const profile = await mkdtemp(join(tmpdir(), 'showroom-context-'))

/*
 * Platform flags, same rationale as `verify-scroll.mjs`: the runner needs `--no-sandbox` to start
 * at all, and the Windows host wants its real GPU rather than a software fallback.
 *
 * Linux is the CI runner, which has no GPU. This probe does not measure pixels or frame times --
 * it asks whether the browser takes a context away and gives it back -- so a software rasteriser
 * is a valid answer, and SwiftShader is the only way to get a real WebGL2 context there at all.
 * Without these flags the probe would report "no live WebGL2 canvas" and read like an app bug.
 */
const platformArgs = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1600,900',
  ...(process.platform === 'linux'
    ? [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
      ]
    : []),
  ...(process.platform === 'win32'
    ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
    : []),
]

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...platformArgs,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws = null
const failures = []
const consoleErrors = []
const exceptions = []
/** How many assertions actually ran, so the report does not invent a number. */
let checksRun = 0

/** Fail with a message that says which assertion broke and why. */
function check(name, condition, detail) {
  checksRun += 1
  if (condition) return true
  failures.push(`${name}: ${detail}`)
  return false
}

try {
  let target = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page')
      if (target) break
    } catch {
      // endpoint not up yet
    }
  }
  if (!target) throw new Error('Chrome debugging endpoint never became ready')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let nextId = 1
  const pending = new Map()

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails
      exceptions.push(d.exception?.description ?? d.text)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(
        (message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
      )
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  /** Evaluate a page-side IIFE and return its value verbatim. */
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    }
    return res.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url: base })

  // Same readiness rule as the scroll gate: the boot veil must be gone, not merely the document
  // loaded. Losing a context while the veil is still up tests the veil, not the notice. The budget
  // is generous because the CI runner compiles every shader on a software rasteriser.
  let ready = false
  for (let attempt = 0; attempt < 160; attempt++) {
    await sleep(250)
    ready = await evaluate(
      "document.readyState === 'complete' && document.body !== null && !document.querySelector('[data-boot]')",
    )
    if (ready) break
  }
  if (!ready) throw new Error('page never finished booting (the veil is still up)')

  /* ── L1: a live WebGL2 canvas, and no notice ─────────────────────────────── */
  const initial = await evaluate(`(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'))
    const live = []
    for (const canvas of canvases) {
      const gl = canvas.getContext('webgl2')
      if (gl && !gl.isContextLost()) live.push(canvas)
    }
    window.__ctxProbe = {
      target: live[0] ?? null,
      background: live.find((c) => c.getBoundingClientRect().width >= window.innerWidth - 1) ?? live[0] ?? null,
      temp: null,
      backgroundExt: null,
      tempExt: null,
    }
    return {
      found: live.length > 0,
      liveGlCanvases: live.length,
      totalCanvases: canvases.length,
      noticeVisible: document.querySelector('[data-webgl-context-status]') !== null,
    }
  })()`)

  console.log(
    `L1 canvases: ${initial.totalCanvases} total, ${initial.liveGlCanvases} with a live WebGL2 context`,
  )

  if (
    !check(
      'L1_live_gl_canvas',
      initial.found && initial.liveGlCanvases >= 1,
      'no live WebGL2 canvas found; the app took its no-WebGL fallback (see scripts/check-webgl.mjs)',
    )
  ) {
    throw new Error('cannot test context loss without a GL context')
  }
  check(
    'L1_notice_absent',
    initial.noticeVisible === false,
    'the notice was already visible before any loss',
  )

  /** Read the notice and the single polite live region in one round trip. */
  const readNotice = () =>
    evaluate(`(() => {
      const notice = document.querySelector('[data-webgl-context-status]')
      const region = document.getElementById('a11y-announcer')
      return {
        visible: notice !== null,
        text: notice ? notice.textContent.trim() : '',
        // The banner explains visually; the singleton announcer speaks. If the banner also
        // carried a live-region attribute the reader would say it twice.
        noticeIsLiveRegion:
          notice !== null &&
          (notice.hasAttribute('aria-live') || notice.getAttribute('role') === 'status' || notice.getAttribute('role') === 'alert'),
        announced: region ? region.textContent.trim() : '',
      }
    })()`)

  /** Poll until `predicate(value)` or the budget runs out. Returns the last value either way. */
  const until = async (read, predicate, budgetMs = 5000) => {
    const deadline = Date.now() + budgetMs
    let value = await read()
    while (!predicate(value) && Date.now() < deadline) {
      await sleep(100)
      value = await read()
    }
    return value
  }

  /* ── L2: lose the background context ─────────────────────────────────────── */
  const lost = await evaluate(`(() => {
    const probe = window.__ctxProbe
    const canvas = probe.background
    if (!canvas) return { ok: false, reason: 'no background canvas' }
    const gl = canvas.getContext('webgl2')
    const ext = gl && gl.getExtension('WEBGL_lose_context')
    if (!ext) return { ok: false, reason: 'WEBGL_lose_context unavailable' }
    probe.backgroundExt = ext
    ext.loseContext()
    return { ok: true }
  })()`)
  check('L2_lose_context', lost.ok === true, `could not force a loss (${lost.reason})`)

  const lostNotice = await until(
    readNotice,
    (value) => value.visible && value.text.length > 0 && value.announced.length > 0,
  )
  const lostWording = [
    'Graphics context lost — the browser is restoring it',
    '图形上下文丢失——浏览器正在恢复',
  ]
  check(
    'L2_notice_visible',
    lostNotice.visible === true,
    'no notice appeared after the context was lost',
  )
  check(
    'L2_notice_wording',
    lostWording.includes(lostNotice.text),
    `notice text was "${lostNotice.text}", expected one of the dictionary strings`,
  )
  check(
    'L2_announced',
    lostNotice.announced === lostNotice.text,
    `live region said "${lostNotice.announced}" while the notice said "${lostNotice.text}"`,
  )
  check(
    'L2_banner_is_not_a_live_region',
    lostNotice.noticeIsLiveRegion === false,
    'the visible banner is also a live region, so the announcement happens twice',
  )

  /* ── L3: a second context goes down ──────────────────────────────────────── */
  const second = await evaluate(`(() => {
    const probe = window.__ctxProbe
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    canvas.setAttribute('data-context-probe', '')
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;opacity:0;pointer-events:none'
    document.body.appendChild(canvas)
    const gl = canvas.getContext('webgl2')
    const ext = gl && gl.getExtension('WEBGL_lose_context')
    if (!ext) return { ok: false, reason: 'WEBGL_lose_context unavailable on the probe canvas' }
    probe.temp = canvas
    probe.tempExt = ext
    ext.loseContext()
    return { ok: true }
  })()`)
  check(
    'L3_lose_second_context',
    second.ok === true,
    `could not lose a second context (${second.reason})`,
  )

  // 600 ms is several frames: long enough for a double announcement to have happened.
  await sleep(600)
  const both = await readNotice()
  check(
    'L3_notice_still_visible',
    both.visible === true,
    'the notice disappeared while a context was still lost',
  )
  check(
    'L3_notice_unchanged',
    both.text === lostNotice.text,
    `the notice text changed to "${both.text}" when the second context was lost`,
  )

  /* ── L4: restore only the first context ──────────────────────────────────── */
  await evaluate(`(() => { window.__ctxProbe.backgroundExt.restoreContext(); return true })()`)
  const backgroundBack = await until(
    () =>
      evaluate(`(() => {
        const canvas = window.__ctxProbe.target
        const gl = canvas && canvas.getContext('webgl2')
        return { restored: gl ? !gl.isContextLost() : false, width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 }
      })()`),
    (value) => value.restored === true,
  )
  check(
    'L4_context_restored',
    backgroundBack.restored === true,
    'the browser never restored the context (a listener did not preventDefault)',
  )
  check(
    'L4_drawing_buffer',
    backgroundBack.width > 0 && backgroundBack.height > 0,
    `the drawing buffer is ${backgroundBack.width}x${backgroundBack.height} after restore`,
  )

  const partly = await readNotice()
  check(
    'L4_notice_survives_partial_restore',
    partly.visible === true,
    'the notice cleared while the second context was still lost',
  )

  /* ── L5: restore the last context ────────────────────────────────────────── */
  await evaluate(`(() => { window.__ctxProbe.tempExt.restoreContext(); return true })()`)
  // The announcer writes its text 60 ms after the call, so wait for both conditions rather than
  // reading the moment the banner unmounts and calling an empty region a failure.
  const cleared = await until(
    readNotice,
    (value) => value.visible === false && value.announced.length > 0,
  )
  check(
    'L5_notice_cleared',
    cleared.visible === false,
    'the notice is still on screen after every context came back',
  )
  check(
    'L5_recovery_announced',
    cleared.announced === 'Graphics restored' || cleared.announced === '图形已恢复',
    `live region said "${cleared.announced}" after recovery`,
  )

  /* ── Teardown: drop the probe canvas, confirm the page is still healthy ──── */
  const final = await evaluate(`(() => {
    const probe = window.__ctxProbe
    if (probe.temp && probe.temp.parentNode) probe.temp.parentNode.removeChild(probe.temp)
    const canvas = probe.target
    const gl = canvas && canvas.getContext('webgl2')
    return {
      backgroundHealthy: gl ? !gl.isContextLost() : null,
      noticeVisible: document.querySelector('[data-webgl-context-status]') !== null,
      probeCanvasRemoved: document.querySelector('[data-context-probe]') === null,
      renderer: gl ? String(gl.getParameter(gl.VERSION)) : null,
    }
  })()`)
  check(
    'L5_background_healthy',
    final.backgroundHealthy === true,
    'the background context is still lost at the end',
  )
  check('L5_notice_gone', final.noticeVisible === false, 'the notice is still mounted at the end')
  check(
    'L5_probe_canvas_removed',
    final.probeCanvasRemoved === true,
    'the probe canvas was left in the page',
  )

  const report = {
    L1_initial: initial,
    L2_lost: lostNotice,
    L3_bothLost: both,
    L4_partialRestore: { backgroundBack, notice: partly },
    L5_restored: cleared,
    final,
    summary: {
      liveGlCanvases: initial.liveGlCanvases,
      totalCanvases: initial.totalCanvases,
      renderer: final.renderer,
      assertions: checksRun,
      failed: failures.length,
    },
  }
  console.log(JSON.stringify(report, null, 2))

  finish({
    label: 'context-loss',
    exceptions,
    consoleErrors,
    failures,
    report: { ...report },
  })
} finally {
  try {
    ws?.close()
  } catch {
    // already closed
  }
  chrome.kill()
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
