# Canvas / Shader 层审查报告（canvas-shaders）

审查范围：`src/components/canvas/{FlowFieldParticles,ScrollArchitecture3D,AuroraCurtain,VolumetricStageLights,CursorStardustTrail,SceneCanvas}.tsx`、
`src/components/canvas/architecture/{cameraPath,geometry,HexGround,layers}.ts`、
`src/utils/vfxParticleEngine.ts`、`src/lib/{curlNoise,vfxPalette,frameBridge}.ts`。
只读审查，未修改任何 `src` 源码。

## 结论速览

| 编号 | 级别 | 分类 | 一句话 |
| --- | --- | --- | --- |
| SH-01 | P0 | 显存 | `meshPhysicalMaterial.transmission` 触发 three 全分辨率 4×MSAA 半浮点传输缓冲（≈40–170 MB），每帧 resolve + mipmap |
| SH-02 | P0 | 性能 | `prewarmed` 粘滞，架构画布整场常驻；离屏仍每帧渲染主场景 + 传输通道 + 镜面反射（≈95 draw call） |
| SH-03 | P1 | 正确性 | 三处 `uPixelRatio` 取 `window.devicePixelRatio` 而非渲染器实际 DPR：medium 档点精灵 2× 过大，填充率反升 4× |
| SH-04 | P1 | 显存 | drei `MeshReflectorMaterial` 的 4 张 RT 无 dispose，每次挂载泄漏 ≈8.9 MB（StrictMode 必现） |
| SH-05 | P1 | 性能 | 等离子球 5 步体积步进 × 2×8-tap sin-hash 噪声 = 每片元 80 次 `sin()` |
| SH-06 | P1 | 性能 | 每帧 72 次 `curve.getTangent()`，three 内部每次分配 2 个 `Vector3` → 144 个/帧 |
| SH-07 | P2 | 性能 | 发射帧整缓冲重传 128 KB（实际变化 ≤2.2 KB）；`aLife` 每帧无条件 16 KB |
| SH-08 | P2 | 可维护性 | 涟漪环池 3 套材质 + 100 行 shader 永不激活（`ring.life` 无写入点） |
| SH-09 | P2 | 正确性 | `uTime` 无界累加，`sin(uTime*42.0)` 长时会话后阶梯化抖动 |
| SH-10 | P2 | 可移植性 | `supportsWebGL()` 放行 WebGL1，但 three r186 只支持 WebGL2 |
| SH-11 | P2 | 正确性 | 全仓无 `webglcontextlost/restored` 处理，上下文丢失后永久黑屏 |
| SH-12 | P2 | 性能 | 每帧 `root.traverse` + 每材质新建 `[mat]` 数组（≈37 个/帧） |
| SH-13 | P2 | 性能 | 三份手写 sin-hash 噪声，锥体每片元 24 次 `sin()`，且 sin-hash 移动端会带状 |
| SH-14 | P2 | 性能 | Aurora 全屏 additive + 2×fBM(4 oct) + `discard`，与 warp 精灵峰值叠加 |
| SH-15 | P3 | 可维护性 | 1936 行 / 75 KB 单文件承载 7 段 GLSL + 5 个图层组件 + 装配 + Canvas |
| SH-16 | P3 | 可维护性 | `CurlVolume.step` 实际存的是 1/step，字段名与语义相反 |
| SH-17 | P3 | 性能 | `VfxParticleEngine.draw()` 每粒子 2 次模板字符串 + 2 次 stroke 状态切换 |
| SH-18 | P3 | 显存 | StrictMode 下 curl 体积双重烘焙，且 geometry/material 被 dispose 后继续使用 |

### 估算所用假设（下文所有数字均由此推出，未实测的会标注）

- 架构画布为视口内 `absolute inset-0`：CSS 尺寸按 **1440×900** 估算；high 档 `dpr=[1,2]`，取 **dpr = 2** → drawing buffer **2880×1800 = 5.18 Mpx**。
- 半浮点 RGBA16F = **8 B/px**；three 传输目标 `samples = max(4, capabilities.samples)`，桌面典型 **4**（部分 GPU 8）。
- `Vector3` 在 V8 中约 **56 B**（16 B header + map/props + 3×8 B 双精度字段）。
- 帧率按 **60 Hz** 换算每秒量级。
- 标注「需实测」的项建议用 Spector.js / `renderer.info` / `performance.memory` 复核。

---

### [SH-01] 水晶的 `transmission` 让 three 每帧分配并维护一张全分辨率 4×MSAA 半浮点缓冲

- 严重级别：P0
- 分类：显存
- 位置：`src/components/canvas/ScrollArchitecture3D.tsx:894`

  ```tsx
  894            <meshPhysicalMaterial
  895              userData={{ noExitFade: true }}
  896              color="#e6f7fb"
  897              transmission={0.98}
  898              thickness={1.2}
  899              roughness={0.05}
  900              ior={1.5}
  901              clearcoat={1}
  906              side={THREE.DoubleSide}
  907              depthWrite={false}
  ```

- 现象与证据：
  - 该章的"玻璃棱镜"已从 drei `MeshTransmissionMaterial` 换成 `meshPhysicalMaterial` + `transmission`，但**代价没有下降**：three r186 的 `WebGLRenderer` 对任何 `transmission > 0` 的材质都会在每帧 `renderTransmissionPass()`（`node_modules/three/src/renderers/WebGLRenderer.js:1782`）。
  - 该 pass 的 RT 建法（`WebGLRenderer.js:2016-2027`）：`type: HalfFloatType`、`generateMipmaps: true`、`minFilter: LinearMipmapLinearFilter`、**`samples: Math.max(4, capabilities.samples)`**；尺寸按 `activeViewport * transmissionResolutionScale`（默认 **1.0**，`WebGLRenderer.js:2044`）设为**整个 drawing buffer 大小**。
  - 每帧还要 `updateMultisampleRenderTarget()` + `updateRenderTargetMipmap()`（`WebGLRenderer.js:2078-2079`），即 MSAA resolve 全图 + 生成整条 mip 链。
  - `side: DoubleSide` 额外命中一条路径：three 对 DoubleSide 的透射物体会**再渲染一遍 BackSide**（`WebGLRenderer.js:2091-2100`）。
  - 注意：文件 1603-1612 行的注释说明"棱镜已不再用 MeshTransmissionMaterial"，但审查项 4 真正要问的是**最贵材质**——换成内置 transmission 只是换了个实现，账单一样。
- 影响：
  - 显存：2880×1800 × 8 B = **41.5 MB**（单采样），4×MSAA = **166 MB**，8×MSAA = **332 MB**；`generateMipmaps` 再加约 1/3 → **55–440 MB**。这是全站单笔最大显存开销。
  - 带宽：每帧 resolve（读 4×、写 1×）+ mip 链生成，约 **（41.5×5）≈ 208 MB/帧** 的读写，60 Hz 下 ≈ **12 GB/s**，需实测。
  - 512² 的低分辨率替代（`transmissionResolutionScale = 0.35`）能把显存压到 **1/8**。
- 修改建议：
  1. 立刻降分辨率（three ≥ r171 API，r186 可用）：
     ```ts
     onCreated={({ gl }) => {
       gl.transmissionResolutionScale = 0.35 // 5.18 Mpx → 0.63 Mpx
     }}
     ```
  2. 关掉 BackSide 二次渲染：`side={THREE.FrontSide}`（笼子是 20 面体，双面并不可见；若必须双面，可拆成两片单面 mesh）。
  3. medium 档直接不用 transmission：`transmission={tier === 'high' ? 0.98 : 0}`，用现成的 `RIM_*` + `DISPERSION_*` 菲涅尔壳冒充折射（这两个 shader 本来就存在，成本近乎为零）。
  4. 若可接受视觉损失，最优解是彻底改用 envMap + 菲涅尔假玻璃：一张 `Environment` 已在场，**零额外 RT**。

---

### [SH-02] `prewarmed` 是粘滞开关：架构画布一旦预热就永不睡眠，离屏仍在整场渲染

- 严重级别：P0
- 分类：性能
- 位置：`src/components/canvas/ScrollArchitecture3D.tsx:1656`

  ```tsx
  1656	  const live = awake || prewarmed
  ...
  1819	      {live && (
  1820	        <>
  1821	          <ArchitectureRig
  ...
  1833	          {lightsReady && (
  1834	            <VolumetricStageLights tier={tier} height={9} scale={0.85} intensity={0.85} />
  ```

- 现象与证据：
  - `prewarmed` 在挂载后第 2 帧被置 `true`（1675-1677），**此后没有任何路径把它置回 false**（`setPrewarmed` 只在 `useEffect` 里被调用一次，1649-1682）。因此 `live` 恒为 `true`，`ArchitectureRig`、`VolumetricStageLights`、`HexGround`、`DataStreams`、`DataConduits` 全程常驻。
  - 1805-1818 行的注释写着"rig 和 composer 只在章节在屏时挂载"——**与代码不符**。
  - `ArchitectureRig` 自己的 `useFrame` 有 `if (!inViewRef.current) return`（1348），但**子组件的 `useFrame` 都没有这个短路**：`OrchestrationLayer`(258)、`SpatialLayer`(804)、`DataStreams`(1022)、`DataConduits`(1224)、`HexGround`(262)、`VolumetricStageLights`(553) 全部照常执行。
  - 更关键的是**渲染本身**：R3F v9 的 `advance()` → `update()` 中 `if (!state.internal.priority && state.gl.render) state.gl.render(...)` 是无条件的（`@react-three/fiber/dist/events-e51d7528.esm.js:17537`，`advance` 在 17616 行逐个 root 调用它），与 `frameloop="never"` 无关。因为本画布**没有** `EffectComposer`（`internal.priority === 0`），所以 Lenis 每 tick 都会把整个架构场景画一遍——包括 SH-01 的传输通道和 SH-04 的镜面反射。
- 影响：
  - 每帧（无论章节是否在屏）：主渲染 ≈37 个 draw call（HexGround 4 + 编排层 7×3 = 21 + 水晶 5 + 流 1 + 导管 1 + 舞台灯 4；另有 2 盏灯不产生 draw call）＋ 传输通道 ≈8 个不透明物 + 全屏 resolve/mipmap ＋ 反射 pass ≈37 + 反射内部的传输 ≈8 + 4 个 512² 模糊 pass → **≈95 draw call/帧 ≈ 5 700/s**，其中约 **85% 是用户看不到的**。
  - 在用户停留在首屏 Hero 章节的整段时间里，GPU 有约一半预算在画一个 3 屏之外的水晶。
- 修改建议：用 render priority 接管渲染，而不是靠挂载/卸载（卸载会触发 SH-04 的泄漏）：
  ```tsx
  function VisibleRenderGate({ inView }: { inView: React.RefObject<boolean> }) {
    const gl = useThree((s) => s.gl)
    const scene = useThree((s) => s.scene)
    const camera = useThree((s) => s.camera)
    // priority ≥ 1 → R3F 自己不再渲染，由这里决定
    useFrame(() => { if (inView.current) gl.render(scene, camera) }, 1)
    return null
  }
  ```
  另外给 `OrchestrationLayer` / `SpatialLayer` / `DataStreams` / `DataConduits` / `HexGround` 的 `useFrame` 补一行 `if (!inViewRef.current) return`（把 `inViewRef` 传下去，或用 `getTransient()` 里加一个 `sceneVisible` 字段）。
  反射材质自身无法门控（drei 内部无 `frames` 参数，见 SH-04），若采用本方案，反射 pass 会随 `gl.render` 一起被跳过——这正是采用 render-gate 而非卸载的第二个理由。

---

### [SH-03] `uPixelRatio` 取的是 `window.devicePixelRatio`，不是渲染器的实际像素比：降档后点精灵反而放大 4 倍

- 严重级别：P1
- 分类：正确性
- 位置：`src/components/canvas/FlowFieldParticles.tsx:660`（同样的写法还有两处）

  ```tsx
  658	  const uniforms = useMemo(
  659	    () => ({
  660	      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
  ...
  700	  /* ── Keep sprite size correct across DPR / resize ──────────────────────── */
  701	  useEffect(() => {
  702	    uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2)
  703	  }, [size.width, size.height, uniforms])
  ```

- 现象与证据：
  - `SceneCanvas.tsx:316` 在 medium 档把渲染器的 dpr 钉死为 **1**：`dpr={highQuality ? [1, 2] : 1}`，并由 `DprSync`（109-115）显式 `setDpr(1)`。
  - 但 `FlowFieldParticles` 的 `uPixelRatio` 仍是 `min(devicePixelRatio, 2)` = **2**（Retina）。`gl_PointSize` 以**物理像素**为单位（`VERTEX_SHADER` 363 行 `size = uSize*aSize*uPixelRatio*(300/depth)`），于是帧缓冲是 1×、精灵按 2× 画 → 屏幕上大了一倍、填充面积大四倍。
  - 刷新依赖 `[size.width, size.height]`，而 tier 切换只改 `dpr` 不改 CSS 尺寸，`size` 不变 → **effect 不会重跑**，值永久停留在 2。
  - 另两处同型：`CursorStardustTrail.tsx:538` + `721-723`（依赖 size，同病）；`VolumetricStageLights.tsx:477` + `549-551`（依赖 `[dustUniforms]`，**连 resize 都不会刷新**，DPR 永远停在首次挂载值）。
- 影响：
  - medium 档的设计意图是"粒子 8000→4000 + DPR 2→1"，两者合计把填充率降到 high 档的 **1/8**。实际结果是 4000 点 × **4 倍像元面积** = 16000 点在 1× 下的填充率 → **只降到 high 档的 1/2**（再多算 8 倍预算），而 Vertex/CPU 成本仍按 4000 算。这是自适应降档"降了档却不省 GPU"的直接原因。
  - `VolumetricStageLights` 的 dust 同理（1500 点），且它同时出现在两个画布中，影响 ×2。
- 修改建议：改读 R3F 自己的 `viewport.dpr`（`setDpr` 会同步更新它，见 fiber 内部 `setDpr → { dpr: resolved }`）：
  ```tsx
  const dpr = useThree((s) => s.viewport.dpr)
  useEffect(() => {
    uniforms.uPixelRatio.value = dpr
  }, [dpr, uniforms])
  ```
  三个组件统一改成这个写法；`VolumetricStageLights` 顺便去掉对 `window` 的依赖（SSR/测试友好）。

---

### [SH-04] drei 的 `MeshReflectorMaterial` 从不 dispose 它的 4 张 RT：每次挂载泄漏 ≈8.9 MB

- 严重级别：P1
- 分类：显存
- 位置：`src/components/canvas/architecture/HexGround.tsx:302`

  ```tsx
  302	      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y + 0.004, 0]} renderOrder={1}>
  303	        <circleGeometry args={[radius * 0.82, 96]} />
  304	        <MeshReflectorMaterial
  305	          resolution={512}
  306	          blur={[320, 120]}
  307	          mixBlur={1}
  308	          mixStrength={0.5}
  309	          mirror={0.45}
  ```

- 现象与证据：
  - `@react-three/drei@10.7.9` 的 `core/MeshReflectorMaterial.js:107-150` 在 `useMemo` 里创建 `fbo1`（512²，`HalfFloatType` + `DepthTexture`）、`fbo2`（512²，HalfFloat）、以及 `BlurPass`——而 `BlurPass`（`materials/BlurPass.js`）内部又创建 `renderTargetA` + `renderTargetB`（各 512² HalfFloat）。
  - 全文件 **没有一处 `dispose`**（`MeshReflectorMaterial.js` 与 `BlurPass.js` 中 `grep dispose` 均为 0 命中）：`useFrame`（151-170）每帧把整场景渲染进 `fbo1`，卸载时这 4 张 RT 和 1 张 depthTexture 只被 JS GC，GL 的 framebuffer/renderbuffer 句柄没有 `deleteFramebuffer`，**显存要等到 WebGL 上下文销毁才回收**。
  - `HexGround` 本身没有为它写任何补偿性 cleanup（组件 236-270 行只有 uniform 与 breathing 逻辑）。
- 影响：
  - 每次挂载泄漏：4 × 512² × 8 B = **8.39 MB** + depth 512²×2 B = **0.52 MB** ≈ **8.9 MB**。
  - 现在是 StrictMode（`src/main.tsx:14`）→ 开发期 mount→unmount→mount 必现 **+8.9 MB**。
  - 生产环境在"整页不刷新"的 SPA 里只泄漏一次；**但一旦按 SH-02 的建议改成"章节离屏就卸载 rig"，每次进入该章都会 +8.9 MB**——所以 SH-02 和本条必须一起处理（SH-02 已给出"渲染门控而非卸载"的方案）。
  - 另外每帧成本：整场景 ≈37 draw call 渲染进 512²（还内含一次传输通道）+ 4 次 512² 卷积（`ConvolutionMaterial.kernel` 长度 5 → `kernel.length - 1 = 4` 个 pass）。
- 修改建议：
  1. 首选**移除**：`HexGround` 的注释（190-199 行）自己说明"真实镜面不是选项"，而且第 3 层 `GLOW_FRAG` 已经在做"模糊反射"的假象。删掉 `<MeshReflectorMaterial>` 这一 mesh，地面观感损失极小，直接省掉 8.9 MB + 41 个 draw call/帧。
  2. 若必须保留，用组件卸载时的补偿（drei 未暴露 fbo，只能拿私有字段，脆弱）：
     ```tsx
     const matRef = useRef<any>(null)
     useEffect(() => () => {
       const m = matRef.current
       m?.fbo1?.dispose?.(); m?.fbo2?.dispose?.()
     }, [])
     ```
     更稳妥的是**升级 drei** 并向上游提 issue（该问题在 10.x 系列长期存在），或本地包装一层自持 `WebGLRenderTarget` 的简化镜面。
  3. 无论哪种方案，`resolution={512}` 可降到 256（模糊本来就会掩盖差异）：256²→ 显存 ÷4，4 个 blur pass 的填充 ÷4。

---

### [SH-05] 等离子球：5 步体积步进 × 2 个 8-tap sin-hash 值噪声 = 每片元 80 次 `sin()`

- 严重级别：P1
- 分类：性能
- 位置：`src/components/canvas/ScrollArchitecture3D.tsx:559`

  ```glsl
  559	  const int STEPS = 5;
  561	  for (int i = 0; i < STEPS; i++) {
  562	    float u = (float(i) + 0.5) / float(STEPS);
  563	    float dist = mix(tEnter, tExit, u);
  566	    vec3 sp = (rd * dist - vCenter) / R;
  569	    vec3 rp = vec3(sp.x * cs - sp.z * sn, sp.y, sp.x * sn + sp.z * cs);
  571	    density += cloudAt(rp * 1.6, drift + u * 0.6);
  572	  }
  ```

- 现象与证据：
  - `cloudAt()`（520-523）= 2 次 `vnoise`；`vnoise()`（508-517）= 8 次 `hash31`；`hash31()`（504-506）= `fract(sin(dot(...)) * 43758.5453)`。合计 **5 × 2 × 8 = 80 次 `sin()` + 约 400 次 ALU/片元**，另有 `pow`、`sqrt`、`normalize` 若干。
  - 该球是 `sphereGeometry args={[CORE_INNER_RADIUS, 64, 48]}`（983 行）= 6144 三角面，正对相机时约占画面直径的 25–35%（半径 ≈0.98，相机距 ≈4.5，fov 42°）。
- 影响：
  - 按"占屏 9%"估算：5.18 Mpx × 9% ≈ **47 万片元/帧 × 80 sin ≈ 3 760 万次 sin/帧**，60 Hz 下 ≈ **22.6 亿次 sin/s**。SFU 吞吐通常是 ALU 的 1/4，集显上这一项很可能就要 **3–8 ms/帧**（需实测）。
  - 这是该章在屏时（`awake`）的主要 GPU 瓶颈，也是"进入章节掉帧"的头号嫌疑——比 draw call 更贵。
- 修改建议：
  1. `STEPS` 5 → **3**（体积感几乎不变，成本 −40%）；medium 档用 `#define` 走 2 步。
  2. 把噪声换成分辨率更低的哈希：`hash31` 用整数位运算（或 `fract(p*0.1031)` 三重乘加）替代 `sin`，可省掉 80 次超越函数。
  3. 更彻底：把云场烘焙成一张 **32³ 的 `DataTexture3D`**（32³×4 B = 128 KB，运行时生成，不违反"零资源"约定），片元里改成 2 次 `texture()` 采样；three r186 在 WebGL2 下原生支持 `Data3DTexture` + 三线性过滤。
  4. 若保留 raymarch，注意 `STEPS` 已经是常量（这点合规），但应加 `#pragma` 之外的 tier 分支，而不是在 medium 档仍跑 5 步。

---

### [SH-06] 每帧 72 次 `CatmullRomCurve3.getTangent()`：three 内部每次分配 2 个 `Vector3`

- 严重级别：P1
- 分类：性能
- 位置：`src/components/canvas/CursorStardustTrail.tsx:904`

  ```tsx
  904	      for (let i = 0; i < RIBBON_SEGMENTS; i++) {
  905	        const t = i / (RIBBON_SEGMENTS - 1)
  906	
  907	        curve.getPoint(t, samplePoint)
  908	        curve.getTangent(t, sampleTangent)
  ```

- 现象与证据：
  - `Curve.prototype.getTangent`（`node_modules/three/src/extras/core/Curve.js:293-313`）实现是差分：`this.getPoint(t1)` / `this.getPoint(t2)` **都不传 target**，因此每次调用都 `new Vector3()` ×2（内部有 `defalut` target，但调用方没传）。
  - `getPoint` 本身是零分配的（`CatmullRomCurve3.js:80-82` 的 module 级 `tmp/tmp2/px`），所以**唯一的分配来自 `getTangent`**。
  - 组件注释（35 行）与 574-588 行的说明都声称"frame loop 里没有 `new`"——这里是一个反例。
- 影响：
  - `RIBBON_SEGMENTS = RIBBON_POINTS * 3 = 72` → **144 个 `Vector3`/帧 ≈ 8.1 KB/帧**（56 B 估算），60 Hz 下 ≈ **486 KB/s** 的持续垃圾。频率不高但**永不停止**（只要指针在动），会在长会话里推高 GC 的 minor 次数，典型表现是每 10–30 s 一次 1–3 ms 的抖动。
  - 附带的隐性成本：`getTangent` 让每帧的样条求值次数从 72 变成 **216**（72 + 144），全部是 Catmull-Rom 的 6 次多项式求值。
- 修改建议：把切线改成对已采样点做前向差分（零分配、且比 `getTangent` 少 2/3 的求值）：
  ```ts
  // 先把 72 个采样点写进预分配的 Float32Array，再差分
  for (let i = 0; i < RIBBON_SEGMENTS; i++) {
    curve.getPoint(i / (RIBBON_SEGMENTS - 1), samplePoint)
    pts[i * 3] = samplePoint.x; pts[i * 3 + 1] = samplePoint.y; pts[i * 3 + 2] = samplePoint.z
  }
  for (let i = 0; i < RIBBON_SEGMENTS; i++) {
    const a = Math.max(0, i - 1) * 3, b = Math.min(RIBBON_SEGMENTS - 1, i + 1) * 3
    const tx = pts[b] - pts[a], ty = pts[b + 1] - pts[a + 1]   // 已是切线方向
    ...
  }
  ```
  若坚持用 three 的 API，则必须自己实现 `getTangentSafe(t, out)`（`out.copy(this.getPoint(t2, _a)).sub(this.getPoint(t1, _b))`），两个 module 级 scratch 即可。

---

### [SH-07] 一次发射只改 ≤56 个槽，却整缓冲重传 128 KB

- 严重级别：P2
- 分类：性能
- 位置：`src/components/canvas/CursorStardustTrail.tsx:864`

  ```tsx
  864	    /* 5. Upload the particle buffers. */
  865	    if (spawned) {
  866	      ;(geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  867	      ;(geometry.getAttribute('aVel') as THREE.BufferAttribute).needsUpdate = true
  868	      ;(geometry.getAttribute('aKind') as THREE.BufferAttribute).needsUpdate = true
  869	      ;(geometry.getAttribute('aSeed') as THREE.BufferAttribute).needsUpdate = true
  870	    }
  871	    ;(geometry.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true
  ```

- 现象与证据：
  - `needsUpdate = true` 在 three 里等价于"整块 buffer 重传"（`WebGLAttributes.update` 用 `bufferSubData(0, array)` 全量上传），没有区间概念。
  - 每帧的发射量上限是 `MAX_EMIT_PER_FRAME = 56`（72 行），环形游标只覆盖 56 个连续槽（`sim.cursor`）。
  - 属性字节数：`position` 3 float、`aVel` 3、`aKind` 1、`aSeed` 1、`aLife` 1、`aSize` 1 → 40 B/粒子 × 4000 = **160 KB VRAM**；一次发射上传 `position`(48 KB)+`aVel`(48)+`aKind`(16)+`aSeed`(16)= **128 KB**，而真实变化 ≤ 56 槽 × 12 B ≈ **0.67 KB**（每个属性各自 ≤2.2 KB）。
  - `aLife` 每帧无条件上传 16 KB（它确实每帧都变，但只有活跃粒子在变）。
- 影响：
  - 指针持续移动时（`EMIT_DENSITY = 90/世界单位`，正常速度约 550 splat/s → 每帧都在发射）：**128 KB + 16 KB = 144 KB/帧 ≈ 8.6 MB/s** 的无效上行；其中 >98% 是重复数据。移动端 UMA 上这是实打实的带宽与同步开销。
- 修改建议：three r159+ 支持 `addUpdateRange`（r186 可用）：
  ```ts
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
  posAttr.clearUpdateRanges()
  if (sim.cursor >= n) posAttr.addUpdateRange((sim.cursor - n) * 3, n * 3)
  else { posAttr.addUpdateRange(0, sim.cursor * 3)                 // 环回的两段
         posAttr.addUpdateRange((count - (n - sim.cursor)) * 3, (n - sim.cursor) * 3) }
  posAttr.needsUpdate = true
  ```
  （`addUpdateRange(offset, count)` 的单位是**元素**，不是字节；three 内部会乘 `array.BYTES_PER_ELEMENT`。）
  另外 4 次 `geometry.getAttribute('...')` 是每帧字符串查表，建议在 `useMemo` 里把 6 个 attribute 引用直接存下来。

---

### [SH-08] 涟漪环池整套（3 材质 + 2 段 shader + 3 mesh）永远不会被激活

- 严重级别：P2
- 分类：可维护性
- 位置：`src/components/canvas/CursorStardustTrail.tsx:947`

  ```tsx
  947	    for (let i = 0; i < rings.length; i++) {
  948	      const ring = rings[i]
  949	      const mesh = ringRefs.current[i]
  950	      if (!mesh) continue
  951	
  952	      if (ring.life <= 0) {
  953	        mesh.visible = false
  954	        continue
  955	      }
  956	
  957	      ring.life -= dt / RING_LIFE
  ```

- 现象与证据：
  - `ring.life` 的初值是 0（662 行 `Array.from(... => ({ life: 0, ... }))`），全文件**没有任何一处把它置 > 0**（`grep 'ring.life'` 只有 952/957/958/959/965 五处，全是递减与判断）。
  - 第七节（737-746 行）的注释明确说明点击反馈已迁到 `src/components/layout/ClickRipple.tsx`，"Nothing here should re-introduce a click response"。
  - 同批死代码：`sim.pendingBurst`（496 行）从未被消费；`sim.bursts`（500 行）从未自增；`RING_FRAGMENT`（367-394）+ `RING_VERTEX`（396-403）+ `ringMaterials`（675-692）+ 3 个 `<mesh><planeGeometry/></mesh>`（1004-1016）全部只为这个不会发生的分支服务。
- 影响：
  - 代码量：≈110 行无用 shader/池逻辑 + 3 个常驻 mesh（`visible=false`，不产生 draw call，但占用 R3F 子树、每帧 `ringRefs` 遍历 3 次）。
  - 认知成本更高：读者会以为点击有 3D 反馈，并在 `useFrame` 里寻找触发点——实际是死路。也解释了为什么 `RING_LIFE`、`RING_POOL` 这些常量"看起来在被使用"。
- 修改建议：整段删除（`RING_*` 常量、两个 shader、`rings`/`ringMaterials`/`ringRefs`、`useFrame` 第 7 节、3 个 mesh），以及 `sim.pendingBurst` / `sim.bursts` / `LIFETIME` 之外的 `SPARK_AGE_RATE` 若也不再需要可一并核对（注意 `aKind` 仍然被 stardust 分支使用，不能删）。若产品上要恢复点击波纹，就把它做完整并写进测试。

---

### [SH-09] `uTime` 无界累加：`sin(uTime * 42.0)` 在长会话后阶梯化

- 严重级别：P2
- 分类：正确性
- 位置：`src/components/canvas/CursorStardustTrail.tsx:270`

  ```glsl
  266	    if (vKind > 0.5) {
  267	      // Burst spark: the palette's two leading hues interleaved, flickering hard.
  268	      float pick = 0.5 + 0.5 * sin(vSeed * 31.7);
  269	      col = mix(uPrimary, uSecondary, pick);
  270	      float flicker = 0.45 + 0.55 * sin(uTime * 42.0 + vSeed * 91.0);
  271	      emission = 2.2 + flicker * 1.9;
  ```

  驱动侧：`CursorStardustTrail.tsx:764` `particleUniforms.uTime.value = time`，`time = state.clock.elapsedTime`（`ScrollArchitecture3D.tsx:1346` 的注释也承认 clock 是页面级 uptime）。

- 现象与证据：
  - 顶点/片元里 `uTime` 是 `highp float`（float32，23 位尾数）。`42·t` 的 ulp 随 t 线性变差：`ulp(x) ≈ x·2⁻²³`。
  - t = 1 h（3 600 s）→ 参数 151 200 → ulp ≈ **0.018 rad**（约周期的 0.3%）；
  - t = 10 h → 参数 1.5 M → ulp ≈ **0.18 rad**（约 1.2°），`sin` 的相位开始明显跳变；
  - t = 30 h → ulp ≈ 0.5 rad → 闪烁变成随机噪点。
  - 同类但更轻微：`VolumetricStageLights` 的 `sin(uTime*3.1 + aSeed*87.0)`、`AuroraCurtain` 的 `uTime*0.022`（系数小，几十小时才有感）。`AuroraCurtain` 的 `uFlow`（549-550）虽然也是无界累加，但乘数只有 0.28–1.7，问题远小于 `*42`。
  - 另一个隐患：`AuroraCurtain.tsx:342` 的注释专门写过"不要在 shader 里用 `uTime * energy`，否则乘上总 uptime 会跳"——同样的推理没有应用到 `*42.0` 的频率上。
- 影响：
  - 个人展厅常见用法是"开着不动几小时"，10 小时后爆闪的闪烁会变成可见的阶梯/抖动伪影；这个值是 42 rad/s（≈6.7 Hz），恰好是最容易被人眼捕捉到不连续的频段。
- 修改建议：在 CPU 侧维护一个**回绕的相位**，不要在 shader 里乘大系数：
  ```ts
  // useFrame 内，dt 已知
  const u = particleUniforms.uFlicker   // { value: 0 }
  u.value = (u.value + dt * 42.0) % (Math.PI * 2)
  ```
  ```glsl
  // 片元：sin(uFlicker + vSeed * 91.0)   —— 参数恒在 [0, 2π) + seed 项
  ```
  `vSeed * 91.0` 最大 91，ulp 约 1e-5，无需处理。同样的做法可用于 `VolumetricStageLights` 的 `uTime*3.1`（回绕到 `2π/3.1`）；`uTime` 本身继续留给线性项使用。

---

### [SH-10] `supportsWebGL()` 放行 WebGL1，但 three r186 已移除 WebGL1 支持

- 严重级别：P2
- 分类：可移植性
- 位置：`src/lib/device.ts:29`

  ```ts
  29	    return Boolean(
  30	      canvas.getContext('webgl2') ??
  31	        canvas.getContext('webgl') ??
  32	        canvas.getContext('experimental-webgl'),
  33	    )
  ```

- 现象与证据：
  - 项目锁定 `three ^0.186.1`，而 three 从 **r163** 起删除了 WebGL1 渲染器，`WebGLRenderer` 构造时只请求 `webgl2` 上下文，失败即抛 `Error: WebGL context could not be created`。
  - `supportsWebGL()` 只要 `webgl`（WebGL1）上下文能创建就返回 `true`，随后 `SceneCanvas.tsx:306` 与 `ScrollArchitecture3D.tsx:1729` 的 `if (!webgl) return null` 会放行，Canvas 挂载 → 抛错 → 整个 React 树被 ErrorBoundary 之外的异常打断（本仓未见针对 canvas 的错误边界）。
  - 同一处还有两个小问题：探测用的一次性 canvas 上下文没有 `WEBGL_lose_context.loseContext()` 释放，会计入浏览器 ~16 个上下文的配额；且每次调用都新建 canvas（`SceneCanvas.tsx:213`、`ScrollArchitecture3D.tsx:1650` 各调一次）。
  - 相关：`HexGround.tsx:176` 的 `fwidth()` 与 `ScrollArchitecture3D` 的 `dFdx` 依赖在 three r186 下没问题（WebGL2 已内含导数），但一旦有人为了兼容去补 WebGL1 回退，这些 shader 会直接编译失败——`extensions: { derivatives: true }` 在当前 three 版本已不再被 `WebGLProgram` 输出（`WebGLProgram.js` 中已无 `derivatives` 分支）。
- 影响：
  - WebGL1-only 设备（老旧 Android WebView、部分国产 ROM 的降级模式、远程桌面/软件渲染回退）会得到**白屏 + 控制台异常**，而不是"优雅降级到纯 DOM"——这正是 `device.ts` 注释想保证的行为。
- 修改建议：
  ```ts
  export function supportsWebGL(): boolean {
    if (typeof window === 'undefined') return false
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return false
    // 主动归还上下文，避免计入浏览器的上下文配额
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  }
  ```
  再补一层能力探测（`gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096`、`EXT_color_buffer_float`），把结果缓存成模块级单例（`let cached: boolean | null`），避免两个画布各建一次上下文。SH-01 之后还需要 `EXT_color_buffer_float` 才能建半浮点 RT，无该扩展时应直接切 medium 档。

---

### [SH-11] 全仓没有 `webglcontextlost` / `webglcontextrestored` 处理，上下文丢失即永久黑屏

- 严重级别：P2
- 分类：正确性
- 位置：`src/components/canvas/SceneCanvas.tsx:325`（两个画布的 `onCreated` 都只做了诊断与注册，没有挂上下文事件）

  ```tsx
  325	      onCreated={({ gl, scene, camera, size }) => {
  ...
  339	        gl.debug.checkShaderErrors = import.meta.env.DEV
  341	        // Transparent so the DOM's ambient gradient layers show through.
  342	        gl.setClearColor(0x000000, 0)
  344	        setCanvasActive(true)
  ```

- 现象与证据：
  - `grep webglcontextlost|webglcontextrestored|isContextLost|forceContextLoss src` → **0 命中**（`ScrollArchitecture3D.tsx:1746` 的 `onCreated` 同样没有）。
  - three 的 `WebGLRenderer` 自己不注册 `webglcontextlost`（只有 `dispose()`/`forceContextLoss()`），R3F 也不代管。浏览器在移动端切后台、GPU 进程崩溃、显存压力时会让上下文丢失，之后所有 `gl.*` 调用变成 no-op，画布停留最后一帧或全黑。
  - 由于本项目是**双画布 + 单时钟**架构（`frameBridge.ts`），一旦某个画布丢失上下文，`advanceR3F` 仍会继续遍历两个 root 调 `gl.render`，每帧在空上下文上产生报错刷屏。
- 影响：
  - iOS Safari 切后台再回来（本项目明确把 iOS 列为目标）有相当概率触发上下文丢失；表现为"回到页面后所有 3D 元素消失，滚动仍在动"，只有刷新能恢复。这是最容易被用户当成"网站坏了"的故障。
- 修改建议：在 `onCreated` 里挂事件，丢失时暂停该 root 的 advance 计数，恢复时重建：
  ```ts
  const canvas = gl.domElement
  const onLost = (e: Event) => { e.preventDefault(); setCanvasActive(false) }   // 允许恢复
  const onRestored = () => { gl.setPixelRatio(gl.getPixelRatio()); setCanvasActive(true) }
  canvas.addEventListener('webglcontextlost', onLost, false)
  canvas.addEventListener('webglcontextrestored', onRestored, false)
  ```
  `e.preventDefault()` 是必需的第一步（否则浏览器不会尝试恢复）。R3F 侧还需要 `useThree((s) => s.invalidate)` + 手动重建材质（three 会在恢复后自动重编译 program 与重传纹理/几何，前提是 GL 对象句柄被 three 记录过——自建 `ShaderMaterial`/`BufferGeometry` 若已被 `dispose`（StrictMode 情形，见 SH-18）则不会自动恢复，需要重新挂载组件）。最省事的稳健做法是：`onRestored` 里 `setWebgl(false)` → 下一帧 `true`，强制整棵 canvas 子树重建。

---

### [SH-12] 每帧 `root.traverse` + 每材质新建一个 `[mat]` 数组，并强制全体材质 `transparent = true`

- 严重级别：P2
- 分类：性能
- 位置：`src/components/canvas/ScrollArchitecture3D.tsx:1457`

  ```tsx
  1457	    root?.traverse((obj) => {
  1458	      const mat = (obj as THREE.Mesh).material
  1459	      if (!mat) return
  1460	      const list = Array.isArray(mat) ? mat : [mat]
  1461	      for (const m of list) {
  ...
  1488	        anyMat.transparent = true
  1489	        anyMat.opacity = base * fade
  ```

- 现象与证据：
  - `[mat]` 是每次遍历、每个对象新建的数组；场景实测对象数 ≈37（HexGround 4 + 编排层 21 + 水晶 5 + 流 1 + 导管 1 + 舞台灯 4）→ **≈37 个小数组/帧 ≈ 1.5 KB/帧**（数组头 ~32 B + 元素槽 8 B），60 Hz ≈ **90 KB/s**。同函数 1375 行的 `const refs = [infraRef.current, ...]` 也是每帧一个新数组。
  - `anyMat.transparent = true` 每帧给**所有**材质置位：把一个本来不透明的材质转成 transparent 会让 three 把它从 `opaqueObjects` 移到 `transmissiveObjects`/`transparentObjects` 列表——这既改变排序，也会让 SH-01 的传输通道多拿到一批候选对象。它只需要执行一次。
  - `baseOpacity` 是 `WeakMap`（206 行），首次写入后每帧仍是 2 次 map 查询/材质。
  - 另外，`transparent` 切换会触发 `material.needsUpdate` 语义（three 内部按 `material.version` 重编译依赖）——虽然在赋值同值时 version 不增，但首次每帧来回切换材质分组是实打实的排序成本。
- 影响：
  - 每帧 ≈37 次 WeakMap 查 + 37 个数组 + 37 次属性写。单看不大（约 30–60 µs/帧，需实测），但它是"每帧都做一次只在 fade 变化时才需要做的事"——`fade` 在 p∈[0, 0.7] 区间恒为 1，也就是**整个章节前 70% 的滚动过程中都在白做**。
- 修改建议：把 fade 应用改成"只在 fade 变化时执行"：
  ```tsx
  const lastFade = useRef(1)
  ...
  if (Math.abs(fade - lastFade.current) > 0.002) {
    lastFade.current = fade
    root.traverse(applyFade)          // 并把 [mat] 换成 for 循环 + 单材质特判
  }
  ```
  ```tsx
  // 单对象：避免建数组
  if (Array.isArray(mat)) { for (const m of mat) apply(m) } else apply(mat)
  ```
  `transparent = true` 移到 `useEffect`（每个材质一次）。同时 1375 行的 `refs` 可以在首次拿到三个 group 后就缓存成 `useRef<THREE.Group[]>`。

---

### [SH-13] 三份各自实现的 sin-hash 噪声：锥体每片元 24 次 `sin()`，且 sin-hash 在移动端会带状

- 严重级别：P2
- 分类：性能
- 位置：`src/components/canvas/VolumetricStageLights.tsx:141`（另有 `ScrollArchitecture3D.tsx:504`、`AuroraCurtain.tsx:212`）

  ```glsl
  115	const PERLIN = /* glsl */ `
  116	  float hash31(vec3 p) {
  117	    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  118	  }
  ...
  141	  float fbm3(vec3 p) {
  ...
  144	    for (int i = 0; i < 3; i++) {
  145	      total += amplitude * gradientNoise(p);
  146	      p *= 2.02;
  147	      amplitude *= 0.5;
  148	    }
  ```

- 现象与证据：
  - `VolumetricStageLights`：`fbm3` = 3 octaves × `gradientNoise` 的 8 个角 = **24 次 `hash31` = 24 次 `sin()`/片元**，每个锥体 `side: DoubleSide`（429 行）→ 一条视线通常会穿过 2 层壳，**3 个锥体 × 2 层 = 最多 6 次该片元着色**。锥体总覆盖约半屏时，等效于每像素 ~72 次 `sin`。而且 225 行的 `if (alpha < 0.002) discard;` 在算完整个 fbm 之后才执行，`discard` 还会让部分 GPU 失去 early-z 优化（这里 `depthWrite:false`，影响有限，但压缩/延迟渲染（tile-based）会因此退化成非快速路径）。
  - `ScrollArchitecture3D` 的 `PLASMA_FRAGMENT` 自己也定义了一份 `hash31`/`vnoise`（504-517），与 `PERLIN` 里的几乎同构，只是名字不同；`AuroraCurtain` 又用 `hash21`（212-216）做了第三种。**同一份噪声在三处独立维护**，其中一处的 `vnoise` 用 `f*f*(3-2f)` 平滑，另一处用 quintic —— 视觉参数无法统一调。
  - sin-hash 的精度问题：`sin(dot(p, ...))` 的输入在大坐标下（锥体 `vWorldPos * 0.22` 只有个位数，尚可；但 `ScrollArchitecture3D` 的 `drift = uTime * 0.35` 会把 y 坐标推到 10⁴ 量级，30 小时后 sin 的输入超过 10⁵）在移动端 `mediump` 或高精度下都会出现格点带状。`AuroraCurtain` 的 `hash21`（乘加 + fract）没有这个问题，是正确的写法。
- 影响：
  - 锥体是该章与 Hero 都用的常驻元素。3 个 DoubleSide 锥体 ≈ 6 层半屏幕覆盖 × 24 sin，接近 SH-05 的量级（虽然面积小些）。需实测，但在集显上与 SH-05、SH-14 叠加后很容易吃掉 30–50% 的帧预算。
  - 三份重复实现意味着改一次噪声要改三个文件，且视觉上会不一致。
- 修改建议：
  1. 抽出 `src/lib/shaders/noise.glsl.ts` 单文件导出 `SINLESS_HASH` / `VALUE_NOISE_3D` / `FBM`，三个组件 `import` 后插值进模板字符串（`${VALUE_NOISE}`）。注意不要用 `#include`——本项目都是 `ShaderMaterial`，three 的 chunk 注入**不会**作用于自定义 shader（`FlowFieldParticles.tsx:401-404` 的注释已经踩过这个坑）。
  2. `hash31` 换成无 sin 版本：`fract(p * 0.1031)` 三次叉乘（Dave Hoskins hash），成本约 1/5。
  3. `fbm3` 的 3 octaves 在 medium 档降为 2（用 uniform 乘末 octave 而不是分支，参考 `AuroraCurtain.tsx:247` 已有的 `octave = (i == 3) ? detail : 1.0` 写法）。
  4. 把 `discard` 换成 `alpha` 连续衰减到 0（additive 下 `alpha≈0` 与 discard 视觉等价），让 GPU 保留早期压缩路径。

---

### [SH-14] Aurora 全屏 additive + 2×fBM(4 oct) + `discard`，与 warp 峰值叠加成多层 overdraw

- 严重级别：P2
- 分类：性能
- 位置：`src/components/canvas/AuroraCurtain.tsx:242`

  ```glsl
  242	  float fbm(vec2 p, float detail) {
  243	    float sum = 0.0;
  244	    float amp = 0.5;
  245	
  246	    for (int i = 0; i < 4; i++) {
  247	      float octave = (i == 3) ? detail : 1.0;
  248	      sum += amp * octave * valueNoise(p);
  249	      p = p * 2.03 + vec2(19.7, 7.3);
  250	      amp *= 0.5;
  251	    }
  ```

- 现象与证据：
  - 该 mesh 是 25 半径 / 42 高的开放圆柱壳，`frustumCulled={false}`、`renderOrder={-1}`、相机在其内部 → **每帧全屏一遍**（含 `discard` 分支之前的全部 ALU）。
  - 每片元成本：`fbm` 被调用 **2 次**（267 行 `broad`、336 行 `fibre`），每次 4 octaves × `valueNoise`（4 次 `hash21` + smoothstep 混合）→ **≈32 次 `hash21`**（每次约 6-8 ALU）≈ 200–250 ALU/片元，再加 3 次 `sin`（290-292）、若干 `pow`/`exp`/`smoothstep`，以及 365 行的 `hash21(gl_FragCoord.xy)` 抖动。
  - 而同一画布里还有：8000 个 additive 点精灵、4500 点的 trail、Bloom（`mipmapBlur` → 8 级 mip ≈ 9 个 pass）、Vignette、Noise。全屏 additive 层是没法靠深度剔除的。
  - warp 峰值时点精灵会膨胀：`heightScale = 1 + uWarp*(11-1)`（`FlowFieldParticles.tsx:368`），基础 `gl_PointSize ≈ 0.055×1×2×(300/7) ≈ 4.7 px` → 峰值 **≈52 px**（clamp 上限 200）。8000 × 52² ≈ **2160 万片元/帧**（约 3.7 个全屏），其中大部分被 `if (dist > 1.0) discard`（447 行）丢掉，但 ALU 已经付了。
- 影响：
  - Aurora 一层 ≈ 5.18 Mpx × 230 ALU ≈ **1.2 GALU/帧**（60 Hz → 72 GALU/s）；warp 峰值额外 ≈2160 万片元 × ~25 ALU 的丢弃成本。两项叠加时，集显很容易掉到 30 fps 以下——这正是 `PerformanceMonitor` 在 45 fps 处降档的场景，而降档后又因为 SH-03 的 bug 没能真正省下填充。
- 修改建议：
  1. medium 档（`uDetail = 0`）除了第 4 octave 之外，把 `fibre` 那次 `fbm` 整体降到 2 octaves（现在只是把最高频乘 0，中间两个 octave 仍在算）。
  2. `fbm` 的两次调用可以合并：`broad` 用 `uv.x*3.4`、`fibre` 用 `uv.x*22.0`，频率差 6.5×，不能直接复用；但 `broad` 只被用来做 3 个标量（fold/hem/sway），可以降到 3 octaves 而肉眼无差。
  3. `discard`（367 行）改成像 `AuroraCurtain` 的 alpha 连续衰减——additive 下 `alpha < 0.004` 本来就不贡献颜色，改成 `return vec4(0)` 之外的连续 0 值可避免 `discard` 的 tile 退化。
  4. 若还嫌贵：把 aurora 渲染到一张 **1/2 分辨率的 RT**（它全是低频渐变），再放大合成。或者干脆降低 `CURTAIN_HEIGHT` 让它在 `uv.y` 两端更快衰减（现在 `envelope` 在 0.92 才开始收）。

---

### [SH-15] 1936 行 / 75 KB 的单文件承载 7 段 GLSL + 5 个图层组件 + 装配逻辑 + Canvas

- 严重级别：P3
- 分类：可维护性
- 位置：`src/components/canvas/ScrollArchitecture3D.tsx:1`（文件总体）与 `:1845`（shader 定义在组件之后）

  ```tsx
  1	import { useEffect, useMemo, useRef, useState } from 'react'
  2	import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
  3	import { Billboard, Environment, Lightformer } from '@react-three/drei'
  ...
  1845	export default ScrollArchitecture3D
  1851	const RIM_VERTEX = `
  1863	const RIM_FRAGMENT = `
  ```

- 现象与证据：
  - 单文件职责至少 5 个：GLSL 库（EDGE / STREAM / PLASMA / DISPERSION / RIM / CONTACT / CONDUIT，共 7 段）＋ 3 个图层组件（Infrastructure/Orchestration/Spatial）＋ 2 个数据层（DataStreams/DataConduits）＋ 装配 RIg（相机路径、fade、拾取、分帧挂载）＋ Canvas 外壳（webgl 探测、预热、boot veil 握手、Environment、灯光、fog）。
  - `geometry.ts` 只有 225 行就承担了"程序化几何"职责，而 shader 却全留在 1936 行的大文件里 —— **同一个分层原则没有贯彻**：`architecture/` 目录里已有 `cameraPath.ts` / `geometry.ts` / `layers.ts` / `HexGround.tsx`，唯独 shader 没有独立文件。
  - `RIM_VERTEX`(1851) / `RIM_FRAGMENT`(1863) / `CONTACT_VERTEX`(1878) / `CORE_GLOW_FRAGMENT`(1902) 定义在**使用它们的 `SpatialLayer`（941、976 行）之后**。当前靠"函数体晚于模块初始化执行"侥幸成立（TDZ 只在模块求值期抛错），但任何把 `SpatialLayer` 提到模块顶层调用（如 `const EL = SpatialLayer(...)`、或测试里直接 eval 这段 JSX 前的辅助函数）的改动都会立刻踩 TDZ。
  - 注释密度过高且大量记录"历史修复原因"（例如 716-731 行连续 5 段关于 `uDeep` 颜色的注释堆叠、1603-1612 关于已删除的 MeshTransmissionMaterial），与代码现状不一致（见"其他小问题"）。
- 影响：
  - 维护成本：改动任何一处 shader 都要在 2000 行里跳转；`git blame`/review 的有效信息密度被历史注释稀释。
  - 与审查项 6 的"职责是否单一"直接相关：不单一，且拆分成本很低（已有 `architecture/` 目录）。
- 修改建议：
  ```
  architecture/
    shaders/edge.glsl.ts        EDGE_VERTEX / EDGE_FRAGMENT
    shaders/stream.glsl.ts      STREAM_*
    shaders/plasma.glsl.ts      PLASMA_*（含 noise 引用）
    shaders/dispersion.glsl.ts  DISPERSION_*
    shaders/rim.glsl.ts         RIM_* / CONTACT_* / CORE_GLOW_FRAGMENT   ← 顺带修 TDZ
    shaders/conduit.glsl.ts     CONDUIT_*
    layers/Infrastructure.tsx   （转发到 HexGround）
    layers/Orchestration.tsx
    layers/Spatial.tsx
    layers/DataStreams.tsx
    layers/DataConduits.tsx
    ArchitectureRig.tsx
  ScrollArchitecture3D.tsx      ← 只剩 Canvas + 预热 + 装配，目标 <300 行
  ```
  同时把 `EDGE_FRAGMENT`/`CONDUIT_FRAGMENT` 里的魔法数（`0.34`、`0.9`、`pow(...,8.0)`、`pow(...,22.0)`、`1.0 + head*2.6`）收拢成文件顶部的常量块，与 `cameraPath.ts` 的 `PHASE` 风格一致。

---

### [SH-16] `CurlVolume.step` 实际存的是 `1/step`，字段名与注释都和语义相反

- 严重级别：P3
- 分类：可维护性
- 位置：`src/lib/curlNoise.ts:245`（定义）与 `:272`（返回）与 `:293`（使用）

  ```ts
  245	  const step = (extent * 2) / (resolution - 1)
  246	  const invStep = 1 / step
  ...
  272	  return { data, resolution, extent, step: invStep }
  ```

  ```ts
  203	  /** World-space step between adjacent lattice samples. */
  204	  step: number
  ...
  292	  // World → lattice coordinates.
  293	  const gx = (x + extent) * step
  ```

- 现象与证据：
  - 类型注释说 `step` 是"相邻格点的世界空间步长"，实际存的是它的**倒数**（`invStep`）；`sampleCurl` 里 `(x + extent) * step` 只有在 `step` 是倒数时才正确。
  - 于是第 246 行算出的 `step`（真步长）和返回对象里的 `step`（倒数）同名不同义，读者要读两遍才能确认公式是对的（它是对的，但只对在命名上）。
  - 顺带：`sampleCurl` 每点都要 `const { data, resolution, extent, step } = volume` 解构一次（8000 次/帧），以及函数签名里的 `o` 参数恒传 0（`FlowFieldParticles.tsx:940`），徒增心智负担。
- 影响：
  - 任何后续调参（改 `resolution` 或 `extent`）的人极易把 `step`/`invStep` 弄反，症状是"粒子全部被 clamp 到格点 0 或 1，流场变成常量"。属于典型的"正确但危险"的命名债。
- 修改建议：字段改名为 `invStep`（或 `gridScale`），并保留派生注释：
  ```ts
  export interface CurlVolume {
    data: Float32Array
    resolution: number
    extent: number
    /** 1 / worldUnitsPerCell —— 直接用于 x → lattice 的线性变换。 */
    invStep: number
  }
  ```
  `sampleCurl` 内部把 `const { data, resolution, extent, invStep } = volume` 提到循环外（在当前调用点做不到，但把 `data`/`resolution`/`invStep` 作为独立参数传入即可，8000 次解构 → 0），并删掉恒为 0 的 `o` 参数。

---

### [SH-17] `VfxParticleEngine.draw()` 每粒子构造 2 个 `rgba()` 字符串 + 2 次 stroke 状态切换

- 严重级别：P3
- 分类：性能
- 位置：`src/utils/vfxParticleEngine.ts:386`

  ```ts
  386	      const tailX = p.x - p.vx * p.stretch
  387	      const tailY = p.y - p.vy * p.stretch
  388	
  389	      ctx.strokeStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha})`
  390	      ctx.lineWidth = p.size
  391	      ctx.beginPath()
  392	      ctx.moveTo(tailX, tailY)
  393	      ctx.lineTo(p.x, p.y)
  394	      ctx.stroke()
  395	
  396	      // Hot white core on the head, so sparks read as metal vapour rather than
  397	      // as coloured chalk.
  398	      if (p.size > 0.9) {
  399	        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.75})`
  ```

- 现象与证据：
  - 每个存活粒子：1–2 次模板字符串拼接（每次 `rgba(...)` 都要走 Canvas2D 的 CSS 颜色解析器）+ 1–2 次 `strokeStyle` 赋值 + `beginPath/moveTo/lineTo/stroke` 各一次。容量默认 512（`FabrikCreature.tsx:578` 的 `VFX_PARTICLE_CAPACITY`），碰撞爆发时可达数百个同时存活。
  - 同类分配：`spawn` 在弹跳分裂时构造 `childOptions` 对象（325-341），`fractalLightning` 每 pass 建一个新数组（131、146）。
  - 正面：`step()` 与 `draw()` 分离、`computeIllumination` 复用出参、`Math.exp(-drag*dt)` 帧率无关——这些设计是对的。
- 影响：
  - 400 个存活粒子时：≈600 个字符串/帧（每帧约 600 × 60 = 3.6 万字符串/s）+ 600 次 CSS 颜色解析 + 800 次状态切换。Canvas2D 的颜色解析是**每条路径最快的隐藏税**之一（每帧几毫秒级），在 30 fps 的移动端尤其明显。需实测（Chrome Performance 面板看 `Paint`/`JavaScript` 占比）。
- 修改建议：
  1. 按颜色分桶：粒子颜色来自 palette，只有 3–4 种可能 → 每帧先按色分组成 `Path2D`（或至少按色 `beginPath` 批量 `moveTo/lineTo` 后一次性 `stroke`），把 400 次 stroke 降到 4 次。
  2. 透明度无法批量（每粒子不同）→ 若要保留逐粒子 alpha，改用**离屏 canvas 精灵 + `drawImage`**（`globalAlpha` 赋值比颜色字符串便宜得多），或用 `ctx.globalAlpha = alpha` + 单一 `strokeStyle`（`globalAlpha` 是纯数值赋值，不触发颜色解析）。
  3. `spawn` 的分裂路径复用模块级 `childOptions` 模板对象改字段，避免每分裂一次分配一次。

---

### [SH-18] StrictMode：curl 体积双重烘焙，且 `geometry`/`material` 在模拟卸载后被 dispose 却继续使用

- 严重级别：P3
- 分类：显存
- 位置：`src/components/canvas/FlowFieldParticles.tsx:543`（烘焙）与 `:704`（dispose）

  ```tsx
  543	  const curlVolume = useMemo<CurlVolume>(
  544	    () =>
  545	      buildCurlVolume({
  546	        resolution: tier === 'high' ? 20 : 14,
  ...
  704	  /* ── Dispose GPU resources ─────────────────────────────────────────────── */
  705	  useEffect(
  706	    () => () => {
  707	      geometry.dispose()
  708	      material.dispose()
  709	    },
  710	    [geometry, material],
  711	  )
  ```

- 现象与证据：
  - `src/main.tsx:14` 用的是 `<StrictMode>`。React 19 在开发模式下：①双重调用渲染函数（`useMemo` 的工厂被跑两次，第一次的结果被丢弃）；②挂载后立即模拟"卸载→再挂载"（effect cleanup 会真的执行）。
  - ①的后果：`buildCurlVolume` 被跑**两次**。high 档 `resolution = 20` → 20³ = 8 000 个格点 × 12 次 `snoise3` = **96 000 次 simplex**，两次共 19.2 万次（`curlNoise.ts:237-273` 的文档按 18³ ≈ 7 万次估算"几毫秒"，20³ 是 96 000 次，实测估计 8–20 ms）。
  - ②的后果：`geometry.dispose()` + `material.dispose()` 在模拟卸载时执行，但 `sim`/`geometry`/`material` 的 `useMemo` 值在重新挂载时**不会重建**（同一 fiber）。于是首帧要重新上传 224 KB 顶点数据（position 96 KB + color 96 KB + aSize 32 KB）并**重新编译自定义 shader program**——正是 `SceneCanvas.tsx:326-339` 注释里说"编译一次要几百毫秒"的那件事。
  - 类似的 dispose-then-reuse 也发生在 `AuroraCurtain`（509-515）、`VolumetricStageLights`（538-546）、`CursorStardustTrail`（726-735）、`ScrollArchitecture3D` 的多个 `useEffect(() => () => x.dispose())`。
  - 生产环境不受影响（无 StrictMode），所以这是**开发期体验 + 冷启动测量噪声**问题。
- 影响：
  - dev 首屏多花 8–20 ms（烘焙）+ 一次 program 重编译（数百 ms，视驱动）；开发机上的 FPS 采样前 1–2 秒会被污染，干扰 SH-02 那类"是否在渲染"的验证。
  - **不是** GPU 泄漏：被丢弃的那份 `BufferGeometry` 从未渲染过，three 是惰性上传的，不占显存；真正的显存风险在 SH-04（drei 的 RT）。
- 修改建议：
  1. 烘焙加模块级缓存，避免 StrictMode/HMR 重跑：
     ```ts
     const curlCache = new Map<string, CurlVolume>()
     const key = `${tier}-20-8-1.15`
     const curlVolume = useMemo(() => {
       let v = curlCache.get(key)
       if (!v) { v = buildCurlVolume({...}); curlCache.set(key, v) }
       return v
     }, [tier])
     ```
     （体积数据是纯 CPU 的 `Float32Array`，缓存不会泄漏 GPU 资源；两个档位合计 8 000+2 744 格 × 3 × 4 B ≈ 129 KB。）
  2. dispose 只做一次：把 cleanup 挂在**真正卸载**上（例如把 `geometry`/`material` 放进一个 `useRef` + 只依赖 `[]` 的 effect，或在 R3F 用 `dispose={null}` + 自己的 unmount 钩子），不要依赖 `[geometry, material]` 的变化——它们在 StrictMode 下不会变，反而会在模拟卸载时被清掉。
  3. 给 `FlowFieldParticles` 的材质加 `dispose={null}` 显式说明"由我负责生命周期"，避免后续有人加第二个 dispose 造成双重释放。

---

## 其他小问题

1. **`Environment` 的 `frames` 与注释不符**：`ScrollArchitecture3D.tsx:1783-1794` 的注释详细论证"`frames={8}` 而不是一次性烘焙"，代码却是 `frames={1}`。要么改注释，要么改代码——`frames={1}` 在 `MeshPhysicalMaterial(transmission)` + `metalness 0.9` 的面上确实可能捕到空场景（正是注释警告的 bug）。
2. **TDZ 风险**：`RIM_VERTEX`(1851)/`RIM_FRAGMENT`(1863)/`CONTACT_VERTEX`(1878)/`CORE_GLOW_FRAGMENT`(1902) 定义在使用点（941、976）之后，建议随 SH-15 一起前移。
3. **`MAX_SPEED` 声明在 8000 次循环体内**（`FlowFieldParticles.tsx:994`）：`const MAX_SPEED = 26` 每粒子求值一次，提到模块常量即可。
4. **每帧 `geometry.getAttribute('...')` 字符串查表**：`FlowFieldParticles.tsx:1056-1057`、`VolumetricStageLights.tsx:661`、`CursorStardustTrail.tsx:866-871`。在 `useMemo`/`useEffect` 里把 attribute 引用存进 ref。
5. **未使用的 uniform/varying**：`HexGround.tsx` 的 `COMMON` 声明 `uniform float uTime`（77 行）而三个片元着色器都没用它，但 `useFrame`(262-264) 仍在每帧写；`VolumetricStageLights.tsx:317` 的 `DUST_FRAGMENT` 声明 `varying float vSeed` 从不使用。
6. **`HexGround` 的默认参数数组每次都新建**：`core = [0, 2.0, 0]`（231 行）→ `shared`(236)/`baseUniforms`(245)/`gridUniforms`(249) 三个 `useMemo` 在每个父组件 render 时全部失效，`uCore` 被换成新 `Vector3`。改成模块常量 `const DEFAULT_CORE = [0, 2, 0] as const`。
7. **`VolumetricStageLights` 在 `heroFade = 0` 之后仍全速运行**：`useFrame`(553-664) 里 `mesh.visible = false` 只省了 draw call，1500 粒子的布朗随机游走 + 3 次 `mesh.updateMatrixWorld()` + `camera.updateMatrixWorld()` 仍在跑（`transient.scroll.progress > 0.18` 之后整页剩余滚动都是纯浪费）。在循环开头加 `if (heroFade <= 0.002 && fadeWithScroll) return` 即可（注意仍需先把 `mesh.visible = false`）。
8. **`soundEngine.readEnergy()` 每帧被调用两次**：`AuroraCurtain.tsx:535` 与 `FlowFieldParticles.tsx:840`。每次都会 `getByteTimeDomainData`（fftSize 默认 2048 → 2 KB 拷贝 + 2048 次乘加）。同一帧内两次结果相同，加一个"帧内缓存"（记录 `lastFrameStamp` + `lastValue`）可省一半。
9. **注释与实现漂移**（择要）：`curlNoise.ts:210,221` 说"18³ 是好折中"而调用方用 20/14；`ScrollArchitecture3D.tsx:1052` 出现乱码 `aSide（卤1, ...）`（应为 `±1`）；`ScrollArchitecture3D.tsx:1555-1559` 的"Virtual floor"注释描述的是一个已不存在的地板；`CursorStardustTrail.tsx:860-862` 留下空的第 4 节（"was: consume a queued click"）。建议清一遍历史注释，把"为什么"留在 commit message 而不是代码里。
10. **`DataStreams` 在 `uSpread = 0` 时仍提交 900 点**（`ScrollArchitecture3D.tsx:1022-1031`）：所有点被压到轴上、`vFade = 0` → 全片元丢弃，但顶点与 draw call 仍在。加 `meshRef.current.visible = uSpread > 0.002`。
11. **`frameBridge` 的正向确认**：`setCanvasActive(false)` 用 `Math.max(0, ...)` 兜底 StrictMode 的双卸载、`originMs` 在每次挂载时重置、`MAX_DELTA_SECONDS` 钳制切后台跳跃——这三个点写得对，没有发现问题。（这也是 SH-02 能成立的前提：`activeCanvases` 计数在架构画布常驻时恒 ≥2。）
12. **`CardParticleCanvas`/`BentoGrid`/sandbox 的 `ResizeObserver` 用法没问题**（不在本次范围，仅确认 R3F v9 内部同样走 `ResizeObserver`，两个画布的 resize 路径是可靠的；真正的缺口是 DPR 变化，见 SH-03）。
13. **`HexGround` 的 `fwidth`**：当前 three r186（WebGL2-only）下 `fwidth`/`dFdx` 属核心功能，无需 `extensions: { derivatives: true }`；`WebGLProgram.js` 中已没有 `derivatives` 分支。此项**不是 bug**，但与 SH-10 叠加时要注意：一旦补 WebGL1 回退，`HexGround.tsx:176` 与 `Plasma` 的导数用法需要同时处理。
