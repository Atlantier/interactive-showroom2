/**
 * Visual regression baseline.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * Three batch-4 items were deferred for one reason: they change PIXELS (a quantised
 * gradient cache, a `shadowBlur` replacement, a restructured bento grid) and this project
 * has no way to tell "the frame looks the same" from "it looks slightly different". Every
 * previous attempt at a visual change was accepted on "seems fine", which is exactly the
 * review's complaint about the whole codebase.
 *
 * ── Why not a pixel diff ────────────────────────────────────────────────────
 * The page is never still: 8000 nebula particles, a rotating core, choreographed camera
 * easing, seven 2D sandboxes. Two consecutive screenshots of the SAME state already differ
 * in thousands of pixels, so a per-pixel threshold would either be so loose it catches
 * nothing or so tight it always fails.
 *
 * So the comparison happens on a 16x16 block grid: each block becomes its mean colour,
 * and the metric is "how much did a block's colour move". Layout shifts, colour changes
 * and missing elements all move blocks by tens of levels; particles drifting average out
 * inside a block. The threshold is calibrated below against the measured noise floor -- two
 * captures of the same state, back to back -- rather than picked by taste.
 *
 * ── What this is NOT (measured, and the reason it is not in CI) ────────────
 * It is not a visual regression gate. The validation that settled this: the accent colour
 * was changed from cyan #22d3ee to red #ff2d55, the build was refreshed, and the comparison
 * still PASSED (worst block 59, mean 8.5 at the entrance) because a small accent swap moves
 * a 96 px block by less than the cross-run noise floor allows. Loosening the blocks further
 * would make it blind; tightening them makes it fail on unchanged code.
 *
 * A real gate needs per-block thresholds calibrated against several full page LOADS (not
 * frames), or deterministic boot: seeded Math.random for the nebula, blocking web fonts, a
 * fixed simulation phase for the 2D sandboxes. That is a project of its own, so this script
 * ships as the diagnostic it actually is:
 *
 *     node scripts/verify-visual.mjs --base ... --update   # (re)capture reference
 *     node scripts/verify-visual.mjs --base ... --report   # capture + diff heat maps
 *
 * It answers "did this section change at all, and where", which is enough to LOOK at a
 * canvas change; it does not answer "is this acceptable", and nothing in CI depends on it.
 *
 * ── Platform ────────────────────────────────────────────────────────────────
 * The baseline records the platform it was captured on and is only compared on that
 * platform: headless Chromium on Windows (ANGLE/D3D11) and on Linux (llvmpipe) do not
 * rasterise the same pixels, and pretending otherwise would make CI red for no reason.
 * On a different platform the check SKIPS with a printed reason. Capture a Linux baseline
 * by running `--update` inside the CI image when that matters.
 *
 * Usage:
 *   node scripts/verify-visual.mjs --base http://127.0.0.1:4173
 *   node scripts/verify-visual.mjs --base ... --update      # rewrite the baselines
 *   node scripts/verify-visual.mjs --base ... --report      # write diff PNGs for eyeballing
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PNG } from 'pngjs'
import WebSocket from 'ws'
import { findMissing, finish } from './lib/verify.mjs'

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

const chromePath = CANDIDATES.find((c) => typeof c === 'string' && c.length > 0 && existsSync(c))

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const base = argValue('--base', 'http://127.0.0.1:4173')
const update = process.argv.includes('--update')
const report = process.argv.includes('--report')

/** Viewport, fixed: the baseline is meaningless if the layout width changes. */
const VIEW = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }

/** Where each capture happens, as a fraction of the scrollable height. */
const VIEWS = [
  { name: '01-entrance', at: 0 },
  { name: '02-gallery', at: 0.22 },
  { name: '03-architecture', at: 0.45 },
  { name: '04-playground', at: 0.68 },
  { name: '05-archive', at: 0.86 },
  { name: '06-contact', at: 1 },
]

/**
 * Edge length of one comparison block, in CSS pixels.
 *
 * 16 px was too fine: a single bright nebula particle landing inside a block moves its mean
 * by 100+ levels, and particle positions come from `Math.random()` on every load, so two
 * runs of the same build disagreed badly enough to fail. 96 px blocks average a few hundred
 * particles each, which puts the cross-run noise floor near zero while still moving by tens
 * of levels when a heading, a panel or a gradient changes.
 */
const BLOCK = 96

/**
 * Thresholds, calibrated against the MEASURED noise floor on this page.
 *
 * The first attempt used a fixed 26-level tolerance and failed immediately on unchanged
 * code: worst blocks moved by 60-120 levels, because a block that happens to contain a
 * moving particle or a drifting camera edge swings enormously between two captures. The
 * page is simply never still enough for a global threshold.
 *
 * The fix is to stop guessing which blocks are animated and measure it: `--update` captures
 * every view three times and marks each block stable or volatile from its own spread. The
 * comparison then uses only stable blocks -- typography, panels, chrome, layout -- which is
 * where a real regression shows up. Volatile regions (nebula, plasma, particle trails) are
 * reported but not asserted, and the number of stable blocks is printed so a drop in
 * coverage is visible instead of silent.
 */
/*
 * Calibrated against the MEASURED cross-run noise floor of this build, not chosen by taste.
 *
 * Measured over repeated runs on an unchanged build (96 px blocks, pinned clock, frozen
 * page): worst block 1-81, mean 0.1-12.6, "bad" block ratio 0-37%. The spread has three
 * causes, all of them page-load nondeterminism rather than animation:
 *
 *   1. the nebula seeds its 8000 particles from Math.random() on mount
 *   2. the two 2D sandboxes are frozen at whatever simulation phase they reached
 *   3. the web fonts load asynchronously, so text renders in the fallback face on some runs
 *
 * The thresholds therefore sit above that floor with about 1.6x margin and the gate is a
 * STRUCTURE gate: it catches a section that disappeared, a colour scheme that flipped, a
 * layout that moved by a block -- it does NOT catch a two-pixel shift, and it cannot be used
 * to approve a subtle canvas change. Closing that gap needs deterministic boot (seeded RNG,
 * blocking fonts), which is a project of its own and is recorded as such in the plan.
 */
const MAX_BLOCK_DELTA = 110
const MAX_MEAN_DELTA = 20
const MAX_BAD_BLOCK_RATIO = 0.5

/** A block is stable when its three calibration frames agree to within this many levels. */
const STABLE_SPREAD = 8

/** Frames captured per view during --update, to measure the spread. */
const CALIBRATION_FRAMES = 3

/** Settle time after scrolling, before the shutter. The camera eases for about a second. */
const SETTLE_MS = 2600

const BASELINE_DIR = 'visual-baselines'
const BASELINE_FILE = join(BASELINE_DIR, 'baseline.json')

/** Reduce a PNG to the mean colour of every block, as a flat byte array. */
function blockMeans(png) {
  const cols = Math.floor(png.width / BLOCK)
  const rows = Math.floor(png.height / BLOCK)
  const out = new Uint8Array(cols * rows * 3)

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let r = 0
      let g = 0
      let b = 0
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
        let idx = (png.width * y + bx * BLOCK) << 2
        for (let x = 0; x < BLOCK; x++) {
          r += png.data[idx]
          g += png.data[idx + 1]
          b += png.data[idx + 2]
          idx += 4
        }
      }
      const n = BLOCK * BLOCK
      const at = (by * cols + bx) * 3
      out[at] = Math.round(r / n)
      out[at + 1] = Math.round(g / n)
      out[at + 2] = Math.round(b / n)
    }
  }

  return { cols, rows, data: out }
}

/**
 * Difference between two block grids with no masking.
 *
 * Used by the settle loop to decide whether the picture has stopped moving, which is a
 * different question from "does it match the baseline".
 */
function compareStrict(a, b) {
  let worst = 0
  let total = 0
  let counted = 0
  for (let i = 0; i < a.data.length; i += 3) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    )
    if (delta > worst) worst = delta
    total += delta
    counted++
  }
  return { worst, mean: counted > 0 ? total / counted : 0 }
}

/**
 * Compare two block grids, on the stable blocks only.
 *
 * `stable` is the calibration mask: 1 where the three calibration frames agreed, 0 where
 * the page is animated there. An empty mask (older baseline, or a view that was animated
 * everywhere) falls back to comparing everything, and the caller prints that fact.
 */
function compare(expected, actual, stable) {
  let worst = 0
  let total = 0
  let bad = 0
  let counted = 0
  const totalBlocks = expected.data.length / 3

  for (let b = 0; b < totalBlocks; b++) {
    if (stable && stable[b] !== 1) continue
    const i = b * 3
    const dr = Math.abs(expected.data[i] - actual.data[i])
    const dg = Math.abs(expected.data[i + 1] - actual.data[i + 1])
    const db = Math.abs(expected.data[i + 2] - actual.data[i + 2])
    const delta = Math.max(dr, dg, db)
    total += (dr + dg + db) / 3
    counted++
    if (delta > worst) worst = delta
    if (delta > MAX_BLOCK_DELTA) bad++
  }

  if (counted === 0)
    return { worst: 0, mean: 0, badRatio: 0, blocks: totalBlocks, counted: 0, bad: 0 }
  return {
    worst,
    mean: total / counted,
    badRatio: bad / counted,
    blocks: totalBlocks,
    counted,
    bad,
  }
}

/** Write a heat map of the differences, so a failure can be looked at instead of guessed. */
function writeDiffImage(path, expected, actual) {
  const png = new PNG({ width: expected.cols, height: expected.rows })
  for (let i = 0; i < expected.data.length; i += 3) {
    const delta = Math.max(
      Math.abs(expected.data[i] - actual.data[i]),
      Math.abs(expected.data[i + 1] - actual.data[i + 1]),
      Math.abs(expected.data[i + 2] - actual.data[i + 2]),
    )
    const at = i
    const heat = Math.min(255, delta * 8)
    png.data[at] = heat
    png.data[at + 1] = delta > MAX_BLOCK_DELTA ? 255 : heat
    png.data[at + 2] = heat
    png.data[at + 3] = 255
  }
  writeFileSync(path, PNG.sync.write(png))
}

if (!chromePath) {
  console.error('::error::no Chrome/Chromium found; set CHROME_PATH')
  process.exit(1)
}

const port = 9500 + Math.floor(Math.random() * 90)
const profile = await mkdtemp(join(tmpdir(), 'showroom-visual-'))

const platformArgs = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1440,900',
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
const exceptions = []
const consoleErrors = []
const failures = []

try {
  let target = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page')
      if (target) break
    } catch {
      // not ready yet
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
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push({
        text: message.params.exceptionDetails.exception?.description ?? 'exception',
      })
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      consoleErrors.push({ text })
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
  await send('Emulation.setDeviceMetricsOverride', VIEW)

  /*
   * Deterministic randomness, installed BEFORE the app boots.
   *
   * The nebula seeds 8000 particles from `Math.random()`, the bento cards pick their ember
   * positions the same way, and the two sandboxes jitter their tags -- so two runs of the
   * same build drew different pictures and the comparison could not mean anything (measured:
   * cross-run worst block 86, larger than a real accent-colour change at 59).
   *
   * Overriding `Math.random` for the test documents is deliberate and blunt: it reaches the
   * particle initialisers, anything three.js does internally, and any future code that
   * forgets to take a seed. It is installed through `Page.addScriptToEvaluateOnNewDocument`,
   * which runs before any page script and disappears with the tab, so production is untouched
   * and nothing needs a test-only branch.
   */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      let s = 0x9e3779b9
      const next = () => {
        // mulberry32: 32-bit state, good enough to scatter particles, tiny and dependency-free.
        s |= 0
        s = (s + 0x6d2b79f5) | 0
        let t = Math.imul(s ^ (s >>> 15), 1 | s)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      Math.random = next
    })()`,
  })

  await send('Page.navigate', { url: base })

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500)
    if (await evaluate(`document.readyState === 'complete' && !!document.getElementById('main')`))
      break
  }
  // Boot sequence, fonts, first WebGL frames.
  await sleep(3500)

  const previous = existsSync(BASELINE_FILE)
    ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
    : { meta: null, views: {} }

  const crossPlatform = previous.meta && previous.meta.platform !== process.platform
  if (crossPlatform && !update) {
    console.log(
      `visual: baselines were captured on ${previous.meta.platform}, this is ${process.platform} — skipping`,
    )
    console.log('        (headless Chromium does not rasterise the same pixels per platform)')
    finish({ label: 'visual' })
    process.exit(process.exitCode ?? 0)
  }

  if (update) mkdirSync(BASELINE_DIR, { recursive: true })
  if (report) mkdirSync('screenshots', { recursive: true })

  const captured = {}

  for (const view of VIEWS) {
    await evaluate(`(() => {
      // Release the freeze from the previous view: the scroll and the camera easing have to
      // run for the next position to settle at all.
      window.__still = false
      window.__stillAt = undefined
      const max = document.documentElement.scrollHeight - window.innerHeight
      window.scrollTo(0, Math.round(max * ${view.at}))
      return true
    })()`)
    await sleep(SETTLE_MS)

    /*
     * Freeze, then shoot.
     *
     * Without this the comparison is hopeless: the camera eases toward its scroll target
     * and every shader owns a `uTime`, so two captures of the same state differ by 60-120
     * levels in the worst blocks and the gate failed on unchanged code.
     *
     * `window.__still` stops the R3F advance and the two 2D sandbox loops (see
     * src/lib/testHooks.ts). The injected stylesheet does the DOM half: CSS animations and
     * transitions are paused, so nothing on the page moves while the screenshot is taken.
     * Layout, styles and scroll position are untouched -- the frame still describes the real
     * page, it is just held still for a moment.
     */
    await evaluate(`(() => {
      // Pin the R3F clock AND freeze the 2D loops: see src/lib/testHooks.ts for why the
      // pinned time is what makes two runs comparable rather than just "stopped".
      window.__stillAt = 6
      window.__still = true
      if (!document.getElementById('visual-freeze')) {
        const style = document.createElement('style')
        style.id = 'visual-freeze'
        // animation:none, not animation-play-state:paused -- pausing freezes each animation
        // at whatever phase it had reached, which differs run to run; removing it puts every
        // element back at its unanimated base state, which does not.
        style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
        document.head.appendChild(style)
      }
      return true
    })()`)
    await sleep(450)

    // Recorded so a mismatch can be attributed: a different scroll position produces a
    // different frame, and "the page moved" is the first thing to rule out.
    const place = await evaluate(`({
      y: Math.round(window.scrollY),
      h: window.innerHeight,
      total: document.documentElement.scrollHeight,
    })`)

    /*
     * Wait for the picture to STOP CHANGING, then use that frame.
     *
     * Freezing the clocks is not enough on its own: framer-motion reveals, the camera's
     * easing and the two sandboxes settle over different numbers of frames depending on how
     * fast the page loaded, so "2.6 s after the scroll" still caught different intermediate
     * states (measured: worst block 60 between two runs of the same build). Instead of
     * guessing a delay, capture repeatedly until two consecutive captures agree -- that IS
     * the definition of a steady state -- and record how many attempts it took.
     */
    const settleFrames = []
    let stableShot = null
    for (let attempt = 0; attempt < 14; attempt++) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const png = PNG.sync.read(Buffer.from(shot.data, 'base64'))
      const grid = blockMeans(png)
      const prior = settleFrames[settleFrames.length - 1]
      settleFrames.push({ png, grid })
      if (prior) {
        const delta = compareStrict(prior.grid, grid)
        if (delta.worst <= 1 && delta.mean <= 0.15) {
          stableShot = { png, grid, attempts: attempt + 1 }
          break
        }
      }
      await sleep(300)
    }
    if (!stableShot) {
      // Never settled. Use the last frame and REPORT that, rather than calling it stable.
      const last = settleFrames[settleFrames.length - 1]
      stableShot = { png: last.png, grid: last.grid, attempts: settleFrames.length }
      failures.push({
        text: `${view.name}: picture never settled in ${settleFrames.length} captures`,
      })
    }
    console.log(`        ${view.name}: settled after ${stableShot.attempts} capture(s)`)

    const frames = [{ png: stableShot.png, grid: stableShot.grid }]
    for (let f = 1; update && f < CALIBRATION_FRAMES; f++) {
      await sleep(250)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const png = PNG.sync.read(Buffer.from(shot.data, 'base64'))
      frames.push({ png, grid: blockMeans(png) })
    }
    const blocks = frames[0].grid

    if (report) writeFileSync(`screenshots/visual-${view.name}.png`, PNG.sync.write(frames[0].png))

    const expected = previous.views[view.name]
    if (update) {
      /*
       * Build the stability mask from the spread of the calibration frames.
       *
       * With the page frozen this should come out almost entirely stable; the mask is kept
       * anyway, because a few regions (a video, a canvas that ignores the flag, a font that
       * loads late) may still move and should be excluded by measurement rather than by a
       * value I picked.
       *
       * The baseline is the MEAN of those frames rather than the first one: the animated
       * blocks are excluded from comparison anyway, and averaging makes the stable ones a
       * little less sensitive to which frame happened to be captured.
       */
      const stable = new Uint8Array(blocks.data.length / 3)
      let stableCount = 0
      for (let b = 0; b < stable.length; b++) {
        let spread = 0
        for (let i = b * 3; i < b * 3 + 3; i++) {
          let lo = 255
          let hi = 0
          for (const frame of frames) {
            const value = frame.grid.data[i]
            if (value < lo) lo = value
            if (value > hi) hi = value
          }
          spread = Math.max(spread, hi - lo)
        }
        if (spread <= STABLE_SPREAD) {
          stable[b] = 1
          stableCount++
        }
      }
      const averaged = new Uint8Array(blocks.data.length)
      for (let i = 0; i < averaged.length; i++) {
        let sum = 0
        for (const frame of frames) sum += frame.grid.data[i]
        averaged[i] = Math.round(sum / frames.length)
      }
      const stableB64 = Buffer.from(stable).toString('base64')
      captured[view.name] = {
        blocks: Buffer.from(averaged).toString('base64'),
        stable: stableB64,
        stableCount,
      }
      const pct = ((stableCount / stable.length) * 100).toFixed(0)
      console.log(
        `captured ${view.name}  ${stableCount}/${stable.length} blocks stable (${pct}%)  y=${place.y}/${place.total - place.h}`,
      )
      continue
    }
    if (!expected) {
      failures.push({ text: `${view.name}: no baseline recorded` })
      continue
    }

    const expectedGrid = {
      cols: expected.cols,
      rows: expected.rows,
      data: new Uint8Array(Buffer.from(expected.blocks, 'base64')),
    }
    const stable = expected.stable ? new Uint8Array(Buffer.from(expected.stable, 'base64')) : null
    const diff = compare(expectedGrid, blocks, stable)
    const ok =
      diff.worst <= MAX_BLOCK_DELTA &&
      diff.mean <= MAX_MEAN_DELTA &&
      diff.badRatio <= MAX_BAD_BLOCK_RATIO

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${view.name}  worst ${diff.worst}  mean ${diff.mean.toFixed(2)}  bad ${(diff.badRatio * 100).toFixed(2)}%  (${diff.counted}/${diff.blocks} blocks)  y=${place.y}/${place.total - place.h}`,
    )

    if (!ok) {
      failures.push({ text: `${view.name}: worst ${diff.worst}, mean ${diff.mean.toFixed(2)}` })
      if (report) {
        writeDiffImage(`screenshots/visual-diff-${view.name}.png`, expectedGrid, blocks)
      }
    }
  }

  if (update) {
    writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        {
          meta: {
            platform: process.platform,
            arch: process.arch,
            viewport: VIEW,
            block: BLOCK,
            views: VIEWS.map((v) => v.name),
            capturedAt: new Date().toISOString(),
          },
          views: Object.fromEntries(
            VIEWS.map((view) => {
              const cols = Math.floor(VIEW.width / BLOCK)
              const rows = Math.floor(VIEW.height / BLOCK)
              const entry = captured[view.name]
              return [
                view.name,
                {
                  cols,
                  rows,
                  blocks: entry.blocks,
                  stable: entry.stable,
                  stableCount: entry.stableCount,
                },
              ]
            }),
          ),
        },
        null,
        2,
      ),
    )
    console.log(`baseline written: ${BASELINE_FILE}`)
  }

  if (failures.length > 0) {
    console.error('visual: the frame changed beyond the measured noise floor')
    for (const failure of failures) console.error(`  - ${failure.text}`)
    console.error('        if the change is intended: node scripts/verify-visual.mjs --update')
  }
} catch (error) {
  failures.push({ text: `harness: ${String(error?.message ?? error)}` })
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

finish({
  failures: [...failures, ...findMissing(report)],
  label: 'visual',
  exceptions,
  consoleErrors,
})
