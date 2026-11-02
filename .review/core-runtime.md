# core-runtime 审查报告

审查范围：`src/App.tsx`、`src/main.tsx`、`src/components/canvas/{Scene,SceneCanvas,CameraRig}.tsx`、`src/lib/*.ts`、`src/hooks/*.ts`、`src/store/useAppStore.ts`、`src/components/layout/{SmoothScroll,ScrollTelemetryHud,PerfTelemetryHud,AudioSpectrumMeter,BootSequence,ClickRipple}.tsx`、`src/config/*.ts`、`src/types/index.ts`。

方法说明：只读审查，未启动 dev server、未修改任何 `src` 源码。凡涉及第三方库行为的判断均直接查证了本仓库安装的源码（`@react-three/fiber@9.8.2`、`lenis@1.3.x`、`@react-three/drei`、`@react-three/postprocessing`），行号可复核；仍无法静态确定的标注「需实测」。

## 总体判断

「单主时钟」在 `scrollEngine → writeScroll → advanceR3F` 这一段是成立的，`frameloop="never"` + 同帧同时间戳的设计也确实避免了 DOM/WebGL 差帧。但这条原则只被贯彻到“三处”中的两处：

1. **时钟原点不是 per-root**（CR-01）：`advance()` 是全局的，`setCanvasActive(true)` 却重置全局原点，导致后挂载的画布把先运行画布的时钟打回 0 —— 这是 P0。
2. **app 内还存在 4 类独立 rAF**（CR-05 及其它小节），`useSectionProgress` 的 rAF 甚至注册在主时钟之前，于是章节 DOM 覆盖层恒定慢一帧。
3. **质量降级/画布注册这类“状态机”缺少成对性校验**（CR-02、CR-06）：失败时是静默的（WebGL 冻结、用户被永久降级），没有 DEV 断言。

# 发现

### [编号 CR-01] `setCanvasActive(true)` 重置全局时钟原点，把已运行画布的 `clock.elapsedTime` 打回 0（负 delta + 着色器时间跳变）
- 严重级别：P0
- 分类：正确性 / 架构
- 位置：`src/lib/frameBridge.ts:65-76`、`src/lib/frameBridge.ts:93-104`
```ts
export function setCanvasActive(active: boolean): void {
  if (active) {
    activeCanvases += 1
    // A newly mounted canvas must not inherit another canvas' clock origin.
    // Resetting here means the first delta after a mount is ~0 for every root.
    originMs = null
    lastSeconds = 0
  } else {
```
```ts
  if (originMs === null) {
    originMs = timestampMs
  }
  const elapsed = Math.max(0, (timestampMs - originMs) / 1000)
```
- 现象与证据：`advanceR3F` 调用的 R3F `advance()` 是**全局**的，会遍历 `_roots` 里的每一个 root 并调用 `update()`（已查证 `node_modules/@react-three/fiber/dist/events-e51d7528.esm.js:17616-17620`：`if (!state) for (const root of _roots.values()) update(timestamp, root.store.getState())`）。而 `update()` 在 `never` 模式下的 delta 计算是 `delta = timestamp - state.clock.elapsedTime`，**没有负数保护**（同文件 `:17523-17527`）：
  ```js
  if (state.frameloop === 'never' && typeof timestamp === 'number') {
    delta = timestamp - state.clock.elapsedTime;
    state.clock.oldTime = state.clock.elapsedTime;
    state.clock.elapsedTime = timestamp;
  }
  ```
  于是：背景画布先挂载并已经跑了 `E` 秒（`elapsedTime = E`），随后架构画布（`ScrollArchitecture3D` 是 lazy，`ArchitectureNarrative` 里懒加载，必然晚于或早于背景画布解析）`onCreated` → `setCanvasActive(true)` → `originMs = null`，下一帧 `advanceFn(0)`，背景 root 收到 `delta = 0 - E = -E`，同时 `elapsedTime` 被写成 `0`。这个 reset 是无条件发生的，只要两个画布不在同一帧挂载就必然触发（常态）。
- 影响：
  - 负 delta 会进入所有 `useFrame`。`CameraRig`/`FlowFieldParticles`/`AuroraCurtain`/`CursorStardustTrail`/`VolumetricStageLights` 都有 `if (!(dt > 0)) return` 兜住（`CameraRig.tsx:71`、`FlowFieldParticles.tsx:719` 等），但 **`DynamicChromaticAberration` 没有**（`SceneCanvas.tsx:164-184`，`dt < 0` 时 `current += (target-current)*min(1, dt*7)` 会朝反方向走）。
  - 更明显的是 `clock.elapsedTime` 归零：`AuroraCurtain.tsx:524`、`VolumetricStageLights.tsx:557`、`CursorStardustTrail.tsx:763`、`FlowFieldParticles.tsx:727`、`ScrollArchitecture3D.tsx:1023/1225` 都直接把它当 `uTime`。极光/星云的程序化相位会**跳回 t≈0**，即用户看到一次图案“重排/闪一下”。这个时机恰好落在 boot 后 1–3 秒，冷启动时被 boot 幕布遮住，弱网/慢 chunk 时会被看见。
  - 该缺陷同时是整个「同一个时间戳」承诺的漏洞：时间戳一致，但**时钟基准不一致**。
- 修改建议：把时钟簿记从“全局”改成“per-root”，`advance()` 本来就支持传 state：
  1. `setCanvasActive` 改为接收 root state 并做 per-root 记录：
     ```ts
     type Tracked = { state: unknown; originMs: number | null; lastSeconds: number }
     const roots = new WeakMap<object, Tracked>()   // key = RootState
     export function registerRoot(state: object) { roots.set(state, { state, originMs: null, lastSeconds: 0 }) }
     export function unregisterRoot(state: object) { roots.delete(state) }
     ```
  2. `advanceR3F(ms)` 里逐个 root 计算自己的 `elapsed/last`（沿用现有 `MAX_DELTA_SECONDS` 钳制），并且**只给第一个 root 打开 globalEffects**，避免 drei 的全局 effect 一帧跑 N 次：
     ```ts
     let first = true
     for (const t of roots.values()) {
       if (t.originMs === null) t.originMs = ms
       const elapsed = Math.max(0, (ms - t.originMs) / 1000)
       const clamped = Math.min(elapsed, t.lastSeconds + MAX_DELTA_SECONDS)
       t.lastSeconds = clamped
       mod.advance(clamped, first, t.state as never)   // 只有第一个传 true
       first = false
     }
     ```
     `onCreated` 里把 `({ gl, scene, camera })` 换成 R3F 的 `useThree` state（`onCreated` 的参数就是 state，直接透传即可）。
  3. 若暂时不想改 API：至少**不要**在 `setCanvasActive(true)` 里重置 `originMs`，改为只在 `activeCanvases === 0` 时重置，并接受“新画布首帧 delta 偏大”的代价（对空场景无副作用）——但这样就无法消除 CR-10 的空转渲染，推荐方案 1。

---

### [编号 CR-02] 画布计数 `+1` 来自 R3F 内部 `onCreated`、`-1` 来自 React 无条件下清理，配对不对称；归零即全站 WebGL 静默冻结
- 严重级别：P1
- 分类：架构 / 正确性
- 位置：`src/lib/frameBridge.ts:72-76`、`src/components/canvas/SceneCanvas.tsx:218`、`src/components/canvas/SceneCanvas.tsx:344`
```ts
  } else {
    // Never go negative: a double-unmount (StrictMode) would otherwise leave the
    // counter permanently below zero and freeze every future canvas.
    activeCanvases = Math.max(0, activeCanvases - 1)
  }
```
```tsx
  // Safety net: if this canvas unmounts, stop advancing it.
  useEffect(() => () => setCanvasActive(false), [])
```
- 现象与证据：`+1` 发生在 `onCreated` 里，而 `onCreated` 是 R3F **内层 reconciler 的 `Provider` 的 layout effect** 调用的（已查证 `node_modules/@react-three/fiber/dist/events-e51d7528.esm.js:17402-17412`，`useIsomorphicLayoutEffect(..., [])` 内 `if (onCreated) onCreated(state)`）；`-1` 发生在业务组件的 **passive effect cleanup**，且**完全无条件**——即使这个画布从未走到 `onCreated`（`webgl === false` 时 `<Canvas>` 根本不渲染，见 `SceneCanvas.tsx:306`），cleanup 一样会执行。
  因此只要出现“某画布 init 失败/提前卸载/StrictMode 下 root 未被重建”，`activeCanvases` 就会少 1；而 `Math.max(0, …)` 把下溢藏起来，`advanceR3F` 的 `if (activeCanvases <= 0) return` 会让**另一个健康画布**停止推进——页面不报错，WebGL 只是静止不动。这是最难受的失效模式：无任何信号。
  StrictMode 下当前顺序（挂载 layout 建 root → `onCreated` +1 → 模拟卸载 passive cleanup −1 → 重挂 layout 再建 root → +1）看起来是配平的，但“重挂时 R3F 是否重建 root / 是否再次触发 `onCreated`”取决于 R3F 内部 root 复用（同文件 `:17256`、`:17304` 的 `prevRoot` 分支），**需实测**。无论结果如何，“计数正确性依赖第三方内部生命周期恰好成对”本身就不该承担。
- 影响：任一路径失衡 → 背景星云/架构 3D 全站静止，且 HUD 只显示 `0 / 0`（见 CR-10），没有控制台错误可循，排查成本极高。
- 修改建议（任选其一，推荐 2）：
  1. 最小改动：把 `+1` 也搬到与 `-1` 同一个 React 生命周期里，用 `gl` 是否存在做前提，并加 DEV 断言：
     ```tsx
     useEffect(() => {
       if (!webgl) return
       setCanvasActive(true)      // strict 模式下成对调用，天然配平
       return () => setCanvasActive(false)
     }, [webgl])
     ```
     （需要确认 `<Canvas>` 已由 R3F 自身完成 root 创建；`webgl` 变 true 后的被动 effect 晚于 `onCreated`，语义上等价。）
  2. 采用 CR-01 的 per-root 方案后，这个计数器可以直接删掉：root 的注册/注销由 `onCreated` + `useThree` 的 `gl.domElement` 生命周期绑定，不再存在“计数”这个二值闸门。
  3. 无论哪种，都加一条 `if (import.meta.env.DEV && activeCanvases > document.querySelectorAll('canvas').length) console.error(...)` 之类的诊断。

---

### [编号 CR-03] `App` 在渲染期调用 `supportsWebGL()`：每次重渲染都新建一个 canvas + WebGL 上下文且从不释放
- 严重级别：P1
- 分类：性能 / 内存
- 位置：`src/App.tsx:33-37`、`src/lib/device.ts:25-37`
```tsx
function App() {
  useSectionObserver(SECTION_IDS)
  const webgl = supportsWebGL()
  const soundEnabled = useAppStore((state) => state.soundEnabled)
  const accentTheme = useAppStore((state) => state.accentTheme)
```
```ts
export function supportsWebGL(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl'),
    )
```
- 现象与证据：`supportsWebGL()` 每次调用都 `createElement('canvas')` 并真取一个 WebGL 上下文；探测完既没有 `WEBGL_lose_context.loseContext()`，也没有把 canvas 挂到文档里以便回收。而 `App.tsx:35` 把它放在**函数体（渲染期）**，所以 `App` 每次重渲染都会再漏一个：切换 accentTheme（44-50 行订阅）、切换 soundEnabled（36 行）、`useSectionObserver` 之外的 state 变化都会触发。此外 `SceneCanvas.tsx:213`、`ScrollArchitecture3D.tsx:1650` 各再探一次，启动阶段就至少 3 个上下文。
- 影响：Chrome 对同一页面有活跃 WebGL 上下文数量上限（通常 16 个左右，且这是**全局**预算，跨标签页共享）。反复切主题/语言/音效会让上下文数量缓慢增长；一旦触顶，浏览器的策略是踢掉最旧的上下文（往往就是正在渲染的那个），表现为画布变黑且不报错。低端 Android/iOS 上单次上下文创建本身也有几十毫秒成本。这是典型的“渲染期副作用”，React 严格模式下还会翻倍。
- 修改建议：
  ```ts
  // src/lib/device.ts
  let webglSupport: boolean | null = null
  export function supportsWebGL(): boolean {
    if (webglSupport !== null) return webglSupport
    if (typeof window === 'undefined') return false
    try {
      const canvas = document.createElement('canvas')
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGL2RenderingContext | null
      webglSupport = Boolean(gl)
      gl?.getExtension('WEBGL_lose_context')?.loseContext()   // 立刻归还上下文
    } catch { webglSupport = false }
    return webglSupport
  }
  ```
  同时把 `App.tsx:35` 改成惰性初值：`const [webgl] = useState(supportsWebGL)`（或干脆只在 `SceneCanvas` 内部判断，`App` 不渲染占位 `div` 也行——现在是多包了一层空 div）。

---

### [编号 CR-04] `pointermove` 热路径上做 `querySelector('canvas')` + `getBoundingClientRect()`，并把 NDC 绑死“文档里第一个 canvas”
- 严重级别：P1
- 分类：性能 / 正确性
- 位置：`src/store/useAppStore.ts:197-213`、`src/lib/pointerInput.ts:51-57` 与 `:118-125`
```ts
export function writePointer(clientX: number, clientY: number): void {
  // The render canvas is the authority for the projection box.
  const canvas =
    typeof document !== 'undefined' ? document.querySelector('canvas') : null
  const rect = canvas?.getBoundingClientRect()

  const left = rect?.left ?? 0
  const top = rect?.top ?? 0
  const width = rect && rect.width > 0 ? rect.width : (window.innerWidth || 1)
```
- 现象与证据：`push()` 在每次接受的 `pointermove / pointerdown / touchmove / touchstart` 上都会走到 `writePointer`，也就是**每个输入事件一次全文档 `querySelector('canvas')`（遍历整棵 DOM 树）+ 一次 `getBoundingClientRect()`（可能触发样式重算）**。而同一帧里 `useSectionProgress`（`ArchitectureNarrative` 的 `onProgress`）会写多个元素的 `style.opacity/transform`（`ArchitectureNarrative.tsx:235-275`），这些写操作会把样式标记为脏；紧随其后的指针事件读 `rect` 就是一次真实的强制重算。整套逻辑只为了拿到“canvas 的宽高和偏移”，而它是固定的（`!fixed !inset-0`，永远 `0,0,innerWidth,innerHeight`）。
  另外 `querySelector('canvas')` 取的是**文档顺序第一个 canvas**：现在恰好是背景画布（`App.tsx:126` 在 `<main>` 之前），但这个隐含契约没有任何保护——一旦架构画布被提前挂载（例如以后改成 `#architecture` 深链先挂），NDC 就会按架构画布的 rect 归一化，射线/鼠标视差全偏。
- 影响：240Hz 鼠标 + 120Hz 屏幕下每秒 120+ 次 DOM 查询与布局读，在低端机上直接吃掉主线程预算；同时这是一个随时会被“无关改动”打破的隐式契约。
- 修改建议：
  1. 把测量结果缓存成模块级可变对象，只在 resize/字体加载/`resizeScroll()` 时刷新：
     ```ts
     let box = { left: 0, top: 0, width: 1, height: 1, valid: false }
     export function invalidatePointerBox() { box.valid = false }
     function ensureBox() {
       if (box.valid) return box
       const rect = canvasRef?.getBoundingClientRect() // 由 SceneCanvas 注册的表元素，而不是 querySelector
       ...
     }
     ```
  2. 更彻底：`SceneCanvas` 在 `onCreated` 里把 `gl.domElement` 注册到 `pointerInput`（`writePointer` 改用该元素），并把“每帧最多读一次 rect”放进主时钟（`onScrollFrame` 里刷新），事件里只写坐标。
  3. 明确注释“NDC 基准 = 背景画布”，并用一个 `setPointerFrameElement(el)` 取代 `querySelector`，避免隐式依赖 DOM 顺序。

---

### [编号 CR-05] `useSectionProgress` 自带 rAF 且注册早于主时钟：章节 DOM 覆盖层恒定落后 3D 一帧
- 严重级别：P1
- 分类：架构 / 正确性
- 位置：`src/hooks/useSectionProgress.ts:78-107`、`src/hooks/useSectionProgress.ts:123`
```ts
    const loop = (): void => {
      rafId = requestAnimationFrame(loop)
      if (!running || !visible) return
      measure()
    }
```
```ts
    rafId = requestAnimationFrame(loop)
```
- 现象与证据：`loop` 每帧无条件重新调度（即使 `visible === false`），构成**永久存在的第二个 rAF 循环**；`measure()` 里读 `el.getBoundingClientRect()`（`:88`）并回调写入 8+ 个 DOM 元素的 style（`ArchitectureNarrative.tsx:228-278`）。
  关键的顺序问题：React 的 passive effect 是**子先父后**执行的。`SmoothScroll` 是 `App` 的子组件，`ArchitectureNarrative` 是 `SmoothScroll` 的后代，因此 `useSectionProgress` 的 effect **先于** `SmoothScroll` 里 `createScrollEngine()` 的 effect 运行（`SmoothScroll.tsx:30`），于是它的 `requestAnimationFrame` **先注册**。同一帧内 rAF 回调按注册顺序执行（HTML 规范行为），所以每帧的顺序是：
  ```
  measure() 读 rect  ← 读到的是上一帧的滚动位置
  lenis.raf(time)    ← 本帧才真正写 scroll
  publish/advanceR3F
  ```
  结果：架构章节里 sticky 面板的 DOM 文字层永远按 frame N−1 的进度定位，而同一画布里的 3D 相机按 frame N 定位 —— 快速滚动时两者会有可感知的 1 帧错位（正是「single clock」文档承诺要消除的东西，`scrollEngine.ts:9-16`）。
- 影响：300vh 架构章节的所有 DOM 动效（标题淡入、层标签、caption 切换、指标卡滑入）相对 3D 模型恒定滞后一帧；快速滚动/120Hz 下错位约 8ms 以上且随滚动速度放大观感。同时多一个永远跑着的 rAF（不在视口内也每帧空转 + 重排调度）。
- 修改建议：删掉自建 rAF，改成主时钟的订阅者：
  ```ts
  useEffect(() => {
    const el = sectionRef.current
    if (!el || !enabled) return
    let visible = false
    const measure = () => { /* 原逻辑 */ }
    const unsubscribe = onScrollFrame(() => { if (visible) measure() })   // 与 lenis.raf 同帧、在 publish 之后
    const observer = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) measure() }, { rootMargin: '20% 0px 20% 0px' })
    observer.observe(el)
    return () => { unsubscribe(); observer.disconnect() }
  }, [enabled])
  ```
  若担心 `onScrollFrame` 在滚动停止后不再调用（实际它每帧都调，见 `scrollEngine.ts:207`），也可以保留 rAF 但改为“在 `onScrollFrame` 里置 dirty 标记”，这仍会把 DOM 写对齐到主时钟。
  同类问题（优先级更低、可不改）：`ScrollTelemetryHud.tsx:39-46`、`AudioSpectrumMeter.tsx:72-103`、`useFpsMonitor.ts:71-83`、`PerfTelemetryHud.tsx:182-253` 各自持有独立 rAF。

---

### [编号 CR-06] 自适应质量降级把“预热期的卡顿”当成“设备不行”，并把降级结果持久化，用户被永久钉在 medium
- 严重级别：P1
- 分类：正确性 / 性能
- 位置：`src/components/canvas/SceneCanvas.tsx:234-254`、`src/store/useAppStore.ts:296-308`、`src/store/useAppStore.ts:369-376`
```ts
  const handleDecline = useCallback(
    (api: { averages: number[] }) => {
      const samples = api.averages
      if (!samples.length) return
      let total = 0
      for (let i = 0; i < samples.length; i++) total += samples[i]
      const average = total / samples.length
      if (average >= DEGRADE_FPS) return
```
```ts
      partialize: (state) => ({
        soundEnabled: state.soundEnabled,
        fpsMonitorEnabled: state.fpsMonitorEnabled,
        performanceTier: state.performanceTier,
```
- 现象与证据：
  1. `PerformanceMonitor` 从挂载那一刻就开始采样（已查证 `node_modules/@react-three/drei/core/PerformanceMonitor.js:47`：每次 `useFrame` 里 `frames.push(performance.now())`），8 个 250ms 窗口 ≈ 2 秒后就可能触发 `onDecline`（`:65`，`lowerBounds.length > iterations * threshold`）。而启动后的前 2 秒正好是 lazy chunk 求值、`checkShaderErrors` 关闭前的首帧编译、`Environment` bake、`BootSequence` 幕布下的编译风暴期（`BootSequence.tsx:9-14` 自己写明冷启动 ~2.7s）。也就是说**多数机器在首屏就会被判“平均 fps < 45”并降级**，与设备真实能力无关。
  2. 降级写入 `performanceTier: 'medium'`，而 `performanceTier` **在 `partialize` 里**（`useAppStore.ts:372`）；`autoDowngradeArmed` 却不在。重载后 `armed` 恢复为 true、`tier` 仍是 `'medium'`，`degradePerformanceTier` 里 `if (state.performanceTier === 'medium') return`（`:299`）意味着它连“再降一次”的机会都没有 —— 用户之后的每次访问都停留在 medium（4000 粒子 + DPR 1 + 无 Bloom），直到手动 `cyclePerformanceTier`。一次偶发卡顿 → 永久降质。
  3. 另：`bounds={() => [DEGRADE_FPS, DEGRADE_FPS + 15]}` = `[45, 60]`，因此在 30Hz 刷新/省电模式/被系统限帧到 30 的设备上，**100% 会降级**且永不回升（没有 `onIncline` 路径）。
- 影响：视觉预算被无声地砍半（这是本项目的核心卖点），且重启浏览器无法自愈；同时告知用户的 toast 只出现一次，难以归因。
- 修改建议：
  1. 加预热窗口：`PerformanceMonitor` 延迟挂载，或用 `useInViewAnimation` + `requestIdleCallback` 让它在 boot 完成后 3 秒再挂载。
     ```tsx
     const warm = usePrewarmFinished()        // 复用 store.prewarmDone
     {warm && <PerformanceMonitor ... />}
     ```
  2. 把“自动降级”与“用户偏好”分开存储：`partialize` 里去掉 `performanceTier`（改为持久化一个 `userTier | null`），自动降级的结果只影响本次会话：
     ```ts
     maybeDegradedTier: PerformanceTier | null   // 不持久化
     performanceTier: () => get().userTier ?? get().maybeDegradedTier ?? detectPerformanceTier()
     ```
  3. 增加回升路径（`onIncline` → `restorePerformanceTier()`），并把 `bounds` 的 `lower` 改为“相对刷新率”而非硬编码 45（例如 `refreshrate * 0.75`），否则 30Hz 设备必然误判。

---

### [编号 CR-07] `prefers-reduced-motion` 没有贯穿到 WebGL/相机；`scrollEngine` 注释承诺的 “calm camera” 并不存在
- 严重级别：P1
- 分类：可访问性
- 位置：`src/lib/scrollEngine.ts:68-70`、`src/components/canvas/CameraRig.tsx:96-108`、`src/lib/device.ts:15-21`
```ts
  // Lenis still uses native scroll when the user asks for reduced motion,
  // while WebGL keeps rendering (it just switches to a calm camera).
  respectReducedMotion: true,
```
```tsx
    const targetX = BASE_POSITION.x + mouse.x * MOUSE_TRAVEL_X
    const targetY = BASE_POSITION.y + mouse.y * MOUSE_TRAVEL_Y + progress * SCROLL_TRAVEL_Y
    const targetZ = BASE_POSITION.z - progress * SCROLL_TRAVEL_Z
```
- 现象与证据：`prefersReducedMotion()` 全仓只有 3 个消费点：`SmoothScroll.tsx:29`（决定是否调 `resize`）、`detectPerformanceTier()`（只降一档到 `'medium'`）、`ClickRipple.tsx:76`。`CameraRig` 没有任何 reduced-motion 分支：鼠标视差（±0.55/±0.32）、每帧 `lookAt` 摆动、滚动推拉（1.1 单位前进）全部照跑；`AuroraCurtain`/`FlowFieldParticles`/`CursorStardustTrail`/`VolumetricStageLights` 也都在每帧改写 uniform 与粒子状态。CSS 侧只有 `.comet-beam`/`.boot-scan` 等装饰被关掉（`index.css:414`、`:530`）。
  而 `scrollEngine.ts:68-70` 的注释明确写着 “it just switches to a calm camera”，**代码里没有这个分支**——这是一条会误导后续维护者的假契约。
- 影响：对运动敏感/前庭功能障碍用户，页面依然是全速滚动视差 + 全速粒子 + 全速光效的 3D 展馆（对照 WCAG 2.3.3 Animation from Interactions）。同时 `detectPerformanceTier` 只在模块加载时快照一次，用户中途改系统设置不会生效（`device.ts:15`，无 `matchMedia` 的 `change` 监听）。
- 修改建议：
  1. 增加一个 `useReducedMotion()`（或 store 里的 `reducedMotion` 由 `matchMedia(...).addEventListener('change')` 维护，并在 App 卸载时移除监听），把结果传进画布层：
     ```tsx
     // CameraRig
     const reduce = useAppStore((s) => s.reducedMotion)
     useFrame((_, raw) => {
       ...
       if (reduce) { camera.position.set(0, 0, BASE_POSITION.z); camera.lookAt(0, 0, 0); return }
     ```
  2. reduced motion 时把 `advanceR3F` 降为“仅在滚动/输入变化时渲染一帧”（`invalidate` 语义 + `frameloop="demand"`），这样既不冻结画面也不持续动画；退一步至少把粒子数/效果栈降到 `medium` 以下。
  3. 删掉或落实 `scrollEngine.ts:68-70` 的注释，避免契约与实现不一致。

---

### [编号 CR-08] Lenis 同时配置 `duration+easing` 与 `lerp`，前者胜出：`lerp: 0.2` 及其整段手感论证是死配置
- 严重级别：P2
- 分类：可维护性 / 正确性
- 位置：`src/lib/scrollEngine.ts:57-71`
```ts
const LENIS_OPTIONS = {
  duration: 1.15,
  easing: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  smoothWheel: true,
  wheelMultiplier: 1.0,
  touchMultiplier: 1.4,
  lerp: 0.2,
```
- 现象与证据：已查证 `node_modules/lenis/dist/lenis.mjs`：
  - `Animate.advance()` 的分支顺序是 `if (this.duration && this.easing) { …固定时长缓动… } else if (this.lerp) { damp(...) }`（`:79`、`:85-86`）；
  - 滚轮路径传参时**同时**给了三者（`:637-640`：`{ lerp: this.options.lerp, duration: this.options.duration, easing: this.options.easing }`）。
  因此实际生效的是 `duration: 1.15` 的固定时长补间，`lerp` 分支永远不执行。`scrollEngine.ts:41-56` 那一大段“为什么 lerp 用 0.2 而不是 0.09 / 25 帧才收敛”的推理，与线上手感无关。
- 影响：调参时改了 `lerp` 完全没有效果（典型“改了没反应”的浪费时间 bug）；一处误导性注释会把后来者引向错误结论。此外 `1.15s` 的固定补间在连续滚轮手势里每格都重启动画，实际观感比注释描述的“跟手”更黏。
- 修改建议：只保留一种模型。要“跟手 + 惯性滑行”就用 `lerp`，删掉 `duration`/`easing`：
  ```ts
  const LENIS_OPTIONS = { lerp: 0.18, smoothWheel: true, wheelMultiplier: 1, touchMultiplier: 1.4, syncTouch: false, autoRaf: false, anchors: false, allowNestedScroll: true, respectReducedMotion: true } as const
  ```
  要复刻当前线上观感就删掉 `lerp` 和那段注释，并说明这是 1.15s 的 `easeOutExpo` 补间（`scrollToTarget` 走的是 1.4s，`scrollEngine.ts:235`，两者语义不同，注释里应写清）。

---

### [编号 CR-09] `destroyScrollEngine()` 不是完整清理：`is-scrolling` 类残留、transient 未复位、`listeners` 从不清空
- 严重级别：P2
- 分类：内存 / 正确性
- 位置：`src/lib/scrollEngine.ts:218-229`
```ts
export function destroyScrollEngine(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  instance?.destroy()
  instance = null
  lastTime = 0
  lastProgress = 0
  smoothedVelocity = 0
  resetSpring(velocitySpring, 0)
}
```
- 现象与证据：
  - `scrollBusy` 与 `document.documentElement` 上的 `is-scrolling` 类没有复位。若在滚动中销毁（StrictMode 二次挂载、HMR、未来路由切换），`html.is-scrolling` 会永久保留，`index.css:554-557` 那组“滚动期间暂停”的装饰动画就永远停在 `paused`。
  - `lastProgress` 被置 0，但没有 `writeScroll(0, 0)`，于是 `getScrollProgress()` 返回 0 而 `getTransient().scroll.progress` 仍是旧值——两个“同一份真相”的读取口不一致；`R3F` 画布在 `destroy` 后仍可能被 `advance` 推进一帧（`rafId` 已取消，风险小）。
  - `listeners` 这个模块级 `Set` 从不被清空；`destroy` 只取消 rAF，没有 `listeners.clear()` 也没有“引擎已死”的标记。任何漏掉 `unsubscribe` 的订阅者会永久留在集合里，下次 `createScrollEngine()` 时立刻收到一次 `publish`。
- 影响：HMR / StrictMode 下装饰动画卡死、transient 与 getter 读数分裂；长期运行无法保证监听器集合不增长（测试环境尤其明显，因为一次测试进程会多次 create/destroy）。
- 修改建议：
  ```ts
  export function destroyScrollEngine(): void {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
    instance?.destroy()
    instance = null
    lastTime = 0; lastProgress = 0; smoothedVelocity = 0
    resetSpring(velocitySpring, 0)
    if (scrollBusy) { scrollBusy = false; document.documentElement.classList.remove('is-scrolling') }
    writeScroll(0, 0)              // 统一两个读取口
    listeners.clear()              // 或保留但文档明确“订阅者由 React 生命周期负责”
  }
  ```
  同时给 `createScrollEngine` 返回的 disposer 加上“幂等”语义（重复调用无副作用），并在注释里写明 `listeners` 的所有权归属。

---

### [编号 CR-10] “睡眠画布”并没有真的睡：全局 `advance()` 每帧仍渲染架构画布的空场景，`setCanvasSleeping` 是死代码
- 严重级别：P2
- 分类：性能 / 可维护性
- 位置：`src/components/canvas/ScrollArchitecture3D.tsx:1819-1837`（只门控子树）、`src/lib/frameBridge.ts:104`、`src/lib/perfMetrics.ts:229-238`、`src/components/layout/PerfTelemetryHud.tsx:241-245`
```tsx
      {live && (
        <>
          <ArchitectureRig
```
```ts
export function setCanvasSleeping(sleeping: boolean): void {
```
- 现象与证据：架构章节的策略是“挂载/卸载 `ArchitectureRig` 子树”（注释 `:1805-1818` 说得对：composer 已移除，`internal.priority` 手法不再需要，`RenderGate` 也已删除——全仓 grep `priority` 只剩注释）。但**`<Canvas>` 本体始终挂载**，而 `advanceR3F` → R3F `advance()` 不检查 `internal.active`/`frames`，会对每个 `_roots` 成员无条件 `update()`（`node_modules/@react-three/fiber/dist/events-e51d7528.esm.js:17618`），从而每帧执行 `gl.render(scene, camera)`（同文件 `:17537`，该 root 无 composer → `internal.priority === 0`）。所以不在视口时它仍在做一次全视口 clear + 一次透明画布合成。
  另一侧，`perfMetrics.setCanvasSleeping()` 在整个仓库**没有任何调用者**，HUD 里的 `sleepingCanvases` 永远是 0（`PerfTelemetryHud.tsx:244` 显示 `N / 0`），也就是说“睡眠”只有一个自述，没有可观测量。
- 影响：常驻的第二块全屏 canvas 在用户阅读其它章节时仍在花 GPU 时间与合成预算（低端机上是持续的背景功耗）；HUD 的 sleeping 列恒为 0，误导性能排查。
- 修改建议：
  1. 采用 CR-01 的 per-root `advance` 后，直接跳过 `awake === false` 的 root（`advanceR3F` 里按 root 判断），或者对睡眠 root 用 `setFrameloop('always'→'never')` + `invalidate` 语义（注意 `never` 下 `invalidate` 是 no-op，见 `:17590`，所以要么切 `'demand'`，要么继续用显式 `advance(ts, false, state)`）。
  2. 实在不行就把 `<Canvas>` 本身挂在 `awake || prewarmed` 下（代价是每次进出重建 gl 上下文，要确认 `Environment` bake 与 shader 缓存命中，需实测）。
  3. 让 `ArchitectureNarrative` 在 `inViewRef` 变化时调用 `setCanvasSleeping(next)`，或在 CR-02 的重构中删除这个计数。

---

### [编号 CR-11] `DprSync` 与 R3F 争夺 `pixelRatio` 所有权，且注释里的“兜底”在 three 语义下不成立
- 严重级别：P2
- 分类：正确性
- 位置：`src/components/canvas/SceneCanvas.tsx:105-118`
```tsx
  useEffect(() => {
    const ratio = Math.min(window.devicePixelRatio || 1, max)
    setDpr(ratio)
    // `setDpr` resizes through the store; the explicit call covers the case
    // where the store value is already correct but the drawing buffer is not.
    gl.setPixelRatio(ratio)
  }, [gl, setDpr, max])
```
- 现象与证据：R3F 已经在 `configure()` 里监听 `viewport.dpr` 并把 `setPixelRatio` **和** `setSize` 一起做（`node_modules/@react-three/fiber/dist/events-e51d7528.esm.js:1348-1357`）：
  ```js
  if (size.width !== oldSize.width || size.height !== oldSize.height || viewport.dpr !== oldDpr) {
    updateCamera(camera, size);
    if (viewport.dpr > 0) gl.setPixelRatio(viewport.dpr);
    gl.setSize(size.width, size.height, updateStyle);
  }
  ```
  而业务侧的 `gl.setPixelRatio()` 只写 `_pixelRatio`，**不重设 drawing buffer 尺寸**（three 的 `setPixelRatio` 不调用 `setSize`）。所以注释声称的“buffer 不对时由这行补救”是错的：真正修正 buffer 的永远是 R3F 的 `setSize`。反过来，这行在 store 更新前抢先把 ratio 改掉，会造成同一 tick 内 `renderer._pixelRatio` 与 `canvas.width/height` 短暂不一致（若这一帧发生渲染，画面会被缩放一次）。另外 `max` 变化时 `dpr` prop 也会变（`SceneCanvas.tsx:316`），存在两条写路径。
- 影响：切档瞬间可能看到一帧画面缩放/模糊；两处所有权让后续改 DPR 策略（例如加 `PerformanceMonitor` 控制的 `<AdaptiveDpr>`）时极易打架。
- 修改建议：删掉 `gl.setPixelRatio(ratio)`，只保留 `setDpr(ratio)`（R3F 负责 resize），并在切档后补一次 `gl.setSize(size.width, size.height, false)` 仅当需要强制重设时（配合 `useThree(s => s.size)`）：
  ```tsx
  const size = useThree((s) => s.size)
  useEffect(() => { setDpr(Math.min(window.devicePixelRatio || 1, max)) }, [setDpr, max])
  ```
  若确实需要“值没变但 buffer 脏了”的兜底，正确写法是 `gl.setSize(size.width, size.height, false)` 而不是 `setPixelRatio`。

---

### [编号 CR-12] 没有 `webglcontextlost` / `webglcontextrestored` 处理：一次 GPU 进程重置就让展馆永久黑屏
- 严重级别：P2
- 分类：可访问性 / 降级
- 位置：`src/lib/device.ts:25-37`（`supportsWebGL` 只做一次性探测）、`src/components/canvas/SceneCanvas.tsx:325-379`（`onCreated` 里没有事件绑定）
```ts
/** Whether the device can create a WebGL2/WebGL context at all. */
export function supportsWebGL(): boolean {
```
- 现象与证据：全仓 grep `webglcontextlost` 无结果。`supportsWebGL()` 只回答“能不能创建上下文”，不回答“上下文是否还活着”。Windows 上驱动重置、双显卡切换、GPU 进程崩溃都会触发 `webglcontextlost`；three/R3F 都不会自动重建（`WebGLRenderer` 只是打一条日志），R3F 的 `advance` 会继续调用 `gl.render` 往死上下文里画。
- 影响：用户把笔记本从独显切到核显、或驱动 TDR 恢复后，背景星云和架构模型永久黑掉，页面其余部分正常——用户以为“这个网站就这样了”。这是最常见也最容易被忽略的 WebGL 事故。
- 修改建议：在 `onCreated` 里接管：
  ```ts
  const canvas = gl.domElement
  const onLost = (e: Event) => { e.preventDefault() /* 允许恢复 */ ; degradedToCssFallback() }
  const onRestored = () => { gl.forceContextRestore?.(); window.location.reload() /* 或 remount canvas */ }
  canvas.addEventListener('webglcontextlost', onLost, false)
  canvas.addEventListener('webglcontextrestored', onRestored, false)
  ```
  同时在 `App` 层准备一个“WebGL 不可用”的降级态（现在 `App.tsx:35` 已经有一个 `webgl` 布尔，可复用为 `webglHealthy`），至少显示静态渐变背景，而不是把固定 z-10 的空层留在那里。

---

### [编号 CR-13] `useInViewAnimation` 把 `ref.current` 当依赖但 React 不会因它重跑：元素后挂载时观察器永不附加
- 严重级别：P2
- 分类：正确性 / 可维护性
- 位置：`src/hooks/useInViewAnimation.ts:69-85`
```ts
  useEffect(() => {
    const element = ref.current

    // No element (unmounted, or a ref that has not attached yet): assume
    // visible. Reporting "hidden" would silently park a module that might be
    // perfectly on screen.
    if (!element) {
      inViewRef.current = true
      return
    }
```
- 现象与证据：effect 的依赖是 `[ref, rootMargin]`（`:101`），而 `ref` 是 `useRef` 的稳定对象，`rootMargin` 是字符串——两者都不会因为“元素后来才 attach”而变化。如果被观察元素是条件渲染（`{visible && <div ref={...}>}`）、或 ref 在首帧之后才指向节点，这个 effect 第一次就拿不到 `element`，走 `inViewRef.current = true` 然后 `return`，**永远不会再尝试 `observe()`**，`onChange` 也永远不会被调用，门控失效（模块永远处于“可见”状态，白跑动画）。
  当前唯一使用者 `ArchitectureNarrative.tsx:298` 的宿主 div 是无条件渲染的，暂时踩不到；但这是一个埋在公共 hook 里的地雷，下一个调用者（例如把 canvas 改成条件挂载）就会中招。
- 影响：休眠/唤醒门控静默失效 → 本该休眠的模块持续渲染（性能），或本该唤醒的模块被判定为不可见（如果以后把默认值改成 false 更糟）。不会有任何报错。
- 修改建议：改用 callback ref（把 attach 变成一次 render 事件）：
  ```ts
  export function useInViewElement(onChange?: (v: boolean) => void, rootMargin = '25% 0px 25% 0px') {
    const inView = useRef(true)
    const obs = useRef<IntersectionObserver | null>(null)
    const setNode = useCallback((node: Element | null) => {
      obs.current?.disconnect()
      if (!node) return
      obs.current = new IntersectionObserver(([e]) => { ... }, { rootMargin })
      obs.current.observe(node)
    }, [rootMargin])
    return { inView, setNode }
  }
  ```
  若要保留现有签名，至少加一个 `useEffect` 的重试：`useEffect(() => { const id = requestAnimationFrame(() => { if (ref.current && !observerRef.current) attach() }); ... })`，并在文档里明确“仅支持首帧即挂载的元素”。

---

### [编号 CR-14] 模块级可变单例（`instance`/`listeners`/`activeCanvases`/`performanceCounters`）无复位入口、无 `import.meta.hot` 处理：编辑即产生双主循环
- 严重级别：P2
- 分类：可维护性 / 内存
- 位置：`src/lib/scrollEngine.ts:21-36`、`src/lib/frameBridge.ts:15-34`、`src/lib/perfMetrics.ts:78-93`
```ts
const listeners = new Set<FrameListener>()

let instance: Lenis | null = null
let rafId: number | null = null
let lastTime = 0
let smoothedVelocity = 0
let lastProgress = 0
```
- 现象与证据：全仓 grep `import.meta.hot` 无结果。`src/lib/scrollEngine.ts` 被修改时，Vite 会替换模块实例：新的模块作用域里 `instance = null`、`rafId = null`，但**旧模块的 rAF 循环闭包仍然活着**（它捕获旧模块的 `instance` 与 `rafId`），旧的 `Lenis` 实例也没有被 `destroy()`。于是编辑器里保存一次 `scrollEngine.ts`，页面上就并存两套主循环与两个 Lenis（各自在 window 上挂着 wheel/touch 监听），滚动速度翻倍、`is-scrolling` 抖动、CPU 翻倍——直到手动刷新。
  `frameBridge.activeCanvases` 与 `perfMetrics.performanceCounters` 同理：HMR 后计数残留，`advanceR3F` 可能因为旧模块的计数而误判，或 HUD 粒子数虚高。
  这正是“可测试性”问题的另一面：这些单例既没有 `__resetForTests()`，也没有在 `afterEach` 里可用的隔离点（`resetFrameBridge`、`resetTransient` 虽然存在，但全仓没有任何调用者，见 CR-16）。
- 影响：开发期每次改核心模块都要手动刷新（否则得到假象性能数据），而这些恰恰是最需要反复调试的文件；单元测试无法隔离，只能在全新的 worker 里跑。
- 修改建议：
  ```ts
  // scrollEngine.ts 末尾
  if (import.meta.hot) import.meta.hot.dispose(() => destroyScrollEngine())
  // frameBridge.ts 末尾
  if (import.meta.hot) import.meta.hot.dispose(() => resetFrameBridge())
  ```
  同时把三个单例改成可注入/可复位的工厂（`createScrollEngine()` 已经是工厂形态，只需让模块级的 `instance` 变成工厂返回值的一个字段，导出 `getEngine()`），并为 `perfMetrics` 增加 `resetPerformanceCounters()`（在 `import.meta.hot.dispose` 里调用）。

---

### [编号 CR-15] 数值边界：`limit === 0` 时 Lenis 的 `progress` 是 `1` 而非 `0`；文档高度变化时 `velocity` 语义漂移
- 严重级别：P3
- 分类：正确性
- 位置：`src/lib/scrollEngine.ts:115`、`src/lib/scrollEngine.ts:134`、`src/lib/scrollEngine.ts:140-147`
```ts
  // Prime state + any listener that mounted before the engine existed.
  lastProgress = clamp(safeNumber(instance.progress), 0, 1)
```
```ts
    const instantaneous = (progress - lastProgress) / (dt || 1 / 60)
```
- 现象与证据：Lenis 的实现是 `get progress() { return this.limit === 0 ? 1 : this.scroll / this.limit }`（`node_modules/lenis/dist/lenis.mjs:985-987`）。也就是说**内容不可滚动（`limit === 0`）时 progress 是 1，不是 0**。当前代码在引擎创建时就用它做初值：短页面/极宽视口（内容不足一屏）、或 Lenis 测量时文档尚未布局完成的极端情况下，`lastProgress = 1`，`CameraRig` 会把相机推到行程末端（`z = 6 - 1.1`、`y = -0.45`），随后尺寸量准后 progress 跳回 0，相机/public 订阅者都要重新收敛。
  `velocity` 是“progress/秒”，含义随文档总高度变化：字体加载、图片撑开、响应式重排都会让同一像素速度对应不同的 `v`。而消费方（`SceneCanvas.tsx:179` 的 CA 增益、`scrollBusy` 阈值 0.035）都把它当绝对量用。
- 影响：边界场景下首帧相机位置错误并回弹；任何内容高度变化都会被读成一次“高速滚动”（CA 色散闪一下、`is-scrolling` 类抖动、HUD 尖峰）。
- 修改建议：
  - 初值与每帧都改用更稳的口径：`const p = limit > 0 ? scroll / limit : 0`（自己算，不要依赖 `lenis.progress` 的 `limit===0` 分支），或者显式判断 `if (!(instance.limit > 0)) lastProgress = 0`。
  - 把 `velocity` 归一化到“像素/秒”再进 store（`transient.scroll.velocityPx`），或在使用处除以“当前文档高度/参考高度”，这样阈值与增益就不随内容高度漂移；至少要在 `ScrollState` 的注释里写清“单位 = 文档高度比例/秒，随文档高度变化”。
  - `dimensions` 变化（`resize()`）时把 velocity 直接归零并跳过一帧的 derivative，避免把它当滚动。

---

### [编号 CR-16] 一批“为测试/热重载准备”的 API 全是死代码，且没有测试锚点
- 严重级别：P3
- 分类：可维护性
- 位置：`src/lib/frameBridge.ts:107-112`、`src/lib/scrollEngine.ts:87-89`、`src/lib/frameBridge.ts:79-82`、`src/lib/perfMetrics.ts:228-238`
```ts
/** Reset internal clock bookkeeping. Exposed for tests / hot reload. */
export function resetFrameBridge(): void {
  originMs = null
  lastSeconds = 0
  activeCanvases = 0
}
```
- 现象与证据（全仓 grep 逐个核对）：
  - `resetFrameBridge()`：0 个调用者（注释说“for tests / hot reload”，但既无测试也无 `import.meta.hot`，见 CR-14）。
  - `getScrollProgress()` / `getScrollVelocity()`：0 个调用者。
  - `resetTransient()`：0 个调用者。
  - `setCanvasSleeping()` / `performanceCounters.sleepingCanvases`：0 个调用者，但 HUD 在读（`PerfTelemetryHud.tsx:244`），所以那一列恒为 0。
  - `transient.mouse.px` / `py`：只有写入（`useAppStore.ts:174-175`）与清零（`:246-247`），**没有任何读取者**，但每个指针事件都写两次。
- 影响：读者会以为“已有测试出口”从而不再补测试；`px/py` 是每事件一次的无用写入；HUD 显示一个永远不会变的指标，误导性能排查。
- 修改建议：要么补齐用途（`import.meta.hot.dispose` 里调 `resetFrameBridge`；`resetTransient` 在 `destroyScrollEngine` 里调；`setCanvasSleeping` 接到 `inViewRef` 的 `onChange`），要么删掉这些导出并把 HUD 的 sleeping 列去掉。`px/py` 若确实无人用，直接删除字段（`MouseState` 在 `src/types/index.ts:51-52`）。

---

### [编号 CR-17] `PerfTelemetryHud` 每帧重绘 2D canvas / 每帧 `toLocaleString`，且降级提示文案被冻结在 store 里
- 严重级别：P3
- 分类：性能 / 可维护性
- 位置：`src/components/layout/PerfTelemetryHud.tsx:228-251`、`src/store/useAppStore.ts:300-307`
```tsx
      const c = performanceCounters
      if (particlesRef.current) {
        // Sum of every registered canvas, not one producer's number.
        particlesRef.current.textContent = getActiveParticleCount().toLocaleString('en-US')
      }
```
```ts
        set({
          performanceTier: 'medium',
          perfNotice: {
            title: getDictionary().hud.noticeTitle,
```
- 现象与证据：
  - HUD 打开时，`tick` 每帧执行 `drawSpark()`（`spectacle`：`clearRect` + 3 条网格线 + 折线 + 面积填充 + 圆点，`:117-180`），以及 `getActiveParticleCount()`、`String(...)`、`toLocaleString('en-US')`（每次分配字符串并走 ICU）。这是一个 debug 面板，60/120Hz 下的固定开销没有意义。
  - `degradePerformanceTier` 在 store 里调 `getDictionary()` 生成**本地化字符串**并存进 `perfNotice`。用户在提示展示期间切换语言，toast 会保持旧语言；同时这让 `store` 反向依赖 `i18n`（`useAppStore.ts:8`），破坏了 store 的“纯状态”定位。
- 影响：开发者开着 HUD 排查性能时，HUD 自身就是 5–10% 的帧成本（"观测即扰动"）；toast 文案可能语言不一致。
- 修改建议：
  - HUD：把数字刷新降到 ~4–10Hz（与 `fpsRef` 一起放进 `if (elapsed >= 250)` 分支，`:198-226`），`drawSpark()` 只在堆采样新增时（`now - lastHeapSample > 250`）重绘，和 `sampleHeap()` 同频。
  - i18n：`perfNotice` 存结构化数据 `{ fps: number, windowSeconds: number, threshold: number }`，由 `PerfNoticeToast` 用 `t.hud.degradeReason.replace(...)` 渲染；这样语言切换即时生效，store 也不必 import i18n。

---

## 其他小问题

- `src/lib/scrollEngine.ts:206-210`：`publish()`（含所有 DOM 写入型监听器）在 `advanceR3F()` **之前**执行，监听器里的布局写入会挤占 WebGL 提交时刻；且任一监听器抛错会跳过本帧的 `advanceR3F`，建议把 `advanceR3F` 提到 `publish` 前，或给监听器循环加 try/catch。
- `src/lib/frameBridge.ts:104`：`advanceFn(clamped)` 传的是**秒**，而 R3F 自己的 `loop()` 给 `flushGlobalEffects` 传的是**毫秒**（`events-e51d7528.esm.js:17554`）；这里把秒透传给 `mod.advance(ts, true)` 会让 drei/全局 effect 收到单位不一致的时间戳。当前无依赖该时间戳的 effect，标注「需实测」；稳妥做法是 `mod.advance(clamped * 1000, true)`（`update()` 内部对 `never` 模式仍按秒计算 delta）。
- `src/lib/perfMetrics.ts:217-226`：`readHeapHistory(out)` 没有校验 `out.length >= count`（typed array 越界写会被静默丢弃），调用方 `PerfTelemetryHud.tsx:106` 恰好等长，但契约缺失。
- `src/lib/pointerInput.ts:124-125`：`document.addEventListener('pointerleave', …)` 未传 options（`pointerleave` 不冒泡，能否在 `document` 上收到依赖浏览器实现，Safari 需实测）；建议改为 `window.addEventListener('pointerout', e => { if (!e.relatedTarget) release() })` 或 `document.documentElement` + `mouseleave`。
- `src/hooks/useSectionProgress.ts:74`：`useRef(createProgressStore(0))` 的实参在**每次 render 都被求值**（新建闭包 + `Set`，然后丢弃），改为 `useRef<ProgressStore>(null!)` + 惰性初始化。
- `src/components/layout/BootSequence.tsx:142-164`：只拦截 `wheel` / `touchmove`，键盘（Space/PageDown/End）与滚动条拖拽仍能移动页面，boot 幕布期间可达性不一致；若目的是“页面不动”，还需 `scrollTo(0,0)` 或对 `keydown` 做同样的处理。
- `src/components/layout/AudioSpectrumMeter.tsx:45-104`：`soundEnabled` 为 true 时持有永久 rAF，且每帧 5 次 `style.transform` 写入；`park()` 只在关闭时调用一次，正常。
- `src/lib/curlNoise.ts:200-207` vs `:272`：`CurlVolume.step` 的文档写「World-space step between adjacent lattice samples」，实际返回的是 `1 / step`（倒数）；`sampleCurl` 按倒数使用（`:293`）所以当前正确，但字段语义与文档相反，任何新消费方按注释使用都会得到 12 倍误差。
- `src/lib/math.ts:17-26`：`mapRange` 用 `clamp(value, inMin, inMax)`，当 `inMin > inMax`（反向映射）时 `Math.min(max, Math.max(min, v))` 恒为 `inMax`，建议把反向区间显式支持或加断言。
- `src/lib/vfxPalette.ts:39-45`：`VfxPalette` 接口里 `id` 后面挂了两个连续 `/** … */` 注释（“Human-facing name” 那条已失效），JSDoc 会被第二条覆盖，属残留文档。
- `src/components/layout/ClickRipple.tsx:73-97`：`pointerdown` 里做 `prefersReducedMotion()`（每次新建 `MediaQueryList`）+ `getBoundingClientRect()`（读布局），点击热路径可接受但可缓存；`ripple` 走 `useState` 会让该组件每次点击重渲染一次（当前只有一个节点，可接受）。
- `src/components/canvas/SceneCanvas.tsx:288-299` / `ScrollArchitecture3D.tsx:1768-1774`：DEV 用的 `window.__showroomScene` / `__archScene` 在 HMR 后会指向已销毁的 gl/scene（旧模块的 Canvas 已 unmount），调试时容易拿到幽灵对象；在 `useEffect` 的清理里置空更稳妥。
- `src/store/useAppStore.ts:267`：`detectPerformanceTier()` 在 `create()` 的初始值里执行（模块加载期就调 `matchMedia`×2 + 读 `navigator`），而 `persist` 的同步 localStorage 水合随后覆盖它——这次探测在“已保存偏好”的场景下是纯浪费；可改为惰性（`performanceTier: 'high'` 初值 + `onRehydrateStorage` 里探测）。
- `src/components/layout/ScrollTelemetryHud.tsx:39-46`：`readMouse` 自成 rAF（仅在 `fpsMonitorEnabled` 时），可并入 `onScrollFrame`，与 `p/mouse` 行统一节流到 10Hz（现在前者 60Hz、后者 10Hz）。
- `src/components/canvas/Scene.tsx:13`：同时导出 `SceneCanvas as Scene` 与 `default`，而 `App.tsx:31` 用的只有 `default`，具名 `Scene` 无人使用——shim 的双出口会让“哪个才是入口”变模糊，建议只留 `default`。
