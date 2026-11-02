# 物理沙盒审查报告 · physics-sandbox

审查范围：`FabrikCreature.tsx`（2829 行 / 101 KB）、`VerletLanyard.tsx`（1999 行 / 76 KB）、`mathPhysics.ts`（1253 行）、`fabrik.ts`（288 行）、`soundEngine.ts`（763 行）、`Sections.tsx`、`AudioSpectrumMeter.tsx`、`useInViewAnimation.ts`。
方法：纯静态审查（读代码 + 常量复算），未运行 dev server、未改 src。
结论概要：共 17 条（P1 × 6、P2 × 7、P3 × 4），**未发现 P0**。其中 6 条（PB-02/03/04/06/09/13）都指向同一件事：两个沙盒各自实现了一套「rAF + 累加器 + 全量 canvas 重绘」的私有循环，而 `mathPhysics.ts` 头部与两个组件的注释都在声明「零分配 / 唯一动画循环」之后又违反了自己的声明。这是当前最值得先修的一块。

---

### [PB-01] 两个 2000+ 行文件各塞了 7 类职责，且两套沙盒循环彼此复制

- 严重级别：P1
- 分类：可维护性
- 位置：`src/components/sandbox/FabrikCreature.tsx:2829`（全文）、`src/components/sandbox/VerletLanyard.tsx:1-1999`
  职责分布实测（行区间互不重叠，含注释/空行）：

  | 文件 | 行段 | 行数 | 内容 |
  |---|---|---|---|
  | FabrikCreature | 46-352 | 307 | 两套调参常量表（ARM_* / LEG_* / VFX 描述符 / 配色） |
  | | 354-681 | 328 | 类型定义 + `createArm` / `createCreature` |
  | | 683-809 | 127 | VFX 发射器（火花/湍流/足印/灼痕） |
  | | 811-1409 | 599 | `stepArm` + `stepCreature`（转向、脊椎、步态、四腿 IK） |
  | | 1411-1776 | 366 | 组件：4 个 useState + 尺寸管理 + rAF 累加器 + HUD + JSX |
  | | 1778-2829 | 1052 | 绘制层（骨骼/关节/全息/灼痕/激光/生物/调试叠层） |
  | VerletLanyard | 58-282 | 225 | 常量表 + VFX 类型 + `hexToRgb` |
  | | 284-761 | 478 | 组件：effect 循环 + 指针绑定 + HUD + JSX |
  | | 763-1245 | 483 | VFX 逻辑（碰撞捕获/断裂弧/粒子） |
  | | 1247-1997 | 751 | 绘制层（绳索/工牌/夹扣/纤维脉冲） |

  两个文件合计 4828 行里，物理核心（`step*`）只占 599 行（12%），React 外壳占 844 行（17%），其余 71% 是常量与绘制。

  证据（`FabrikCreature.tsx:1411-1482`，组件 + 状态 + 循环 + 尺寸管理挤在同一段）：
  ```tsx
  type RideMode = 'arm' | 'creature'
  interface DebugFlags { vectors: boolean }
  export function FabrikCreature({ className }: { className?: string }) {
    const { t } = useI18n()
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const wrapRef = useRef<HTMLDivElement>(null)
  ```
- 影响：任何一处物理调参都要在 2829 行里跳转；两个文件各自持有的 `FIXED = 1/60`、`dpr` 钳制、累加器、`import.meta.env.DEV` 暴露逻辑都是复制品，PB-02/PB-03/PB-13 这几个 bug 因此需要修两遍；两人同时改会冲突（git blame 已被注释淹没）。
- 修改建议（拆分清单 + 迁移顺序，每步独立可编译）：
  1. **第一步（纯搬运，零行为变化）**：常量表 → `sandbox/fabrik/armConfig.ts`、`creatureConfig.ts`、`sandbox/verlet/lanyardConfig.ts`（含 `LANYARD_SPECS`、`COLLISION_SPARK_OPTIONS`、`IMPACT_BURST_OPTS` 等可复用记录）。
  2. **第二步（纯函数出栈，立刻可抽）**：
     - `hexToRgb`（VerletLanyard:221）→ `src/lib/color.ts`
     - `roundRect`（VerletLanyard:1978）→ `src/utils/canvasKit.ts`
     - `overlapObb`（VerletLanyard:840）→ 合并进 `mathPhysics.collideObb`，见 PB-09
     - `stanceFor`（FabrikCreature:1397）、`rayRectDistance`（:700）→ `src/utils/gait.ts`、`src/utils/raycast.ts`
     - `drawAngleCone` / `drawBullseye` / `drawVelocityArrow`（FabrikCreature:2743/2764/2797）→ `src/utils/canvasDebug.ts`
     - `drawRope` 内的应力配色两段插值（VerletLanyard:1466-1489）→ `strainToCordColor(stress): number`（返回 0xRRGGBB，避开每帧拼字符串）
     - 步态决策（FabrikCreature:1140-1228，90 行内联 + 6 次 `stanceFor` 分配）→ `decideGait({lag0, lag1, lastGroup, lockTimer}): number`，纯函数、可直接单测
  3. **第三步**：绘制层出栈（只吃 `ctx` + 状态对象，无闭包依赖）。
     - `sandbox/verlet/drawRope.ts`（drawRope + drawFibrePulses + drawClasp）
     - `sandbox/verlet/drawTag.ts`、`drawSnapArcs.ts`、`drawSandbox.ts`
     - `sandbox/fabrik/drawArm.ts`、`drawCreature.ts`、`holo.ts`（drawHoloJoint/drawEnergyFluid/drawIonBraid）、`debugDraw.ts`
  4. **第四步**：VFX 逻辑出栈 → `sandbox/verlet/lanyardVfx.ts`（create/reset/advanceSnapArcs/captureImpactEvents/spawnSnapArc/updateVfx，模块级 scratch 一起搬）。
  5. **第五步**：模拟步进出栈 → `sandbox/fabrik/stepArm.ts`、`stepCreature.ts`。
  6. **第六步（关键）**：把两个 effect 里的循环抽成一个共享 hook `src/hooks/useFixedStepSandbox.ts`，参数 `{ fixedDt, maxSteps, inView, render }`，**PB-02/PB-03/PB-11/PB-13 的修复只落在这一个文件**。
  7. **第七步**：组件壳只剩 JSX + HUD + 指针绑定（目标 ≤ 300 行）。
  目标结构：FabrikCreature 主文件 ≈ 300 行，VerletLanyard ≈ 260 行，其余 12-14 个文件每份 90-450 行。

---

### [PB-02] 累加器只封顶「每帧步数」不封顶「时间债务」，低帧率下物理时间永久落后真实时间

- 严重级别：P1
- 分类：物理正确性
- 位置：`src/components/sandbox/VerletLanyard.tsx:432-485`（`FabrikCreature.tsx:1539-1573` 同构）
  ```ts
  const dt = lastTime === 0 ? FIXED_DT : Math.min((now - lastTime) / 1000, 0.1)
  lastTime = now
  accRef.current += dt
  while (accRef.current >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
    timeRef.current += FIXED_DT
    sim.step(FIXED_DT, timeRef.current)
    accRef.current -= FIXED_DT
    steps++
  }
  // ← 这里没有 accRef.current = Math.min(accRef.current, FIXED_DT * MAX_STEPS_PER_FRAME)
  ```
- 现象与证据：`dt` 被钳到 0.1 s，每帧最多消费 `4 × 1/60 = 0.0667 s`。只要单帧 `dt > 0.0667`（即实测帧率 < 15 fps，或任意一次 100 ms 长帧），每帧净增 `dt − 0.0667` 的债务，且**没有上限、没有丢弃策略**。14 fps 时债务以 ≈ 0.0047 s/帧 累积，30 秒后 `acc` ≈ 0.14 s，此后每帧都跑满 4 步而模拟只推进 0.0667 s，`timeRef` 与墙钟的偏差单调增长。同理，`isScrollBusy()` / `!inView` 的提前 `return`（:413、:425）**不复位 `lastTime`**，所以每次滚动结束、每次回到视口，第一帧必然拿到被钳到 0.1 s 的 dt → 固定一次 4 子步（66 ms）的物理跳跃。
- 影响：① 低端设备上绳索的摆动逐渐与输入脱节（拖拽时指针已停、绳子还在追赶），风场相位漂移（`elapsed` 用 `timeRef`，与渲染时钟 `renderTime` 不同源）；② 高刷设备每次滚动/回屏都看到一次 66 ms 的瞬移，正好在"停下来看"的瞬间。README:285 写的"max 4 steps/frame 防止切页后补帧爆炸"只防了爆炸，没防漂移。
- 修改建议：消费后回收债务 + 门控返回时复位时间基准，一处两行：
  ```ts
  // 循环结束后
  const maxDebt = FIXED_DT * MAX_STEPS_PER_FRAME
  if (accRef.current > maxDebt) accRef.current = maxDebt   // 丢弃追不上的时间，宁可慢放不漂移
  // 两个门控分支里（inView / isScrollBusy）
  if (!inViewRef.current) { lastTime = now; return }
  ```
  同时把 `lastTime === 0 ? FIXED_DT` 换成 `lastTime = now` 初始化语义（首帧 dt 应为 0 而非一整步，见 PB-03 的插值方案）。

---

### [PB-03] 定长步进却不做渲染插值：120/144 Hz 屏上 2–3 帧画同一姿态

- 严重级别：P1
- 分类：物理正确性 / 性能
- 位置：`src/components/sandbox/VerletLanyard.tsx:487-511`
  ```ts
  // Draw once per animation frame, not once per physics step.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  drawSandbox(ctx, sim, cssW, cssH, renderTime(timeRef.current), vfx)
  ```
  `drawSandbox` 直接读 `l.points[i].x/y`（`VerletLanyard.tsx:1461`），没有任何 `alpha = acc/FIXED_DT` 插值。
- 现象与证据：144 Hz 下单帧 dt≈6.94 ms，累加器每 2.4 帧才凑满一个 `FIXED_DT`；也就是 144 fps 里约 **58% 的帧跑 0 步、42% 的帧跑 1 步**，画面以 60 Hz 的节奏跳变，而显示以 144 Hz 刷新 → 移动的绳索出现周期性「顿一下」。60 Hz 屏上因为步长与刷新同步看不出来，这也是为什么 README 的"跨设备物理一致"在数值上成立、在观感上不成立。
- 影响：卖点级的"丝滑"在 120/144 Hz 设备（MacBook Pro、多数安卓旗舰）上掉档；同时 `clearRect + 全量重绘` 在 0 步的帧上完全是白做的（见 PB-06）。
- 修改建议：为每个 `VerletPoint` 增加 `rx/ry`（上一物理步的渲染位置），绘制时按 `t = accRef.current / FIXED_DT` 插值：
  ```ts
  // step 前：保存渲染快照
  for (const p of l.points) { p.rx = p.x; p.ry = p.y }
  // 绘制时（drawRope 内取点处）
  const t = Math.min(1, accRef.current / FIXED_DT)
  const x = p.rx + (p.x - p.rx) * t
  const y = p.ry + (p.y - p.ry) * t
  ```
  若嫌字段侵入，可在 `LanyardState` 上放一条 `renderPoints` 复用数组（同样零分配）。FABRIK 侧同理，插值 7 个关节与 4 个脚位即可。

---

### [PB-04] 每帧新建 20+ 个渐变对象、16 次 `shadowBlur` 绘制——canvas 2D 上最贵的两种操作都在热路径里

- 严重级别：P1
- 分类：性能
- 位置：`src/components/sandbox/VerletLanyard.tsx:1788-1854`（drawClasp，每个工牌每帧 5 个渐变）、`:1888`（drawTag）、`:1499-1526`（两次 `shadowBlur` 描边）
  ```ts
  const body = ctx.createLinearGradient(-hw, 0, hw, 0)
  body.addColorStop(0, '#4a5468'); body.addColorStop(0.22, '#8d9bb5')
  body.addColorStop(0.42, '#dfe8f5'); body.addColorStop(0.6, '#9aa8c0')
  body.addColorStop(0.82, '#5b677d'); body.addColorStop(1, '#3b4557')
  ...
  for (const rx of [-5.6, 5.6]) {
    const rivet = ctx.createRadialGradient(rx - 0.6, -hh * 0.35, 0, rx, -hh * 0.35, 1.9)
  ```
- 现象与证据：
  - 渐变：drawClasp 每绳 5 个（body/spec/bounce/2×rivet）+ drawTag 1 个 → 4 绳 = **24 个/帧**；`drawIllumination`→`drawRadialFlash`（`vfxParticleEngine.ts:180`）再各建 1 个。每次 `addColorStop` 都要解析一次 CSS 颜色字符串：每绳 body 6 + spec 3 + bounce 2 + rivet 3×2 + tag 4 = 19 次 → **≈76 次颜色字符串解析/帧**。FabrikCreature 侧同样：`drawBoneMetal`（:1816）每骨 1 个、`drawJoint`（:1849）每关节 1 个 → 每帧 15-16 个。
  - `shadowBlur`：`drawRope` 的纤维泛光层 `lineWidth = 18 + stress*8` + `shadowBlur = 22`，外发光层 `shadowBlur = 10 + stress*16`，各绳 2 次；加上 `drawTag`（`shadowBlur = t.attached ? 16 : 22`）与 `drawClasp`（5）→ **每帧 16 次带模糊的描边/填充**。每个 shadow 都要把路径渲染进离屏表面再高斯模糊，模糊半径 22 时缓冲区约为 bbox+44px；而这条曲线横跨整个画布宽度（≈1000 px），4 绳 × 2 层 = 8 个大面积模糊层。
- 影响：这是本页最贵的一段渲染。代码注释自己也记录了 A/B：两个沙盒不挂载时整页滚动 121 → 144 fps（`VerletLanyard.tsx:418-423`），说明成本集中在这里。`shadowBlur` 在软件光栅化（无头/低端 GPU/远程桌面）下会直接跌到 20 fps 级别，而它服务的是纯装饰性的柔光。
- 修改建议：
  1. **渐变缓存**：所有 `drawClasp` / `drawTag` / `drawBoneMetal` / `drawJoint` 的渐变都定义在**局部坐标**里（形状尺寸恒定），可以只建一次并挂在 rig 对象上（`if (!rig.grad.claspBody) rig.grad.claspBody = ctx.createLinearGradient(...)`），之后每帧复用。`drawBoneMetal` 目前用世界坐标建渐变，改成局部 `createLinearGradient(0,0,len,0)` + `ctx.rotate(atan2(dy,dx))` 即可同样缓存。
  2. **删掉 `shadowBlur`，用堆叠描边替代**（这本来就是更便宜的柔光做法，且代码里已经有 2 层光晕）：
     ```ts
     // 替代 shadowBlur = 22 的泛光：三层递增宽度、递减 alpha，一次路径三次描边
     ctx.globalCompositeOperation = 'lighter'
     for (const [w, a] of [[28, 0.03], [18, 0.06], [10, 0.10]] as const) {
       ctx.globalAlpha = alpha * a
       ctx.lineWidth = w
       ctx.beginPath(); traceBezierPath(ctx, segments); ctx.stroke()
     }
     ```
     路径只 trace 一次（`traceBezierPath` 已支持复用），三次 stroke 比一次 blur 便宜一个数量级。
  3. 工牌投影改成预渲染的离屏 canvas（`drawImage` 一次），或直接用 CSS `filter: drop-shadow()` 交给合成器。

---

### [PB-05] 两个 canvas 是 `role="application"` 却不可聚焦、无键盘路径；`touch-action:none` 吞掉移动端滚动

- 严重级别：P1
- 分类：可访问性
- 位置：`src/components/sandbox/VerletLanyard.tsx:676-685`、`src/components/sandbox/FabrikCreature.tsx:1688-1698`
  ```tsx
  <canvas
    ref={canvasRef}
    className="drag-surface relative block h-full w-full select-none"
    style={{ touchAction: 'none' }}
    role="application"
    aria-label={t.sandbox.verletAria}
  />
  ```
- 现象与证据：
  1. 两处都**没有 `tabIndex`**，也没有任何 `onKeyDown` / `keydown` 监听（全文件 grep 无键盘处理）。`role="application"` 会让屏幕阅读器切换到应用模式、把后续按键交给页面——但页面此时拿不到焦点，等于把一个可交互控件声明成"应用"却无法到达。i18n 已经写好了描述性 aria（`zh.ts:212` 明确承诺"可拖拽…过度拉伸会扯断绳索"），承诺的能力对键盘用户全部不可用。
  2. `touch-action: none` 铺满整个 canvas（`h-full w-full`），而 Playground 里两块沙盒分别占 `52vh` 与 `48vh`（`Sections.tsx:165-166`），合计约 100vh：移动端用户若把手指落在沙盒上就无法滚动页面，只能瞄准卡片两侧 ~16px 的留白。`VerletLanyard.tsx:623-627` 另有 `touchmove` + `preventDefault` 兜底，进一步锁死。
  3. 指针捕获只在 VerletLanyard 做了（`:586 canvas.setPointerCapture`），FabrikCreature 的 `pointerdown` 无捕获——可接受（只点不拖），但两处行为不一致。
- 影响：键盘/开关设备用户完全无法使用这两个"卖点模块"；移动端存在"滚不动"的卡死体验，且这块正好是页面中段的第二个 section。
- 修改建议：
  ```tsx
  <canvas
    tabIndex={0}
    role="application"
    aria-label={t.sandbox.verletAria}
    aria-describedby="verlet-keys"
    onKeyDown={onKeyDown}          // ← 见下
    style={{ touchAction: 'pan-y' }}   // ← 允许纵向滚动，拖拽靠 pointermove 抢占
  />
  ```
  键盘映射（两个沙盒共用一份 hook）：方向键移动"虚拟指针"、`Space` 对 FabrikCreature 开火、`R` 触发 Re-forge、`Shift+方向键` 加力拖拽；同时在 HUD 里显示键位提示（`<p id="verlet-keys" className="sr-only">`）。`touch-action` 改为 `pan-y` 后，`onDown` 命中工牌时再 `e.preventDefault()` 即可阻止该次手势的滚动（现有 `onTouchMove` 已经这么做了，保留即可）。若坚持锁死滚动，请给沙盒加 `max-height: 60svh` 并在下方显式提供"展开"按钮。

---

### [PB-06] 渲染循环每帧分配 ≈ 750 个对象（文件头声称"绝不复制成新结构"）

- 严重级别：P1
- 分类：内存 / 性能
- 位置：`src/components/sandbox/VerletLanyard.tsx:1461-1462`、`:1577-1606`
  ```ts
  const fitted = l.points.map((p) => ({ x: p.x + jx, y: p.y + jy }))
  const segments = catmullRomToBezier(fitted, 0.5)
  ...
  for (let i = 0; i < marks; i++) {
    const p = sampleBezier(seg, localT)
    const q = sampleBezier(seg, Math.min(1, localT + 0.02))
    const r = sampleBezier(seg, Math.max(0, localT - 0.02))
  ```
- 现象与证据：每绳每帧：`map` 产生 1 数组 + 12 对象；`catmullRomToBezier`（`mathPhysics.ts:397-419`）产生 1 数组 + 11 个 `BezierSegment`；编织纹路 `marks = floor(totalLen/5.5)` ≈ 54，每处调用 3 次 `sampleBezier`，而 `sampleBezier`（`mathPhysics.ts:469-482`）每次都 `return { x, y }` → **162 对象**。合计 ≈ 185 对象/绳/帧 × 4 绳 ≈ **740 对象/帧 ≈ 44 000 对象/秒**，全部短命 → 每 1-2 秒一次 scavenge。对照 `mathPhysics.ts:11-16` 的自述「no arrays, objects or vectors are created inside the hot path」「never copied into fresh structures」——该承诺对 `step()` 成立（确实是零分配），对 `drawRope` 完全不成立。
- 影响：GC 抖动导致的掉帧正好落在火花/断裂最密集的时刻；移动端 V8 上 scavenge 是可见的 3-8 ms 停顿。同时这是 drawRope 每帧最慢的一环（54 次 × 3 次贝塞尔求值 + 54 次独立 stroke，见 PB-16）。
- 修改建议：
  - `sampleBezier` 增加出参版本 `sampleBezierInto(seg, t, out: {x,y})`，或直接内联成标量计算 `bezierAt(s, t): [x, y]` 的两个 number 变量。
  - `catmullRomToBezier` 增加 `into: BezierSegment[]` 复用缓冲（每绳一个，长度 11）。
  - drawRope 内用 `l.points` 直接构造 4 个 number 数组（或直接喂给 `traceBezierPath` 的变体），去掉 `fitted` 的 12 个对象。
  - `ctx` 级缓存：`const SEG_BUF: BezierSegment[] = []`（模块作用域，按需扩容，不 shrink）。

    ```ts
    export function bezierPointInto(s: BezierSegment, t: number, out: Vec2): Vec2 {
      const mt = 1 - t, a = mt*mt*mt, b = 3*mt*mt*t, c = 3*mt*t*t, d = t*t*t
      out.x = a*s.x0 + b*s.x1 + c*s.x2 + d*s.x3
      out.y = a*s.y0 + b*s.y1 + c*s.y2 + d*s.y3
      return out
    }
    ```

---

### [PB-07] README「全站唯一 requestAnimationFrame」与事实不符：实际 36 处 rAF，两个沙盒各有一套私有循环

- 严重级别：P2
- 分类：可维护性
- 位置：`README.md:85`、`src/components/sandbox/VerletLanyard.tsx:409-410`、`src/components/sandbox/FabrikCreature.tsx:1531-1532`、`src/components/layout/AudioSpectrumMeter.tsx:72-73`
  ```ts
  const frame = (now: number): void => {
    rafId = requestAnimationFrame(frame)
  ```
- 现象与证据：`src` 下 `requestAnimationFrame(` 共 **36 处调用，分布在 16 个文件**：`ScrollArchitecture3D`(8)、`BentoGrid`(3)、`useFpsMonitor`(3)、`VerletLanyard`(2)、`FabrikCreature`(2)、`AudioSpectrumMeter`(2)、`CardParticleCanvas`(2)、`TokenThroughputChart`(2)、`PerfTelemetryHud`(2)、`ScrollTelemetryHud`(2)、`useSectionProgress`(2)、`scrollEngine`(2)、`TerminalTyper`、`CommandPalette`、`BootSequence`、`commands.ts` 各 1。README:85 的「唯一 rAF」若指 R3F 主循环则成立，但读者会当成全局事实——而 `AudioSpectrumMeter.tsx:72-103` 就是一条毫无门控的常驻循环（只要声音开着就 60 Hz 读分析器，即使导航栏已滚出视口）。
- 影响：文档承诺与现实不符会直接误导性能优化方向（"只有一条循环，所以不用管帧预算"）；两个沙盒的循环各自复制同一套累加器/尺寸/门控逻辑，PB-02 必须改两遍，且顺序上先改哪个都会产生行为差异。`AudioSpectrumMeter` 的循环还独立于 any 门控，只要声音开启就 60 Hz 常驻（即使导航栏滚出视口）。
- 修改建议：① 文档改为「R3F 侧单循环 + 两个 2D 沙盒各自一条视口门控的循环」，并补一句它们共用 `useFixedStepSandbox`；② 落地 PB-01 第 6 步的共享 hook，把 `MAX_STEPS_PER_FRAME`、`dpr` 钳制、`lastTime` 复位、债务回收全部收敛到一处；③ `AudioSpectrumMeter` 包一层 `useInViewAnimation`，不可见时 `cancelAnimationFrame`。

---

### [PB-08] 断裂点定位用「绝对值应变」，与断裂判定用的「带符号应变」不是同一个量

- 严重级别：P2
- 分类：物理正确性
- 位置：`src/components/sandbox/VerletLanyard.tsx:947-963` vs `src/utils/mathPhysics.ts:260-278`
  ```ts
  // mathPhysics.ts:273 —— 判定用带符号应变
  const strain = (dist - c.restLength) / c.restLength
  ...
  // VerletLanyard.tsx:957 —— 定位断点却取了绝对值
  const strain = Math.abs(Math.hypot(dx, dy) - c.restLength) / c.restLength
  ``` 桥接在 `mathPhysics.ts:933`：`if (strain > BREAK_STRAIN) { this.snap(l); continue }`。
- 现象与证据：断裂规则只看**拉伸**（带符号，`> 2.5`），但 `spawnSnapArc` 用绝对值重算「最坏约束」，于是当一个被**压缩**到 0 长（绝对值应变 = 1.0，等价于拉长 1 倍）的段与一个被拉伸 2.6 倍的段同时存在时，两者的度量不可比；更常见的是：拖拽时靠近锚点的几段常被压到 `dist < L0`，闪电/断裂火花可能画在压缩段上，而真正撕裂的是另一端。另外 `snap()` 本身只报告计数不报告位置，所以这个「二次推导」是唯一来源。
- 影响：断裂特效落在错误节点——"绳索断开"的因果叙事在视觉上错位；`Math.hypot` 也比 `sqrt` 慢（在每断一次只跑一次，可忽略）。同时这违反「单一事实来源」：同一物理量在两处各算一遍。
- 修改建议：让 `mathPhysics` 直接返回断点，避免二次推导：
  ```ts
  // mathPhysics.ts
  export interface BreakInfo { index: number; strain: number; x: number; y: number }
  /** 返回最严重（拉伸）的约束；无则 index = -1。复用 out，零分配。 */
  export function measureMaxStrain(points, constraints, out: BreakInfo = { index: -1, strain: 0, x: 0, y: 0 }): BreakInfo
  ```
  `step()` 里 `const b = measureMaxStrain(l.points, l.constraints, l.breakInfo)`，`snap()` 把 `b.index/x/y` 存进 `LanyardState`；`spawnSnapArc` 直接读 `l.breakInfo`，删除那段 `Math.abs` 循环。

---

### [PB-09] `collideObb` 每次调用分配 8 元数组；且同一份 SAT 数学在渲染层被复制了一遍

- 严重级别：P2
- 分类：内存 / 可维护性
- 位置：`src/utils/mathPhysics.ts:294-343`
  ```ts
  // Face normals of each box.
  const axesX = [ca, sa, -sa, ca, cb, sb, -sb, cb]
  ...
  for (let k = 0; k < 4; k++) {
    const ax = axesX[k * 2]
    const ay = axesX[k * 2 + 1]
  ```
  副本：`src/components/sandbox/VerletLanyard.tsx:840-897`（`overlapObb`，用 `if (k===0) … else` 展开，注释自承「the solver's version allocates its eight axis components into an array on every call」）。
- 现象与证据：4 绳 = 6 个 pair，`step()` 每步每 pair 一次 → 60 Hz 下 360 个小数组/秒，且发生在 `LanyardSimulation` 里——该文件头（:11-16）同样承诺热路径零分配。更麻烦的是**两份同样的数学**：一份分配、一份不分配；一份用数组索引、一份用 switch 展开。任何一侧修正（法向取向、退化轴处理）都不会自动同步，而 `VerletLanyard` 的注释里明确要求「the maths is deliberately identical … so the two agree」——这种靠注释维持的一致性正是漂移的温床。
- 影响：与 PB-06 同类的 GC 噪声；维护上会在「火花法向与物理法向相反」时产生极难定位的 bug。
- 修改建议：删掉 `overlapObb`，让 `collideObb` 自身零分配（用标量三元组或 4 次直接计算，不建数组），并把 OBB 构造也内联，避免调用方再准备一份副本：
  ```ts
  export function collideObb(a: Obb, b: Obb, out: ObbHit): ObbHit {
    const ca = Math.cos(a.angle), sa = Math.sin(a.angle)
    const cb = Math.cos(b.angle), sb = Math.sin(b.angle)
    const dx = b.cx - a.cx, dy = b.cy - a.cy
    let minOverlap = Number.POSITIVE_INFINITY, nx = 0, ny = 0
    for (let k = 0; k < 4; k++) {
      const ax = k === 0 ? ca : k === 1 ? -sa : k === 2 ? cb : -sb
      const ay = k === 0 ? sa : k === 1 ? ca : k === 2 ? sb : cb
      /* … 与 overlapObb 完全相同的标量逻辑 … */
    }
    return out
  }
  ```
  渲染层改为调用同一个函数（入参 OBB 从 `LanyardState.tag` 现场填充到模块级 scratch，本来就有 `VFX_OBB_A/B`）。

---

### [PB-10] `FabrikCreature` 的 ResizeObserver 每次都重建两套 rig（含 640 槽粒子池），移动端地址栏收起即清空全部状态

- 严重级别：P2
- 分类：内存 / 性能
- 位置：`src/components/sandbox/FabrikCreature.tsx:1461-1482`
  ```ts
  const resize = (): void => {
    const rect = wrap.getBoundingClientRect()
    cssW = Math.max(1, Math.round(rect.width))
    cssH = Math.max(1, Math.round(rect.height))
    dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    ...
    armRef.current = createArm(cssW, cssH)
    creatureRef.current = createCreature(cssW, cssH)
    pointerRef.current = { x: cssW / 2, y: cssH * 0.35 }
  ```
  对比 `VerletLanyard.tsx:363-378`——那边用 `simRef.current.resize(cssW, cssH)` 保留状态，是对的。
- 现象与证据：`createArm`/`createCreature` 各自 `new VfxParticleEngine(640)`（`FabrikCreature.tsx:578`、`:676`），并重建 16 个 scorch、10+12 个 ripple 槽、所有关节与肌钟。ResizeObserver 在移动端浏览器地址栏收/放（±60px 高度变化）、软键盘、旋转、甚至 DevTools 打开时都会触发；每次都会：丢弃粒子与灼痕、把指针重置到画布中心（手臂下一次 solve 目标突变）、重新分配两个 640 槽对象池。
- 影响：一次地址栏收起 = 两次大对象池分配 + 屏幕上的火花/弹痕瞬间清空 + 机械臂甩向中心；在 iOS Safari 上下滑页面时每次都能复现。GC 压力与 PB-06 叠加。
- 修改建议：尺寸变化只做画布重设 + rig 的**相对**重定位，不重建：
  ```ts
  const resize = (): void => {
    const rect = wrap.getBoundingClientRect()
    const nextW = Math.max(1, Math.round(rect.width))
    const nextH = Math.max(1, Math.round(rect.height))
    if (nextW === cssW && nextH === cssH) return          // ← 关键：跳过无变化
    const sx = cssW ? nextW / cssW : 1
    cssW = nextW; cssH = nextH
    /* dpr / canvas.width / style 设置 */
    const arm = armRef.current
    if (arm) { arm.baseX = cssW / 2; arm.baseY = cssH - 46; arm.viewW = cssW; arm.viewH = cssH;
               arm.bounds.right = cssW; arm.bounds.bottom = cssH; scaleRigX(arm, sx) }
    else { armRef.current = createArm(cssW, cssH) }
    // creature 同理：spine/leg 位置按 sx 缩放，bounds 更新，粒子池与 scorch/ripple 保留
  }
  ```
  并给高度变化加阈值（`|Δh| < 8` 忽略），彻底避开地址栏抖动。

---

### [PB-11] 单向 Gauss-Seidel 扫描 + 末端硬 pin：误差系统性堆在锚点端，断点位置由扫描顺序而非物理决定

- 严重级别：P2
- 分类：物理正确性
- 位置：`src/utils/mathPhysics.ts:225-249`（固定 0→N-1 顺序）、`:216-223`（每轮先重贴 pin）
  ```ts
  for (let it = 0; it < iterations; it++) {
    if (pinIndex >= 0) { const pin = points[pinIndex]; pin.x = pinX; pin.y = pinY }
    for (let ci = 0; ci < constraints.length; ci++) {
      const c = constraints[ci]
      /* 每次都从锚点侧向 pin 侧推进 */
  ```
  断裂判定：`mathPhysics.ts:931-936`，`measureMaxStrain` 取 `strain > max` 即**第一个**最大值（`mathPhysics.ts:275`）。
- 现象与证据：pin 每轮被重新贴回目标位置，而约束按 0→10 顺序松弛，最后一轮最后处理的是 `constraints[10]`（贴近 pin 的那一段）——即误差在扫描方向上被"赶到"链的起点侧。结果是：拖拽时**总是靠近锚点的第 0-1 段最接近断裂阈值**，`measureMaxStrain` 取第一个最大值，断点因此稳定落在锚点附近（`spawnSnapArc` 又用绝对值重算一次，见 PB-08）。这不是"未定义顺序"（顺序是确定性的），但它是**由扫描方向决定的伪影**：把 `for` 改成倒序，断点会跑到另一端，而物理上完全等价。
- 影响：① 断裂位置不反映真实受载分布，"拉扯断裂"的观感永远是"从挂钩处断"；② 一旦有人改了 `SEGMENTS` 或 pin 位置，断点行为会跳到另一个位置，难以解释；③ 与 README:320「逐点修正 N=12 次」隐含的对称性不符。
- 修改建议：交替扫描方向（对称 Gauss-Seidel），代价零：
  ```ts
  for (let it = 0; it < iterations; it++) {
    if (pinIndex >= 0) { const pin = points[pinIndex]; pin.x = pinX; pin.y = pinY }
    if (it % 2 === 0) {
      for (let ci = 0; ci < constraints.length; ci++) solveOne(constraints[ci])
    } else {
      for (let ci = constraints.length - 1; ci >= 0; ci--) solveOne(constraints[ci])
    }
  }
  ```
  另外把 `measureMaxStrain` 的并列处理改为「取并列中 strain 最大且离 pin 最近者」，或在 `snap()` 里记录 `index` 供 HUD 显示，避免"同值取首"的隐含偏向。

---

### [PB-12] 持久化的 `soundEnabled=true` 会在非手势环境创建 AudioContext；且 `at: ctx.currentTime` 在冻结时钟上排 0 时刻事件 → 解锁瞬间齐发

- 严重级别：P2
- 分类：音频
- 位置：`src/utils/soundEngine.ts:676-693`
  ```ts
  const ctx = this.ensureContext()
  if (!ctx || !this.master) return null
  if (ctx.state === 'closed') return null
  // Scheduling while suspended is fine: `currentTime` is frozen, so the events
  // fire as soon as the resume lands.
  if (ctx.state === 'suspended') void ctx.resume()
  return { ctx, out: this.master, at: ctx.currentTime }
  ```
  触发链：`App.tsx:70` `soundEngine.setEnabled(soundEnabled)`（`setEnabled` 直接 `ensureContext()` → `new Ctor()`），而 `soundEnabled` 被持久化（`useAppStore.ts:370`）。
- 现象与证据：用户上一次开过声音 → 刷新页面 → store 从 localStorage 恢复 `true` → 挂载时的 effect 里 `setEnabled(true)` → **在没有任何用户手势的情况下 `new AudioContext()`**。此时的注释假设「frozen clock + 排队，稍后 resume 即可」，但每次 `begin()` 都返回 `at = 0`：hover tick（`duration 0.015`，`start(0)`/`stop(0.025)`）、碰撞音（0.15 s）、激光（0.42 s）全部锚在 t=0。一旦首个手势触发 `resume()`，这一批已经 `start()` 的源会在同一时刻起播——压缩器前瞬间叠 5-10 个瞬态，正是文档里说"要避免的 crackle"。Chrome 也会在控制台打出 "The AudioContext was not allowed to start"。
- 影响：首次交互时一声爆响/啸叫（最差的首次印象就出现在"点了第一下"）；控制台告警。这不影响"自动播放策略合规"（确实没在无手势时播放），但破坏了自家的限幅设计。
- 修改建议：
  ```ts
  // begin()：suspended 时不排事件，直接放弃这一声，等解锁后自然恢复
  if (ctx.state !== 'running') { void ctx.resume(); return null }
  return { ctx, out: this.master, at: ctx.currentTime }
  ```
  并让 `setEnabled(true)` 不在没有手势时创建 context：加一个 `unlocked` 标记，只有 `pointerdown/keydown/click` 之后才 `ensureContext()`；`setEnabled(true)` 之前仅记偏好。另外补上页面隐藏时挂起（现在全仓只有 `BootSequence`/`useFpsMonitor` 监听 `visibilitychange`，音频侧没有）：
  ```ts
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void ctx.suspend()
    else if (this.enabled) void ctx.resume()
  }, { passive: true })
  ```

---

### [PB-13] 自适应降档（DPR→1.0 / 粒子减半）不覆盖两个 2D 沙盒，而它们恰是页面上最贵的两段

- 严重级别：P2
- 分类：性能
- 位置：`src/components/sandbox/VerletLanyard.tsx:354-357`、`src/components/sandbox/FabrikCreature.tsx:1465-1466`
  ```ts
  // 1.5 rather than 2: this canvas is pure additive glow on a near-black
  // ground, where the extra density of a 2x buffer is invisible, but the
  // per-frame fill cost is 44% higher.
  dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  ```
- 现象与证据：`performanceTier` 的消费者只有 WebGL 组件（`SceneCanvas.tsx:207`、`AuroraCurtain`、`FlowFieldParticles`、`ScrollArchitecture3D`）与导航/HUD；两个沙盒**完全不读 store 的 tier**。降档触发条件是 `SceneCanvas.tsx:80 DEGRADE_FPS = 45` 的全页 FPS 均值——而压低这个均值的主要是沙盒（代码自己记录 A/B：卸载沙盒 121→144 fps）。结果：沙盒造成降档，降档却只削减 WebGL 的画质，DPR 仍是 1.5、`VFX_PARTICLE_CAPACITY` 仍是 640/512、`shadowBlur` 22 一层不减。
- 影响：低端设备上出现"两边都难看、还都不够快"；README:53 的「DPR 1.0 / 粒子减半」对读者承诺的正是沙盒参与降档。
- 修改建议：两个沙盒读 `const tier = useAppStore((s) => s.performanceTier)`，并把它当作渲染预算：
  ```ts
  const budget = tier === 'medium'
    ? { dpr: 1.0, particles: 256, shadow: false, weaveSpacing: 9 }
    : { dpr: Math.min(devicePixelRatio || 1, 1.5), particles: 640, shadow: true, weaveSpacing: 5.5 }
  ```
  `dpr` 变化时需要重设 canvas 尺寸（已有 resize 路径），`shadow: false` 时走 PB-04 的堆叠描边方案。建议顺带把 `MAX_STEPS_PER_FRAME` 在 medium 档降到 2。

---

### [PB-14] README/注释里的"实测数据"与代码常量对不上（5 处）

- 严重级别：P3
- 分类：可维护性
- 位置与逐条比对：

| # | 文档说法 | 代码事实 | 位置 |
|---|---|---|---|
| 1 | `ξ = 0.93 阻尼`（README:284） | `VELOCITY_DAMPING = 0.994` | `mathPhysics.ts:35` |
| 2 | 机械臂 `maxBend 100°`（README:361） | `ARM_MAX_BEND = (Math.PI * 95) / 180` | `FabrikCreature.tsx:52` |
| 3 | `four ropes (13 points each)`（文件头自述） | `SEGMENTS = 11` → 12 个点 | `mathPhysics.ts:38` / `:706-709` |
| 4 | `step() runs 360 times a second`（同段） | 60 Hz × 4 绳 = 240 次/秒 | `mathPhysics.ts:13` |
| 5 | 五个音色（README:79） | 6 个 voice（多 `renderLocaleConfirm`） | `soundEngine.ts:222` |

  另外 `a = g·γ + W(t)·ℓ + P(d)`（README:294-299）里的 `P(d)`（鼠标斥力 R=2.5 / 强度 34）在 `mathPhysics.ts` 中**完全不存在**——那是 `FlowFieldParticles` 的 curl-noise 参数被搬进了 Verlet 章节。
  ```ts
  /** Velocity retained per step. Verlet keeps velocity as position deltas. */
  const VELOCITY_DAMPING = 0.994
  ```
- 影响：0.93 与 0.994 相差 0.994⁶⁰ ≈ 0.70 与 0.93⁶⁰ ≈ 0.013 的每秒衰减——按文档值，绳索会在 1 秒内完全静止，任何人照 README 复现都会得到"死掉的绳子"，从而怀疑整套实现。100°/95° 会让读代码的人以为锥约束没生效（HUD 显示 `cone=±95°`）。
- 修改建议：把「实测数据」改为可复现的推导值并统一常量来源（README 只引用常量名，不抄数字）：
  - `VELOCITY_DAMPING = 0.994`，注释里写清 `每秒保留 = 0.994^60 ≈ 0.70`；
  - 机械臂锥统一为 95°（与 `ARM_MAX_BEND` 一致，`fabrik.ts` 的 `DEFAULT_MAX_BEND = 100°` 是**从未被使用的死默认**，两个调用方都显式传值——见"其他小问题"）；
  - `SEGMENTS = 11` → 12 点，删掉 `360 次/秒`；
  - README:79 补第 6 个音色 `localeConfirm`；
  - 删除 `P(d)` 那一行，或注明"该式属 §6 curl-noise 章节"。
  - `BREAK_STRAIN = 2.5`（README:335 一致 ✓）、`2.501` 是实测峰值而非常量 ✓、膝盖 `65.5px / 23px` 的推导复算正确（`√(38²+46²−2·38·46·cos102°) = 65.47`；`cos30° → 23.08`）✓ —— 这四处**一致**，无需修改。

---

### [PB-15] 热路径上的小分配与每帧字符串/字体操作（`stanceFor`、`applyGrab`、`split`、`ctx.font`）

- 严重级别：P3
- 分类：性能
- 位置：`src/components/sandbox/FabrikCreature.tsx:1397-1409`、`src/utils/mathPhysics.ts:961-975`、`src/components/sandbox/VerletLanyard.tsx:1932-1952`
  ```ts
  function stanceFor(hip, dirX, dirY, side): { x: number; y: number } {
    const perpX = -dirY * side
    const perpY = dirX * side
    return { x: hip.x + perpX * LEG_SPREAD + dirX * STRIDE_LEAD, ... }
  }
  ```
- 现象与证据：`stanceFor` 在 `stepCreature` 里每固定步调用 4 次（lag 计算）+ 最多 2 次（起摆）→ ~360 个对象/秒；`applyGrab`（`mathPhysics.ts:974`）每次拖拽步 `return { x, y }`；`drawTag` 每帧每工牌 `l.label.split(' ')` + `words.slice(0,mid).join(' ')`（:1939-1946）以及 2 次 `ctx.font = ...` 字符串赋值（:1932、:1938，每次都触发字体串解析）；换行判据是 `l.label.length > 15` 而**从不 `measureText`**。
- 影响：与 PB-06 相比量级很小（拖拽时才有），但同属"注释承诺零分配、代码实际分配"；字体串 / 字符串拼接在 4 个工牌 × 60 Hz 下也是稳定的常量开销。换行靠字符数会让中文/长词标签溢出 132px 的牌面（当前 4 个英文标签恰好没触发）。
- 修改建议：`stanceFor` 改为 `stanceInto(hip, dirX, dirY, side, out)`（复用 `leg` 上的 scratch 字段 `_sx/_sy`）；`applyGrab` 直接把结果写进 `l.pinX/pinY` 字段而不是返回对象；标签换行在**建工牌时**算一次并缓存到 `LanyardState`（`labelLines: string[]`），`ctx.font` 只在 change 时设置（用 `if (ctx.font !== FONT_BODY)` 守卫，或每帧设置一次而不是每个工牌两次）。

---

### [PB-16] 逐笔 `stroke()`：编织纹 54×4、拉丝纹 34×4 各自 `beginPath`，每帧约 450 次描边调用

- 严重级别：P3
- 分类：性能
- 位置：`src/components/sandbox/VerletLanyard.tsx:1577-1606`（编织纹）、`:1906-1911`（拉丝纹）
  ```ts
  for (let i = 0; i < marks; i++) {
    ...
    ctx.beginPath()
    ctx.moveTo(p.x - nx * half, p.y - ny * half)
    ctx.lineTo(p.x + nx * half + ..., p.y + ny * half + ...)
    ctx.stroke()
  }
  ```
- 现象与证据：`marks = floor(bezierPathLength(segments)/5.5)` ≈ 54 处/绳 → 4 绳 = 216 次 `stroke()`；工牌拉丝 `for (let i = -hh; i < hh; i += 2.5)` = 34 条/工牌 → 4 工牌 = 136 次；加上绳索 8 层 × 4 绳 = 32 次、clasp/tag 各自 8-10 次（约 70 次），**每帧 ≈ 450 次独立描边**。canvas 2D 每次 `stroke()` 都是一次独立的路径提交与光栅化批次，无法与下一条合并。
- 影响：在 PB-04 的模糊层之外，这是第二大的每帧固定开销；同一路径本可合成一次绘制。
- 修改建议：把同类笔画合并成单条路径、单次描边（样式相同即可）：
  ```ts
  ctx.beginPath()
  for (let i = 0; i < marks; i++) {
    /* … 计算 p/nx/ny … */
    ctx.moveTo(p.x - nx * half, p.y - ny * half)
    ctx.lineTo(p.x + nx * half + ..., p.y + ny * half + ...)
  }
  ctx.stroke()          // 216 次 → 4 次
  ```
  工牌拉丝同理（34 → 1）。若担心抗锯齿叠加，可保留 2 次（奇偶交替两类斜向）。

---

### [PB-17] 数值健壮性补丁缺失：无 NaN 看门狗、退化约束永久卡死、FABRIK 死默认与 `maxIterations=0` 边界

- 严重级别：P3
- 分类：物理正确性
- 位置：`src/utils/mathPhysics.ts:233-238`、`src/utils/fabrik.ts:73-76`、`fabrik.ts:171-172`、`fabrik.ts:277-280`
  ```ts
  const distSq = dx * dx + dy * dy
  if (distSq < 1e-9) continue          // ← 直接跳过，不解开退化
  ...
  for (; iterations < maxIterations; iterations++) { ... }
  out.converged = error <= tolerance   // ← maxIterations === 0 时用的是"未求解前"的 error
  ```
- 现象与证据：
  1. `fabrik.ts:238-243` 在两点重合时会把两点**推开**（"Nudge them apart so the next pass has something to work with instead of producing NaN"），而 `mathPhysics.relaxConstraints` 遇到同样情况只是 `continue` —— 该段永远不会被拉回 `restLength`，且 `measureMaxStrain` 会报 `strain = (0−27)/27 = −1`（负数不触发断裂，静默失效）。两条链对同一退化输入的处理不一致。
  2. 全程没有 NaN/Infinity 哨兵：一旦任一 `VerletPoint.x` 变成 NaN（例如未来加入除零、或 dev 钩子传入 `dt=0`），`integratePoints` 会让它永久 NaN，`drawRope` 生成非法 path 命令 → 绳索静默消失，只能靠 Re-forge 恢复，且没有任何日志。
  3. `fabrik.ts` 的 `DEFAULT_MAX_BEND = 100°` / `DEFAULT_MAX_ITERATIONS = 12` 从被调用方看是**死默认**：`FabrikCreature.tsx:847-851` 传 `maxBend: 95°, maxIterations: 18`，`:1296-1302` 传 `maxBend: 150°, maxIterations: 8`。文档「Default is 100°, which permits a natural elbow」因此永远不生效（也是 PB-14 第 2 条的根因）。
  4. `maxIterations = 0` 时 `converged` 由求解前的 `error` 决定，可能返回 `converged: true` 而关节从未被扫过一次；`unreachable` 分支则完全跳过 `applyAngleConstraints`，返回的 `error = targetDist − reach` 与可达分支的 `error`（tip 残差）语义不同——HUD 直接把它当 "err" 显示（`FabrikCreature.tsx:1601`）。
- 影响：当前为潜伏问题（生产中不触发），但每一条都会在"扩展沙盒"时变成难查的静默失败。
- 修改建议：① `relaxConstraints` 的退化分支改为与 FABRIK 一致地沿 `+x` 推开 `restLength`；② 在 `LanyardSimulation.step()` 末尾加一句廉价的看门狗（每 30 步检查一次即可）：
  ```ts
  private nanGuardTick = 0
  private guardNaN(): void {
    if (++this.nanGuardTick % 30) return
    for (const l of this.lanyards) for (const p of l.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { this.reforgeFromSpecs(); return }
    }
  }
  ```
  ③ 把 `DEFAULT_MAX_BEND` 删掉或改为 `95°` 并在 README 对齐；④ `solveFABRIK` 加 `if (maxIterations <= 0)` 直接返回未收敛；⑤ `unreachable` 时把 `error` 明确为 `targetDist − reach` 并由 HUD 用不同字段（如 `shortfall`）显示。

---

## 其他小问题（不单独编号，按可照做程度排序）

1. **DEV 专用时钟覆盖 `__rdTime`**：`drawRope` 的过载抖动按 `time*47.3` 等频率采样，而 `time` 在沙盒不可见时暂停（`timeRef` 只在 `step()` 内增长），所以回屏后抖动相位连续、不会跳变——这点实现是对的；但 `renderTime()` 在 DEV 下会被 `window.__rdTime` 覆盖（`VerletLanyard.tsx:1259-1265`），建议注释里点明"仅 DEV、仅用于验证"。
2. **`reportPhysicsSolve` 的迭代计数用了魔法数 11**：`steps * RELAXATION_ITERATIONS * (sim.lanyards.length * 11)`（`VerletLanyard.tsx:490`），11 是 `mathPhysics` 私有的 `SEGMENTS`。应从 `mathPhysics` 导出 `SEGMENTS`（或 `constraintCount`），否则改段数后 HUD 的"约束迭代数"会撒谎。
3. **`steps < 4` 魔法数**：`FabrikCreature.tsx:1554` 直接写 4，而 `VerletLanyard.tsx:67` 有 `MAX_STEPS_PER_FRAME`。两处应共用常量（PB-01 的共享 hook 一并解决）。
4. **`drawSandbox` 的 `void height`**（`VerletLanyard.tsx:1291`）：参数未使用，直接删参。
5. **`AudioSpectrumMeter` 的频段包含 DC bin**：`readSpectrum` 的 band 0 下界 `floor(20/86) = 0`，把 bin 0（DC/极低频）算进了 teal 柱（`soundEngine.ts:606`）。建议 `Math.max(1, ...)`，否则低频柱在静音时也可能被 DC 偏置顶起。
6. **`readEnergy()` 的缓冲区来源与 `readSpectrum()` 不对称**：前者用 `analyser.fftSize`（512，时域）分配 `timeScratch`，后者用 `frequencyBinCount`（256，频域）分配 `spectrumScratch`——两者语义都对、都是"分配一次之后零分配"，只是读起来容易误以为有重复分配。它被 `AuroraCurtain.tsx:535` 与 `FlowFieldParticles.tsx:840` 消费（音频反应层），并非死代码。
7. **`dispose()` 的结论**：确实 `ctx.close()` 并清空引用（`soundEngine.ts:504-518`），一次性 `Oscillator/Gain/Biquad` 在 `stop()` 后由浏览器回收，**不存在节点累积**——这条审查项通过，不需要改。
8. **工牌文案硬编码英文**：`LANYARD_SPECS` 的 `label` 是 `'AI Architecture'` 等英文（`VerletLanyard.tsx:59-64`），而 HUD 文案走 i18n。中文界面下工牌仍是英文，建议把 label 改为 i18n key（`t.sandbox.lanyardLabels`），或在 `buildLanyard` 时注入翻译后的字符串。
9. **调试叠层文案未 i18n**：`FABRIK err=… iter=…`、`cone=±95°`、`|v| = … px/s` 是硬编码英文（`FabrikCreature.tsx:2437-2447`、`:2663-2675`），而触发它的复选框标签已 i18n（`zh.ts:229 fabrikShowVectors`）。调试面板本身**在生产构建中保留**（`import.meta.env.DEV` 只包住了 `window.__fabrik`/`window.__lanyardSim`，见 `VerletLanyard.tsx:385`、`FabrikCreature.tsx:1493`）——若"显示 IK 向量"是产品功能，那么叠层文案应一起 i18n；若要裁产物体积，应在 `debug` 为 false 时用 `if (import.meta.env.DEV)` 包住 `drawArmDebug`/`drawCreatureDebug` 的调用与三个绘图原语（约 190 行）。
10. **触屏指针捕获**：`VerletLanyard` 的 `setPointerCapture` 在 `pointerdown` 命中工牌后调用（`:586`）、`onUp` 里先 `hasPointerCapture` 再 release——符合规范（`releasePointerCapture` 在 pointerId 已失效时会抛 `NotFoundError`，这个守卫是必要的）。不一致的是 `FabrikCreature` 既无捕获也无 `pointercancel`：它只在 down 时开火、没有需要清理的拖拽状态，可接受，但建议补一个 `pointercancel` 空处理以对齐两个沙盒的行为。
11. **`wheel`/`contextmenu`**：两个沙盒都未阻止右键菜单，拖拽时右键会弹菜单并让 `pointerup` 丢失（`pointercancel` 已兜底）。加 `onContextMenu={e => e.preventDefault()}` 可避免拖拽被打断。
12. **`snap()` 里的 `Math.random()`**：`t.angularVelocity += (Math.random() - 0.5) * 4.5`（`mathPhysics.ts:1042`）让同一次拖拽的断裂结果不可复现。断裂是事件点、不是每帧路径，可接受；但若要做回归/录屏对比，建议改成由应变与断点位置推导的确定性值（`(breakStrain - BREAK_STRAIN) * k`）。同类问题还有 `spawnScorch` / `spawnSnapArc` 的 `Math.random()`，它们只在生成时取一次并缓存进池槽，属于正确用法。
13. **`fabrik.ts` 的 `chainLength` 在 `stepArm` 每步调用两次**（`FabrikCreature.tsx:830`、`:2444`），每次遍历 6 个长度——可忽略，但 rig 上缓存一个 `reach` 字段更整洁。

---

## 附：按"要不要现在做"排序的建议

1. **PB-02 + PB-03**（一个共享 `useFixedStepSandbox`，两处删重复）：直接决定"高刷是否丝滑 / 低端是否漂移"，且改动集中、可回归验证（写死 FPS 节流后对比 `timeRef` 与墙钟）。
2. **PB-04 + PB-16**（删 `shadowBlur`、缓存渐变、合并笔画）：预计是本页最大的单点帧时间收益，且纯渲染层、不改物理。
3. **PB-05**（tabIndex + 键盘 + `touch-action: pan-y`）：一行 CSS + 一个 keydown 即可解除移动端滚动锁死与键盘不可用。
4. **PB-06 + PB-09**（零分配化绘制与 SAT）：消除 GC 抖动，顺手统一两份 OBB 数学。
5. **PB-01**（拆分）：在 1-4 之后做，因为那时循环与绘制已经被抽走，拆分冲突面最小；顺序按 PB-01 里的 7 步。
6. **PB-08 + PB-11**（断点单一事实来源 + 对称扫描）：物理观感修正，需要人工目视验证一次。
7. **PB-12 + PB-13**（音频排期与降档接线）：产品体验，改动小但需要真机验证（iOS 解锁时机、低端机帧率）。
8. **PB-14**（文档对齐）：纯文档，但直接影响可信度——建议与 0.93/100° 这两处一起改，避免下一位维护者照着错的数重复现。
