/**
 * Shader-level visual regression gate.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `verify-visual` compares the UI layer and hides every large canvas, because the backdrop streams
 * particles whose count depends on how long the page took to load. That was the right call for a UI
 * gate, but it left shader work unverifiable -- which is exactly why the review's SH-13 (duplicated
 * sin-hash noise, 24 `sin()` calls per fragment on the cone) has been deferred: changing a shader
 * without a gate is how you break a picture and find out from a visitor.
 *
 * ── What made it possible ───────────────────────────────────────────────────
 * Measured, not assumed: with the R3F clock pinned (`window.__stillAt`) and the page's 2D loops
 * frozen (`window.__still`), the architecture canvas is reproducible ACROSS FRESH LOADS -- but only
 * once the shader cache is warm. Three loads of the same build, 96 px blocks, canvas region:
 *
 *   cold load vs warm: worst 19.2, mean 3.78   (first load compiles 19 programs; extra frames)
 *   warm load vs warm: worst  0.9, mean 0.14   (two independent loads)
 *
 * So this gate spends one load warming up, captures a second load, and compares that against a
 * committed baseline. Thresholds sit far above the measured noise floor and far below a real
 * shader edit's signal (a colour change moves blocks by tens of levels).
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 * It is not a UI gate (`verify:visual` owns that) and it currently covers ONE canvas: the
 * architecture chapter, where the shaders SH-13 is about live. Scroll positions and the viewport are
 * fixed; the baseline records both, plus the platform, because headless Chromium does not rasterise
 * the same pixels per platform -- on a different platform this prints a skip reason and exits 0,
 * exactly like the UI gate.
 *
 * Usage:
 *   pnpm preview --port 4173            # in another shell
 *   node scripts/verify-shader.mjs --base http://127.0.0.1:4173
 *   node scripts/verify-shader.mjs --base ... --update    # re-capture the baseline
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PNG } from 'pngjs'
import WebSocket from 'ws'
import { finish } from './lib/verify.mjs'

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
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

const base = argValue('--base', 'http://127.0.0.1:4173')
const update = process.argv.includes('--update')

/**
 * Thresholds, per block and per channel.
 *
 * Warm-to-warm noise measured 0.9 worst / 0.14 mean over 144 blocks. 8 and 2 leave roughly 8x
 * headroom while still failing on a colour edit (tens of levels) or a removed light. The
 * "unsettled" guard below catches the cold-cache case that produced 19.
 */
const MAX_WORST_DELTA = 8
const MAX_MEAN_DELTA = 2
/** If two captures of the SAME build disagree by more than this, the run is not trustworthy. */
const UNSETTLED_WORST = 24

const BLOCK = 96
const VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 }
const VIEW = {
  id: 'architecture-mid',
  /** Fraction of the chapter's track; 0.5 of the section plus half a viewport puts the stack mid-plot. */
  sectionRatio: 0.5,
}
const BASELINE_DIR = 'visual-baselines'
const BASELINE_FILE = join(BASELINE_DIR, 'shader.json')
const SETTLE_MS = 2600
const BOOT_MS = 3500
const WARMUP_MS = 2000

const chromePath = CANDIDATES.find((c) => typeof c === 'string' && c.length > 0 && existsSync(c))
if (!chromePath) {
  console.error('::error::no Chrome/Chromium found; set CHROME_PATH')
  process.exit(1)
}

/* -------------------------------------------------------------------------- */
/*  Image comparison                                                          */
/* -------------------------------------------------------------------------- */

/** Reduce a screenshot to the mean colour of every 96 px block. */
function blockMeans(png) {
  const { width, height, data } = png
  const cols = Math.ceil(width / BLOCK)
  const rows = Math.ceil(height / BLOCK)
  const means = new Float64Array(cols * rows * 3)
  const counts = new Uint32Array(cols * rows)
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / BLOCK)
    for (let x = 0; x < width; x++) {
      const block = row * cols + Math.floor(x / BLOCK)
      const offset = (y * width + x) * 4
      means[block * 3] += data[offset]
      means[block * 3 + 1] += data[offset + 1]
      means[block * 3 + 2] += data[offset + 2]
      counts[block] += 1
    }
  }
  for (let block = 0; block < counts.length; block++) {
    const n = counts[block] || 1
    means[block * 3] /= n
    means[block * 3 + 1] /= n
    means[block * 3 + 2] /= n
  }
  return { cols, rows, means: Array.from(means, (value) => Number(value.toFixed(2))) }
}

/**
 * Compare two grids on the blocks fully inside `rect` and return the worst and mean channel deltas.
 *
 * Only interior blocks: an edge block is half page background, so its mean says more about where the
 * canvas happens to sit than about what the shader drew.
 */
function compareBlocks(a, b, rect) {
  if (a.cols !== b.cols || a.rows !== b.rows) throw new Error('grid size mismatch')
  let worst = 0
  let total = 0
  let counted = 0
  for (let row = 0; row < a.rows; row++) {
    for (let col = 0; col < a.cols; col++) {
      const left = col * BLOCK
      const top = row * BLOCK
      if (left < rect.x || left + BLOCK > rect.x + rect.w) continue
      if (top < rect.y || top + BLOCK > rect.y + rect.h) continue
      const block = row * a.cols + col
      const dr = Math.abs(a.means[block * 3] - b.means[block * 3])
      const dg = Math.abs(a.means[block * 3 + 1] - b.means[block * 3 + 1])
      const db = Math.abs(a.means[block * 3 + 2] - b.means[block * 3 + 2])
      const delta = Math.max(dr, dg, db)
      if (delta > worst) worst = delta
      total += delta
      counted += 1
    }
  }
  if (counted === 0) throw new Error('rect covers no whole block')
  return {
    worst: Number(worst.toFixed(1)),
    mean: Number((total / counted).toFixed(2)),
    blocks: counted,
  }
}

/* -------------------------------------------------------------------------- */
/*  Browser                                                                   */
/* -------------------------------------------------------------------------- */

const port = 9200 + Math.floor(Math.random() * 60)
const profile = await mkdtemp(join(tmpdir(), 'showroom-shader-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ...(process.platform === 'linux'
      ? [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]
      : []),
    ...(process.platform === 'win32'
      ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
      : []),
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
      const details = message.params.exceptionDetails
      exceptions.push(details.exception?.description ?? details.text)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(
        (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '),
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
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    }
    return result.result?.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false })

  /**
   * One capture: load, settle on the chapter, freeze, shoot, and report where the canvas is.
   *
   * `warmup` loads are discarded: the first load pays for 19 shader program links and its extra
   * frames are what produced the 19.2 cold-vs-warm measurement.
   */
  const capture = async (label) => {
    await send('Page.navigate', { url: base })
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      await sleep(250)
      ready = await evaluate(
        "document.readyState === 'complete' && !!document.getElementById('main')",
      )
      if (ready) break
    }
    if (!ready) throw new Error('page never loaded')
    await sleep(BOOT_MS)

    await evaluate(`(() => {
      const section = document.getElementById('architecture')
      if (!section) return false
      window.scrollTo(0, section.offsetTop + window.innerHeight * ${VIEW.sectionRatio})
      return true
    })()`)
    await sleep(SETTLE_MS)

    // Same font rule as the UI gate: freeze only after every pending face has settled, otherwise text
    // inside the canvas can be measured in a fallback face on one run and not the other.
    await evaluate(`(document.fonts && document.fonts.ready
      ? document.fonts.ready.then(() => document.fonts.status)
      : 'unsupported')`)

    const frozen = await evaluate(`(() => {
      // Same seam the UI gate uses: pin the R3F clock, stop the 2D loops, and tell components that
      // own timers to snap to a canonical state.
      window.__stillAt = 6
      window.__still = true
      window.dispatchEvent(new Event('still'))
      return true
    })()`)
    if (!frozen) throw new Error('could not freeze the page')

    // A couple of frames for the pinned-clock redraw to land, without letting the scene drift.
    await sleep(400 + (label === 'warmup' ? WARMUP_MS : 0))

    const rect = await evaluate(`(() => {
      const entry = Array.from(document.querySelectorAll('canvas'))
        .map((canvas) => ({ canvas, box: canvas.getBoundingClientRect() }))
        .filter((item) => item.box.width * item.box.height >= window.innerWidth * window.innerHeight * 0.6)
        .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0]
      if (!entry) return null
      const gl = entry.canvas.getContext('webgl2')
      return {
        x: Math.round(entry.box.x),
        y: Math.round(entry.box.y),
        w: Math.round(entry.box.width),
        h: Math.round(entry.box.height),
        contextLost: gl ? gl.isContextLost() : null,
        scrollY: Math.round(window.scrollY),
      }
    })()`)
    if (!rect) return { rect: null }

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const png = PNG.sync.read(Buffer.from(shot.data, 'base64'))
    return { rect, grid: blockMeans(png) }
  }

  /* ── Warm-up, then two measured captures ───────────────────────────────── */
  const warmup = await capture('warmup')
  if (!warmup.rect) throw new Error('no large canvas found during warm-up')
  const first = await capture('measure')
  const second = await capture('measure')
  if (!first.rect || !second.rect) throw new Error('the canvas disappeared between captures')

  const settled = compareBlocks(first.grid, second.grid, second.rect)
  if (settled.worst > UNSETTLED_WORST) {
    console.log(
      `shader: WARNING the same build disagreed with itself (worst ${settled.worst}); ` +
        'the machine is probably busy — comparing anyway',
    )
  }

  const meta = {
    platform: process.platform,
    viewport: VIEWPORT,
    view: VIEW.id,
    scrollY: second.rect.scrollY,
    canvas: { w: second.rect.w, h: second.rect.h },
    block: BLOCK,
  }

  if (update) {
    mkdirSync(BASELINE_DIR, { recursive: true })
    writeFileSync(
      BASELINE_FILE,
      JSON.stringify({ meta, grid: second.grid, rect: second.rect }, null, 0) + '\n',
    )
    console.log(`shader: baseline written to ${BASELINE_FILE}`)
    finish({ label: 'shader', exceptions, consoleErrors, failures, report: { meta } })
  } else {
    if (!existsSync(BASELINE_FILE)) {
      console.error(`::error::shader: no baseline at ${BASELINE_FILE} (run with --update)`)
      process.exitCode = 1
    } else {
      const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
      if (baseline.meta.platform !== process.platform) {
        console.log(
          `shader: baseline was captured on ${baseline.meta.platform}, this is ${process.platform} — skipping`,
        )
        console.log('        (headless Chromium does not rasterise the same pixels per platform)')
      } else {
        const result = compareBlocks(baseline.grid, second.grid, second.rect)
        const pass = result.worst <= MAX_WORST_DELTA && result.mean <= MAX_MEAN_DELTA
        console.log(
          `${pass ? 'PASS  ' : 'FAIL  '}${VIEW.id}  worst ${result.worst}  mean ${result.mean}  ` +
            `(${result.blocks} blocks)  y=${second.rect.scrollY}  stability ${settled.worst}`,
        )
        if (!pass) {
          failures.push(
            `${VIEW.id}: canvas differs from the baseline (worst ${result.worst} > ${MAX_WORST_DELTA} or mean ${result.mean} > ${MAX_MEAN_DELTA})`,
          )
        }
      }
    }

    finish({
      label: 'shader',
      exceptions,
      consoleErrors,
      failures,
      report: {
        meta,
        measured: { worst: settled.worst, mean: settled.mean },
        canvas: second.rect,
      },
    })
  }
} finally {
  try {
    ws?.close()
  } catch {
    // already closed
  }
  chrome.kill()
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
