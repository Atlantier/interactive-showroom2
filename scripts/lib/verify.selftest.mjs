/**
 * Self-test for the probe verdict contract (see `verify.mjs`).
 *
 * The whole point of this file is that a script cannot be trusted to fail just because
 * it prints the word "error": the exit code has to change. So the test spawns real node
 * processes and asserts on their exit codes rather than on return values — the same thing
 * CI looks at.
 *
 * Run: node scripts/lib/verify.selftest.mjs
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findMissing } from './verify.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFY = join(HERE, 'verify.mjs')
// A bare Windows path is not a valid import specifier -- `node:url` turns it into the
// `file:///C:/...` form the ESM loader requires. (Learned the hard way: the first run
// reported all five cases as "exit 1", which looked like a verdict bug and was this.)
const VERIFY_URL = pathToFileURL(VERIFY).href
const scratch = mkdtempSync(join(tmpdir(), 'verify-selftest-'))

/** Write a throwaway script that imports the real module and calls it once. */
function probe(name, call) {
  const file = join(scratch, `${name}.mjs`)
  writeFileSync(file, `import { finish } from ${JSON.stringify(VERIFY_URL)}\n${call}\n`)
  return file
}

/** Run a probe and return its exit code, capturing output so the test stays quiet. */
function exitCodeOf(file) {
  try {
    execFileSync(process.execPath, [file], { stdio: 'pipe' })
    return 0
  } catch (error) {
    return typeof error.status === 'number' ? error.status : -1
  }
}

/*
 * `findMissing` is the part that decides whether a probe found the app, so it gets its own
 * cases: it must flag the two "not here" conventions, ignore the keys a script opts out of
 * (dev-only hooks that cannot exist in a production bundle), and stay quiet about normal
 * measurements.
 */
const findMissingCases = [
  [
    'flags found:false and ok:false',
    { a: { found: false }, b: { ok: false, reason: 'x' }, c: { ok: true } },
    [],
    ['a', 'b'],
  ],
  ['honours the ignore list', { dev: { ok: false }, real: { found: false } }, ['dev'], ['real']],
  ['ignores numbers, arrays and nulls', { n: 0, arr: [1], z: null, deep: { value: 3 } }, [], []],
]

let findMissingFailed = 0
for (const [name, report, ignore, expected] of findMissingCases) {
  const actual = findMissing(report, { ignore })
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) findMissingFailed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  findMissing: ${name}: ${JSON.stringify(actual)}`)
}

const cases = [
  ['clean run', 'finish({ label: "clean" })', 0],
  [
    'uncaught exception',
    'finish({ label: "boom", exceptions: [{ text: "TypeError: x is undefined" }] })',
    1,
  ],
  [
    'console.error',
    'finish({ label: "noisy", consoleErrors: [{ text: "WebGL: CONTEXT_LOST_WEBGL" }] })',
    1,
  ],
  [
    'harness failure',
    'finish({ label: "fatal", report: { fatal: "helpers failed to install" } })',
    1,
  ],
  ['explicit assertion', 'finish({ label: "assert", failures: ["p95 24ms > 22ms budget"] })', 1],
]

let failed = 0
for (const [name, call, expected] of cases) {
  const actual = exitCodeOf(probe(name.replace(/\W+/g, '-'), call))
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: exit ${actual} (expected ${expected})`)
}

rmSync(scratch, { recursive: true, force: true })

if (findMissingFailed > 0) {
  failed += findMissingFailed
}

if (failed > 0) {
  console.error(`::error::verify selftest: ${failed}/${cases.length} cases failed`)
  process.exit(1)
}
console.log(
  `verify selftest OK — ${cases.length} verdict cases + ${findMissingCases.length} findMissing cases`,
)
