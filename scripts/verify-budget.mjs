/**
 * Critical-path budget check.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The build had no size guard at all: `chunkSizeWarningLimit` only silences a
 * warning, and the entry chunk had silently grown to include the entire three.js
 * graph because `manualChunks` grouped by substring. Nothing failed, nothing was
 * reported, and the lazy `Scene` import bought nothing. A budget is the only thing
 * that makes "the shell paints first" an enforced property instead of an intention.
 *
 * What counts as "critical": every script the browser must fetch before the app can
 * run -- the entry `<script src>` plus every `<link rel="modulepreload">`. Deferred
 * chunks (the lazy WebGL graph) are reported but NOT counted against the budget.
 *
 * Run after `pnpm build`:  node scripts/verify-budget.mjs
 * Exit code 1 on violation, so CI blocks the deploy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { resolve } from 'node:path'

/** Total gzip budget for the critical path, in KB. */
const BUDGET_KB = 240

/** Patterns that must never appear on the critical path. */
const FORBIDDEN = [/three/i, /webgl/i]

const htmlPath = resolve('dist/index.html')
let html
try {
  html = readFileSync(htmlPath, 'utf8')
} catch {
  console.error(`::error::${htmlPath} not found — run "pnpm build" first`)
  process.exit(1)
}

/** Entry scripts: what the document executes. */
const entry = [...html.matchAll(/<script[^>]+src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])

/** Everything the document preloads: fetched on the critical path all the same. */
const preloads = [...html.matchAll(/<link[^>]+modulepreload[^>]+href="(\/assets\/[^"]+\.js)"/g)].map(
  (m) => m[1],
)
// Attribute order is not guaranteed; catch href-before-rel too.
preloads.push(
  ...[...html.matchAll(/<link[^>]+href="(\/assets\/[^"]+\.js)"[^>]+modulepreload/g)].map(
    (m) => m[1],
  ),
)

const critical = [...new Set([...entry, ...preloads])].sort()

if (critical.length === 0) {
  console.error('::error::no scripts found in dist/index.html — did the build shape change?')
  process.exit(1)
}

/**
 * Deferred chunks: every emitted JS asset that is NOT on the critical path.
 *
 * Read from the output directory rather than from index.html: lazy chunks are never
 * referenced there, so scanning the HTML reported "0 KB deferred" even while a 1 MB
 * lazy chunk existed.
 */
const emitted = readdirSync(resolve('dist/assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => '/assets/' + f)
const deferred = emitted.filter((f) => !critical.includes(f))

let criticalGzip = 0
const rows = []
for (const file of critical) {
  const abs = resolve('dist', '.' + file)
  let raw = 0
  let gzip = 0
  try {
    const buf = readFileSync(abs)
    raw = statSync(abs).size
    gzip = gzipSync(buf).length
  } catch {
    console.error(`::error::preloaded asset missing on disk: ${file}`)
    process.exit(1)
  }
  criticalGzip += gzip
  rows.push({ file, raw, gzip })
}

let deferredGzip = 0
for (const file of deferred) {
  try {
    deferredGzip += gzipSync(readFileSync(resolve('dist', '.' + file))).length
  } catch {
    // Referenced by name only (e.g. inside a comment in the HTML): ignore.
  }
}

const kb = criticalGzip / 1024
const failures = []

for (const row of rows) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(row.file)) {
      failures.push(
        `${row.file} (${(row.gzip / 1024).toFixed(1)} KB gzip) is on the critical path — it matches ${pattern}`,
      )
    }
  }
}

if (kb > BUDGET_KB) {
  failures.push(`critical JS is ${kb.toFixed(1)} KB gzip, over the ${BUDGET_KB} KB budget`)
}

// Report, always: CI job summaries are the only place this stays visible over time.
console.log('critical path (gzip)')
for (const row of rows) {
  console.log(
    `  ${row.file.padEnd(34)} ${(row.gzip / 1024).toFixed(1).padStart(7)} KB` +
      `  raw ${(row.raw / 1024).toFixed(0).padStart(6)} KB`,
  )
}
console.log(`  ${'TOTAL'.padEnd(34)} ${kb.toFixed(1).padStart(7)} KB  (budget ${BUDGET_KB} KB)`)
console.log(`deferred (lazy) gzip: ${(deferredGzip / 1024).toFixed(1)} KB — not counted`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`)
  process.exit(1)
}

console.log('budget OK')
