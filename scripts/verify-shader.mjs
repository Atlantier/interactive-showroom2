/**
 * Shader/canvas-level visual regression gate.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `verify-visual` compares the UI layer and hides every large canvas, because the animated canvases
 * used to be irreproducible. That was the right call for a UI gate, but it left shader and canvas
 * work unverifiable -- the reason SH-13 (duplicated sin-hash noise) sat deferred for so long.
 *
 * Two changes made canvas comparison possible, both measured rather than assumed:
 *   1. With the R3F clock pinned (`window.__stillAt`) and one warm-up load, the architecture canvas
 *      reproduces to worst 0.9 / mean 0.14 across fresh loads (修改计划 §5.40).
 *   2. The two 2D sandboxes now snap to a canonical state when the `still` event fires, which brought
 *      them to the same noise level: worst 0.9 / 0.8 (§5.43).
 * So this gate warms up, captures a second load at each view, and compares 96 px block means against
 * a committed baseline.
 *
 * ── What it covers ─────────────────────────────────────────────────────────
 *   · architecture-mid  -- the chapter canvas, where the SH-13 shaders live;
 *   · playground        -- the two 2D sandboxes (Verlet lanyard, FABRIK creature).
 * It is not a whole-site shader gate: the backdrop canvas streams particles whose count depends on
 * load timing and is deliberately out of scope. `verify:visual` keeps owning the UI layer.
 *
 * Baselines record the platform, viewport, scroll position and every compared rectangle. Headless
 * Chromium does not rasterise the same pixels per platform, so on a different platform this prints a
 * skip reason and exits 0 -- the same contract as the UI gate.
 *
 * Usage:
 *   pnpm preview --port 4173
 *   node scripts/verify-shader.mjs --base http://127.0.0.1:4173
 *   node scripts/verify-shader.mjs --base ... --update    # re-capture every view's baseline
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
 * Warm-to-warm noise measured 0.4–0.9 across the canvases this gate covers. 8 and 2 leave roughly
 * 8x headroom while still failing on a colour edit (tens of levels) or a removed light.
 */
const MAX_WORST_DELTA = 8
const MAX_MEAN_DELTA = 2
/** If two captures of the SAME build disagree by more than this, the run is not trustworthy. */
const UNSETTLED_WORST = 24

const BLOCK = 96
const VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 }
const SETTLE_MS = 2600
const BOOT_MS = 4000
const WARMUP_MS = 2000

/**
 * One view = where to scroll, which canvases to compare, and how big they must be to count.
 *
 * `minAreaRatio` is relative to the viewport. The architecture canvas is nearly full-screen; the two
 * sandboxes are about half, so a single ratio would not select both sensibly.
 */
const VIEWS = [
  {
    id: 'architecture-mid',
    sectionId: 'architecture',
    /** 'ratio' = fraction of viewport past the section top; 'offset' = fixed pixels. */
    scroll: { mode: 'ratio', value: 0.5 },
    minAreaRatio: 0.6,
    only2d: false,
  },
  {
    // The two sandboxes are stacked and cannot both fit in 900 px, so each gets its own scroll
    // position. Gating one and calling it "the playground" would leave the other unverified.
    id: 'playground-top',
    sectionId: 'playground',
    scroll: { mode: 'offset', value: 200 },
    minAreaRatio: 0.2,
    only2d: true,
  },
  {
    id: 'playground-bottom',
    sectionId: 'playground',
    scroll: { mode: 'offset', value: 420 },
    minAreaRatio: 0.2,
    only2d: true,
  },
]

const BASELINE_DIR = 'visual-baselines'
const BASELINE_FILE = join(BASELINE_DIR, 'shader.json')

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
  return {
    worst: Number(worst.toFixed(1)),
    mean: counted ? Number((total / counted).toFixed(2)) : 0,
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
   * One capture of one view: load, settle on the section, wait for fonts, freeze, shoot, measure.
   *
   * `warmup` loads are discarded: the first load pays for the shader program links, and its extra
   * frames are what produced the 19-level cold-vs-warm difference measured in §5.40.
   */
  const capture = async (view, label) => {
    await send('Page.navigate', { url: base })
    let ready = false
    for (let attempt = 0; attempt < 240; attempt++) {
      await sleep(250)
      ready = await evaluate(
        "document.readyState === 'complete' && !!document.getElementById('main')",
      )
      if (ready) break
    }
    if (!ready) throw new Error('page never loaded')
    await sleep(BOOT_MS)

    const target =
      view.scroll.mode === 'ratio'
        ? `section.offsetTop + window.innerHeight * ${view.scroll.value}`
        : `section.offsetTop + ${view.scroll.value}`
    const scrolled = await evaluate(`(() => {
      const section = document.getElementById('${view.sectionId}')
      if (!section) return false
      window.scrollTo(0, ${target})
      return true
    })()`)
    if (!scrolled) throw new Error(`view ${view.id}: section never appeared`)
    await sleep(SETTLE_MS)

    // Fonts before freezing: a capture taken while text is still in the fallback face is a frame the
    // next run cannot reproduce.
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
    if (!frozen) throw new Error(`view ${view.id}: could not freeze the page`)

    await sleep(400 + (label === 'warmup' ? WARMUP_MS : 0))

    const rects = await evaluate(`(() => {
      const viewportArea = window.innerWidth * window.innerHeight
      const candidates = Array.from(document.querySelectorAll('canvas'))
        .map((canvas) => {
          const box = canvas.getBoundingClientRect()
          return {
            canvas,
            box,
            area: box.width * box.height,
            is2d: canvas.getContext('2d') !== null,
          }
        })
        .filter((entry) => entry.area >= viewportArea * ${view.minAreaRatio})
        .filter((entry) => !${view.only2d} || entry.is2d)
        .filter((entry) => entry.box.top >= 0 && entry.box.bottom <= window.innerHeight)
        .sort((a, b) => b.area - a.area)
      const picked = ${view.only2d} ? candidates : candidates.slice(0, 1)
      return picked.map((entry) => ({
        x: Math.round(entry.box.x),
        y: Math.round(entry.box.y),
        w: Math.round(entry.box.width),
        h: Math.round(entry.box.height),
        is2d: entry.is2d,
        contextLost: (() => {
          const gl = entry.canvas.getContext('webgl2')
          return gl ? gl.isContextLost() : null
        })(),
      }))
    })()`)
    if (!Array.isArray(rects) || rects.length === 0) {
      throw new Error(`view ${view.id}: no matching canvas`)
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const png = PNG.sync.read(Buffer.from(shot.data, 'base64'))
    return { rects, grid: blockMeans(png), scrollY: await evaluate('Math.round(window.scrollY)') }
  }

  /* ── Warm-up, then two measured captures per view ──────────────────────── */
  await capture(VIEWS[0], 'warmup')

  const meta = {
    platform: process.platform,
    viewport: VIEWPORT,
    block: BLOCK,
    views: VIEWS.map((view) => view.id),
  }

  const measured = {}
  for (const view of VIEWS) {
    const first = await capture(view, 'measure')
    const second = await capture(view, 'measure')
    measured[view.id] = { first, second }
  }

  if (update) {
    mkdirSync(BASELINE_DIR, { recursive: true })
    const views = {}
    for (const view of VIEWS) {
      const second = measured[view.id].second
      views[view.id] = { rects: second.rects, grid: second.grid, scrollY: second.scrollY }
    }
    writeFileSync(BASELINE_FILE, JSON.stringify({ meta, views }, null, 0) + '\n')
    console.log(`shader: baseline written to ${BASELINE_FILE} (${VIEWS.length} views)`)
    finish({ label: 'shader', exceptions, consoleErrors, failures, report: { meta } })
  } else if (!existsSync(BASELINE_FILE)) {
    console.error(`::error::shader: no baseline at ${BASELINE_FILE} (run with --update)`)
    process.exitCode = 1
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
    if (baseline.meta.platform !== process.platform) {
      console.log(
        `shader: baseline was captured on ${baseline.meta.platform}, this is ${process.platform} — skipping`,
      )
      console.log('        (headless Chromium does not rasterise the same pixels per platform)')
    } else if (!baseline.views) {
      console.error('::error::shader: baseline predates multi-view support; run with --update')
      process.exitCode = 1
    } else {
      for (const view of VIEWS) {
        const aligned = measured[view.id]
        const saved = baseline.views[view.id]
        if (!saved) {
          failures.push(`${view.id}: no baseline for this view`)
          continue
        }
        if (saved.rects.length !== aligned.second.rects.length) {
          failures.push(
            `${view.id}: ${aligned.second.rects.length} canvases matched now, ${saved.rects.length} in the baseline`,
          )
          continue
        }
        for (let index = 0; index < saved.rects.length; index++) {
          const rect = aligned.second.rects[index]
          const result = compareBlocks(saved.grid, aligned.second.grid, rect)
          const settled = compareBlocks(aligned.first.grid, aligned.second.grid, rect)
          const pass = result.worst <= MAX_WORST_DELTA && result.mean <= MAX_MEAN_DELTA
          const label = `${view.id}${saved.rects.length > 1 ? `#${index}` : ''}`
          console.log(
            `${pass ? 'PASS  ' : 'FAIL  '}${label}  worst ${result.worst}  mean ${result.mean}  ` +
              `(${result.blocks} blocks)  y=${aligned.second.scrollY}  stability ${settled.worst}`,
          )
          if (settled.worst > UNSETTLED_WORST) {
            console.log(
              `shader: WARNING ${label} disagreed with itself by ${settled.worst}; the machine is probably busy`,
            )
          }
          if (!pass) {
            failures.push(
              `${label}: canvas differs from the baseline (worst ${result.worst} > ${MAX_WORST_DELTA} or mean ${result.mean} > ${MAX_MEAN_DELTA})`,
            )
          }
        }
      }
    }

    finish({
      label: 'shader',
      exceptions,
      consoleErrors,
      failures,
      report: { meta, views: Object.keys(measured) },
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
