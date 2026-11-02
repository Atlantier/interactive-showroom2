/**
 * Shared exit-code contract for the CDP probe scripts.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * The review's P0-06 counted 17 of these scripts completing with `exit 0` even when the
 * run had collected uncaught exceptions or console errors. They were written as probes:
 * they dump a JSON report, print it, and close. Nothing about that output is a signal a
 * machine can act on, so wiring them into CI would have produced a job that is green no
 * matter what the page does — worse than no job, because it looks like coverage.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * `finish()` is the last thing every script calls. It turns the report the script has
 * already built into one verdict line plus a process exit code:
 *
 *   no problems  -> `verify-foo: verdict OK`            exit 0
 *   any problem  -> `::error::verify-foo: <reasons>`    exit 1
 *
 * The `::error::` prefix is the GitHub Actions annotation format, so a red script points
 * at the offending line in the job log instead of needing to be read.
 *
 * What counts as a problem is deliberately narrow and mechanical — things that are
 * never acceptable on a page that loads successfully:
 *
 *   - an uncaught exception reaching `window.onerror` (the page is broken)
 *   - a `console.error` (the app, or a WebGL context, is complaining)
 *   - `report.fatal`, which scripts set when their own harness failed to install
 *   - explicit `failures` passed by scripts that do have assertions
 *
 * Numeric expectations stay in the scripts that own them (scroll pacing, bundle size,
 * accessibility). This module only decides "did the run report anything wrong".
 */

/** How many entries of each list to print. Enough to diagnose, not enough to scroll. */
const PRINT_LIMIT = 5

function summarise(entries) {
  return entries.slice(0, PRINT_LIMIT).map((entry) => {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object') {
      // CDP exception/console payloads nest the interesting part one or two levels down.
      const text =
        entry.text ??
        entry.exception?.description ??
        entry.description ??
        entry.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ')
      return String(text ?? JSON.stringify(entry)).split('\n')[0]
    }
    return String(entry)
  })
}

/**
 * Print the verdict for one script and set the process exit code.
 *
 * Call it once, last. It never throws: a probe that already reached its report should
 * always produce a verdict rather than a stack trace.
 */
/**
 * Names of the probes that reported "my element is not here".
 *
 * A probe script knows how to ask the page specific questions, and almost all of them already
 * answer "not found" in a consistent way (`{ found: false }` for the canvas probes, `{ ok:
 * false, reason }` for the scene probes). This turns those answers into the one thing the
 * verdict layer understands -- an assertion failure -- so pointing a script at the wrong URL
 * is red instead of green.
 *
 * Deliberately NOT a heuristic on the report as a whole: an earlier attempt tried to infer
 * "nothing was measured" from the shape of the report and could not, because a blank page
 * still yields numbers (`targetP: 0`, `scrollY: 0`) and arrays of nulls. Per-probe markers are
 * precise; report-shape guessing is not.
 */
export function findMissing(report, { ignore = [] } = {}) {
  if (!report || typeof report !== 'object') return []
  const missing = []
  for (const [key, value] of Object.entries(report)) {
    if (ignore.includes(key)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (value.found === false || value.ok === false) missing.push(key)
  }
  return missing
}

export function finish({
  label = 'verify',
  exceptions = [],
  consoleErrors = [],
  report = null,
  failures = [],
} = {}) {
  const problems = []

  if (report && report.fatal) problems.push(`harness failed: ${String(report.fatal)}`)
  if (exceptions.length > 0) problems.push(`${exceptions.length} uncaught exception(s)`)
  if (consoleErrors.length > 0) problems.push(`${consoleErrors.length} console error(s)`)
  if (failures.length > 0) problems.push(`${failures.length} failed assertion(s)`)

  for (const line of summarise(exceptions)) console.error(`  exception: ${line}`)
  for (const line of summarise(consoleErrors)) console.error(`  console.error: ${line}`)
  for (const line of summarise(failures)) console.error(`  assertion: ${line}`)

  if (problems.length > 0) {
    console.error(`::error::${label}: ${problems.join('; ')}`)
    // `process.exitCode` rather than `process.exit()`: the process still gets to flush
    // stdout (the JSON report above can be megabytes) instead of being cut off mid-write.
    process.exitCode = 1
    return false
  }

  console.log(`${label}: verdict OK`)
  return true
}
