/**
 * Verifies the FABRIK IK + procedural animation sandbox.
 *
 * Strategy: drive the rigs through the dev hook and assert on REAL solver state
 * (convergence, bone rigidity, joint angles, gait phase). An earlier sandbox in
 * this project was verified through synthetic pointer events aimed at canvas
 * coordinates, and those events silently missed because the canvas' document
 * position shifts with layout — so this test never guesses a screen position.
 *
 * Arm checks:
 *   A1. Chain topology: 7 joints, 6 bones, base pinned.
 *   A2. FABRIK converges and the tip reaches the target.
 *   A3. Bones stay rigid (lengths preserved).
 *   A4. No joint bends past the angle cone (no 180° fold-back).
 *   A5. Out-of-reach targets are clamped into the working annulus.
 *   A6. Clicking fires: laser resets, shot count rises, recoil impulses.
 *   A7. Recoil decays back to rest (the spring settles).
 *
 * Creature checks:
 *   C1. Topology: 12 spine nodes, 4 legs, 2 bones per leg.
 *   C2. Spine keeps its spacing and respects the spine angle cone.
 *   C3. Steering: the head accelerates toward the pointer.
 *   C4. Arrival: it settles near the pointer instead of orbiting.
 *   C5. Gait: every leg steps, diagonal pairs alternate, never all four at once.
 *   C6. Foot placement uses a parabolic lift arc.
 *   C7. Leg 2-bone IK converges.
 *
 * Shared:
 *   S1. Both modes paint pixels.
 *   S2. The mode switch and the "Show IK Vectors" toggle exist.
 *   S3. No runtime exceptions.
 *
 * Run: node scripts/verify-fabrik.mjs [url]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import { findMissing, finish } from './lib/verify.mjs'

const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9347'
const URL_TO_TEST = process.argv[2] ?? 'http://127.0.0.1:5267'

/* -------------------------------------------------------------------------- */
/*  Page-side probes                                                          */
/* -------------------------------------------------------------------------- */

function installHelpers() {
  const wrap = () => document.getElementById('playground')

  /** Largest bend at any interior joint, in degrees. */
  const maxBendDeg = (joints) => {
    let worst = 0
    for (let i = 1; i < joints.length - 1; i++) {
      const a = joints[i - 1]
      const b = joints[i]
      const c = joints[i + 1]
      const ax = b.x - a.x
      const ay = b.y - a.y
      const bx = c.x - b.x
      const by = c.y - b.y
      const la = Math.hypot(ax, ay)
      const lb = Math.hypot(bx, by)
      if (la < 1e-9 || lb < 1e-9) continue
      const cross = (ax / la) * (by / lb) - (ay / la) * (bx / lb)
      const dot = (ax / la) * (bx / lb) + (ay / la) * (by / lb)
      worst = Math.max(worst, Math.abs((Math.atan2(cross, dot) * 180) / Math.PI))
    }
    return worst
  }

  /** Largest deviation of an actual bone length from its rest length. */
  const boneError = (joints, lengths) => {
    let worst = 0
    for (let i = 0; i < lengths.length; i++) {
      const d = Math.hypot(joints[i + 1].x - joints[i].x, joints[i + 1].y - joints[i].y)
      worst = Math.max(worst, Math.abs(d - lengths[i]))
    }
    return worst
  }

  window.__fc = {
    ready: () => Boolean(window.__fabrik),
    mode: () => (window.__fabrik ? window.__fabrik.mode() : null),
    canvas: () => {
      const s = wrap()
      return s ? s.querySelector('canvas') : null
    },

    armSnapshot() {
      const a = window.__fabrik.arm()
      if (!a) return null
      const tip = a.joints[a.joints.length - 1]
      const base = a.joints[0]
      return {
        jointCount: a.joints.length,
        boneCount: a.lengths.length,
        reach: a.lengths.reduce((s, v) => s + v, 0),
        baseX: base.x,
        baseY: base.y,
        tipX: tip.x,
        tipY: tip.y,
        targetX: a.target.x,
        targetY: a.target.y,
        baseToTarget: Math.hypot(a.target.x - base.x, a.target.y - base.y),
        tipToTarget: Math.hypot(tip.x - a.target.x, tip.y - a.target.y),
        maxBendDeg: maxBendDeg(a.joints),
        boneError: boneError(a.joints, a.lengths),
        error: a.result.error,
        iterations: a.result.iterations,
        converged: a.result.converged,
        unreachable: a.result.unreachable,
        laserT: a.laserT,
        shots: a.shots,
        recoilMag: Math.hypot(a.recoil.x, a.recoil.y),
      }
    },

    creatureSnapshot() {
      const c = window.__fabrik.creature()
      if (!c) return null
      let worstLegErr = 0
      let worstLegBend = 0
      for (const leg of c.legs) {
        worstLegErr = Math.max(worstLegErr, leg.result.error)
        worstLegBend = Math.max(worstLegBend, maxBendDeg(leg.joints))
      }
      // Spine spacing error.
      let spacingErr = 0
      for (let i = 1; i < c.spine.length; i++) {
        const d = Math.hypot(c.spine[i].x - c.spine[i - 1].x, c.spine[i].y - c.spine[i - 1].y)
        spacingErr = Math.max(spacingErr, Math.abs(d - 21))
      }
      return {
        spineCount: c.spine.length,
        legCount: c.legs.length,
        legBones: c.legs.map((l) => l.lengths.length),
        legJointCounts: c.legs.map((l) => l.joints.length),
        headX: c.head.x,
        headY: c.head.y,
        velX: c.vel.x,
        velY: c.vel.y,
        speed: Math.hypot(c.vel.x, c.vel.y),
        spineMaxBendDeg: maxBendDeg(c.spine),
        spineSpacingError: spacingErr,
        worstLegErr,
        worstLegBend,
        comX: c.comX,
        comY: c.comY,
        comSpeed: Math.hypot(c.comVX, c.comVY),
        feet: c.legs.map((l) => ({
          x: l.joints[2].x,
          y: l.joints[2].y,
          stepping: l.stepping,
          pair: l.pair,
          side: l.side,
        })),
      }
    },

    /** Advance the active rig deterministically. */
    step: (n, dt) => window.__fabrik.step(n, dt),
    pointer: (x, y) => window.__fabrik.pointer(x, y),
    fire: () => window.__fabrik.fire(),

    /**
     * Walk the creature and audit the gait.
     *
     * Records, per frame: which legs swing, their side and group, which legs
     * STARTED, and how many ripples are alive. Every trot assertion is derived
     * from that timeline.
     *
     * Note that "two legs of the same group swing together" is now EXPECTED —
     * it is what a diagonal trot is. The failure modes worth detecting are two
     * legs on the same SIDE, and legs from BOTH groups swinging at once.
     */
    recordGait(steps, dt, flipEvery) {
      const c = window.__fabrik.creature()
      if (!c) return null

      const stepCount = c.legs.map(() => 0)
      let maxConcurrent = 0
      let allFourUp = false
      let sameSideFrames = 0
      let mixedGroupFrames = 0
      let sameGroupFrames = 0
      let plantedFrames = 0
      let maxRipplesAlive = 0
      const startEvents = []

      for (let s = 0; s < steps; s++) {
        /**
         * Alternate the goal so the creature keeps walking for the whole audit.
         *
         * A single fixed target is reached within a second, after which the
         * arrival dead zone stops the creature dead and the remaining frames
         * contain no steps at all — far too few to judge a gait.
         */
        if (flipEvery > 0 && s % flipEvery === 0) {
          const rect = window.__fc.canvas().getBoundingClientRect()
          const leftward = Math.floor(s / flipEvery) % 2 === 1
          window.__fabrik.pointer(
            leftward ? rect.width * 0.08 : rect.width * 0.92,
            rect.height * (leftward ? 0.72 : 0.3),
          )
        }

        const before = c.legs.map((l) => l.stepping)
        window.__fabrik.step(1, dt)
        const after = c.legs.map((l) => l.stepping)

        const swinging = []
        const started = []
        for (let i = 0; i < after.length; i++) {
          if (after[i]) swinging.push(i)
          if (after[i] && !before[i]) {
            stepCount[i]++
            started.push(i)
          }
        }

        const alive = c.ripples.filter((r) => r.alive).length
        if (alive > maxRipplesAlive) maxRipplesAlive = alive

        if (swinging.length > maxConcurrent) maxConcurrent = swinging.length
        if (swinging.length === c.legs.length) allFourUp = true
        if (swinging.length === 0) plantedFrames++

        // Two legs on the same SIDE up at once is the instability being fixed.
        const sides = swinging.map((i) => c.legs[i].side)
        if (new Set(sides).size < sides.length) sameSideFrames++

        // Legs from both groups up at once means the groups are not exclusive.
        const groups = swinging.map((i) => c.legs[i].pair)
        const uniqueGroups = new Set(groups)
        if (uniqueGroups.size > 1) mixedGroupFrames++
        if (groups.length >= 2 && uniqueGroups.size === 1) sameGroupFrames++

        if (started.length > 0) {
          const startGroups = [...new Set(started.map((i) => c.legs[i].pair))]
          startEvents.push({
            frame: s,
            legs: started,
            group: startGroups[0],
            // A trot lifts the entire group on one frame.
            synchronous: startGroups.length === 1 && started.length === 2,
            ripplesAlive: alive,
          })
        }
      }

      // Do the groups strictly alternate?
      const groupOrder = startEvents.map((e) => e.group)
      let alternations = 0
      let repeats = 0
      for (let i = 1; i < groupOrder.length; i++) {
        if (groupOrder[i] !== groupOrder[i - 1]) alternations++
        else repeats++
      }

      return {
        stepCount,
        maxConcurrent,
        allFourUp,
        sameSideFrames,
        mixedGroupFrames,
        sameGroupFrames,
        plantedFrames,
        startEventCount: startEvents.length,
        synchronousStarts: startEvents.filter((e) => e.synchronous).length,
        groupOrder: groupOrder.slice(0, 20),
        alternations,
        repeats,
        maxRipplesAlive,
      }
    },

    /** Measure the parabolic lift of leg 0 over one full swing. */
    measureFootArc(dt) {
      const c = window.__fabrik.creature()
      if (!c) return null
      const leg = c.legs[0]
      // Walk until this leg starts a step.
      let guard = 0
      while (!leg.stepping && guard++ < 4000) window.__fabrik.step(1, dt)
      if (!leg.stepping) return { started: false }

      const fromX = leg.fromX
      const fromY = leg.fromY
      const toX = leg.toX
      const toY = leg.toY
      const samples = []
      let guard2 = 0
      while (leg.stepping && guard2++ < 400) {
        window.__fabrik.step(1, dt)
        const foot = leg.joints[2]
        // Progress along the step, derived from the planted anchor.
        samples.push({ x: foot.x, y: foot.y })
      }
      if (samples.length < 3) return { started: true, samples: samples.length }

      // The lift is how far the foot rises above the straight chord, evaluated
      // by projecting each sample onto the chord.
      let maxLift = 0
      const cdx = toX - fromX
      const cdy = toY - fromY
      const clen2 = cdx * cdx + cdy * cdy || 1
      for (const s of samples) {
        const t = Math.max(0, Math.min(1, ((s.x - fromX) * cdx + (s.y - fromY) * cdy) / clen2))
        const chordY = fromY + cdy * t
        maxLift = Math.max(maxLift, chordY - s.y)
      }
      return {
        started: true,
        samples: samples.length,
        maxLift,
        durationMs: samples.length * dt * 1000,
      }
    },

    /** Sample N frames of heading, to test steering. */
    sampleHeading(frames, dt) {
      const c = window.__fabrik.creature()
      if (!c) return null
      const out = []
      for (let i = 0; i < frames; i++) {
        window.__fabrik.step(1, dt)
        out.push({
          x: c.head.x,
          y: c.head.y,
          speed: Math.hypot(c.vel.x, c.vel.y),
        })
      }
      return out
    },

    ink() {
      const c = this.canvas()
      if (!c) return null
      const ctx = c.getContext('2d')
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let lit = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 16) lit++
      return { lit, total: c.width * c.height }
    },

    /** Is the "Show IK Vectors" toggle present and checkable? */
    findDebugToggle() {
      const s = wrap()
      if (!s) return null
      const boxes = Array.from(s.querySelectorAll('input[type="checkbox"]'))
      const box = boxes.find((b) => /show ik vectors/i.test(b.closest('label')?.textContent ?? ''))
      return box ? { found: true, checked: box.checked } : { found: false }
    },

    findModeButtons() {
      const s = wrap()
      if (!s) return null
      const btns = Array.from(s.querySelectorAll('button'))
      return {
        arm: btns.some((b) => /机械臂/.test(b.textContent ?? '')),
        creature: btns.some((b) => /四足/.test(b.textContent ?? '')),
      }
    },

    clickMode(label) {
      const s = wrap()
      if (!s) return false
      const btn = Array.from(s.querySelectorAll('button')).find((b) =>
        new RegExp(label).test(b.textContent ?? ''),
      )
      if (!btn) return false
      btn.click()
      return true
    },

    clickDebug() {
      const s = wrap()
      if (!s) return false
      const boxes = Array.from(s.querySelectorAll('input[type="checkbox"]'))
      const box = boxes.find((b) => /show ik vectors/i.test(b.closest('label')?.textContent ?? ''))
      if (!box) return false
      box.click()
      return true
    },
  }
  return {
    ok: true,
    hasHook: Boolean(window.__fabrik),
    hasCanvas: Boolean(document.querySelector('#playground canvas')),
  }
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
const consoleErrors = []

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
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

const run = async (fn, ...args) => {
  const call =
    typeof fn === 'function'
      ? '(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')'
      : fn
  const res = await send('Runtime.evaluate', {
    expression: call,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    return { __error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text }
  }
  return res.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: URL_TO_TEST })
await sleep(7000)

await run(function scrollTo() {
  const s = document.getElementById('playground')
  if (s) s.scrollIntoView({ block: 'start' })
  return true
})
await sleep(2200)

const report = {}
report.install = await run(installHelpers)
mkdirSync('screenshots', { recursive: true })

/* ══════════════════════════ ARM ══════════════════════════════════════════ */

/* A1/A2/A3/A4: solve to a reachable point. */
report.A_reachable = await run(function armReach() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  // Point up and to the right of the base, comfortably inside the reach.
  window.__fc.pointer(r.width * 0.72, r.height * 0.22)
  window.__fc.step(180, 1 / 60)
  return window.__fc.armSnapshot()
})

/* A5: an out-of-reach pointer must be clamped into the annulus. */
report.A_outOfReach = await run(function armFar() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  window.__fc.pointer(r.width * 2.2, r.height * 2.2)
  window.__fc.step(180, 1 / 60)
  return window.__fc.armSnapshot()
})

/* A5c: a target just inside the clamp must still converge.
 * This is the ill-conditioned case: at the outer clamp the chain is nearly
 * straight, the tip is almost insensitive to joint angles, and FABRIK can stall
 * short of tolerance while burning every sweep. */
report.A_nearLimit = await run(function armNearLimit() {
  const a = window.__fabrik.arm()
  // Aim straight up so the pose is deterministic, at 99% of the outer clamp.
  const reach = a.lengths.reduce((s, v) => s + v, 0)
  window.__fc.pointer(a.baseX, a.baseY - reach * 0.99)
  window.__fc.step(200, 1 / 60)
  return window.__fc.armSnapshot()
})

/* A5d: an extremely close pointer must be pushed out to the inner annulus. */
report.A_tooClose = await run(function armNear() {
  const snap = () => window.__fc.armSnapshot()
  const a = window.__fabrik.arm()
  window.__fc.pointer(a.baseX, a.baseY)
  window.__fc.step(180, 1 / 60)
  return snap()
})

/* A6: firing. */
await run(function resetAim() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  window.__fc.pointer(r.width * 0.6, r.height * 0.25)
  window.__fc.step(120, 1 / 60)
  return true
})
report.A_beforeFire = await run(function beforeFire() {
  return window.__fc.armSnapshot()
})
report.A_fire = await run(function doFire() {
  const shots = window.__fc.fire()
  // One frame so the laser starts and the recoil impulse is integrated.
  window.__fc.step(1, 1 / 60)
  const after = window.__fc.armSnapshot()
  return { shots, ...after }
})

/* A7: the recoil spring must settle back to rest. */
report.A_recoilDecay = await run(function recoil() {
  const peaks = []
  peaks.push(window.__fc.armSnapshot().recoilMag)
  window.__fc.step(6, 1 / 60)
  peaks.push(window.__fc.armSnapshot().recoilMag)
  window.__fc.step(90, 1 / 60)
  const settled = window.__fc.armSnapshot().recoilMag
  return { start: peaks[0], peak: Math.max(...peaks), settled }
})

const shotArm = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/90-fabrik-arm.png', Buffer.from(shotArm.data, 'base64'))

report.S_armInk = await run(function ink() {
  return window.__fc.ink()
})

/* Debug overlay in arm mode. */
report.debugToggles = await run(function dbg() {
  const before = window.__fc.findDebugToggle()
  window.__fc.clickDebug()
  return before
})
await sleep(700)
const shotArmDebug = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/91-fabrik-arm-debug.png', Buffer.from(shotArmDebug.data, 'base64'))
report.armDebugInk = await run(function ink() {
  return window.__fc.ink()
})
// Turn it back off for the creature shots.
await run(function off() {
  window.__fc.clickDebug()
  return true
})

/* ══════════════════════════ CREATURE ═════════════════════════════════════ */

report.modeButtons = await run(function modeBtns() {
  return window.__fc.findModeButtons()
})
await run(function switchToCreature() {
  return window.__fc.clickMode('四足')
})
await sleep(900)

/* C1: topology. */
report.C_topology = await run(function topo() {
  window.__fc.step(60, 1 / 60)
  return window.__fc.creatureSnapshot()
})

/* C3: steering — does the head close on the pointer and build speed? */
report.C_steering = await run(function steer() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  const cr = window.__fabrik.creature()

  // Park the pointer far away so the creature has a long run-up.
  const tx = r.width - 90
  const ty = r.height / 2
  window.__fc.pointer(tx, ty)
  const before = { x: cr.head.x, y: cr.head.y }
  const beforeDist = Math.hypot(before.x - tx, before.y - ty)

  // 150 frames = 2.5 s: long enough for the steering to reach cruising speed and
  // cover real ground. The earlier 45-frame window started from near-standstill
  // and closed only 79 px, which said nothing about whether it can chase.
  const samples = window.__fc.sampleHeading(150, 1 / 60)
  const after = { x: cr.head.x, y: cr.head.y }
  const afterDist = Math.hypot(after.x - tx, after.y - ty)

  return {
    beforeDist,
    afterDist,
    closedDistance: beforeDist - afterDist,
    closedFraction: beforeDist > 0 ? (beforeDist - afterDist) / beforeDist : 0,
    speedRose: samples[samples.length - 1].speed > samples[0].speed,
    peakSpeed: Math.max(...samples.map((s) => s.speed)),
    finalSpeed: samples[samples.length - 1].speed,
  }
})

/* C4: arrival — it must settle near the pointer, not orbit it. */
report.C_arrival = await run(function arrive() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  const tx = r.width * 0.35
  const ty = r.height * 0.65
  window.__fc.pointer(tx, ty)
  window.__fc.step(300, 1 / 60)
  const cr = window.__fabrik.creature()
  // Sample the distance over the last stretch to detect orbiting.
  let minD = Infinity
  let maxD = 0
  for (let i = 0; i < 60; i++) {
    window.__fc.step(1, 1 / 60)
    const d = Math.hypot(cr.head.x - tx, cr.head.y - ty)
    minD = Math.min(minD, d)
    maxD = Math.max(maxD, d)
  }
  const finalD = Math.hypot(cr.head.x - tx, cr.head.y - ty)
  return {
    targetX: tx,
    targetY: ty,
    finalDistance: finalD,
    settledWithin: finalD < 120,
    speedAtRest: Math.hypot(cr.vel.x, cr.vel.y),
    minD,
    maxD,
  }
})

/* C5: gait timeline — the diagonal trot audit. */
report.C_gait = await run(function gait() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  window.__fc.pointer(r.width * 0.5, r.height * 0.5)
  window.__fc.step(30, 1 / 60)
  // Alternate the goal every 1.5 s so the creature walks continuously for the
  // whole 12-second audit instead of arriving and stopping.
  const res = window.__fc.recordGait(720, 1 / 60, 90)
  if (!res) return null
  return res
})

/* C2/C7: spine and leg constraints under load. */
report.C_constraints = await run(function constraints() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  // Hard turn: yank the pointer to the opposite side.
  window.__fc.pointer(90, 90)
  window.__fc.step(40, 1 / 60)
  window.__fc.pointer(r.width - 90, r.height - 90)
  window.__fc.step(40, 1 / 60)
  return window.__fc.creatureSnapshot()
})

/* C6: parabolic foot arc. */
report.C_footArc = await run(function arc() {
  const c = window.__fc.canvas()
  const r = c.getBoundingClientRect()
  /**
   * Teleport the creature to the far side and put the goal at the opposite edge.
   *
   * Without this the creature has often already arrived at the goal left by the
   * previous probe, the arrival dead zone holds it still, no leg ever crosses the
   * stride threshold, and the arc measurement reports `started: false` — a false
   * failure that says nothing about the arc.
   */
  const cr = window.__fabrik.creature()
  cr.head.x = r.width * 0.12
  cr.head.y = r.height * 0.5
  cr.vel.x = 0
  cr.vel.y = 0
  for (const leg of cr.legs) {
    leg.anchorX = cr.head.x + leg.side * 40
    leg.anchorY = cr.head.y + 30
    leg.stepping = false
    leg.stepT = 1
  }
  window.__fc.pointer(r.width * 0.94, r.height * 0.5)
  window.__fc.step(40, 1 / 60)

  const res = window.__fc.measureFootArc(1 / 60)
  if (!res) return null
  return {
    started: res.started,
    samples: res.samples,
    maxLift: res.maxLift,
    durationMs: res.durationMs,
  }
})

const shotCreature = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('screenshots/92-fabrik-creature.png', Buffer.from(shotCreature.data, 'base64'))

report.S_creatureInk = await run(function ink() {
  return window.__fc.ink()
})

/* Debug overlay in creature mode. */
await run(function on() {
  window.__fc.clickDebug()
  return true
})
await sleep(800)
const shotCreatureDebug = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(
  'screenshots/93-fabrik-creature-debug.png',
  Buffer.from(shotCreatureDebug.data, 'base64'),
)
report.creatureDebugInk = await run(function ink() {
  return window.__fc.ink()
})

/* ── Assertions ─────────────────────────────────────────────────────────── */
const arm = report.A_reachable ?? {}
const far = report.A_outOfReach ?? {}
const near = report.A_tooClose ?? {}
const fire = report.A_fire ?? {}
const recoil = report.A_recoilDecay ?? {}
const topo = report.C_topology ?? {}
const steer = report.C_steering ?? {}
const arrive = report.C_arrival ?? {}
const gait = report.C_gait ?? {}
const cons = report.C_constraints ?? {}
const arc = report.C_footArc ?? {}

report.assertions = {
  /* Arm */
  armTopology: arm.jointCount === 7 && arm.boneCount === 6,
  baseIsPinned:
    Math.abs((far.baseX ?? 0) - (arm.baseX ?? -1)) < 1e-6 &&
    Math.abs((far.baseY ?? 0) - (arm.baseY ?? -1)) < 1e-6,
  armConverges: arm.converged === true && (arm.tipToTarget ?? 99) < 1.0,
  armBonesRigid: (arm.boneError ?? 99) < 0.01,
  armRespectsAngleCone: (arm.maxBendDeg ?? 999) <= 95.5,
  farTargetClamped: (far.baseToTarget ?? 0) <= (far.reach ?? 0) * 0.91,
  farStillConverges: far.converged === true,
  nearLimitConverges:
    report.A_nearLimit?.converged === true && (report.A_nearLimit?.tipToTarget ?? 99) < 1.0,
  closeTargetClamped: (near.baseToTarget ?? 0) >= (near.reach ?? 1) * 0.215,
  fireStartsLaser: (fire.laserT ?? 1) < 0.2,
  fireIncrementsShots: (fire.shots ?? 0) >= 1,
  fireRecoils: (fire.recoilMag ?? 0) > 0.5,
  recoilSettles: (recoil.settled ?? 99) < (recoil.peak ?? 0) * 0.5 && (recoil.settled ?? 99) < 3,

  /* Creature */
  creatureTopology:
    topo.spineCount === 12 &&
    topo.legCount === 4 &&
    (topo.legBones ?? []).every((n) => n === 2) &&
    (topo.legJointCounts ?? []).every((n) => n === 3),
  spineKeepsSpacing: (cons.spineSpacingError ?? 99) < 0.5,
  spineRespectsCone: (cons.spineMaxBendDeg ?? 999) <= 34.5,
  legIkConverges: (cons.worstLegErr ?? 99) < 1.0,
  // 150° knee limit: still short of the 180° inversion the cone forbids.
  legRespectsCone: (cons.worstLegBend ?? 999) <= 150.5,
  steeringClosesDistance: (steer.closedFraction ?? 0) > 0.6,
  steeringBuildsSpeed: steer.speedRose === true && (steer.peakSpeed ?? 0) > 100,
  arrivalSettles: arrive.settledWithin === true,
  arrivalStopsMoving: (arrive.speedAtRest ?? 99) < 30,
  everyLegSteps: Array.isArray(gait.stepCount) && gait.stepCount.every((n) => n > 0),
  gaitNeverLiftsAllFour: gait.allFourUp === false,
  /* ── Diagonal trot contract ────────────────────────────────────────────── */
  // The reported bug: two legs on the same side leaving the ground together.
  gaitNeverSameSide: (gait.sameSideFrames ?? 1) === 0,
  // Groups must be mutually exclusive: never a leg from each group up at once.
  gaitGroupsAreExclusive: (gait.mixedGroupFrames ?? 1) === 0,
  // Diagonal partners swing as a unit rather than one after the other.
  gaitLiftsWholeGroup:
    (gait.startEventCount ?? 0) > 2 && gait.synchronousStarts === gait.startEventCount,
  // Strict alternation: a group never takes two phases in a row.
  gaitAlternatesGroups: (gait.repeats ?? 1) === 0 && (gait.alternations ?? 0) > 2,
  // There must be a moment with all four feet planted between phases.
  gaitHasSupportPhase: (gait.plantedFrames ?? 0) > 10,
  // Landing ripples actually spawn.
  ripplesSpawnOnLanding: (gait.maxRipplesAlive ?? 0) > 0,
  footArcIsParabolic: (arc.maxLift ?? 0) > 8,
  footStepDurationSane: (arc.durationMs ?? 0) > 100 && (arc.durationMs ?? 0) < 400,

  /* Shared */
  armDraws: (report.S_armInk?.lit ?? 0) > 3000,
  creatureDraws: (report.S_creatureInk?.lit ?? 0) > 3000,
  debugOverlayDraws:
    (report.armDebugInk?.lit ?? 0) > (report.S_armInk?.lit ?? 0) &&
    (report.creatureDebugInk?.lit ?? 0) > (report.S_creatureInk?.lit ?? 0),
  debugToggleExists: report.debugToggles?.found === true,
  modeButtonsExist: report.modeButtons?.arm === true && report.modeButtons?.creature === true,
}

report.exceptions = exceptions
report.consoleErrors = consoleErrors
writeFileSync('screenshots/fabrik-report.json', JSON.stringify(report, null, 2))

const failed = Object.entries(report.assertions)
  .filter(([, v]) => !v)
  .map(([k]) => k)

console.log(
  JSON.stringify(
    {
      assertions: report.assertions,
      failed,
      key: {
        reachable: {
          tipToTarget: arm.tipToTarget,
          iterations: arm.iterations,
          boneError: arm.boneError,
          maxBendDeg: arm.maxBendDeg,
        },
        far: { baseToTarget: far.baseToTarget, reach: far.reach, converged: far.converged },
        fire: { laserT: fire.laserT, shots: fire.shots, recoil: fire.recoilMag },
        recoil,
        gait: {
          stepCount: gait.stepCount,
          maxConcurrent: gait.maxConcurrent,
          allFourUp: gait.allFourUp,
          sameSideFrames: gait.sameSideFrames,
          mixedGroupFrames: gait.mixedGroupFrames,
          sameGroupFrames: gait.sameGroupFrames,
          plantedFrames: gait.plantedFrames,
          startEvents: gait.startEventCount,
          synchronousStarts: gait.synchronousStarts,
          groupOrder: gait.groupOrder,
          alternations: gait.alternations,
          repeats: gait.repeats,
          maxRipplesAlive: gait.maxRipplesAlive,
        },
        arc,
        steer,
        arrive,
        ink: {
          arm: report.S_armInk?.lit,
          armDebug: report.armDebugInk?.lit,
          creature: report.S_creatureInk?.lit,
          creatureDebug: report.creatureDebugInk?.lit,
        },
      },
      exceptions,
      consoleErrors,
    },
    null,
    2,
  ),
)

finish({ failures: findMissing(report), label: 'fabrik', exceptions, consoleErrors, report })
ws.close()
