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

if (failed > 0) {
  console.error(`::error::verify selftest: ${failed}/${cases.length} cases failed`)
  process.exit(1)
}
console.log(`verify selftest OK — ${cases.length} cases`)
