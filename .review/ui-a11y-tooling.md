# ui-a11y-tooling 审查报告

- **审查员**：ui-a11y-tooling（Agent Teams 子审查员）
- **仓库**：`interactive-showroom2`（Vite 8 + React 19 + TS 5.9 strict + Tailwind v4 + framer-motion + lucide-react）
- **审查范围**：`src/index.css`、`layout/Navbar(.parts)`、`command/CommandPalette`、`config/commands`、`bento/*`、`sections/*`、`ui/*`、`i18n/**`、`VfxSweepTransition`、`index.html`、`scripts/*.mjs`（抽查 4 个）、`.github/workflows/deploy.yml`、`pnpm-workspace.yaml`、`.gitignore`、`.gitattributes`
- **方法**：只读静态审查 + 只读命令取证（`git ls-files`、`Measure-Object`、`Select-String`、WCAG 相对亮度公式现场计算）。**未**运行 dev server、**未**运行任何 `verify-*.mjs`、**未**安装依赖、**未**修改 `src/` 与任何配置。
- **结论概览**：19 条，P0 × 2、P1 × 9、P2 × 7、P3 × 1。

---

## 0. 先澄清两个前提（避免误伤）

### 前提 A：`screenshots/` 并没有被提交进 git —— 与任务书假设不符

任务书假设「screenshots/ ~150 张 PNG（可能 100MB+）被提交进 git」。**实测不成立**：

```
$ git ls-files screenshots | Measure-Object
Count : 0
$ (Get-ChildItem .git -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB
1.951
$ git check-ignore -v screenshots/foo.png dist/index.html
.gitignore:71:screenshots/      screenshots/foo.png
.gitignore:10:dist/             dist/index.html
$ (Get-ChildItem screenshots -File | Measure-Object Length -Sum).Sum / 1MB
178.55     # 188 个文件：171 PNG + 17 JSON，仅存在于本地工作区
```

`.gitignore` 第 63–73 行已经明确排除 `screenshots/` 与 `dist/`，`.git` 目录只有 1.95 MB，健康。**无需 Git LFS，无需迁移。** 只需修两处文档性瑕疵（「其他小问题」#4/#5）。仓库卫生维度是这份代码里做得最好的一项，不应被当成问题凑数。

### 前提 B：类型检查通过 ≠ 没有 i18n 缺口

`zh.ts` 以 `Dictionary`（`= typeof en`）注解，缺键/错键是编译错误，**这条是真的**，也是本仓库最扎实的设计之一。但「键存在」与「界面已本地化」是两件事：`t.commands.groups` 两份字典都写了，却没有任何调用点（见 UI-06），于是命令面板的分组标题在中文界面里显示的是 `navigate / physics / accent / palette / actions` 这些内部 token。类型系统无法发现「定义了但没用」。

---

## 1. 问题清单（P0 → P3）

### [编号 UI-01] 命令面板是「假模态」：没有焦点陷阱、没有焦点归还、背景未 inert，且 listbox 里塞了非法子节点

- **严重级别**：P0
- **分类**：可访问性
- **位置**：`src/components/command/CommandPalette.tsx:127`、`:255`、`:303`、`:317`

```tsx
// :127 打开时只负责聚焦输入框，关闭路径没有任何归还逻辑
useEffect(() => {
  if (!open) return
  setQuery(''); setActiveIndex(0); setFlash(null)
  const handle = requestAnimationFrame(() => inputRef.current?.focus())
  return () => cancelAnimationFrame(handle)
}, [open])

// :255 声明了 aria-modal，但没有任何机制让它成为事实
<motion.div role="dialog" aria-modal="true" aria-label={t.commands.dialogAria} …>

// :303 listbox 的直接子节点里混入了分组标题 div
<div id="command-palette-list" role="listbox" aria-label={t.commands.listAria} …>
  …
  <div className="px-2.5 pt-2 pb-1 font-mono text-[0.55rem] … uppercase">{section.group}</div>
```

- **现象与证据**：
  1. **无焦点陷阱**。`aria-modal="true"` 承诺「Tab 不会离开对话框」，但组件内没有任何 `Tab` 拦截、也没有把背景设为 `inert`/`aria-hidden`。面板打开后连按 Tab：输入框 → 16 个命令行（每行 `role="option"` 但**没有 `tabIndex`**）→ 焦点直接落到面板**后面**的 Navbar 图标按钮、章节按钮、6 个 section 的 CTA。此时 `aria-modal` 与真实行为不一致，读屏（NVDA/JAWS 的「模态」语义）会与视觉焦点冲突。违反 **WCAG 2.4.3 Focus Order (A)**；对纯键盘用户就是「焦点消失在遮罩下面」。
  2. **无焦点归还**。关闭路径三条：Esc（`:154`）、点遮罩（`:251`）、执行命令后 `setOpen(false)`（`:197`）。三条都没有记录触发元素、也没有把焦点还回触发按钮；`AnimatePresence` 卸载后 `document.activeElement` 变成 `<body>`，下一次 Tab 从页面第一个可聚焦元素重新开始。同样违反 **2.4.3**。
  3. **背景未 inert**。全仓 `inert` 出现 0 次（只命中注释）。遮罩是 `:249` 的 `div`，除 `aria-hidden` 外无任何隔离手段，背景树对读屏完全可读、可聚焦。
  4. **listbox 结构非法**。`:317-321` 的分组标题是 `listbox` 的直接子 `div`（无 `role`）。ARIA 要求 `listbox` 子节点只能是 `option` 或 `group`；Chrome 会把这类无角色 `div` 展平，导致「共 16 条命令」被读成夹带 5 段无角色文本的混合列表，`ArrowDown` 的 index（`:217`）与读屏报出的 `n / m` 也对不上。**WCAG 4.1.2 Name, Role, Value (A)**。
  5. `aria-expanded`（`:289`）写作裸布尔属性，恒为 `true`，与 `open` 状态脱钩。不致命，但属同类「声明与状态不一致」。

- **影响**：这是整个作品集最核心的交互（`⌘K`）。不修，任何用键盘或读屏的招聘方在 10 秒内就会撞到「Tab 跑到遮罩下面」和「关掉面板后不知道自己在哪」。本仓已有全局 `focus-visible` 环（`index.css:183`）、`role="option"`、`aria-activedescendant` 这些正确细节，说明作者懂规范——缺的正是模态这一层的收尾。

- **修改建议**（四步，可直接落地）：

```tsx
// ① 焦点归还：打开时记录，卸载/关闭时还回
const restoreRef = useRef<HTMLElement | null>(null)
useEffect(() => {
  if (!open) return
  restoreRef.current = document.activeElement as HTMLElement | null
  const raf = requestAnimationFrame(() => inputRef.current?.focus())
  return () => { cancelAnimationFrame(raf); restoreRef.current?.focus?.() }
}, [open])
```

```tsx
// ② 焦点陷阱：挂在 dialog 上，Tab / Shift+Tab 首尾回环
const dialogRef = useRef<HTMLDivElement>(null)
const trapTab = (e: React.KeyboardEvent) => {
  if (e.key !== 'Tab') return
  const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
    'input, button, [href], [tabindex]:not([tabindex="-1"])',
  )
  if (!nodes?.length) return
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}
// <motion.div ref={dialogRef} role="dialog" aria-modal="true" onKeyDown={trapTab} …>
```

```tsx
// ③ 背景 inert（React 19 原生支持 boolean inert，@types/react 19 已带类型）
// src/App.tsx: 把 <Navbar/> + <main/> 包进同一容器
const paletteOpen = useAppStore((s) => s.commandPaletteOpen)
<div inert={paletteOpen || undefined}>
  <Navbar />
  <main id="main" tabIndex={-1}>…</main>
</div>
```

```tsx
// ④ listbox 结构：分组标题只做视觉，语义靠 role="group" + aria-labelledby
<div role="group" aria-labelledby={`cg-${section.group}`} className="mb-1 last:mb-0">
  <div id={`cg-${section.group}`} role="presentation"
       className="px-2.5 pt-2 pb-1 font-mono text-[0.55rem] tracking-[0.18em] text-ink-700 uppercase">
    {t.commands.groups[section.group]}   {/* 顺手修掉 UI-06 */}
  </div>
  {section.items.map(/* 保持不变 */)}
</div>
```

> 想省事可换 `@radix-ui/react-dialog` / `@headlessui/react`，它们把 `inert`、焦点陷阱、归还、滚动锁都做了。手写则只差上面 40 行。

---

### [编号 UI-02] 22 个 CDP 验证脚本从不进 CI，且断言失败永远退出码 0 —— 278 KB 的验证是装饰

- **严重级别**：P0
- **分类**：工程化
- **位置**：`.github/workflows/deploy.yml:77`、`scripts/verify-perf-audit.mjs:474`、`scripts/verify-command-mobile.mjs:576`

```yaml
# deploy.yml: 全部校验步骤只有这三步，没有任何 scripts/*.mjs
      - name: Typecheck
        run: pnpm typecheck
      - name: Build
        run: pnpm build
      - name: Verify build output      # 只数文件个数，不做断言
        run: |
          test -f dist/index.html || { echo "::error::dist/index.html missing"; exit 1; }
```

```js
// verify-perf-audit.mjs:474  算出了 failed，然后只 console.log，脚本正常结束
const failed = Object.entries(report.assertions).filter(([, v]) => !v).map(([k]) => k)
console.log(JSON.stringify({ assertions: report.assertions, failed, … }, null, 2))
ws.close()          // ← 没有 process.exitCode = 1
```

- **现象与证据**：
  1. **CI 不跑**：`deploy.yml` 只有 `typecheck → build → 文件存在性检查 → 上传/部署`；`scripts/` 下 22 个 `.mjs` 文件（合计 **278.5 KB / 7 696 行**）从未被调用，`package.json` 也没有任何 `verify:*` 入口。
  2. **失败静默通过**：21 个带 CDP 客户端的脚本里只有 2 个出现 `process.exit(1)`（`verify-sound.mjs:311`、`verify-spectrum.mjs:234`），其余 19 个——包括最核心的 `verify-perf-audit`、`verify-command-mobile`——都只 `console.log` 一个 `failed` 数组就结束。断言红着、进程 0，任何 `&&` 链或 CI 步骤都会绿。
  3. **只能在 dev server 上跑**：7 个脚本通过 `import('/src/store/useAppStore.ts')`（`verify-perf-audit.mjs:43`、`verify-command-mobile.mjs:43`、`verify-leaks.mjs:57`、`verify-sound.mjs:48`、`verify-spectrum.mjs:44`、`shots-spectrum.mjs:73`）直接拿源码模块。这要求 Vite **开发服务器**在跑；对着 `pnpm preview`（`dist/`）或线上产物，这些 `import()` 会 404，脚本会以「拿不到数据」的方式静默降级。**没有任何脚本能验证真正部署出去的那份产物。**
  4. **零复用**：21 个脚本各自 `new WebSocket(page.webSocketDebuggerUrl)` + 各自实现 `send/evaluate/shot`；共享的 `scripts/page-helpers.mjs` 只有 `verify-ring-touch.mjs:12` 一个消费者。
  5. **不会自动拉浏览器**：全部脚本要求外部已有一个开好 `--remote-debugging-port` 的 Chrome，且**每个脚本一个专属端口**（9333/9334/9337–9341/9344/9345/9347–9349/9351/9352/9355/9357/9359）与专属 URL（5250/5260–5263/5265–5269/5271/5272/5275/5277/5279）。没有任何 `chrome.exe` 路径或启动逻辑——这解释了它为什么从未被自动化：**它需要人肉准备环境**。

- **影响**：这是测试债务的最高级形态——存在、看起来专业、但既不阻断回归也不覆盖产物。招聘方点开 `scripts/` 看到 7 700 行 CDP 断言，会默认「这项目有 E2E」；实际一次重构把 `useAppStore` 的 slice 改名，CI 依然全绿。风险评分上它比「没有测试」更糟，因为它制造了虚假信心。

- **修改建议**：三步，全部可照抄。

**第 1 步**：抽公共 harness，让这 7 700 行只剩断言。

```js
// scripts/lib/cdp.mjs
import WebSocket from 'ws'
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222'

export async function connect() {
  const targets = await (await fetch(`${BASE}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 1
  const pending = new Map()
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => { const n = id++; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })) })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
  const shot = async (name) => {
    mkdirSync('screenshots', { recursive: true })
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`screenshots/${name}.png`, Buffer.from(data, 'base64'))
  }
  return { ws, send, evaluate, shot, close: () => ws.close() }
}

const results = []
export function assert(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) process.exitCode = 1          // ← 关键：失败即红
  return ok
}
export function summary() {
  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ total: results.length, failed }, null, 2))
  if (failed.length) console.error(`✗ ${failed.length} assertion(s) failed`)
}
```

```js
// scripts/verify-perf-audit.mjs 尾部改三行
import { assert, summary } from './lib/cdp.mjs'
…
for (const [name, v] of Object.entries(report.assertions)) assert(name, v)
summary()
```

**第 2 步**：加 npm 入口与 CI job（`ubuntu-latest` 自带 `google-chrome`）。

```json
// package.json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "typecheck": "tsc -b --noEmit",
  "preview": "vite preview",
  "verify": "node scripts/run-verify.mjs",
  "smoke": "node scripts/smoke.mjs"
}
```

```yaml
# .github/workflows/deploy.yml —— 在 build 之前新增 verify job
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pin-SHA>
      - uses: pnpm/action-setup@<pin-SHA>
        with: { version: '11.8.0' }
      - uses: actions/setup-node@<pin-SHA>
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Start Vite dev server (scripts import /src/*.ts)
        run: |
          pnpm dev --port 5277 --strictPort &
          npx --yes wait-on http://127.0.0.1:5277 -t 60000
      - name: Launch headless Chrome
        run: |
          google-chrome --headless=new --no-sandbox --disable-gpu \
            --remote-debugging-port=9357 --window-size=390,844 about:blank &
          npx --yes wait-on http://127.0.0.1:9357/json/version -t 30000
      - name: Verify (command palette + mobile bento)
        run: CDP_HTTP=http://127.0.0.1:9357 node scripts/verify-command-mobile.mjs http://127.0.0.1:5277
```

**第 3 步**：补一条「验产物」的冒烟。`smoke.mjs` 不 import `/src/*`，可直接指向 `pnpm preview --port 4173` 的 dist 产物，放在 deploy 之前。这样「源码级断言」与「产物级冒烟」各归其位。

> 另：所有 `.mjs` 既不被 `tsconfig` 覆盖（`allowJs/checkJs` 未开），也没有 `// @ts-check`，改一个字段名不会有任何提示。建议在 `scripts/*.mjs` 顶部加 `// @ts-check` + JSDoc，或把 harness 改成 `.ts` 由 `tsx` 运行。

---

### [编号 UI-03] 零 lint / 零格式化 / 零单测，且代码里已经躺了两条「假」eslint-disable

- **严重级别**：P1
- **分类**：工程化
- **位置**：`package.json:7`、`src/components/bento/SpotlightCard.tsx:191`、`:208`

```json
// package.json:7 —— 全仓 102 个 git 文件，脚本只有这 4 个
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "typecheck": "tsc -b --noEmit",
  "preview": "vite preview"
}
```

```tsx
// SpotlightCard.tsx:186 —— 注释让 ESLint 闭嘴，但仓库里根本没有 ESLint
const handleEmberOver = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
  …
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

- **现象与证据**：
  1. 无 `eslint` / `prettier` 依赖、无配置文件、无 `lint`/`format`/`test` 脚本、无 `.editorconfig`。CI 也只有 `typecheck`（`deploy.yml:77`）。
  2. **两条 `// eslint-disable-next-line react-hooks/exhaustive-deps`**（`SpotlightCard.tsx:191`、`:208`）——抑制的是 `actionCentre` 这个每次渲染新建的闭包被 `useCallback` 捕获的问题。没有 linter 时这两行是纯噪音，反而向读者暗示「这里已被检查过」。一旦真装上 ESLint，这两行会立刻把真实告警吞掉。
  3. 本报告 19 条里有 **7 条**（UI-01 的 listbox 结构、UI-04 的对比度、UI-08 的 inert、UI-09 的目标尺寸、UI-10 的焦点可见性、UI-14 的 `role="application"`、UI-15 的 `aria-label` on div）能被 `eslint-plugin-jsx-a11y` 的静态规则直接抓到；`exhaustive-deps` 类问题能被 `react-hooks` 抓到。**装 lint 的投入产出比，在这份代码上是最高的一项。**

- **影响**：作品集的技术信号里，「没有任何一行自动化静态检查」会被读成「不熟悉工程化」；而 7 700 行手写 CDP + 完整 design token 体系又说明作者明明有这个能力。这是**投入已经花了、却没形成门禁**的典型错配。此外 `BentoGrid`/`SpotlightCard` 里大量 `useCallback` 依赖数组，没有 `exhaustive-deps` 就等于把闭包陈旧 bug 的发现权交给运气。

- **修改建议**（可直接照抄；版本以 `pnpm add` 实际解析为准）：

```bash
pnpm add -D eslint@^9 typescript-eslint@^8 \
  eslint-plugin-react-hooks@^5 eslint-plugin-react-refresh@^0.4 \
  eslint-plugin-jsx-a11y@^6 \
  prettier@^3 prettier-plugin-tailwindcss@^0.6 \
  vitest@^3 jsdom@^25 @testing-library/react@^16 \
  @testing-library/jest-dom@^6 @testing-library/user-event@^14
```

```js
// eslint.config.js （ESLint 9 flat config）
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default tseslint.config(
  { ignores: ['dist', 'screenshots', 'node_modules', '**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // 本项目大量 command/registry 模式，先降级观察
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
    },
  },
)
```

```json
// package.json
"scripts": {
  "lint": "eslint . --max-warnings 0",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "test": "vitest run"
}
```

```ts
// vitest.config.ts —— 先把纯函数测起来，成本最低收益最高
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'] },
  resolve: { alias: { '@': '/src' } },
})
```

CI 里把 `pnpm lint`（`--max-warnings 0`）插到 `pnpm typecheck` 之前，`prettier --check` 并入同一个 `quality` job，任一项红即阻断部署。

首批建议的 6 个单测（纯函数、零 DOM）：`lib/fuzzyMatch.ts` 的 `fuzzyMatch/toRanges`、`lib/vfxPalette.ts` 的 `getNextVfxPreset`、`config/commands.ts` 的 `buildCommands().length` 与分组顺序、`i18n` 的 `Dictionary` 形状（`expectTypeOf`）、`utils/mathPhysics.ts` 的弹簧收敛、`lib/math.ts` 的 `clamp`。这会让 `test` 脚本立刻变成有意义的门禁。

---

### [编号 UI-04] `text-ink-700` 实测对比度只有 2.76:1，却承担了全部 8.8px 小字

- **严重级别**：P1
- **分类**：可访问性 / 设计系统
- **位置**：`src/index.css:33`（token 定义）、`src/components/command/CommandPalette.tsx:319`、`:412`、`:297`、`:295`

```css
/* src/index.css:29-33 */
  --color-ink-100: #eef2ff;
  --color-ink-300: #b9c4dc;
  --color-ink-500: #7c8aa6;
  --color-ink-700: #4a5670;   /* ← 大量 0.5–0.6rem 文案用它 */
```

```tsx
// CommandPalette.tsx:319-321 —— 8.8px + 2.76:1
<div className="px-2.5 pt-2 pb-1 font-mono text-[0.55rem] tracking-[0.18em] text-ink-700 uppercase">
  {section.group}
</div>
// :295 搜索框占位符同样是 ink-700
className="… placeholder:text-ink-700 focus:outline-none"
```

- **现象与证据**：按 **WCAG 2.x 相对亮度公式**计算（sRGB 通道归一化，`c ≤ 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`，`L = 0.2126R + 0.7152G + 0.0722B`，对比度 `(L1+0.05)/(L2+0.05)`）：

| 前景 | 背景 | 对比度 | 判定 |
|---|---|---|---|
| `ink-100 #eef2ff` | `void-950 #04060b` | **18.13 : 1** | AAA ✅ |
| `ink-300 #b9c4dc` | `#04060b` | **11.58 : 1** | AAA ✅ |
| `ink-500 #7c8aa6` | `#04060b` | **5.83 : 1** | AA ✅ |
| **`ink-700 #4a5670`** | **`#04060b`** | **2.76 : 1** | **AA/AAA 全不达标** ❌ |
| `ink-700` | 面板 `void-850 #0a0e18` | **2.62 : 1** | ❌ |
| `ink-700` | 面板 `void-800 #0d121f` | **2.54 : 1** | ❌ |
| `signal-cyan #22d3ee` | `#04060b` | 11.22 : 1 | AAA ✅ |
| `void-950 #04060b` 文字 | cyan 药丸底 `#22d3ee` | 11.22 : 1 | AAA ✅（LanguageSwitcher 选中态安全） |
| `signal-violet #a78bfa` | `#04060b` | 7.45 : 1 | AAA ✅ |
| `signal-amber #f59e0b`（amber 主题下的 accent） | `#04060b` | 9.44 : 1 | AAA ✅ |

  四套 accent（cyan 11.22 / emerald 10.54 / violet 7.45 / amber 9.44）**全部 ≥ 7.4**，换肤不会制造对比度事故，这点做得很好。违规面集中在 `ink-700`：命令面板分组标题/页脚快捷键提示/kbd/placeholder、`Navbar.tsx:274`（brandSub）、`Navbar.parts.tsx:77`、`Sections.tsx:39/81/122/196/202`、`ArchitectureNarrative.tsx:348`，字号清一色 `text-[0.55rem]`–`text-[0.6rem]`（**8.8–9.6 px**）。WCAG 1.4.3 要求正文 ≥ 4.5:1；「大文本」豁免是 ≥18.66px bold 或 ≥24px，都不适用。

  双重问题：8.8px 本就低于可读性下限（Chrome 最小字号一档在 9–10px），叠 2.76:1 之后中文笔画基本糊掉。`hud-label`（`index.css:244`）这个工具类把 `color: var(--color-ink-500)` 写死（5.83:1 尚可），但作者四处手写 `text-ink-700` 绕过了它。

- **影响**：命令面板的分组标题、页脚快捷键提示、"esc" 键帽、搜索占位符——都是第一次使用就要读的信息。作品集浏览者中相当比例会放大网页或在低亮度屏上看；2.76:1 在笔记本 200 nit 下几乎不可见。

- **修改建议**：
  1. 把 `--color-ink-700` 提到 **`#737f9a`**（实测 `#04060b` **5.05:1**、`#0a0e18` **4.80:1**、`#0d121f` **4.66:1**，三处全过 AA，且仍明显暗于 `ink-500` 的 5.83/5.55，层级不被压平）。想留更多对比余量用 `#7b89a3`（5.74 / 5.46 / 5.30）。
  2. 新增一档**非文本**暗色 token 承接现角色（1px 描边、分隔线、图标底），不要复用文本 token：
     ```css
     @theme {
       --color-ink-700: #737f9a;   /* 文本用，AA 达标 */
       --color-line-600: #4a5670;  /* 仅用于 border / 装饰，不承载文本 */
     }
     ```
  3. 字号下限：`text-[0.5rem]`（8px，`ScrollProgressRing.tsx:148`）与 `text-[0.55rem]` 统一抬到 `text-[0.68rem]`（≈10.9px）；`0.68rem` 是本仓 `ArchitectureNarrative.tsx:186` 已在用的档位，等于把隐性「最小字号」显式化为一个 token：
     ```css
     @theme { --text-2xs: 0.68rem; --text-2xs--line-height: 1rem; }
     ```
  4. 落地检查：装 `eslint-plugin-jsx-a11y` 后加一条禁用 `text-ink-700` 的规则，或直接 grep 干净。更稳的是加个 5 行单测守门：
     ```ts
     // src/test/contrast.test.ts
     import { expect, test } from 'vitest'
     const lum = (hex: string) => { /* 上面的公式 */ }
     const cr = (a: string, b: string) => { /* 上面的公式 */ }
     test('ink tokens meet 4.5:1 on every surface', () => {
       for (const fg of ['#eef2ff', '#b9c4dc', '#7c8aa6', '#737f9a'])
         for (const bg of ['#04060b', '#070a12', '#0a0e18'])
           expect(cr(fg, bg)).toBeGreaterThanOrEqual(4.5)
     })
     ```

---

### [编号 UI-05] 语言切换、主题切换、命令执行结果全部没有 `aria-live` 播报

- **严重级别**：P1
- **分类**：可访问性
- **位置**：`src/components/command/CommandPalette.tsx:388`、`src/components/ui/LanguageSwitcher.tsx:52`、`src/config/commands.ts:254`

```tsx
// CommandPalette.tsx:388 —— 只有视觉上的 tick，没有播报
{flash === item.cmd.id ? (
  <span className="flex shrink-0 items-center gap-1 font-mono text-[0.55rem] text-signal-teal">
    <Check className="size-3" aria-hidden />
    {t.commands.done}
  </span>
) : …}
```

```tsx
// LanguageSwitcher.tsx:52 —— 切完就完了，<html lang> 变了但没有任何「已切换」提示
const select = (next: Locale): void => {
  if (next === locale) return
  setLocale(next)
  soundEngine.playLocaleConfirm()
}
```

- **现象与证据**：全仓 `aria-live` / `role="status"` 只出现在 3 处：`BootSequence.tsx:229`、`PerfTelemetryHud.tsx:458-459`（其余为注释干扰命中）。也就是说：**唯一被播报的状态变化是开发者 HUD**。用户可触发的三类状态变化——(a) 命令执行完成（复制邮箱 / 下载 JSON）、(b) accent 主题切换（`commands.ts:254`）、(c) 语言切换（整页文案换语种）——对读屏用户完全静默。命令面板的 `flash` 是一个 1.6s 的视觉 tick（`:186-191`），焦点都没移动。
  另外，语言切换会让全部可见文本瞬间变成另一种语言，这是典型需要 `aria-live="polite"` 播报「界面已切换为中文」的场景（**WCAG 4.1.3 Status Messages (AA)**）。

- **影响**：盲用用户执行「复制邮箱」后无法确认成功；`copyText` 返回 `false` 时面板甚至不关闭（`:184`），但成功/失败都没有声音。切换语言后用户只会听到后续导航突然变成另一种语言，没有任何确认。

- **修改建议**：加一个全局播报器，三处调用点各改一行。

```tsx
// src/components/ui/Announcer.tsx
import { create } from 'zustand'
import { useEffect, useState } from 'react'

const useAnnouncer = create<{ message: string; say: (m: string) => void }>((set) => ({
  message: '',
  say: (m) => set({ message: m }),
}))
export const announce = (m: string) => useAnnouncer.getState().say(m)

export function Announcer() {
  const message = useAnnouncer((s) => s.message)
  const [shown, setShown] = useState('')
  // 同一句话连发两次时清空再写，保证 SR 重新播报
  useEffect(() => {
    setShown('')
    const t = window.setTimeout(() => setShown(message), 60)
    return () => window.clearTimeout(t)
  }, [message])
  return <p role="status" aria-live="polite" className="sr-only">{shown}</p>
}
```

```tsx
// CommandPalette.tsx execute() —— 成功/失败都播报
const ok = result !== false
announce(ok ? t.commands.done : t.commands.copyFailed)   // copyFailed 字典里已有（见 UI-06 死键）
```
```tsx
// LanguageSwitcher.tsx select() —— 用新 locale 的语言播报
setLocale(next)
announce(next === 'zh' ? '界面语言已切换为中文' : 'Language switched to English')
```
```ts
// commands.ts accent 命令 run() —— 主题切换播报当前色名
run: () => { useAppStore.getState().setAccentTheme(option.theme); announce(dict.commands.accents[option.theme].title) }
```
把 `<Announcer />` 挂在 `App.tsx` 的 `<main>` 之后即可（`sr-only` 是 Tailwind v4 内置工具类，无需自定义）。

---

### [编号 UI-06] 命令面板的分组标题在中文界面下仍显示 `navigate / physics / accent` 内部 token

- **严重级别**：P1
- **分类**：i18n
- **位置**：`src/components/command/CommandPalette.tsx:320`、`src/config/commands.ts:44`、`src/i18n/locales/en.ts:311`

```tsx
// CommandPalette.tsx:317-321 —— 直接把分组 token 当标题渲染
<div key={section.group} className="mb-1 last:mb-0">
  <div className="… uppercase">{section.group}</div>
```

```ts
// commands.ts:44-47 —— 注释明确承诺「渲染时从字典解析」，但没有消费者
 * The visible heading is resolved from the dictionary at render time; storing
 * Chinese here meant the palette's group headers were the one part of it that
 * could never be translated.
export type CommandGroup = 'navigate' | 'physics' | 'accent' | 'palette' | 'actions'
```

```ts
// en.ts:311-317 / zh.ts:291-297 —— 两份字典都写好了，全是死键
groups: { navigate: 'Chapters', physics: 'Physics sandbox', accent: 'Accent theme', palette: 'Visual palette', actions: 'Actions' },
```

- **现象与证据**：`t.commands.groups` 全仓引用数 = **0**。连带 `nav.sectionsAria`、`hero.fpsBadge`、`hero.particlesBadge`、`bento.copyCode`、`bento.copyFailed`、`architecture.layerDetailAria`、`commands.openPalette`、`commands.closePalette`、`commands.gravityPrefix` 共 **10 个键 × 2 语种 = 20 条死串**，全部只在 `en.ts`/`zh.ts` 里出现（用「键名全仓出现次数 = 2」筛出）。于是中文用户按 `⌘K` 看到的是：

  ```
  NAVIGATE          <- 应为「跳转章节」
    Jump to 架构
  PHYSICS           <- 应为「物理沙盒」
  ACCENT            <- 应为「主题强调色」
  ```

  同类问题还有 bento 卡片上的硬编码英文（`BentoShowcase.tsx:78/108/134/161/207`：`eyebrow="live telemetry"` / `"architecture"` / `"terminal"` / `"render"` / `"uptime"`），以及 `Navbar.tsx:91` 的 `Telemetry` 标题——它们一句都不在字典里。

- **影响**：命令面板是作品集里最容易被主动尝试的功能（`⌘K` 有明确 affordance 图标）。中文界面里出现 5 个全大写英文分词式单词，是「国际化只做了一半」最直观的证据。这一条和 UI-01 的 `role="group"` 可合并成一次改动。

- **修改建议**：
  1. `CommandPalette.tsx:320` 改成 `{t.commands.groups[section.group]}`，并按 UI-01 的第 ④ 步包 `role="group"`。
  2. 把 6 处硬编码 eyebrow 收进字典（每卡一键，避免复用出歧义）：
     ```ts
     // en.ts bento 段新增
     cardThroughputEyebrow: 'Live telemetry',
     cardTopologyEyebrow: 'Architecture',
     cardTerminalEyebrow: 'Terminal',
     cardRenderEyebrow: 'Render',
     cardUptimeEyebrow: 'Uptime',
     // zh.ts
     cardThroughputEyebrow: '实时遥测',
     cardTopologyEyebrow: '架构',
     cardTerminalEyebrow: '终端',
     cardRenderEyebrow: '渲染',
     cardUptimeEyebrow: '在线',
     ```
  3. 加一条守卫测试，把「死键」变成 CI 可发现：
     ```ts
     // src/test/i18n.test.ts
     import { en } from '@/i18n/locales/en'
     const flat = (o: object, p = ''): string[] =>
       Object.entries(o).flatMap(([k, v]) =>
         typeof v === 'object' ? flat(v as object, `${p}${k}.`) : [`${p}${k}`])
     test('no dead dictionary keys', () => {
       const src = Object.values(import.meta.glob('/src/**/*.tsx', { as: 'raw', eager: true })).join('\n')
       const dead = flat(en).filter((k) => !src.includes(k.split('.').pop()!))
       expect(dead).toEqual([])   // 允许白名单后再收紧
     })
     ```

---

### [编号 UI-07] `index.html` 写死 `lang="zh-CN"` + 中文 title/description，而应用默认语言是 `en`

- **严重级别**：P1
- **分类**：i18n
- **位置**：`index.html:2`、`:17-21`、`src/i18n/useI18n.ts:38`、`:58`

```html
<html lang="zh-CN" class="dark">
  <meta name="description" content="个人数字展厅 · 基于 React 19 / Three.js / Lenis 构建的沉浸式交互展厅。" />
  <title>数字展厅 · DIGITAL SHOWROOM</title>
```

```ts
// useI18n.ts:38-47 —— 运行时确实会改，但只在 JS 执行之后
function applyDocumentLocale(locale: Locale): void {
  document.documentElement.lang = HTML_LANG[locale]   // en → 'en'
  document.title = DICTIONARIES[locale].meta.title
  const description = document.querySelector('meta[name="description"]')
  if (description) description.setAttribute('content', DICTIONARIES[locale].meta.description)
}
```

- **现象与证据**：**运行时更新是做了的**（`useI18n.ts:77` 在模块求值调用一次，`:80-82` 订阅后续变更），所以这不是「忘了改 `document.lang`」。真正的问题是三层错配：
  1. **静态声明与默认值矛盾**：`useI18n.ts:58` 初始 locale 是 `'en'`，`HTML_LANG.en = 'en'`，但 HTML 写的是 `zh-CN` 与中文标题。任何在 JS 执行前读文档的消费者（爬虫、社交预览、`view-source`、禁用 JS 的访客、`applyDocumentLocale` 之前的首帧）拿到的都是**中文**，而实际界面是**英文**。
  2. **SEO / 分享卡**：`<html lang>` 是最强的语言信号，翻译扩展、Chrome「翻译此页」提示、Google 的 `hreflang` 推断都据此判断。英文默认站声明 `zh-CN`，Chrome 不会提示翻译。且没有任何 `og:` / `twitter:` 标签，分享链接退回用 `<title>`（中文）。
  3. **无水合闪烁风险（这点是好的）**：`persist` 用 `createJSONStorage(() => localStorage)` 同步读取，且没有 SSR，所以不存在「先渲染 en 再跳 zh」的水合不一致；返回访客的 locale 在首次 paint 前就已就位。唯一可见抖动是标签页标题在 JS 执行瞬间从中文跳到英文（被 `BootSequence` 的 2.7s 面纱盖住）。**因此本条不需要 `suppressHydrationWarning` 之类手段，只需把静态 HTML 的默认值改成 en。**

- **影响**：作品集的第一入口就是「被分享 / 被搜索」。分享到 Twitter/微信时预览卡是中文标题 + 中文描述，点进去是英文界面；招聘方在英文环境看到 `<html lang="zh-CN">` 会认为站点语言与内容不符。

- **修改建议**：
  1. 静态默认值对齐代码默认值（英文）：
     ```html
     <html lang="en" class="dark">
       <meta name="description" content="An immersive personal showroom built with React 19, Three.js and Lenis: scroll-driven camera choreography, real-time GPU particles and physics sandboxes." />
       <title>Digital Showroom — Real-time Graphics Engineering</title>
       <meta property="og:type" content="website" />
       <meta property="og:title" content="Digital Showroom — Real-time Graphics Engineering" />
       <meta property="og:description" content="An immersive personal showroom built with React 19, Three.js and Lenis." />
       <meta property="og:image" content="/og-cover.png" />   <!-- 1200×630，放 public/ -->
       <meta name="twitter:card" content="summary_large_image" />
     ```
  2. 想让返回访客的 `<html lang>` 在首帧前就是对的，加一段同步内联脚本（比等模块求值早一个数量级）：
     ```html
     <script>
       try {
         var s = JSON.parse(localStorage.getItem('showroom_locale_v1') || '{}')
         var l = s && s.state && s.state.locale
         if (l === 'zh') document.documentElement.lang = 'zh-CN'
       } catch (e) {}
     </script>
     ```
     注意 `LOCALE_STORAGE_KEY` 是 `showroom_locale_v1`、zustand `persist` 落盘形状是 `{"state":{"locale":"zh"},"version":0}`——上面按这个形状取值，与 `partialize` 一致。
  3. 若确实想要「中文为默认」，把 `useI18n.ts:58` 改成 `'zh'` 并让 `HTML_LANG` 与之对齐——**两者必须一致**。当前是最坏组合：静态中文 + 运行时英文。
  4. `applyDocumentLocale` 只改 `title` / `description`，建议顺带更新 `og:title` / `og:description`。

---

### [编号 UI-08] 关闭状态的移动抽屉仍在 Tab 序列里；全站没有 skip link

- **严重级别**：P1
- **分类**：可访问性 / 响应式
- **位置**：`src/components/layout/Navbar.tsx:391`、`src/App.tsx:158`

```tsx
// Navbar.tsx:391-398 —— 收起只是 max-h-0 + opacity-0，元素与按钮全部还在
<div className={cn(
  'overflow-hidden border-t border-void-600/40 bg-void-950/96 transition-[max-height,opacity] duration-400 lg:hidden',
  mobileOpen ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0',
)}>
  <nav aria-label={t.nav.mobileMenuAria} className="flex flex-col px-4 py-2 sm:px-6">
    {SHOWROOM_SECTIONS.map((section) => (
      <button key={section.id} type="button" onClick={() => goTo(section.id)} …>
```

```tsx
// App.tsx:158 —— main 没有 id、没有 tabIndex，前面是 14 个可聚焦的 navbar 控件
<main className="relative z-20">
```

- **现象与证据**：
  1. `max-h-0` + `overflow-hidden` **不会**把子元素移出 tab 序列（只有 `display:none`、`visibility:hidden`、`inert`、`hidden` 属性会）。所以 `<lg` 视口下抽屉关闭时 6 个章节按钮**依然可聚焦**；键盘用户 Tab 到它们时，浏览器 focus 到一个高度为 0 的容器内的按钮，焦点环被 `overflow-hidden` 裁掉，还可能触发容器滚动。桌面视口因 `lg:hidden` 表现正常，**这个 bug 只在手机 / 窄窗口 + 外接键盘（或 iPad 触控板、或读屏）时出现**——正是最容易被漏测的组合。
  2. **没有 skip link**。`<main>` 之前有：品牌按钮、6 个章节按钮（lg）、进度环、FPS、HUD、命令面板、调色、静音、语言切换、移动菜单——**约 14 个 tab 停靠点**，然后才是 hero 的 h1。**WCAG 2.4.1 Bypass Blocks (A)**。
  3. `main` 无 `id` / `tabIndex={-1}`，即便加 skip link 也没有落点。

- **影响**：键盘 / 读屏用户进入站点的第一个动作就是「Tab × 14 才能看到内容」，且中途会穿过 6 个不可见按钮。这是无障碍审计最常见的两条 finding，修复成本却只有 10 行。

- **修改建议**：

```tsx
// App.tsx —— 跳过链接 + main 落点
<a href="#main"
   className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-200
              focus:rounded-md focus:bg-void-900 focus:px-4 focus:py-2
              focus:font-mono focus:text-sm focus:text-signal-cyan
              focus:outline focus:outline-2 focus:outline-signal-cyan">
  {t.nav.skipToContent}   {/* 新增字典键：'Skip to content' / '跳到正文' */}
</a>
<main id="main" tabIndex={-1} className="relative z-20 outline-none">
```

```tsx
// Navbar.tsx —— 抽屉关闭时彻底不可交互（React 19 的 boolean inert）
<div
  inert={!mobileOpen || undefined}
  aria-hidden={!mobileOpen}
  className={cn('overflow-hidden …', mobileOpen ? 'max-h-80 opacity-100' : 'max-h-0 opacity-0')}
>
```
> 不想依赖 `inert`（Chrome 102+ / Safari 15.5+ / FF 112+，2026 年可放心）时，等价低配是 `{mobileOpen && <nav>…</nav>}`——代价是失去高度过渡动画。推荐 `inert`。

另外 `Navbar.tsx:375` 的汉堡按钮应在 `aria-expanded` + `aria-controls` 上声明状态（当前只有 `aria-pressed`，语义是「开关按钮」而非「展开/收起」）：

```tsx
<IconButton label={…} aria-expanded={mobileOpen} aria-controls="mobile-nav" …>
```

---

### [编号 UI-09] 触摸目标不足 24×24（WCAG 2.2 AA 2.5.8）：语言切换药丸实测约 31×19px

- **严重级别**：P1
- **分类**：响应式 / 可访问性
- **位置**：`src/components/ui/LanguageSwitcher.tsx:76`、`src/components/bento/BentoShowcase.tsx:185`、`src/components/ui/primitives.tsx:27`、`src/components/sections/ArchitectureNarrative.tsx:158`

```tsx
// LanguageSwitcher.tsx:76-80 —— py-1 + text-[0.58rem]
'relative rounded-full px-2.5 py-1 font-mono text-[0.58rem]',
'tracking-[0.14em] uppercase transition-colors duration-300',
```

```tsx
// BentoShowcase.tsx:185 —— py-1 + text-[0.6rem] 的「查看架构」
className="mt-2.5 inline-flex items-center gap-1.5 self-start rounded-full border border-signal-teal/30
           bg-signal-teal/10 px-2.5 py-1 font-mono text-[0.6rem] …"
```

- **现象与证据**（按 Tailwind 默认刻度换算，1rem = 16px）：
  - **LanguageSwitcher 分段按钮**：`py-1` = 8px 上下 + 文本行 `0.58rem ≈ 9.3px`（mono `line-height: normal ≈ 1.2` → ≈ 11.1px）→ **高度 ≈ 19.1px**；宽 `EN` ≈ 31px、`中文` ≈ 39px。**低于 24×24**，相邻两段只有 `gap-0.5`（2px）+ 外层 `p-[3px]`，**不满足 2.5.8 的 24px 间距豁免**（以目标中心画 24px 圆必然相交）→ **直接不满足 WCAG 2.2 AA 2.5.8 Target Size (Minimum)**。
  - **bento「查看架构」按钮**：`py-1` + `0.6rem ≈ 9.6px` → 高度 ≈ **23.2px**，同样不足 24。
  - **IconButton**（`primitives.tsx:27` `size-9` = **36×36**）：满足 2.5.8（≥24），但不满足 2.5.5 Enhanced (AAA) 的 44×44。导航栏一行 8 个图标按钮、间距 `gap-2`（8px）→ 36+8=44 刚好够间距豁免，可用性可接受，故只列 AAA 差距。
  - **LayerHud 关闭按钮**（`ArchitectureNarrative.tsx:158` `grid size-6`）= **24×24**，正好卡在 AA 下限、无余量。
  - **TopologyMini 节点**（`micro/TopologyMini.tsx:113-158`）：SVG `viewBox="0 0 240 130"` 铺满卡片宽；1 列布局（手机，内容宽 ≈ 326px）缩放 ≈ 1.36×，dot 直径约 **10–14px**，连标签的整体命中区约 30×20px——**横向量够、纵向不足 24**。**渲染尺寸需实测**（`lg:col-span-2` 时缩放 3.3×，dot 直径约 33px，反而合格）。
  - 参考：命令面板行 `py-2.5` ≈ 33px ✅；移动抽屉章节按钮 `py-3` ≈ 44px ✅；hero CTA `px-5 py-3` ≈ 44px ✅。**说明作者知道 44px 这个数**，只是把「小药丸」和「HUD 按钮」当成了例外——而例外正是 WCAG 不允许的。

- **影响**：手机上语言切换是**唯一**改语言的可见入口（见「其他小问题」#1），却只有 19px 高——拇指点击命中率极低，且它紧贴静音按钮（`Navbar.tsx:352-372`），误触会顺手切掉声音。WCAG 2.2 在 2023 年把 2.5.8 提升为 AA，是所有新审计的必查项。

- **修改建议**：用「假包装、真命中区」，不把视觉撑大（视觉密度是这个设计的一部分）。

```tsx
// LanguageSwitcher.tsx —— 保持视觉，把命中区扩到 44×44
<button
  type="button"
  onClick={() => select(option.value)}
  aria-pressed={active}
  className={cn(
    'relative rounded-full px-2.5 py-1 font-mono text-[0.58rem]',
    'before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[""]',
    'tracking-[0.14em] uppercase transition-colors duration-300',
    active ? 'text-void-950' : 'text-ink-500 hover:text-ink-100',
  )}
>
```
> 19px + 上下各 12px ≈ 43px；左右各 8px 让两段不再贴边。`before` 不会拦截自身点击，安全。

```tsx
// BentoShowcase.tsx —— 小药丸给最小高度
className="… mt-2.5 inline-flex min-h-11 items-center gap-1.5 self-start rounded-full px-3
           font-mono text-[0.6rem] …"     // min-h-11 = 44px，视觉几乎不变（卡片本身有 padding）
```

```tsx
// TopologyMini.tsx —— 给每个 g 加一块透明命中矩形
<g key={node.id} …>
  <rect x={node.x - 14} y={node.y - 14} width={28} height={28} fill="transparent" />
  …
</g>
```
> SVG 内 28 是 viewBox 单位，渲染后随缩放放大；要保证**最小渲染尺寸**≥24，可给 `svg` 设 `min-height`，或用绝对定位的 HTML 按钮覆盖层彻底解耦。

---

### [编号 UI-10] 两处「焦点可见」被主动移除：TopologyMini 的 `outline-none` 与 TerminalTyper 的 1px 透明输入框

- **严重级别**：P1
- **分类**：可访问性
- **位置**：`src/components/bento/micro/TopologyMini.tsx:126`、`:83`、`src/components/bento/micro/TerminalTyper.tsx:375`

```tsx
// TopologyMini.tsx:113-127
<g key={node.id} onClick={() => setActiveId(node.id)} role="button" tabIndex={0}
   aria-label={`${node.label} — ${t.bento.topologyRoles[node.id]}`} aria-pressed={active}
   onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { … } }}
   className="cursor-pointer focus-visible:outline-none">   // ← 全局焦点环被关掉，没有替代品
```

```tsx
// TerminalTyper.tsx:375-388
<input ref={inputRef} value={value} onChange={…} onKeyDown={onKeyDown}
       aria-label={t.bento.terminalAria}
       className="pointer-events-auto absolute h-px w-px opacity-0" tabIndex={0} />
```

- **现象与证据**：
  1. `TopologyMini` 的结论是**确定的**：`index.css:183-186` 有全站生效的 `:focus-visible { outline: 2px solid var(--color-signal-cyan); outline-offset: 3px; }`，这里用 `focus-visible:outline-none` 主动覆盖，且**没有任何替代焦点样式**（`active` 走的是 `aria-pressed` / 点击态，不是 `:focus-visible`）。用户 Tab 过 6 个节点时屏幕上**没有任何变化**。**WCAG 2.4.7 Focus Visible (AA)** 硬失败。
  2. `TerminalTyper` 输入框 `h-px w-px opacity-0`：聚焦后**完全不可见**（1×1 像素且全透明），也没有 `focus-within` 样式挂到外层容器。同样 2.4.7 失败；附带 2.4.11 Focus Appearance（AA，2.2 新增）的问题。
  3. 同文件 `:83-88` 的 `<svg role="img" aria-label=…>` 是第二个问题：`img` 角色按 ARIA 规范**不接受**子节点语义，内部 6 个 `role="button"` 会被无障碍树剪掉（`img` 是 leaf node）。读屏用户只能听到「架构拓扑图，可点击节点查看职责」，**永远看不到那 6 个按钮**——虽有 `tabIndex` 仍能被 Tab 命中，但会被读成无名元素。**WCAG 4.1.2 / 1.3.1**。
  4. 附带：`aria-pressed` 用在「选中一个节点查看详情」上，语义更接近 `aria-current` 或 `listbox` 单选；能读出来，不算错，但与视觉上的「单选」不一致。

- **影响**：bento 的拓扑卡是作品集里唯一「真正可交互的数据视图」，也是展示无障碍意识的最好机会。现在键盘用户能 Tab 进去但看不到自己在哪；读屏用户听不到任何节点。`TerminalTyper` 是「带真实键盘输入的终端模拟器」（`en.ts:137` 的自述）——它自己要求键盘交互，却给了一个不可见的焦点。

- **修改建议**：

```tsx
// TopologyMini.tsx —— ① 外层改 group，② 节点给可见焦点环
<svg viewBox="0 0 240 130" className="mt-2 w-full flex-1" role="group" aria-label={t.bento.topologyAria}>

<g
  key={node.id}
  onClick={() => setActiveId(node.id)}
  role="button"
  tabIndex={0}
  aria-label={`${node.label} — ${t.bento.topologyRoles[node.id]}`}
  aria-pressed={active}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveId(node.id) } }}
  className="cursor-pointer outline-none focus-visible:[&>rect.focus-ring]:opacity-100"
  style={{ touchAction: 'manipulation' }}
>
  {/* 焦点环：SVG 上 CSS outline 跟随 bounding box，观感差，用描边矩形更稳 */}
  <rect className="focus-ring opacity-0" x={node.x - 12} y={node.y - 22}
        width={24 + node.label.length * 3} height={34}
        rx={6} fill="none" stroke="var(--color-signal-cyan)" strokeWidth={1.2}
        vectorEffect="non-scaling-stroke" />
  {/* 命中区（见 UI-09） */}
  <rect x={node.x - 14} y={node.y - 14} width={28} height={28} fill="transparent" />
  …
</g>
```
> 若觉得 SVG 焦点环难维护，更稳的是把 6 个节点渲染成**绝对定位的 HTML `<button>` 覆盖层**（`position:absolute` + 百分比坐标），`:focus-visible` 与 44px 命中区都能直接复用 `index.css` 的全局样式。

```tsx
// TerminalTyper.tsx —— 焦点状态上移给可见容器
<div className={cn('font-mono …', 'focus-within:ring-1 focus-within:ring-signal-cyan/60')}>
  …
  <input … className="pointer-events-auto absolute h-px w-px opacity-0" tabIndex={0} />
</div>
```
> 并且：终端输出（`lines`）是动态播报区，加 `role="log" aria-live="polite" aria-atomic="false"` 即可让读屏用户听到命令结果——这是 `role="log"` 的教科书用法，顺手把「终端是死的」变成「终端可读」。

---

### [编号 UI-11] 开了 `viewport-fit=cover` 却没有任何 `env(safe-area-inset-*)` 适配

- **严重级别**：P1
- **分类**：响应式
- **位置**：`index.html:6`、`src/index.css:79`、`src/components/layout/Navbar.tsx:247`

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

```css
/* index.css:77-80 */
:root { color-scheme: dark; --nav-height: 4.25rem; }
```

```tsx
// Navbar.tsx:247-254 —— fixed 顶部通栏，无安全区补偿
<header className={cn('fixed inset-x-0 top-0 z-90 transition-all duration-500', …)}>
```

- **现象与证据**：全仓 `env(safe-area-inset` 出现 **0 次**（grep 确认）。但 `index.html:6` 声明了 `viewport-fit=cover`——**这个属性唯一的作用就是把内容铺到刘海/圆角/Home Indicator 下面**，要求作者用 `env()` 把内容拉回来。两者必须成对出现，当前只有前者：
  - **顶部**：`fixed top-0` 的 header 在 iPhone 14 Pro 上会被灵动岛/状态栏覆盖（`4.25rem = 68px` 的条带里 `safe-area-inset-top` 约占 47–59px），品牌字与图标按钮压在状态栏下。
  - **底部**：`ArchitectureNarrative` 的 `bottom-[12vh]` 度量卡、`ScrollTelemetryHud` 在横屏 iPhone 上会与 Home Indicator 重叠。
  - **横向**：横屏时 `safe-area-inset-left/right` ≈ 47px，`px-4`（16px）不够，hero 的 `left-6`（24px）也不够。
  - 代码里也没有 `100vh` 问题（见 UI-18），说明 dvh 迁移做了一部分——**安全区是漏掉的那一半**。

- **影响**：作品集的首要展示设备就是手机。iPhone 上首屏导航被状态栏压住是最显眼的「没在真机上试过」信号。

- **修改建议**：把安全区折进 `--nav-height`，全站只改一处。

```css
/* index.css:77-80 */
:root {
  color-scheme: dark;
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  /* 内容行仍是 4.25rem，但整体向下让出刘海 */
  --nav-height: calc(4.25rem + var(--safe-top));
}
```
```tsx
// Navbar.tsx —— 内容行保持 4.25rem，外层补安全区
<header className="fixed inset-x-0 top-0 z-90 pt-(--safe-top) …">
  <div className="mx-auto flex h-[4.25rem] max-w-[104rem] items-center gap-4 px-4 sm:px-6 lg:px-10 …">
```
```tsx
// Sections.tsx / ArchitectureNarrative.tsx 的左右内边距
'px-[max(1rem,var(--safe-left))] sm:px-6 lg:px-10'
```
```tsx
// CommandPalette.tsx:242 —— 顶部安全区与 dvh 一起处理（见 UI-18）
className="fixed inset-0 z-[120] flex items-start justify-center px-4
           pt-[max(10vh,calc(var(--safe-top)+8px))] sm:pt-[14vh]"
```
> 验证：Chrome DevTools 设备工具栏的 iPhone 14 Pro 模拟会画出安全区；iOS 真机需实测（**此项需真机确认**）。

---

### [编号 UI-12] `prefers-reduced-motion` 只覆盖了 CSS，framer-motion 的动画完全不受控

- **严重级别**：P2
- **分类**：可访问性
- **位置**：`src/index.css:203`、`src/components/ui/LanguageSwitcher.tsx:83`、`src/components/command/CommandPalette.tsx:241`

```css
/* index.css:203-211 —— 只作用于 CSS animation / transition */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

```tsx
// LanguageSwitcher.tsx:83-89 —— 弹簧动画由 framer 直接写内联 transform，绕过上面的规则
<motion.span layoutId={PILL_LAYOUT_ID} className="absolute inset-0 rounded-full bg-signal-cyan"
  transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.6 }} aria-hidden />

// CommandPalette.tsx:241-247 —— 入场 opacity/scale/y 同理
<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} … />
```

- **现象与证据**：CSS 那条规则处理得相当细致——`index.css:414-421`（comet）、`:464-470`（data-pulse）、`:530-542`（boot，还解释了为什么用 `translateX(0)` 而不是让它跑到终点）、`VfxSweepTransition.tsx:154-159`（连 `display:none` 都补了）。但 framer-motion 的动画是 **JS 驱动**（rAF 或 WAAPI 直接写内联 `transform`/`opacity`），不经过 CSS `animation`/`transition` 属性，**完全逃过全局兜底**：
  - `LanguageSwitcher` 的 `layoutId` 药丸：420 stiffness 弹簧位移照跑。
  - `CommandPalette` 的 `scale 0.97 → 1` + `y -10 → 0`：缩放式入场是前庭敏感用户最不友好的动画类型之一。
  - `SpotlightCard` 的 `useSpring` 倾斜（`SpotlightCard.tsx:108-114`）：鼠标驱动 3D 旋转照转 8°。
  - 全仓**没有 `<MotionConfig reducedMotion="user">`**（grep 0 次），也没有任何 `useReducedMotion()` 调用（`VfxSweepTransition` 用的是自己的 `prefersReducedMotion()`，只在那一个组件生效）。

- **影响**：设置「减少动态效果」的用户（macOS/iOS 无障碍首选，Windows「动画效果」关闭）在本站会看到命令面板缩放弹入、语言药丸弹簧滑动、卡片随鼠标 3D 倾斜。**CSS 层的细致程度说明这是有意承诺，但承诺只兑现了一半。** WCAG 2.3.3 Animation from Interactions (AAA) 与实际审计口径都会看。

- **修改建议**：一行解决 90%——`MotionConfig` 自动把 transform/layout 类动画降级为不动画，保留 opacity 淡入（framer 既定行为，也是规范推荐）。

```tsx
// src/App.tsx
import { MotionConfig } from 'framer-motion'
…
<MotionConfig reducedMotion="user">
  <SmoothScroll>…</SmoothScroll>
</MotionConfig>
```
```tsx
// SpotlightCard.tsx —— 3D 倾斜单独关掉（MotionConfig 管不到 motion value 驱动的 style）
import { useReducedMotion } from 'framer-motion'
const reduced = useReducedMotion()
const tiltEnabled = enableTilt && !reduced
```
并把 `update()` 里的 `offsetX/offsetY` 写入也跳过（`:145` 已有 `if (!enableTilt …) return`，把 `enableTilt` 换成 `tiltEnabled`）。
> 顺带：`BentoGrid` 的 ambient 呼吸环（`:433-478`）与 inter-card 闪电脉冲（`:607-621`）是持续性装饰运动，reduced-motion 下应整体停掉（两个 `useEffect` 顶部 `if (reduced) return`），而不是等 CSS 压 `animation-duration`——它们本来就是 rAF 驱动的。

---

### [编号 UI-13] 设计 token 没有闭环：1 个死 token、1 个悬空选择器、5 处硬编码 emerald、96 处任意值

- **严重级别**：P2
- **分类**：设计系统
- **位置**：`src/index.css:39`、`:557`、`src/components/bento/SpotlightCard.tsx:93`、`:368`、`src/components/bento/CardParticleCanvas.tsx:59`

```css
/* index.css:37-39 —— drift 动画定义了，从未使用 */
  --animate-scan: scan 7s linear infinite;
  --animate-pulse-dot: pulse-dot 2.4s ease-in-out infinite;
  --animate-drift: drift 18s ease-in-out infinite;    /* animate-drift 全仓 0 次 */

/* index.css:554-558 —— .animate-pulse-soft 根本不存在（真实工具类是 animate-pulse-dot） */
html.is-scrolling .comet-beam,
html.is-scrolling .data-pulse,
html.is-scrolling .animate-scan,
html.is-scrolling .animate-pulse-soft { animation-play-state: paused; }
```

```tsx
// SpotlightCard.tsx:93 —— 默认主题硬编码 emerald，与 accent 主题系统脱钩
glowColor = '16, 185, 129',
// :368 / :375 / :395 —— 两根 comet 光束写死 emerald + cyan
style={{ '--comet-glow': '#10b981' } as React.CSSProperties}
stroke="#10b981"      stroke="#22d3ee"
```

- **现象与证据**：
  1. **死 token**：`--animate-drift` / `@keyframes drift`（`index.css:39`、`:63-71`）全仓引用 0 次（`animate-drift` 只在 `@theme` 里出现）。
  2. **悬空选择器**：`html.is-scrolling .animate-pulse-soft`（`:557`）——Tailwind 里没有 `animate-pulse-soft`（`@theme` 只定义了 `--animate-pulse-dot`）。这条选择器**永远不匹配**，作者显然想暂停 `StatusDot` 的呼吸（`primitives.tsx:76` 用的 `animate-pulse-dot`）。**`is-scrolling` 的级联影响面本身很克制**（只暂停 4 个具名类，`:544-559` 的注释解释得清楚），问题只在这一条写错的类名。
  3. **硬编码色值绕过调色板**：`BentoShowcase.tsx:20-27` 的注释声称「每张卡的 glow 都取当前 VFX 调色板的 `glowRgb`」，但：
     - `SpotlightCard.tsx:93` 默认值 emerald；
     - `SpotlightCard.tsx:368/375/395` 两根 comet 光束写死 `#10b981` / `#22d3ee`（切到「黑金超新星」时边框光晕变金色、周界光束仍是绿色）；
     - `CardParticleCanvas.tsx:59-60` `COLOR_WARM = '16, 185, 129'` / `COLOR_COOL = '34, 211, 238'`；
     - `TokenThroughputChart.tsx:117-119 / :144 / :156` 全用 `rgba(16,185,129…)` / `rgba(52,211,153…)` / `rgba(110,231,183…)`；
     - `TopologyMini.tsx:102 / :141-142` `rgba(16,185,129,…)`、`fill="#34d399"`、`fill="#6ee7b7"`。
     共 **5 个文件、13 处**绕过调色板。**UI 外壳会换肤，卡片内部不会。**
  4. **任意值密度**：in-scope 的 7 个组件里 `[...]` 类共 **96 处**（`ArchitectureNarrative.tsx` 28、`Sections.tsx` 23、`CommandPalette.tsx` 18、`Navbar.tsx` 16、`BentoShowcase.tsx` 8、`BentoGrid.tsx` 2、`SpotlightCard.tsx` 1），绝大多数是 `text-[0.55rem]` / `text-[0.6rem]` / `text-[0.72rem]` 这类**重复字号**，本该是 token 却以字符串散落。`--radius-panel` 是唯一被正确抽象出来的（12 次使用），说明作者知道怎么做。
  5. **圆角不一致**：`SpotlightCard.tsx:373/392` 的 comet `rect rx="13"`，而卡片圆角是 `--radius-panel: 0.875rem = 14px`（`index.css:35`），差 1px 会让光束在圆角处微微内缩。

- **影响**：换肤（Visual Overdrive，navbar 上有专门按钮 + 命令面板 3 个预设项）是卖点之一；点下去只有 UI 外壳变色、卡片内部仍旧绿，会被读成「假功能」。任意值字号让「统一抬字号」变成 30 处替换而不是 1 个 token 改动。

- **修改建议**：

```css
/* index.css @theme —— 补齐卡内发光色阶 + 字号档位，删掉死 token */
@theme {
  --animate-scan: scan 7s linear infinite;
  --animate-pulse-dot: pulse-dot 2.4s ease-in-out infinite;
  /* --animate-drift 删除，@keyframes drift 同步删除 */

  --text-2xs: 0.68rem;  --text-2xs--line-height: 1rem;    /* 替代 text-[0.55rem] */
  --text-xs2: 0.72rem;  --text-xs2--line-height: 1.1rem;  /* 替代 text-[0.72rem] */

  --color-glow-emerald: #34d399;   /* 卡片内部粒子/图表/拓扑统一从这里取 */
  --color-glow-cyan: #22d3ee;
  --color-glow-amber: #fbbf24;
}
html.is-scrolling .animate-pulse-dot { animation-play-state: paused; }   /* 修正类名 */
```

```tsx
// lib/vfxPalette.ts 里补一个 CSS 变量注入点，让 SVG/canvas 也吃到主题
useEffect(() => {
  const root = document.documentElement
  root.style.setProperty('--glow-warm', palette.glowRgb)       // 'r, g, b' 三元组
  root.style.setProperty('--glow-cool', palette.secondaryRgb)
}, [palette])
```
```tsx
// SpotlightCard.tsx —— comet 改用变量
<rect className="comet-beam" stroke="rgb(var(--glow-warm))"
      style={{ '--comet-glow': 'rgb(var(--glow-warm))' }} … />
```
```tsx
// SpotlightCard.tsx:373/392 —— 圆角对齐
rx="14"   // = --radius-panel
```
> 建议加一条 CI 检查把硬编码 hex 挡在门外（`rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+` 与 `#[0-9a-f]{6}` 在 `src/components/**` 下只允许出现在 `index.css` 与 `lib/vfxPalette.ts`），10 行脚本即可。

---

### [编号 UI-14] `role="application"` 用在了两个不可键盘操作的 canvas 上

- **严重级别**：P2
- **分类**：可访问性
- **位置**：`src/components/sandbox/VerletLanyard.tsx:683`、`src/components/sandbox/FabrikCreature.tsx:1692`（跨范围，但属同一模式，故在此登记）

```tsx
// VerletLanyard.tsx:677-685
<canvas ref={canvasRef} className="drag-surface relative block h-full w-full select-none"
  style={{ touchAction: 'none' }}
  role="application"
  aria-label={t.sandbox.verletAria} />
```

- **现象与证据**：`role="application"` 的语义是「这块区域接管全部键盘交互，请把浏览模式切掉」，必须配**自定义键盘模型**（自己处理 Tab/方向键/Esc）。但这两个 canvas：
  - 没有 `tabIndex`（全仓 `tabIndex` 只在 `TerminalTyper:387`、`TopologyMini:117` 出现），**键盘根本进不去**；
  - 没有任何 `onKeyDown`（`onKeyDown=` 全仓只有 3 处，均不在 sandbox）；
  - `aria-label` 描述的是**指针操作**：「可拖拽的物理工牌沙盒，拖动工牌可甩动」（`zh.ts:212`）、「移动鼠标追踪，点击发射激光」（`zh.ts:213`）。对只能键盘的用户，这些描述描述了不可能完成的操作。
  
  带着读屏进入区块的用户，`application` 会让部分 AT（NVDA browse mode、JAWS virtual cursor）暂时交出导航控制权，而内部**没有可操作对象**——结果是「进了隧道出不来」。

- **影响**：`role="application"` 是 ARIA 里被滥用最严重的角色之一，出现在作品集里对懂行的面试官是负面信号。这两个组件本来就无法键盘操作（纯视觉演示），`application` 一点好处都没带来。

- **修改建议**：降级为静态图形 + 文本等价物。

```tsx
// 两个 sandbox 统一改法
<canvas
  role="img"
  aria-label={t.sandbox.verletAria}          // 保留描述，但改成陈述而非指令
  aria-describedby="verlet-hint"
  …
/>
<p id="verlet-hint" className="sr-only">
  {t.sandbox.verletKeyboardFallback}         // 新增：'键盘用户可使用下方的「重新锻造挂绳」按钮'
</p>
```
并确认现有的 `verletReset` / `fabrikReset` 按钮在 DOM 里是键盘可达的 `<button>`（不在 canvas 内部）。若未来要做可操作版本，再升级为 `role="application"` + 完整 `onKeyDown` 模型（方向键移动、空格拖拽），并在 `aria-label` 写明键盘映射。
> 字典里 `zh.ts:212-213` 的文案建议改成中性陈述（「物理工牌沙盒，拖动可甩动，过度拉伸会扯断」），去掉「移动鼠标」这类指令式描述。

---

### [编号 UI-15] 四颗点击无反应的死按钮 + 5 处对普通 `div` 的 `aria-label`（实际无效）

- **严重级别**：P2
- **分类**：可访问性 / 可维护性
- **位置**：`src/components/sections/Sections.tsx:192`、`src/components/bento/BentoShowcase.tsx:182`、`src/components/bento/SpotlightCard.tsx:251`

```tsx
// Sections.tsx:192-209 —— archive 三行是可聚焦按钮，点了什么都不发生
<button type="button" className="group flex w-full items-center gap-4 py-5 text-left …">
  <span …>{row.year}</span>
  <span …>{row.title}</span>
  <ArrowUpRight className="…" aria-hidden />
</button>
```

```tsx
// BentoShowcase.tsx:182-188 —— 自述是 action 目标，但没有 onClick
<button type="button" data-card-action="true" className="…">{t.bento.inspectArchitecture}</button>
```

```tsx
// SpotlightCard.tsx:251 —— div 没有 role，aria-label 按 ARIA 规范对它无效
<motion.div ref={cardRef} data-spotlight-card … aria-label={label}>
```

- **现象与证据**：
  1. **死按钮（4 个）**：`Sections.tsx:192` 的 Archive 三行（`year/title/type` 是历史作品索引，本该链接到案例，现在点下去毫无反应）、`BentoShowcase.tsx:182` 的「查看架构 / Inspect architecture」。键盘用户可以 Tab 到它们、按 Enter、然后**什么都不发生**——比纯文本更糟。有意思的是 `data-card-action` 的存在说明它唯一的作用是给 ember 粒子当引力井（`SpotlightCard.tsx:167-209`）：**按钮的主要功能是装饰特效。**
  2. **无效 `aria-label`（5 处）**：`SpotlightCard` 的 `label` prop 被 `BentoShowcase` 以 `label={t.bento.cardThroughputLabel}` 等形式传了 5 次，最终落在 `<motion.div>` 上。`div` 的隐式角色是 `generic`，ARIA 1.2 明确规定 `generic` **不支持** author 命名（Chrome/AT 实测均忽略）。这 5 个本地化好的标签（`Live inference` / `Topology` / `Deploy` / `Rendering` / `Uptime`）**一个字都不会被读出来**。要做「卡片有区域名」，必须是 `role="region"` / `role="group"` / `role="figure"` 之一。
  3. 附带：卡片本身的 `onClick`（`SpotlightCard.tsx:261-266`）只播音效，没有键盘等价物——纯装饰反馈可接受，但配合「卡片内有死按钮」就成了误导。

- **影响**：Archive 章节是给招聘方看「过往作品」的，三行看起来可点、点不动，直接降低可信度。5 处 `aria-label` 是「以为做了无障碍但实际没做」的典型，axe 会报 `aria-prohibited-attr`。

- **修改建议**：
  1. 给 Archive 行真实落点（`<a href>` 或 `onClick` 打开详情）；暂无内容时**降级为非交互文本**：
     ```tsx
     // 没有详情页时别用 button
     <li key={row.title} className="flex w-full items-center gap-4 py-5 text-left">
       … 同内容，去掉 button 与 group-hover 位移 …
     </li>
     ```
  2. 「查看架构」要么接 `scrollToTarget('#architecture', -16)`，要么删按钮只留文字。
  3. 卡片语义：`<motion.div role="group" aria-label={label} …>`（`group` 支持 author 命名），保留卡片里的 `<h3>`——两者不冲突。

---

### [编号 UI-16] i18n 格式化层缺失：数字/日期/复数没走 `Intl`，且命令式写入的文案换语言后滞留旧语种

- **严重级别**：P2
- **分类**：i18n
- **位置**：`src/components/command/CommandPalette.tsx:427`、`src/config/commands.ts:303`、`src/components/sections/ArchitectureNarrative.tsx:253`

```tsx
// CommandPalette.tsx:427 —— 手写占位符替换，没有复数规则
{t.commands.countLabel.replace('{items}', String(flat.length)).replace('{total}', String(commands.length))}
// en.ts:330  countLabel: '{items} results · {total} commands'   → 1 条结果时是 "1 results"
```

```ts
// commands.ts:303-307 —— 简历 JSON 用 ISO 时间戳，面向人却给了机器格式
generatedAt: new Date().toISOString(),
```

```tsx
// ArchitectureNarrative.tsx:253-267 —— 只在 phase 变化时写 textContent，换语言不重写
const phase = p < 0.3 ? 'interlocked' : p < 0.7 ? 'exploded' : 'reassembled'
if (cap.dataset.phase !== phase) {
  cap.dataset.phase = phase
  const copy = getDictionary().architecture
  cap.textContent = phase === 'interlocked' ? copy.subtitleIdle : …
}
```

- **现象与证据**：
  1. **复数 / 数字**：`{items} results` 在 1 条结果时是语法错误；`{total} commands` 同理。全仓没有 `Intl.PluralRules` / `Intl.NumberFormat` / `Intl.DateTimeFormat`（grep 0 次）。硬编码数字格式还有 `BentoShowcase.tsx:153` 的 `'8 000'`（英文应 `8,000`）、`ArchitectureNarrative.tsx:61-64` 的 `'12.4k'` / `'8 000'`。
  2. **日期**：下载的 resume JSON 里 `generatedAt: new Date().toISOString()`。对「给人看的简历导出」，应同时给 `Intl.DateTimeFormat(locale)` 的人类可读字段。
  3. **滞留旧语种（确凿的行为缺陷）**：`ArchitectureNarrative` 的 subtitle 由 `onProgress` 里 `cap.textContent = …` 写入，并以 `cap.dataset.phase` 做「只在阶段变化时写」的节流。**用户切到中文时，如果还没滚动跨过 phase 边界，这段文案会继续显示英文**——React 重渲染不会覆盖它，因为它不是 JSX 文本（`:362-368` 的 `<p ref={captionRef}>` 子节点只有初始的 `{t.architecture.subtitleIdle}`，之后被 DOM 直接改写）。这是本仓唯一一处「切换语言后界面语言不一致」的实证缺陷。
  4. 同类（更轻）：`FpsReadout` 的 `Telemetry` 标题（`Navbar.tsx:91`）与同面板的 `t.nav.frame` / `t.nav.worst` 混排——半英半中。

- **影响**：`1 results` 在英文母语面试官眼里格外刺眼；数字不本地化让 `8 000` vs `8,000` 混乱。第 3 条是**功能性 bug**：切了语言但屏幕上还留着另一种语言。

- **修改建议**：

```tsx
// CommandPalette.tsx —— 用 Intl.PluralRules，字典改成 {one, other} 两态
const nf = new Intl.NumberFormat(locale)
const pr = new Intl.PluralRules(locale)
const results = t.commands.countLabel[pr.select(flat.length) as 'one' | 'other']
  .replace('{items}', nf.format(flat.length))
  .replace('{total}', nf.format(commands.length))
// en.ts:  countLabel: { one: '{items} result · {total} commands', other: '{items} results · {total} commands' }
// zh.ts:  countLabel: { one: '{items} 项 · {total} 条命令',  other: '{items} 项 · {total} 条命令' }
```
```ts
// commands.ts —— 简历导出补人类可读时间
generatedAt: new Date().toISOString(),
generatedAtLocal: new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'long', timeStyle: 'short' }).format(new Date()),
```

```tsx
// ArchitectureNarrative.tsx —— 把 phase 提成 state，让 React 负责渲染，语言切换自动跟随
const [phase, setPhase] = useState<'interlocked' | 'exploded' | 'reassembled'>('interlocked')
// onProgress 里只 setPhase（React 对相同值自动短路）
<p ref={captionRef} className="…">
  {phase === 'interlocked' ? t.architecture.subtitleIdle
   : phase === 'exploded' ? t.architecture.subtitleExplode
   : t.architecture.subtitleFinal}
</p>
```
> 这会引入「每跨一个 phase 一次 render」——phase 只有 3 态、一次滚动最多切 2 次，与零渲染目标不冲突。若坚持零渲染，至少要在 locale 变化时清掉缓存标记：`useEffect(() => { if (cap.dataset) cap.dataset.phase = '' }, [locale])`。

数字处理统一入口建议放 `src/lib/format.ts`：`formatNumber(n, locale)` / `formatDate(d, locale)` / `formatPlural(...)`，配 3 个单测。

---

### [编号 UI-17] CI 供应链与预算：6 个 action 全部浮动 tag、无 bundle 预算、`minimumReleaseAge` 与 `--frozen-lockfile` 的隐式耦合

- **严重级别**：P2
- **分类**：工程化
- **位置**：`.github/workflows/deploy.yml:49`、`:102`、`pnpm-workspace.yaml:24`

```yaml
      - uses: actions/checkout@v4                 # :49  浮动 major
      - uses: pnpm/action-setup@v4                # :54
      - uses: actions/setup-node@v4               # :63
      - uses: actions/configure-pages@v5          # :114
      - uses: actions/upload-pages-artifact@v3    # :117
      - uses: actions/deploy-pages@v4             # :135
```

```yaml
# deploy.yml:102-111 —— 唯一的产物检查只数个数，没有体积门槛
      - name: Verify build output
        run: |
          test -f dist/index.html || { echo "::error::dist/index.html missing"; exit 1; }
          js_count=$(find dist -name '*.js' | wc -l)
          test "$js_count" -gt 0 || { echo "::error::no JS bundle emitted"; exit 1; }
          echo "dist size: $(du -sh dist | cut -f1)"
```

- **现象与证据**：
  1. **供应链**：6 个 action 全部使用浮动 major tag。tag 可被上游重新指向（2025 年 `tj-actions/changed-files` 就发生过 tag 被改写后外泄 secrets 的事件）。对一个有 `pages: write` + `id-token: write` 权限的部署 job，必须 pin 到 commit SHA（GitHub 官方安全加固建议的原文要求）。
  2. **无 bundle 预算**：实测 `dist/` 总计 **1.74 MB**——`three-*.js` **1 044.6 KB**、`index-*.js` **237.1 KB**、`react-*.js` **216.1 KB**、`motion-*.js` **144.8 KB**、`index-*.css` **61.7 KB**。CI 只打印 `du -sh`，**没有任何阈值**——一次误把 `three` 打进主包、或 CSS 翻 3 倍，CI 都会绿。对一个「性能即卖点」的仓库（README 与 UI 里到处是 FPS/帧预算话术），这一条格外讽刺。
  3. **`minimumReleaseAge: 720` 与 `--frozen-lockfile`**：`pnpm-workspace.yaml:8-24` 把检疫期从 24h 降到 12h，理由是「默认 1440 曾让 CI 在两个刚发布的版本上失败」——这本身就说明 **`minimumReleaseAge` 在 install 阶段生效，即便带 `--frozen-lockfile`**。推论：每次依赖升级后的 12 小时内重新触发部署，仍可能被检疫期拦下，且失败与代码无关、可重复触发、只能干等 12 小时。当前两个包（`lucide-react@1.66.0`、`ws@8.22.1`）都过了窗口，所以暂时看不到问题——这是**定时炸弹式的 flaky**。（**需实测**：pnpm 11 对 `--frozen-lockfile` + `minimumReleaseAge` 的确切行为，建议本地对照 `pnpm install --frozen-lockfile` 的输出。）
  
  另外 `pnpm-workspace.yaml` **没有 `packages:` 字段**——它现在纯粹被当配置文件用（pnpm 11 允许）。一旦有人加 `packages: ['.']` 或真建子包，文件语义会静默改变；建议加注释说明。

- **影响**：供应链项对个人项目是「概率低、后果重」；bundle 预算项对「性能作品集」是「概率高、后果直接」（首屏 1.74MB 未压缩，`three` 1MB 是大头，需 gzip 后才知道真实传输量——**建议实测 `gzip -c dist/assets/three-*.js | wc -c`**）。`minimumReleaseAge` 那条会以「过几天再部署就好了」的形式浪费排查时间。

- **修改建议**：

```yaml
# 1) pin SHA（用 pnpm dlx pin-github-action 或 actions-up 批量改；SHA 以 git ls-remote 实测为准）
      - uses: actions/checkout@<40位SHA>              # v5.0.0
      - uses: pnpm/action-setup@<40位SHA>             # v4.1.0
      - uses: actions/setup-node@<40位SHA>            # v4.4.0
      - uses: actions/configure-pages@<40位SHA>       # v5.0.0
      - uses: actions/upload-pages-artifact@<40位SHA> # v3.0.1
      - uses: actions/deploy-pages@<40位SHA>          # v4.0.5
```

```yaml
# 2) bundle 预算：把实测数字变成硬门槛
      - name: Bundle budget
        run: |
          node - <<'NODE'
          const fs = require('node:fs'), path = require('node:path')
          const dir = 'dist/assets'
          const kb = f => fs.statSync(path.join(dir, f)).size / 1024
          const files = fs.readdirSync(dir)
          const total = files.reduce((s, f) => s + kb(f), 0)
          const limits = { total: 2200, 'three-': 1150, 'index-': 320, '.css': 90 }  // KB
          const fail = []
          if (total > limits.total) fail.push(`total ${total.toFixed(0)}KB > ${limits.total}`)
          for (const [prefix, max] of Object.entries(limits)) {
            if (prefix === 'total') continue
            for (const f of files.filter(f => f.includes(prefix)))
              if (kb(f) > max) fail.push(`${f} ${kb(f).toFixed(0)}KB > ${max}`)
          }
          if (fail.length) { console.error('::error::bundle budget exceeded\n' + fail.join('\n')); process.exit(1) }
          console.log(`✓ ${total.toFixed(0)}KB total`)
          NODE
```
> 当前实测：total 1740 / three 1044.6 / index 237.1 / css 61.7 KB —— 上面阈值留了约 25% 余量，可先当基线，再按 gzip 后真实传输量收紧（建议最终以 gzip 后为准：`three` 约 300KB 量级）。

```yaml
# 3) minimumReleaseAge：把「等 12 小时」变成显式可见，而不是神秘失败
      - name: Install dependencies
        run: pnpm install --frozen-lockfile --reporter=append-only
      - name: Explain quarantine failures
        if: failure()
        run: echo "::warning::若失败信息含 minimumReleaseAge，说明依赖发布不足 12h；等待或临时设置 minimumReleaseAgeExclude"
```
更稳的做法是对**已锁定且已审阅**的两个包做最小豁免，而不是全局放宽：
```yaml
minimumReleaseAge: 720
minimumReleaseAgeExclude:
  - lucide-react
  - ws
```

---

### [编号 UI-18] 响应式：`dvh` / `svh` / `vh` 三套单位混用，iOS 地址栏会让 sticky 舞台在滚动中变高

- **严重级别**：P2
- **分类**：响应式
- **位置**：`src/components/sections/ArchitectureNarrative.tsx:319`、`:14`、`src/components/sections/Sections.tsx:35`、`src/components/command/CommandPalette.tsx:307`

```tsx
// ArchitectureNarrative.tsx:317-320 —— sticky 舞台用 h-dvh
<div ref={stageRef} className="sticky top-0 flex h-dvh w-full items-center overflow-hidden">
// 但同一文件 :14 的文档注释还写着「exactly 100vh」，:20 写着 "(300vh - 100vh)"
 *     <div position:sticky top:0>   the pinned stage, exactly 100vh
```

```tsx
// Sections.tsx:35 / :74 —— 章节壳用 svh
'relative mx-auto flex min-h-[100svh] w-full max-w-[104rem] flex-col justify-center px-4 py-28 …'
// CommandPalette.tsx:307 —— 面板高度用 vh
className="scrollbar-none max-h-[min(24rem,52vh)] overflow-y-auto overscroll-contain p-1.5"
```

- **现象与证据**：
  1. **单位四套并存**：`100dvh`（`App.tsx:111`、`index.css:167`）、`100svh`（`Sections.tsx:35`、`:74`、`:230`）、`vh`（`CommandPalette.tsx:307`、`ArchitectureNarrative.tsx:345` 的 `top-[16vh]`、`:405` 的 `bottom-[12vh]`）、`h-dvh`（`ArchitectureNarrative.tsx:319`）。四者各有正确用途，但分工不一致：
     - **sticky 场景是真 bug 候选**：`ArchitectureNarrative` 是 `h-[300vh]` 轨道（`:314`）+ `h-dvh` 粘性舞台。iOS Safari 的 `dvh` 会**随地址栏收起/展开动态变化**，而 `300vh` 是固定。于是地址栏展开时舞台矮 60–90px，粘性元素在滚动中「抽动」一下；`useSectionProgress` 的分母若按 rect 计算也会跳变。**这是移动端最容易看到的抖动。** 建议舞台改 `h-[100svh]`（最小视口高度，永远不变）或 `h-[100lvh]` + `overflow-hidden` 裁切，不要用会变的 `dvh` 做 sticky。
     - **`52vh` 在移动端偏大**：地址栏展开时 `52vh` ≈ 实际可视高度的 58%，配 `pt-[10vh]` + 页脚，命令面板在小屏上会超出可视区下沿（页面又被 `stopScroll()` 锁了滚动），底部页脚被切掉且无法滚动。改 `52dvh` 或 `min(24rem, 50dvh)` 更稳。
     - **`100svh` 章节壳在 iOS 上会露缝**：地址栏收起后可视高度 = `lvh` > `svh`，`min-h-[100svh]` 的章节比视口矮，底部会露出下一章一截。对「一屏一章」的设计意图，`min-h-dvh` 更符合预期（`App.tsx:111` 已用 `min-h-dvh`，两处不一致）。
  2. **断点体系是克制的（应表扬）**：自定义只有 `--breakpoint-xs: 25rem`（`index.css:11`，仅 `Navbar.parts.tsx:110` 一个 `xs:inline` 使用点），其余全用默认 `sm/md/lg`，没有 `min-[900px]:` 这类散装断点。`BentoGrid.tsx:648-650` 的 `auto-rows-[auto] md:auto-rows-[minmax(0,17rem)]` + `grid-cols-1 md:grid-cols-2 lg:grid-cols-4` 是**单列回退做对了**的正面例子（注释还解释了手机要 `auto` 而不是 `17rem`，避免 7 个 17rem 空盒）。
  3. **横向溢出**：`body { overflow-x: hidden }`（`index.css:175`）兜住绝大多数情况，`smoke.mjs:180-183` 也断言了 `scrollWidth > innerWidth + 1`。但 `overflow-x: hidden` 会**掩盖根因**（例如 `ArchitectureNarrative` 的 `translate3d(64px)` 度量卡在未展开时可能顶出右边界），且在部分浏览器里会让 `position: sticky` 失效（overflow 祖先成为新的滚动容器）——`ArchitectureNarrative` 的 sticky 恰好依赖这一点，当前 `overflow-x: hidden` + `html.lenis` 的样式组合**需实测** sticky 是否仍生效。

- **影响**：`dvh` 用在 sticky 上会在 iPhone 上产生肉眼可见的抽动；`52vh` 面板在小屏上够不到页脚。两点都在「招聘方用手机打开」的主路径上。

- **修改建议**：定一条明确规则并落进注释。

```css
/* index.css —— 写清四套单位的用途，避免下次又混 */
/*
 * viewport units policy:
 *  100lvh  仅用于「必须铺满最大可视区」的装饰层（背景、扫描线）
 *  100svh  仅用于 sticky / 固定高度容器（地址栏变化时不能跳）
 *  100dvh  仅用于「随可视区伸缩即可」的内容容器（body min-height）
 *  vh      仅用于百分比定位（top-[16vh]），不参与 sticky 布局
 */
```
```tsx
// ArchitectureNarrative.tsx:319 —— sticky 舞台改用稳定的最小视口
<div ref={stageRef} className="sticky top-0 flex h-[100svh] w-full items-center overflow-hidden">
// 同步修掉 :14/:20 的过期注释（"100vh" → "100svh"）
```
```tsx
// Sections.tsx:35 / :74 —— 章节壳与 body 统一到 dvh
'relative mx-auto flex min-h-dvh w-full max-w-[104rem] flex-col justify-center …'
```
```tsx
// CommandPalette.tsx:307 —— 用 dvh 并给页脚留位置
className="scrollbar-none max-h-[min(24rem,calc(100dvh-18rem))] overflow-y-auto overscroll-contain p-1.5"
```
> 回归方式：用现有 `smoke.mjs` 里那段 `overflowX` 断言，扩成「iPhone SE(375×667) / iPhone 14 Pro(393×852) / iPad(820×1180)」三个 `Emulation.setDeviceMetricsOverride` 各跑一次，并把 sticky 舞台的 `getBoundingClientRect().top` 在滚动中采样 5 次，断言 `|top| < 2px`——这才是 dvh 抖动的量化检测。

---

### [编号 UI-19] 组件体量与职责：`BentoGrid` 769 行 / 28.4 KB 里塞了 3 套互不相干的系统

- **严重级别**：P3
- **分类**：可维护性
- **位置**：`src/components/bento/BentoGrid.tsx:108`、`:433`、`:514`、`src/components/command/CommandPalette.tsx:336`

```tsx
// BentoGrid.tsx 一份文件里同时是：
// ① 指针 → 卡片聚光灯的坐标管线（:140-328，measureLayoutBox/refreshLayout/applyPointer/registry）
const registry = useMemo<SpotlightRegistry>(() => ({
  register: (element, handle) => { … cardsRef.current.set(element, {…}); if (pointerRef.current.active) schedule() },
  unregister: (element) => { cardsRef.current.delete(element) },
}), [schedule])

// ② 触屏环境光：Lissajous 呼吸 + 陀螺仪倾斜（:363-478，约 115 行）
const breathX = 0.5 + BREATH_AMPLITUDE * Math.sin((seconds / BREATH_PERIOD_X) * Math.PI * 2)
// ③ 卡片间闪电脉冲：邻接检测 + 中点位移分形 + 4s 心跳（:514-621 + :734-767，约 190 行）
const points = midpointDisplace(pick.from, pick.to, 4, 0.55)
```

```tsx
// CommandPalette.tsx:335-340 —— 每行 hover 里做一次 O(n) 线性查找
onPointerEnter={() => {
  const index = flat.findIndex((entry) => entry.cmd.id === item.cmd.id)
  if (index >= 0) setActiveIndex(index)
}}
```

- **现象与证据**：
  1. **BentoGrid 三职责**：① 聚光灯坐标管线（`:53-328`），② 环境光呼吸/陀螺仪（`:363-478`），③ 跨卡闪电脉冲（`:514-621` + `:702-767` 的分形生成器）。三者**没有共享状态**（除 `inViewRef`），拆开后每个都能独立测试：`midpointDisplace` 是纯函数却埋在组件文件底部。769 行意味着改「闪电粗糙度」和改「聚光灯 rAF 合并」要在同一文件里跳 300 行。
  2. **`SpotlightCard` 18.5 KB / 422 行**：职责相对清楚（3D 变换层 + 裁剪层 + 4 个光效层 + ember 句柄），但 `handleEmberOver/Out/Burst` 里的 `actionCentre` 是每次渲染新建的闭包，被 `useCallback([])` 捕获（`:191`/`:208` 用 `eslint-disable` 掩盖，见 UI-03）——**真实的陈旧闭包隐患**。
  3. **`spotlightRegistry` 的模式本身是合理的**：用 context 传「注册表」而非回调 props，避免父渲染导致 N 个子重渲染（`spotlightRegistry.ts:6-14` 写清了理由），且卸载时 `SpotlightCard.tsx:212-218` 正确 `unregister`，`Map` 不泄漏。**唯一残留风险**：`cardsRef` 以 DOM 元素为 key，若未来新增卡片忘写 unregister，`refreshLayout` 会对已卸载元素调 `offsetLeft`（返回 0，不抛错）→ 静默坐标错乱而非崩溃。建议 `unregister` 后置 `layoutDirtyRef.current = true`，或在 `refreshLayout` 里校验 `entry.element.isConnected`。
  4. `CommandPalette` 474 行：搜索/分组/键盘/执行/渲染全在一个组件。`:336` 的 `findIndex` 是 O(n²)（16 行 × 每行 hover = 256 次，无感），但说明「行 index 应该由数据直接携带」——`ScoredCommand` 加一个 `flatIndex` 即可。
  5. **重复 key 风险（任务书特别问的点）：逐项检查后没有发现问题**——`CommandPalette` 用 `cmd.id`（`:327`）、分组用 `section.group`（`:318`）、`BentoShowcase` 五张卡是硬编码子节点（无需 key）、`UptimeCard` 用 index（`BentoShowcase.tsx:218`，静态 14 根柱子，安全）、`Sections.tsx:191` 用 `row.title`（3 个不同标题）、`ArchitectureNarrative.tsx:179` 用 `tech.name`（`layers.ts` 内唯一）。**key 用得很干净，无需改。**

- **影响**：这份代码注释密度极高（每个常量都有「为什么是这个值」），说明作者会写可维护代码；但「一个文件 769 行」会让新人（或三个月后的自己）不敢动。招聘方挑一个文件看时，`BentoGrid.tsx` 大概最容易被点开。

- **修改建议**：纯机械拆分，零行为变更。

```
src/components/bento/grid/
  useSpotlightField.ts      ← :108-328（measureLayoutBox / refreshLayout / applyPointer / registry）
  useAmbientTilt.ts         ← :363-478（Lissajous + gyro + permission）
  useInterCardPulse.ts      ← :514-621（心跳 + emitPulse）
  pulseGeometry.ts          ← :702-767（midpointDisplace / PulsePoint，纯函数，可直接单测）
  BentoGrid.tsx             ← 只剩 JSX + 三个 hook 的组装（目标 ≤ 120 行）
src/components/command/
  useCommandSearch.ts       ← :80-124（buildCommands + filter + score + group + flat）
  useCommandKeyboard.ts     ← :207-234（onInputKeyDown）
  CommandInput / CommandList / CommandFooter ← 三段 JSX
```

配套两个「拆完就变简单」的点：
- `midpointDisplace` 抽出后加**确定性单测**（注入 `Math.random` 种子）：4 次迭代产出 17 个顶点、首尾点等于输入端点、位移不改变端点间大致方向。几何纯函数最值得测。
- `ScoredCommand` 加 `flatIndex`（在 `flat` 计算时一次性填好），`:336` 的 `findIndex` 变 `setActiveIndex(item.flatIndex)`。

---

## 2. 其他小问题（不单独立条，可顺手修）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | `Navbar.tsx:372` | 语言切换器 `hidden sm:flex` —— **<640px 时导航里没有任何语言入口**，只能先点命令面板图标再搜，而 `⌘K` 在手机上不存在。 | 在移动抽屉里加一行语言切换，或让小屏也显示胶囊（`sm` 段本来就空）。 |
| 2 | `Navbar.tsx:91` | `Telemetry` 硬编码英文标题，同一面板下方却是 `t.nav.frame` / `t.nav.worst`。 | 加 `t.hud.telemetry`（`hud.panelAria` 已有，可复用）。 |
| 3 | `BentoGrid.tsx:125-131` | 注释写「Add the scroll position so the result is comparable with `clientX + window.scrollX`」，**代码里并没有加 scroll**（`offsetParent` 链本身产出文档坐标，所以正确）。注释误导。 | 删掉或改成「offset 链已是文档坐标，勿再加 scroll」。 |
| 4 | `.gitignore:67-69` | 注释说截图「at ~60 MB they would dominate the repository」，实测本地 **178.6 MB**（171 PNG + 17 JSON）。 | 改成「~180 MB 且随脚本增长」，注明「由 `scripts/*.mjs` 生成，永不入库」。 |
| 5 | `.gitattributes:14` | `screenshots/** -text -diff` —— 截图已完全不入库，这条规则是死的（无害但误导）。 | 删除，或保留并注释「历史遗留，截图已在 .gitignore」。 |
| 6 | `Sections.tsx:245` | `<footer>` 嵌在 `<section id="contact">` 内部 → 映射为 `generic`，**全站没有 `contentinfo` landmark**。 | 提到 `main` 之外，或给 `<footer role="contentinfo">`。 |
| 7 | `Sections.tsx:246` | `t.footer.copyright` 写死 `© 2026`（`en.ts:294` / `zh.ts:276`），2027 年过期。 | `© {new Date().getFullYear()}`，或接受静态并加注释。 |
| 8 | `BentoShowcase.tsx:153` | 数字 `'8 000'` 用不换行空格还是普通空格不可见，英文应为 `8,000`。 | 走 `Intl.NumberFormat`（见 UI-16）。 |
| 9 | `zh.ts:55/61/67/73/79/85` | `sections.*.eyebrow` 在中文里仍是 `'entrance'/'gallery'/'architecture'…`。若这是设计意图（HUD 风格 eyebrow 保持英文）应注释说明；否则是漏翻。 | 在 `en.ts` 顶部注明「eyebrow 是技术标识符，不翻译」。 |
| 10 | `zh.ts:100` | `hero.scrollHint: 'scroll'` 与英文完全相同（可能刻意，也可能漏翻）。 | 同上，注明意图即可。 |
| 11 | `VfxSweepTransition.tsx:82-160` | 用 `<style>{SWEEP_STYLES}</style>` 运行时注入 2.6 KB CSS（只在扫光时挂载，用完即卸）。 | 移到 `index.css`（一次解析、可被构建压缩），组件只留 `data-vfx-sweep` 与变量。 |
| 12 | `SpotlightCard.tsx:373/392` | comet `rx="13"` vs `--radius-panel: 14px`。 | 改 `rx="14"`（见 UI-13）。 |
| 13 | `CardParticleCanvas.tsx:59-60` | `COLOR_WARM`/`COLOR_COOL` 与 `glowColor` prop 并存，前者优先 → 换肤后 ember 仍是 emerald。 | 统一走 palette（见 UI-13）。 |
| 14 | `commands.ts:156` | 简历 JSON 的 skills 里把 `'A11y'`、`'Responsive'` 当技能列，但本站实际有 UI-01/04/08/09/10 这些问题。 | 修完本报告后这句才站得住；或改成更具体的措辞（「Keyboard-first command palette」）。 |
| 15 | `scripts/page-helpers.mjs:8/26/87` | 选择器用**中文** `aria-label="回到顶部"`；默认语言是 en 时 `querySelector` 返回 null，`ringInfo()` 返回 `{found:false}` 而不失败。 | 改用稳定选择器（`data-testid` 或中英双匹配），并且「找不到」必须断言失败。 |
| 16 | `scripts/smoke.mjs:195-197` | `consoleErrors` 收集了却没断言，报告里躺着一个可能非空的数组。 | `assert('no console errors', report.consoleErrors.length === 0)`。 |
| 17 | `scripts/smoke.mjs:5` | 注释 `Run: node scripts/smoke.mjs http://127.0.0.1:5250` 与默认 CDP 端口 `9333`（`:13`）写死，没有 `process.env.CDP_HTTP` 回退（其他脚本都有）。 | 统一 `process.env.CDP_HTTP ?? …`，默认端口收进 harness。 |
| 18 | `scripts/*.mjs` 共 22 个 | 每个脚本一套专属 CDP 端口（9333–9359）+ 专属 URL 端口（5250–5279），共 40 个硬编码端口，**且没有 `chrome.exe` 路径**。这是「能并发跑」的隐式约定，但没有任何文档或启动脚本。 | 写一个 `scripts/run-verify.mjs`（允许并发生成或串行复用端口），并把「如何启动 Chrome」写进 `scripts/README.md`。 |
| 19 | `package.json:41-43` | `engines.node: ">=20.19.0"` 但 CI 用 22；本地无 `.nvmrc` / `.node-version`。 | 加 `.nvmrc`（`22`），`engines` 与 Vite 8 对齐（`>=22.12`）。 |
| 20 | `pnpm-workspace.yaml` | 文件名叫 workspace 但没有 `packages:` 字段。 | 加注释「本文件仅用于 pnpm 11 的项目级配置，非 workspace」。 |

---

## 3. 建议的落地顺序（按「改动小、见效大」排序）

| 顺序 | 动作 | 覆盖条目 | 预估 |
|---|---|---|---|
| 1 | 装 ESLint（含 `jsx-a11y`）+ Prettier + `pnpm lint`，跑一遍把现有告警修掉 | UI-03（并自动发现 UI-01/04/08/09/10/14/15 的一部分） | 0.5 天 |
| 2 | `ink-700 → #737f9a` + 字号 token 化（`--text-2xs`） | UI-04、UI-13 字号部分 | 1 小时 |
| 3 | 命令面板四改：焦点归还、Tab 陷阱、背景 inert、`role="group"` + `t.commands.groups` | UI-01、UI-06（与 UI-08 的 `inert` 改造可合并） | 0.5 天 |
| 4 | skip link + 移动抽屉 `inert` + `aria-expanded` | UI-08 | 1 小时 |
| 5 | `MotionConfig reducedMotion="user"` + 关掉倾斜 | UI-12 | 30 分钟 |
| 6 | `index.html` 改 `lang="en"` + 英文 title/desc + og 标签 | UI-07 | 30 分钟 |
| 7 | `--nav-height` 折入 `env(safe-area-inset-top)` + 三处 padding | UI-11 | 1 小时 |
| 8 | 触摸命中区（`min-h-11` / 伪元素扩张）+ TopologyMini 焦点环 | UI-09、UI-10 | 2 小时 |
| 9 | `Announcer`（`role="status"`）+ 三处 `announce()` | UI-05 | 1 小时 |
| 10 | 抽 `scripts/lib/cdp.mjs` + `assert()` + CI verify job | UI-02 | 1 天 |
| 11 | actions pin SHA + bundle 预算 step | UI-17 | 2 小时 |
| 12 | BentoGrid 拆 4 个文件 + `midpointDisplace` 单测 | UI-19 | 0.5 天 |
| 13 | 卡内硬编码色统一走 palette 变量 | UI-13 剩余 | 0.5 天 |
| 14 | dvh/svh 单位策略落注释 + sticky 改 `100svh` | UI-18 | 1 小时 |

---

## 附录：本报告用到的取证命令（均可复跑）

```powershell
# 截图体积与 git 追踪状态（确认「未入库」）
(Get-ChildItem screenshots -File | Measure-Object Length -Sum).Sum / 1MB      # 178.55
(git ls-files screenshots | Measure-Object).Count                             # 0
(Get-ChildItem .git -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB   # 1.951

# 死 token / 悬空选择器
Get-ChildItem src -Recurse -Include *.tsx,*.ts,*.css | Select-String 'animate-drift|pulse-soft'

# 无 aria-live / 无 inert / 无 safe-area
Get-ChildItem src -Recurse -Include *.tsx | Select-String 'aria-live|role="status"|inert'
Get-ChildItem src -Recurse -Include *.tsx,*.css | Select-String 'env\(safe-area'     # 0 命中

# 脚本断言与退出码
Get-ChildItem scripts -Filter *.mjs | Select-String 'process\.exit'                  # 仅 2 个文件
Get-ChildItem scripts -Filter *.mjs | Select-String "import\('/src/"                 # 11 处，7 个文件

# 对比度（WCAG 相对亮度，见 UI-04 公式；把 Get-Lum/Get-CR 两个函数贴进 pwsh 即可复跑）
```
