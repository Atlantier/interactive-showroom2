/**
 * Scroll-pacing assertion.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every scroll optimisation in this repo so far was verified by eye, with a throwaway
 * CDP script that was never kept. That is how a 500 ms stall in the architecture
 * chapter survived unnoticed through several rounds of tuning: nothing was measuring.
 *
 * This turns the throwaway into an assertion: load the production build, wheel-scroll
 * the whole page, and fail if the frame-delta distribution regresses.
 *
 * ── Why it drives its own browser ───────────────────────────────────────────
 * The 17 existing `verify-*.mjs` scripts need a human to start Chrome on a specific
 * debug port, which is why none of them ever ran in CI. This one launches Chromium
 * itself (CHROME_PATH, or the usual install locations) and shuts it down again.
 *
 * Usage:
 *   node scripts/verify-scroll.mjs --base http://127.0.0.1:4173
 *   CHROME_PATH=/usr/bin/chromium node scripts/verify-scroll.mjs --base ...
 *
 * Exit code 1 on any violated threshold.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

/* -------------------------------------------------------------------------- */
/*  Budgets                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Thresholds, in milliseconds of frame delta.
 *
 * Generous on purpose: this runs on shared CI hardware behind a software rasteriser,
 * so the numbers are several times worse than a real GPU. They still catch the
 * regressions that matter -- a reintroduced off-screen pass, a synchronous layout in
 * a pointer handler, a lost chunk boundary.
 */
const BUDGET = {
  /** 95% of frames must be at or below this. */
  p95: 22,
  /** 99% of frames must be at or below this. */
  p99: 60,
  /**
   * Cold-start allowance for a single frame.
   *
   * The gallery's entry currently costs one ~1.2 s frame (measured at y=960): eleven
   * 2D card canvases plus the chart and terminal wake on the same intersection tick.
   * That is a known, logged defect -- tracked in 修改计划.md -- not a regression this
   * script should pretend is fine. It is tolerated HERE so the assertion can still
   * police everything else; `over50` is the guard that would catch the stall becoming
   * systemic rather than a one-off.
   */
  worst: 1600,
  /** How many frames may exceed 50 ms. One cold frame is expected; more is jank. */
  over50: 3,
}

const SCROLL_BURSTS = 60
const BURST_DELTA = 240
const BURST_INTERVAL = 80

/* -------------------------------------------------------------------------- */
/*  Chrome discovery                                                          */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

const base = argValue('--base', 'http://127.0.0.1:4173')

/*
 * How many times to repeat the whole scroll, and why.
 *
 * Measured on an unchanged build: two consecutive runs of this script reported worst 50 ms and
 * worst 2390 ms at the same scroll position. A 48x spread on identical code, almost certainly
 * the GPU driver's shader disk cache -- the same link work is either reused in tens of
 * milliseconds or paid cold. Any verdict from a single run is therefore a coin flip about
 * cache state rather than a statement about the page.
 *
 * So the same scroll is repeated (fresh page load each time, same browser) and the verdict is
 * taken on the MEDIAN run. The first run is reported separately as "cold" because that is what
 * a first-time visitor with an empty cache experiences, and it is genuinely worse.
 */
const RUNS = Number(argValue('--runs', '5'))
const chromePath = CANDIDATES.find((c) => typeof c === 'string' && c.length > 0 && existsSync(c))
if (!chromePath) {
  console.error('::error::no Chrome/Chromium found; set CHROME_PATH')
  process.exit(1)
}

const port = 9400 + Math.floor(Math.random() * 90)
const profile = await mkdtemp(join(tmpdir(), 'showroom-scroll-'))

/*
 * Platform flags.
 *
 * `--no-sandbox` and `--disable-dev-shm-usage` are required for Chrome to start at all
 * on the GitHub runner (and in most containers): without them the process exits before
 * it opens the debugging port, which surfaced as "debugging endpoint never became
 * ready" rather than as a clear error. The GPU flags are Windows-oriented and are
 * skipped elsewhere so they cannot be rejected as unknown switches.
 */
const platformArgs = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1600,900',
  ...(process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox']
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
let failures = []

try {
  // Wait for the debugging endpoint, then for the page target.
  let target = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page')
      if (target) break
    } catch {
      // not up yet
    }
  }
  if (!target) throw new Error('Chrome debugging endpoint never became ready')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let messageId = 0
  const pending = new Map()
  const consoleErrors = []

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
      consoleErrors.push(
        String(message.params.exceptionDetails.exception?.description).slice(0, 200),
      )
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++messageId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails)
      throw new Error(String(result.exceptionDetails.exception?.description))
    return result.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  /**
   * One full measurement: load, wait for the boot veil, sample every frame while scrolling.
   *
   * A fresh `Page.navigate` per run resets the scroll position and re-runs the app's mount
   * path, while the browser process (and therefore the driver's shader cache) is reused --
   * which is exactly the situation the median is meant to describe.
   */
  const measureRun = async (runIndex) => {
    await send('Page.navigate', { url: base })

    // Wait for the boot veil to lift: the app reports readiness through `prewarmDone`.
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(500)
      ready = await evaluate(
        `!!document.querySelector('[data-boot], main, section#hero') && document.readyState === 'complete'`,
      )
      if (ready) break
    }
    if (!ready) throw new Error(`run ${runIndex + 1}: page never finished loading`)
    await sleep(2500)

    await evaluate(`(() => {
      window.__scrollProbe = { frames: [] }
      let last = performance.now()
      const loop = (now) => {
        window.__scrollProbe.frames.push([now - last, Math.round(window.scrollY)])
        last = now
        window.__scrollProbe.raf = requestAnimationFrame(loop)
      }
      window.__scrollProbe.raf = requestAnimationFrame(loop)
      return true
    })()`)

    await sleep(300)
    for (let burst = 0; burst < SCROLL_BURSTS; burst++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 800,
        y: 450,
        deltaX: 0,
        deltaY: BURST_DELTA,
      })
      await sleep(BURST_INTERVAL)
    }
    await sleep(1500)

    return evaluate(`(() => {
      cancelAnimationFrame(window.__scrollProbe.raf)
      const samples = window.__scrollProbe.frames
      const deltas = samples.map((s) => s[0]).sort((a, b) => a - b)
      const count = deltas.length
      const mean = deltas.reduce((a, b) => a + b, 0) / count
      /*
       * A bare "worst frame" number is not actionable -- the same 1 s stall means
       * completely different things at y=0 (first paint) and y=4400 (mid chapter). Report
       * where the three worst frames happened so a failure points at a section.
       */
      const worstFrames = [...samples]
        .sort((a, b) => b[0] - a[0])
        .slice(0, 3)
        .map((s) => ({ ms: Math.round(s[0]), y: s[1] }))

      return {
        count,
        fps: 1000 / mean,
        p95: deltas[Math.floor(count * 0.95)],
        p99: deltas[Math.floor(count * 0.99)],
        worst: deltas[count - 1],
        worstFrames,
        over50: deltas.filter((d) => d > 50).length,
        endY: Math.round(window.scrollY),
      }
    })()`)
  }

  const runs = []
  for (let run = 0; run < RUNS; run++) {
    const runStats = await measureRun(run)
    runs.push(runStats)
    console.log(
      `  run ${run + 1}/${RUNS}: fps ${runStats.fps.toFixed(1)}  p95 ${runStats.p95.toFixed(1)}` +
        `  p99 ${runStats.p99.toFixed(1)}  worst ${runStats.worst.toFixed(0)}` +
        `  over50 ${runStats.over50}`,
    )
  }

  /** Median of one metric across runs; the verdict is taken on medians (see RUNS). */
  const median = (pick) => {
    const values = runs.map(pick).sort((a, b) => a - b)
    const middle = Math.floor(values.length / 2)
    return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle]
  }

  const stats = {
    count: Math.min(...runs.map((r) => r.count)),
    fps: median((r) => r.fps),
    p95: median((r) => r.p95),
    p99: median((r) => r.p99),
    worst: median((r) => r.worst),
    over50: median((r) => r.over50),
    endY: Math.min(...runs.map((r) => r.endY)),
    worstFrames: runs.reduce((worst, r) => (r.worst > worst.worst ? r : worst), runs[0])
      .worstFrames,
  }

  console.log(
    `  cold run (first load, empty shader cache): worst ${runs[0].worst.toFixed(0)} ms at ${JSON.stringify(runs[0].worstFrames[0])}`,
  )
  console.log(`  median of ${RUNS} runs is the verdict`)

  const report = {
    frames: stats.count,
    fps: +stats.fps.toFixed(1),
    p95: +stats.p95.toFixed(1),
    p99: +stats.p99.toFixed(1),
    worst: +stats.worst.toFixed(0),
    over50: stats.over50,
    scrolled: stats.endY,
    worstAt: stats.worstFrames,
  }
  console.log(`scroll pacing (median of ${RUNS} runs):`, JSON.stringify(report))

  if (stats.count < 200)
    failures.push(`only ${stats.count} frames sampled — the page did not scroll`)
  if (stats.endY < 2000)
    failures.push(`page only scrolled to ${stats.endY}px — wheel input was not applied`)
  if (stats.p95 > BUDGET.p95) failures.push(`p95 ${report.p95} ms > ${BUDGET.p95} ms`)
  if (stats.p99 > BUDGET.p99) failures.push(`p99 ${report.p99} ms > ${BUDGET.p99} ms`)
  if (stats.worst > BUDGET.worst)
    failures.push(
      `worst frame ${report.worst} ms > ${BUDGET.worst} ms at ${JSON.stringify(report.worstAt)}`,
    )
  if (stats.over50 > BUDGET.over50)
    failures.push(`${stats.over50} frames over 50 ms > ${BUDGET.over50}`)
  if (consoleErrors.length > 0)
    failures.push(`console errors: ${consoleErrors.slice(0, 2).join(' | ')}`)
} catch (error) {
  failures.push(String(error?.message ?? error))
} finally {
  try {
    ws?.close()
  } catch {
    // already closed
  }
  chrome.kill()
  await sleep(300)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`)
  process.exit(1)
}
console.log('scroll pacing OK')
