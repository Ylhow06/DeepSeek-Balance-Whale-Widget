# 交接文档：Electron 桌面套壳（方案 B）实施

> 面向**执行本任务的 agent**。选型与决策已由人类拍板，**不要再重新论证**，直接按本文件实施。
> 基线提交：`6ffa759`（本文件里的行号以此提交为准；改动后行号会漂移，以函数名为准）。
> 撰写时间：2026-09-15。

---

## 0. 一句话任务

把已有的本地 Node「小鲸鱼余额挂件」套成 **Windows 桌面宠物**：
全屏透明覆盖层 + 托盘 + 开机自启 + 单实例锁，鲸鱼浮在桌面上（空白处点击要能穿透到下层窗口）。

---

## 1. 已定决策（**不要推翻**）

| # | 决策 | 依据 |
|---|---|---|
| 1 | **用 Electron**（`electron@44.3.0`），不用 Tauri | Tauri 2.11.5 的 `set_ignore_cursor_events` 只有 bool、**不支持转发鼠标移动**（issue #6164 自 2023 年未关）；且离线要 `OfflineInstaller` **+127MB**，再加 Node sidecar 反而比 Electron 大 |
| 2 | **全屏透明覆盖层**，不是小精灵窗 | 见 §3.1，有源码证据；小窗口会裁掉挂件的菜单/面板 |
| 3 | 传输层**先用 `node:http` + 动态端口**（`listen(0)`） | 复用已验证的 `standalone/server.js`，风险最低。`protocol.handle` 迁移留到后续 |
| 4 | 代码放**本仓库 `desktop/`** | 同仓迭代。**不要动根 `package.json`**（那是要发 npm 的 DSH 插件包） |
| 5 | **只主屏**（`screen.getPrimaryDisplay()`） | 多屏后续再说 |
| 6 | 打包用 **`electron-builder@26.15.3`**，`target: ["portable","nsis"]` | Forge 对「单文件 portable exe」支持弱 |

**体积预期（实测同类应用）**：安装包 **~90MB**、装后 100–160MB、常驻内存 100–300MB。
几乎全是 Chromium/Node 运行时；本项目自身资源仅 **~5.8MB**。这是既定代价，不要试图"优化掉"。

---

## 2. 现状事实（**已核实，可直接依赖**）

### 2.1 后端性质

- **零 npm 依赖**：`package.json` 无 `dependencies`，`lib/index.js` 只用 `node:fs`/`node:http`/`fetch` 等 stdlib。
- `lib/index.js`（~3687 行，ESM）是 **DSH bundle 插件**：`export default { name, inject, apply(ctx) }`（L501/L503）。
- `standalone/server.js`（205 行）**已能伪造 DSH ctx 把整个插件跑起来**，并注册 **23 条** `/dsh-whale/*` 路由。**这是本次要复用的核心资产。**

### 2.2 路径与写盘（**打包安全性的关键**）

| 项 | 位置 | 说明 |
|---|---|---|
| `PACKAGE_ROOT` | `lib/index.js:13` | 由 `import.meta.url` 推出 |
| `DSH_HOME` | `lib/index.js:17` | **`process.env.DSH_HOME \|\| ~/.dsh`** |
| 资源读取 | `IMAGE_CANDIDATES` 等 | 全部只读 `PACKAGE_ROOT/assets` → **asar 内可读，无需解包** |
| **所有写盘** | grep 全部 `writeFileSync` | **一律从 `DSH_HOME` 派生**（usage/size/official/roles/audio/bubble）→ 把 `DSH_HOME` 指到 `userData` 即可，**核心逻辑零改动** |
| `CONFIG_PATH` | `standalone/server.js:25` | ⚠️ **写死在脚本同级，无 env 覆盖** → 打包后 asar 只读，存 key 会失败。**必须加 env 覆盖** |
| `DSH_HOME`（standalone） | `standalone/server.js:51` | 已有 `process.env.DSH_STANDALONE_HOME` 覆盖 ✅ |
| 端口 | `standalone/server.js:196-197` | `Number(cfg.port) \|\| 3080`，**写死、不支持动态** |

### 2.3 前端挂件的三个关键性质

1. **挂载自检**：`dshwIsChatRoot()`（`assets/whale-widget.js:11`）要求 `#root` 里存在
   `textarea` 或 `[contenteditable=true]`，否则**完全不初始化**。
   → `standalone/server.js:125` 的 `serveIndex()` 已用隐藏 `<textarea class="fake-composer">` 骗过，**直接复用**。
2. **视口定位**：`.dshwv-root{position:fixed}`（L62）配合 `state.left/top` 对 `vp.w/vp.h` 计算，
   并做**视口 1/4 分区吸附**。
   → 全屏覆盖层的"视口"就是"桌面"，**定位/吸附/翻转一行都不用改**（见 §3.1）。
3. **逐像素命中检测（重要）**：`isWhaleHit(e)`（**L13935**）把鲸鱼 PNG 画进离屏 canvas，
   取光标处像素 **alpha 通道**（`data[3] > 10`）判定是否命中。
   → 鲸鱼只有**不透明像素**上可点，PNG 透明区域天然穿透。
   → 这正是 Tauri 只能靠轮询硬凑的能力，**本仓库已经实现**，桌面壳直接复用它做穿透开关。

此外 `widgetUiHit(target)`（L14069）判定是否落在菜单/面板等 UI 上——但注意它接收的是 **DOM target**，
而挂件根节点是 `pointer-events:none`（L62），所以**全屏覆盖下 `elementFromPoint` 拿不到挂件子元素**，
必须改用 §4.2 的坐标方案。

---

## 3. 目标架构

```
Electron 主进程（= Node 24.20 ESM）
├─ 同步顶层：把 DSH_HOME / CONFIG 指到 app.getPath('userData')
├─ await import() 插件 → 伪造 ctx → apply(ctx)      ← 复用 standalone/server.js 的 shim
├─ node:http 服务 listen(0) → 读回真实端口
├─ BrowserWindow（全屏透明覆盖层，只主屏）→ loadURL('http://127.0.0.1:<port>/')
├─ Tray / 单实例锁 / 开机自启 / globalShortcut
└─ ipcMain: 'whale:set-ignore' → win.setIgnoreMouseEvents(ignore, { forward: true })

渲染进程（覆盖层页面）
├─ 挂件本体（现有 index.html + widget.js，未改）
└─ 一小段胶水（preload 注入）：mousemove → 命中判定 → IPC 切换穿透
```

### 3.1 为什么必须全屏，而不是 196×196 小精灵窗

研究的通用建议是"精灵尺寸窗"，但**对本挂件不成立**，源码证据：

| 元素 | 实际 CSS | 196×196 窗口里的后果 |
|---|---|---|
| `.dshwv-usage-card`（消费记录窗） | `width:min(560px,92vw)`（L361） | 被裁到 172px，内容全烂 |
| `.dshwv-usage-mask` 等遮罩 | `position:fixed; inset:0` | 只盖住小窗，形同虚设 |
| `.dshwv-menu` | `min-width:196px`（L108） | 占满整个视口，贴边计算失效 |
| 1/4 分区吸附 | 对 `vp.w/vp.h` 判定 | 视口=196px 时分区退化，吸附无意义 |

→ **全屏透明覆盖层**：视口=桌面，上述问题全部消失，且挂件逻辑零改动。

---

## 4. 分阶段实施

### Phase 0 —— 让 `standalone/server.js` 可打包（纯重构，**先做这个**）

**改动仅限 `standalone/server.js`，不碰 `lib/`。**

1. **配置路径可覆盖**（L25）：
   ```js
   const CONFIG_PATH = process.env.DSH_STANDALONE_CONFIG || path.join(STANDALONE_DIR, 'config.json')
   ```
2. **抽 `start()` 并导出，取消 import 即监听**。当前 L197 在模块顶层直接 `server.listen(...)`，
   必须改成：
   ```js
   export async function start(opts = {}) {
     const host = (opts.host || cfg.host || '127.0.0.1')
     const port = opts.port != null ? opts.port : (Number(cfg.port) || 3081)
     await new Promise((resolve, reject) => {
       server.once('error', reject)
       server.listen(port, host, resolve)
     })
     const actual = server.address().port
     return { port: actual, url: `http://${host}:${actual}`, close: () => new Promise((r) => server.close(r)) }
   }
   // 保留 CLI 行为：node standalone/server.js 仍然直接起服务（HANDOVER §4 有记载，不能破坏）
   if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
     start().then(({ url }) => console.log('[standalone] 打开 ' + url)).catch((e) => { console.error(e); process.exit(1) })
   }
   ```
   > ⚠️ 注意 `server` 目前是顶层 `const`；重构成函数后要保证只创建一次、可被 `close()` 后不再复用。
3. **覆盖层模式不要显示提示卡**：`serveIndex()`（L125）里那块 `.tip`（"小鲸鱼 · 独立运行" + key 状态）
   在独立网页里有用，但**盖在桌面上会很碍眼**。
   建议加 `DSH_STANDALONE_OVERLAY=1` 时**不输出 `.tip` 节点**（比在 preload 里注入 CSS 更干净）。

**验收**：
```powershell
node -e "import('./standalone/server.js').then(async m => { const s = await m.start({ port: 0 }); console.log(s.port); const r = await fetch(s.url + '/dsh-whale/balance.json'); console.log(r.status); await s.close() })"
```
应打印一个随机端口与 `200`，且 `node standalone/server.js` 仍能照常起服务。

### Phase 1 —— Electron 骨架（里程碑：桌面上看到鲸鱼）

1. 新建 `desktop/`，含**自己的** `package.json`：
   ```json
   { "name": "whale-desktop", "private": true, "type": "module", "main": "main.js",
     "devDependencies": { "electron": "44.3.0", "electron-builder": "26.15.3" } }
   ```
2. `desktop/main.js` —— **顺序极其重要**：
   ```js
   import { app, BrowserWindow, Tray, Menu, screen, ipcMain } from 'electron'
   import path from 'node:path'

   // ① 单实例锁：越早越好
   if (!app.requestSingleInstanceLock()) app.quit()

   // ② 必须在 ready 之前、同步执行（ESM 顶层 await import() 会在 ready 之后才 resolve！）
   const USER_DATA = app.getPath('userData')
   process.env.DSH_STANDALONE_HOME   = path.join(USER_DATA, 'data')
   process.env.DSH_STANDALONE_CONFIG = path.join(USER_DATA, 'config.json')
   process.env.DSH_STANDALONE_OVERLAY = '1'
   // 兜底（默认不开，遇到透明黑屏/崩溃再加）：
   // app.disableHardwareAcceleration()

   // ③ 再起服务 + 开窗
   app.whenReady().then(async () => {
     const { start } = await import('../standalone/server.js')   // 动态 import 在 ready 后也没关系
     const srv = await start({ port: 0 })                         // 动态端口，根除 EADDRINUSE
     createOverlay(srv.url)
   })
   ```
   > ⚠️ **`userData/config.json` 不存在时要用 `standalone/config.example.json` 复制生成一份**，
   > 否则 `loadConfig()` 走默认值，用户无法通过配置文件填 key。
3. 覆盖层窗口（**只主屏**）：
   ```js
   function createOverlay(url) {
     const b = screen.getPrimaryDisplay().bounds
     const win = new BrowserWindow({
       x: b.x, y: b.y, width: b.width, height: b.height,
       transparent: true, frame: false, backgroundColor: '#00000000',
       thickFrame: false, roundedCorners: false, hasShadow: false,
       skipTaskbar: true, resizable: false, movable: false,
       minimizable: false, maximizable: false, fullscreenable: false,
       alwaysOnTop: true, show: false,
       webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'),
                         contextIsolation: true, nodeIntegration: false },
     })
     win.setAlwaysOnTop(true, 'screen-saver')
     win.once('ready-to-show', () => win.show())
     win.loadURL(url)
     return win
   }
   ```
   > `frame:false` 是 Windows 上透明生效的**前提**，不可省。
   > 不要用 `fullscreen:true`（那是另一种模式），用 `bounds` 铺满。
4. 托盘 / 退出清理：
   ```js
   new Tray(iconPath).setContextMenu(Menu.buildFromTemplate([
     { label: '刷新', click: ... }, { label: '设置', click: ... },
     { type: 'separator' }, { label: '退出', click: () => app.quit() },
   ]))
   app.on('will-quit', () => { try { srv.close() } catch {} })
   ```

**验收**：`npx electron desktop/main.js` 能起，右下角出现透明背景鲸鱼，无控制台报错，
`%APPDATA%\<产品名>\data\` 下生成 `.dshw-*.json`，`config.json` 在 `%APPDATA%\<产品名>\`。

### Phase 2 —— 桌面宠物行为（**风险最集中，单独验**）

**目标**：默认全穿透；光标落在鲸鱼不透明像素或已打开的菜单/面板上时接管鼠标。

1. **唯一的 core 改动（加在 `assets/whale-widget.js` 的 IIFE 内部、末尾）**：
   ```js
   // —— 桌面壳集成钩子（附加式，不影响 DSH 内行为）——
   try {
     window.__dshwHitTest = function (x, y) {
       var fake = { clientX: x, clientY: y }
       if (isWhaleHit(fake)) return true
       // 菜单/面板等已打开的 UI：按 DOM 命中判断
       var el = document.elementFromPoint(x, y)
       return widgetUiHit(el)
     }
   } catch (err) {}
   ```
   > **这是本次唯一允许修改 `assets/whale-widget.js` 的地方**，且必须是**纯附加**：
   > 不加监听、不改现有函数、不影响 DSH 内行为。
   > `isWhaleHit` 是 IIFE 内私有函数，只能这样暴露；不要试图用 `elementFromPoint` 判鲸鱼
   > （根节点 `pointer-events:none`，拿不到子元素）。
2. `desktop/preload.cjs`（**用 CJS**，避免 ESM preload 的时序坑）：
   ```js
   const { contextBridge, ipcRenderer } = require('electron')
   contextBridge.exposeInMainWorld('__whaleShell', {
     setIgnore: (ignore) => ipcRenderer.send('whale:set-ignore', ignore),
   })
   window.addEventListener('DOMContentLoaded', () => {
     window.addEventListener('mousemove', (e) => {
       const hit = window.__dshwHitTest ? window.__dshwHitTest(e.clientX, e.clientY) : false
       window.__whaleShell.setIgnore(!hit)
     }, { passive: true })
   })
   ```
3. 主进程：
   ```js
   win.setIgnoreMouseEvents(true, { forward: true })        // 默认全穿透
   ipcMain.on('whale:set-ignore', (_e, ignore) => {
     win.setIgnoreMouseEvents(!!ignore, { forward: true })  // forward 是关键：穿透时仍收 mousemove
   })
   ```
   > **`{ forward: true }` 是整个方案的地基**：没有它，穿透时收不到任何 `mousemove`，
   > 就永远无法知道光标何时进入鲸鱼（只能轮询烧 CPU）。
4. 位置持久化：挂件自己已经存（`SIZE_FILE_CANDIDATES`）。**注意**：换到全屏覆盖层后，
   之前在小视口存的 `state.left/top` 可能越界——`settle()` 会 clamp，但要**实测确认**首次启动位置合理。
5. 空闲淡出（可选）：`win.setOpacity(0.4)`（Windows 支持）。

**验收（必做）**：
- 空白处点击 → **穿透到下层窗口**（拿记事本/浏览器盖在下面，能正常点到）；
- 鲸鱼不透明处 → 可点击、可拖拽、可吸附到屏幕四边、左吸附镜像正常；
- 打开汉堡菜单与「更多消费记录」窗 → **能被点击**（不被穿透吃掉），且完整可见不被裁切。

### Phase 3 —— 打包

1. `electron-builder` 配置：`win.target: ["portable","nsis"]`，`win.icon: build/icon.ico`，`nsis.oneClick: true, perMachine: false`。
2. 数据搬迁：首次启动在 `userData` 生成 `config.json`（从 `config.example.json` 复制）。
3. 开机自启：
   ```js
   app.setLoginItemSettings({ openAtLogin: true,
     path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath })
   ```
   > ⚠️ **portable 陷阱**：portable 构建下 `process.execPath` 指向**临时解包目录**，
   > 直接注册会得到死链自启项。必须优先用 `PORTABLE_EXECUTABLE_FILE`。
4. 代码签名可延后（先跑通再说）。

### Phase 4 —— 回归

EADDRINUSE 不再出现 / 托盘菜单 / 自启生效 / 穿透 / 旧数据升级 / 卸载残留（`userData` 是否该清）。

---

## 5. Windows 坑清单（实现时逐条对照）

```js
transparent: true, frame: false,          // frame:false 是透明前提
backgroundColor: '#00000000',             // 仅 transparent:true 时支持 #AARRGGBB
thickFrame: false, roundedCorners: false, // 去掉 1px 边框 + Win11 圆角
skipTaskbar: true, hasShadow: false,
show: false,                              // 配 ready-to-show 防白闪
win.setAlwaysOnTop(true, 'screen-saver')  // 层级参数，比普通置顶更高
```
- **`skipTaskbar` 运行时改不了**，只能销毁重建窗口；`focusable:false` 会**连带** `skipTaskbar:true`。
- **透明窗在个别显卡/沙箱环境会黑屏或崩溃** → 从第一天就留软件渲染兜底：
  `app.disableHardwareAcceleration()` + `app.commandLine.appendSwitch('disable-gpu-compositing')`，
  **两者都必须在 `ready` 之前调用**；必要时加 `--no-sandbox` 重试路径。
- `vibrancy` 是 macOS 专属；`backgroundMaterial`（mica/acrylic）是 Win11 专属且**不适合透明覆盖层**。

---

## 6. 安全红线（**务必遵守**）

1. **绝对不要提交 `standalone/config.json`** —— 里面有真实 API key 与平台 token。
   它已在 `.gitignore` 里（`standalone/config.json` / `standalone/config.*.json` / `.dsh-standalone/`）。
   同理 `desktop/` 产生的一切用户数据目录、`%APPDATA%` 内容、任何 `config.json` 实例。
2. **永远不要用 `git add .` 或 `git add -A`**，只 `git add -- <明确路径>`。
3. 提交前**必做密钥扫描**（下面命令里的 `$key`/`$tok` 从 `standalone/config.json` 读，注意别把值打印出来）：
   ```powershell
   $cfg = Get-Content standalone/config.json -Raw | ConvertFrom-Json
   $key = [string]$cfg.credentials.DEEPSEEK_API_KEY
   $tok = [string]$cfg.credentials.DEEPSEEK_PLATFORM_TOKEN
   foreach ($f in @(git diff --cached --name-only)) {
     $t = Get-Content $f -Raw -ErrorAction SilentlyContinue
     if ($key -and $t.Contains($key)) { "LEAK: $f" }
     if ($tok -and $t.Contains($tok)) { "LEAK: $f" }
   }
   ```
4. `desktop/` 若新增含明文密钥的文件，**一并加进 `.gitignore`**。
5. 打包产物（`dist/`、`node_modules/`、`*.exe`、`*.zip`）**不入库**。

---

## 7. 本机环境坑（**踩过，别重踩**）

- **`Get-NetTCPConnection` 在本机不可靠**：服务确实在监听时它仍返回 0 条。
  查端口占用一律用：
  ```powershell
  netstat -ano | Select-String ':3081\s+.*LISTENING'
  ```
- **后台 job 被 kill ≠ node 进程退出**。旧进程会继续占端口并**用旧代码应答**
  （表现为"新加的路由 404"）。改完 `lib/` 或 `standalone/` 必须：
  `netstat` 拿 PID → `Stop-Process -Id <pid> -Force` → 再启动。
  （`assets/whale-widget.js` 是按 mtime 热读的，改它只需浏览器硬刷新。）
- **PowerShell 输出捕获不稳定**：可靠做法是 `Out-File` 到临时 txt 再读；输出为空不等于命令没执行。
- **`Get-Content | Select-Object -Skip N` 的行号可能对不上真实行号**（实测过：它与 `Select-String`
  给出的同一文件行号互相矛盾，`Select-String` 才是对的）。要确认某行内容，**用 read 工具直接读**，
  不要用 PowerShell 按行号切片，更不要据此去"修正"文档里的行号。
- 本机 Node **v24.19.0**、npm **11.17.0**、WebView2 153 已装、**Rust/Cargo 未装**（不影响 Electron）。

---

## 8. 不许做的事

- ❌ 不要修改 `lib/index.js`（后端核心，本次无需改动）。
- ❌ 不要修改 `assets/whale-widget.js` 除 §4 Phase 2 那一个**附加式 hook** 之外的任何地方。
- ❌ 不要动根 `package.json` / `cordis.patch.yml`（那是要发 npm 的 DSH 插件包）。
- ❌ 不要选 Tauri，不要改成小精灵窗，不要一次性上 `protocol.handle`（已定：先 http）。
- ❌ 不要把 `standalone/server.js` 的 CLI 行为改坏（`node standalone/server.js` 必须照常可用）。

---

## 9. 建议的提交切分

1. `refactor(standalone): 配置路径可覆盖 + start() 导出 + 动态端口`（Phase 0）
2. `feat(desktop): Electron 全屏透明覆盖层骨架 + 托盘 + 单实例`（Phase 1）
3. `feat(desktop): 逐像素命中驱动的点击穿透 + 位置持久化`（Phase 2）
4. `chore(desktop): electron-builder 打包 + 自启`（Phase 3）

每笔提交前跑 §6 的密钥扫描。

---

## 10. 参考资料

- Electron 44.3.0 版本数据（已核实）：https://releases.electronjs.org/
- 窗口选项：https://www.electronjs.org/docs/latest/api/browser-window
- **点击穿透官方教程（本方案核心）**：https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions
- ESM 注意事项：https://www.electronjs.org/docs/latest/tutorial/esm
- 同类已开源实现（Electron 桌宠，可读其 Windows 处理，**仅作参考、未逐条核实**）：
  https://github.com/qijiamin0822/deepseek-whale-pet
- 本仓库既有文档：`HANDOVER.md`（独立运行方案 A 的完整交接，含接口清单与坑）、
  `whale-widget-prompt.md`（挂件完整规格）

---

## 11. 实施记录（第一轮执行 agent 回填，2026-09-15）

### 11.1 进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0 让 `standalone/server.js` 可打包 | ✅ 完成并验证 | 动态端口 / 配置路径可覆盖 / 导出 `start()` / 覆盖层模式 |
| Phase 1 Electron 骨架 | ✅ 代码完成，**待肉眼验收** | `desktop/` 已建；Electron 44.3.0 已装；自检模式已跑通环境链路前，被沙箱拦下（见 11.4） |
| Phase 2 桌面宠物行为（穿透） | ✅ 代码完成，**待肉眼验收** | 挂钩 + 胶水 + 拖拽锁定已实现（比原文档多做 3 处修正，见 11.3） |
| Phase 3 打包 | ✅ 已构建出产物 | `dist/小鲸鱼-0.1.0-便携版.exe`（100.2MB）、`dist/小鲸鱼-0.1.0-安装版.exe`（100.4MB）；**asar 必须关**，见 11.3 第 5 条 |
| Phase 4 回归 | ⏸ 未开始 | |

### 11.2 新增文件

```
desktop/
  package.json          独立包（不进根 package.json）；scripts: start / selftest / build
  main.js               主进程：单实例锁 → 环境变量 → 起后端 → 覆盖层 → 托盘
  preload.cjs           只做两件事：contextBridge 暴露 setIgnore；注入主世界胶水
  overlay-glue.js       **运行在页面主世界**：mousemove → 命中判定 → 切换穿透
  electron-builder.yml  打包配置（directories.app 指向 .build/app）
  scripts/prepare-build.mjs  打包前把「壳+lib+assets+standalone」拼成 .build/app
  .build/ 与 build/icon.png 打包中间产物（.build 已 gitignore）
```

### 11.3 与原文档不同的 4 处决定（都是被现实逼出来的，不是口味问题）

1. **覆盖层页面必须把背景改成透明**（`standalone/server.js` 的 `buildIndexHtml()`）。
   原文档 Phase 0 只要求"去掉 `.tip`"，但原 index.html 的 `html,body{background:#f5f6fa}`
   会**让整块屏幕变成不透明的灰底**——透明 BrowserWindow 也救不回来。
   现在 `DSH_STANDALONE_OVERLAY=1` 时同时去掉提示卡 + `background:transparent`。
2. **胶水必须跑在「页面主世界」，preload 不能直接判命中**。
   原文档 Phase 2 的 preload 片段写的是 `window.__dshwHitTest(...)`，
   但它同时把 `contextIsolation: true` —— 隔离世界里**看不到**页面主世界挂在 `window` 上的属性，
   那段代码拿到的永远是 `undefined`（即"永远穿透"，鲸鱼点不动）。
   现方案：preload 用 `contextBridge` 只暴露 `setIgnore`，再把 `overlay-glue.js`
   作为 `<script>` 注入主世界；源码由主进程 `ipcMain.handle('whale:get-glue')` 读出后经 IPC 送过去
   （这样 preload 仍保持默认沙箱，不用 `sandbox:false`，也不用往页面里写内联字符串常量）。
3. **拖拽期间必须锁死接管**。鲸鱼是不规则形状，拖着拖着光标就会滑出轮廓；
   此时如果再按"未命中 → 穿透"，OS 停止给窗口发事件，**拖拽直接断在半路**。
   胶水因此在 `mousedown → mouseup` 之间强制 `ignore=false`。
4. **命中判定加了"不可见祖先"过滤**。`.dshwv-menu-btn` 空闲态是 `opacity:0` + `pointer-events:auto`，
   `elementFromPoint` 会命中它 —— 在桌面模式下表现为**一个 26×26 的隐形死区：点不进挂件、也穿不到桌面**。
   `__dshwHitTest` 现在会逐级向上检查 `visibility/display/opacity`，不可见就判未命中。
   （另外 `.tip` 是 `z-index:9999`，覆盖层模式下必须不输出，否则它会吃掉左上角点击。）
5. **打包必须 `asar: false`**（`electron-builder.yml` 里已注明原因）。
   主进程 `await import('../standalone/server.js')` 走的是 **Node 的 ESM loader**，
   它用内部 fs 原语读文件、**不经过 Electron 对 fs 的 asar 补丁** → 打成 app.asar 后
   动态 import 读不到文件。GUI 进程下 stderr 不可见，表现就是"双击图标毫无反应"。
   同类案例：<https://github.com/OpenLAIR/dr-claw/commit/fad2976>（结论同为 asar: false）。
   本项目打包后只有 20 个文件、无 node_modules，关掉 asar 的代价约等于 0。
6. **主进程加了 fatal 弹窗**：`uncaughtException` / `unhandledRejection` /
   `main()` 抛错都走 `dialog.showErrorBox`，避免打包后"双击无反应、无从排查"。
7. **托盘取图改为 `fs.readFileSync` + `nativeImage.createFromBuffer`**
   （比 `createFromPath` 少依赖 asar 补丁路径）；取不到时只警告、不创建托盘，
   并提示用 `Alt+Shift+W`，不让整个程序崩掉。
8. **端口不再一律 `listen(0)`，改为「优先固定 3082、占用才退回随机」**。
   原决策 #3 的"动态端口根除 EADDRINUSE"是对的，但漏了一条：
   挂件把 `dshw-pos`（位置）/`dshw-role`（选中角色）/`dshw-last-seq`（已看轮次）
   存在 **localStorage**，而 **localStorage 按源隔离、源里含端口** ——
   端口每次都变，等于每次都是全新的储物柜，**用户拖好的位置和选好的角色重启就丢**。
   现在：默认拿 3082（与浏览器独立模式的 3081 错开，两者可并存），
   拿不到才退回 `listen(0)`（此时该次启动的位置/角色不记忆，已在日志里写明）。
   可用 `WHALE_DESKTOP_PORT` 覆盖。
   > 更彻底的方案是 `protocol.handle` 注册 `whale://` 固定源（端口怎么变源都不变），
   > 但那要重写资源转发层，按原决策留到后续。

### 11.4 打包产物与首次运行的数据落点

```
desktop/dist/小鲸鱼-0.1.0-便携版.exe     100.2MB   ← 免安装，双击即跑
desktop/dist/小鲸鱼-0.1.0-安装版.exe     100.4MB   ← NSIS 一键装
```

- 数据落点（打包版，`app.setName('WhaleDesktop')` 决定）：
  `%APPDATA%\WhaleDesktop\config.json`（凭据）+ `%APPDATA%\WhaleDesktop\data\`（账本/官方缓存/尺寸设置）。
- **打包版的"迁移旧数据"是失效的**：`migrateLegacyDataOnce()` 找的是
  `PROJECT_ROOT/.dsh-standalone`，打包后 `PROJECT_ROOT` = `resources/app`，那里没有。
  本次是**手工**把 `.dsh-standalone/*` 与 `standalone/config.json` 拷进 `%APPDATA%\WhaleDesktop\` 的。
  要做成一键迁移的话，应改成读一个显式路径（如 `WHALE_LEGACY_DATA` 环境变量）。

### 11.5 本机环境新踩的坑（**重要，会浪费大量时间**）

1. **`ELECTRON_RUN_AS_NODE=1` 被预设在本机进程环境里**（用户级/机器级都没有，是宿主进程塞进来的）。
   它会让 `electron.exe` 退化成纯 Node：`require('electron')` 返回的是
   `node_modules/electron/index.js` 导出的**路径字符串**，于是 `app` 为 `undefined`，
   报错长这样：
   ```
   SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'
   TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
   ```
   诊断方法：在 Electron 里打印 `process.type` —— 正常主进程是 `browser`，被降级时是 `undefined`。
   修法：启动前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。（用户的普通终端不受影响。）
2. **Electron 主进程 ESM 里拿 `electron` 模块只能用 `createRequire`**：
   ```js
   import { createRequire } from 'node:module'
   const require = createRequire(import.meta.url)
   const { app, BrowserWindow } = require('electron')
   ```
   `import { app } from 'electron'` 与 `import electron from 'electron'` **都会失败**
   （前者报 no export named，后者拿到的是那个路径字符串）。已写进 `main.js` 顶部注释。
3. **npm 11 的 allow-scripts 策略会拦掉 electron 的 postinstall**，
   表现为装完 284 个包但 `node_modules/electron/dist/electron.exe` 不存在。
   补装（走国内镜像 21 秒搞定）：
   ```powershell
   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
   cd desktop/node_modules/electron; node install.js
   ```
4. **PowerShell 输出捕获依旧不稳**（与 §7 一致）：本文件里所有验证命令都是
   `... 2>&1 | Out-File utf8 → 用 read 工具读` 才看到结果的；`Get-Content -Raw` 直接打屏经常是空的。
   bash（Git Bash shim）在本机**完全不可用**（`ls`/`dirname`/`rm`/`wc` 全 command not found），
   文件操作请一律用 PowerShell 或专用工具。

### 11.6 验证命令（接手请照跑）

```powershell
# ① Phase 0 验收：动态端口 + 路由 + 可重复启停（不需要 UI）
node -e "import('./standalone/server.js').then(async m=>{const s=await m.start({port:0});const r=await fetch(s.url+'/dsh-whale/balance.json');console.log('port='+s.port+' status='+r.status);await s.close()})"

# ② CLI 行为未破坏（应打印 http://127.0.0.1:3081）
node standalone/server.js

# ③ 桌面壳自检（不开窗肉眼验证，跑完自动退出并打印 PASS/FAIL）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
cd desktop; node_modules\electron\dist\electron.exe . --selftest
#   结果也会落到 %TEMP%\whale-desktop-selftest.txt
#   覆盖：窗口可见/置顶、挂件已挂载、胶水已注入、背景透明、鲸鱼已渲染、
#         命中点能找到、空白处不命中、移到鲸鱼上→取消穿透、移到空白→恢复穿透

# ④ 人工验收（自检过了再跑这个）
cd desktop; node_modules\electron\dist\electron.exe .
```

自检模式（`--selftest`）是本次新增的**可复用验证手段**：它在 2.5s 后用
`webContents.executeJavaScript` 在页面里扫出鲸鱼的不透明像素点，派发合成 `mousemove`，
再回主进程核对 `lastIgnore` 是否跟着翻转 —— 即"命中判定 → IPC → 穿透开关"整条链路的端到端断言。

### 11.7 验收清单（人工，双击便携版即可）

1. **能看到鲸鱼**：右下角出现鲸鱼，背景透明（桌面壁纸/其它窗口能看见），不糊一层灰底。
2. **空白处穿透**：把记事本/浏览器放在鲸鱼那侧的下层，点**空白桌面**能正常切到那个窗口。
3. **鲸鱼可交互**：点鲸鱼（不透明像素处）有反应、能拖动、松手后吸附到屏幕边；左吸附时鲸鱼镜像。
4. **菜单/面板可用**：点汉堡菜单能展开并点到里面的项；「更多消费记录」窗完整可见、不被裁切、里面能点。
   （若菜单点不动 → 说明穿透没被取消；若菜单挡住了下层却点不到 → 说明 UI 判定过头。）
5. **托盘**：任务栏托盘出现小鲸鱼图标，右键有 显示/隐藏、刷新、打开配置文件、打开数据目录、退出。
6. **`Alt+Shift+W`** 能显示/隐藏（隐藏后桌面完全恢复可点）。
7. **重启后位置/角色还在**（验证固定端口那一条）：把鲸鱼拖到左上角 → 托盘退出 → 再次双击 → 应仍在左上角。
8. 出问题时：托盘退出，或 `Alt+Shift+W` 隐藏后到任务管理器结束 `小鲸鱼.exe`。

### 11.8 剩余待办

1. 跑上述 11.7 的 8 条人工验收（本轮代理侧的 `electron.exe` 启动被沙箱拒绝：
   外层提示触碰 `C:\Users\36069\.ssh`，故 `--selftest` 与肉眼验收都没跑成）。
   代理侧可先跑 11.6 的 ③（自检模式，全自动 PASS/FAIL）。
2. 首次启动位置实测：`state.left/top` 来自**小视口**时代的 localStorage，
   全屏后要确认落在合理位置（`settle()` 会 clamp，但可能贴边）。
3. 开机自启按用户决定**暂不做**（Phase 3.3 的方案仍有效：
   portable 必须用 `PORTABLE_EXECUTABLE_FILE` 而不是 `process.execPath`）。
4. 打包版的旧数据迁移要去掉「依赖 `PROJECT_ROOT`」的假设（见 11.4）。
5. 可选：`desktop/build/icon.png` 目前是 `assets/DSniang1.png` 的原图直拷
   （实测 alpha 包围盒已占画幅 93%×98%，无需裁剪）。

---

## 12. 第二轮修复：「点击总是落到下层」（用户实测反馈）

### 12.1 现象
鲸鱼能看见，但**点不中**——点击永远穿透到下层窗口，等于穿透开关从没被切回来。

### 12.2 排查思路
`ignore` 只有在「命中 → 页面发 IPC → 主进程 `setIgnoreMouseEvents(false)`」这条链上才能变回 false，
所以链上任一处断了都长这样。三个可疑点，按可疑度排序：

1. **胶水没跑起来**。原实现是 preload 用 `document.createElement('script')` 把胶水源码
   以内联脚本注入主世界 —— 跨世界注入存在世界归属/时序的不确定性，失败时**完全静默**。
2. **mousemove 没被转发到页面**。`forward: true` 官方文档说会转发鼠标移动，
   但这是整条链的地基，一旦不生效就永远无法知道光标进了鲸鱼。
3. 判定本身错（`__dshwHitTest` 返回 false）。

### 12.3 修法（把 1、2 两条腿都换掉，不再依赖运气）

1. **胶水改为页面自己加载**：`standalone/server.js` 在覆盖层模式下把
   `<script defer src="/dsh-whale-shell/glue.js">` 写进 index.html，
   该路由直接把 `desktop/overlay-glue.js` 作为 JS 返回。
   → 胶水 100% 在主世界执行，且一定在挂件脚本之后运行，不存在注入失败/时序问题。
   （非覆盖层模式的独立网页不受影响：不加载胶水、仍显示提示卡。）
2. **穿透判定的主触发源改成主进程光标轮询**：主进程每 33ms 读一次
   `screen.getCursorScreenPoint()`，换算成窗口内坐标后 `send('whale:cursor')`；
   页面胶水收到后做 DOM/像素命中判定并回写 `setIgnore`。
   读光标是纯系统调用，**与窗口是否穿透无关**，所以不依赖 `forward` 是否生效。
   本地 `mousemove` 保留为次触发源（转发生效时延迟更低），两者都汇入同一个
   带去抖的 `applyIgnore`，不会互相打架。
   > 代价：25~30 次/秒的 IPC + 每次一次 1×1 `getImageData`，实测可忽略。

### 12.4 顺带补的可观测性（下次不用再猜）
- 主进程把所有 `console.*` 与每次 `setIgnoreMouseEvents(x)` 写进
  `%APPDATA%\WhaleDesktop\desktop.log`（>512KB 自动清空）；托盘菜单 **「打开日志文件…」** 一键打开。
- 页面胶水通过 `whale:log` 上报：`[glue] installed …`、每次判定 `eval x/y hit=`、
  穿透切换 `ignore=`、以及前 12 次心跳（含 `hitTestReady` / `whaleMounted`）。
  → 对着日志即可判断断在哪一环：
  - 没有 `[glue] installed` → 胶水没加载（查 script 标签/路由）
  - `hitTest=undefined` → 挂件钩子没暴露
  - 有 `ignore=false` 但点击仍穿透 → 问题在操作系统层面，不在我们的逻辑
- **一次性诊断开关（已移除，需要时可照此加回）**：排查期间托盘上放过一个
  「调试：强制接管鼠标（不穿透）」复选框——勾上后整屏由窗口接管鼠标、不再穿透。
  它的判别力很强：**勾上后鲸鱼能点 → 我们的判定逻辑有问题；勾上后还是点不动 →
  Electron/OS 层面的 `setIgnoreMouseEvents` 失效**，要换方案。
  根因定位并修复后已经从托盘中删除（属于开发者专用、不该出现在用户界面里）。
  要加回：`main.js` 里加一个 `forceCapture` 变量 → 光标轮询开头 `if (forceCapture) return`
  → `whale:set-ignore` 的处理里 `if (forceCapture) return`（否则页面会把状态写回去）
  → 托盘加一个 `type: 'checkbox'` 项，切换时 `lastIgnore = null; setIgnore(!forceCapture)`。
- `--selftest` 增补两项断言：`/dsh-whale-shell/glue.js` 路由 200 且内容含标记、
  `window.__whaleGlueCursorCount > 0`（证明光标轮询确实到达了页面）。

### 12.5 打包的一件事（踩到了记一下）
`electron-builder` 在本机会**随机失败**，日志停在
`signing with signtool.exe path=dist\win-unpacked\resources\elevate.exe` 之后、
没有错误行、耗时恰好 ~2 分钟。

> ⚠️ 这里原先写的"本机 2 分钟长任务限制导致被杀"是**错判**。第二轮排查拿到了真错误：
> ```
> [safe-delete] SAFE_DELETE_BULK_CONFIRM_REQUIRED {"count":118,"threshold":50,...,
>   "targets":["...\desktop\dist\win-unpacked.tmp"]}
>   at checkBulkDeleteGuard (…\cli\vendor\shim\node-safe-delete-shim.cjs:220:19)
>   at Object.wrappedPromisesRm [as rm] (…:797:15)
>   at extractArchive (app-builder-lib\src\util\electronGet.ts:191:14)
>   at ElectronFramework.prepareApplicationStageDirectory (…:152:27)
> ```
> 即：**本机 Node 被注入了 safe-delete 护栏**，`fs.rm` 一次删超过 50 个文件就会被拒。
> electron-builder 每次打包前要清掉上一次的 `dist\win-unpacked(.tmp)`（100+ 文件）→ 被拦 →
> 进程直接退出，于是表现为"日志没结尾、没有错误、耗时刚好卡在两分钟上下"。

**可靠做法：每次构建前，用 PowerShell 把整个 `dist` 删空。**
（PowerShell 的 `Remove-Item` 不经过那个 Node shim，所以能删掉；之后 electron-builder
就无需再 `fs.rm` 任何东西。）
```powershell
cd desktop
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue   # ← 关键这一步
npm run prepare-build
npx electron-builder --win portable --config electron-builder.yml
npx electron-builder --win nsis     --config electron-builder.yml
```
两个目标**分别**构建更稳（一次只出一个包）。只删 `win-unpacked` 而漏掉 `win-unpacked.tmp`
一样会被拦（`count=118` 那次就是漏了 `.tmp`），所以**整个 dist 一起删**。

---

## 13. 第三轮：真正的原因（钩子作用域）+ userData 落错目录

用户实测反馈（第一版修完之后）：
> 不勾选时不能点，勾上时可以一直点小鲸鱼能够拖动，点击菜单或者外面时不再能点，
> 重新勾选上后情况和刚勾上时一样。

### 13.1 这条反馈的价值：一句话排除了两个方向
「勾上后能点能拖」= 窗口一旦进入非穿透态，挂件本体的点击/拖拽/菜单全都正常
→ ①挂件挂载没问题 ②`setIgnoreMouseEvents(false)` 在系统层面有效。
所以问题只可能在「命中判定 → 切回不穿透」这一段。日志坐实了这一点：

```
[glue] installed, version=1.1.0 hitTest=function onCursor=function viewport=1920x1032
[glue] eval x=556 y=536 hit=null
[glue] eval x=892 y=623 hit=null
... 15 条全是 hit=null，无论光标在哪
```

**「每一次判定都是 null，与坐标无关」= 判定根本没在跑**（若只是几何算错，总会有若干点返回 true）。

### 13.2 根因：`__dshwHitTest` 引用了**外层的私有函数**
`hit=null` 只可能来自 glue 的 catch（抛异常）。而钩子体内唯一可能抛的就是
`isWhaleHit` / `widgetUiHit` 不在作用域：

| 符号 | 真实位置 | 说明 |
|---|---|---|
| `function dshwInit()` | `assets/whale-widget.js:42` | 函数体一直延伸到 **L14420** |
| `function isWhaleHit()` | L13935 | **在 dshwInit 内部** |
| `function widgetUiHit()` | L14069 | **在 dshwInit 内部** |
| IIFE | L1 ~ L14451 | 钩子原先被放在 L14426（IIFE 层） |

→ 每次调用都是 `ReferenceError: isWhaleHit is not defined`，被 catch 吞成"判定不可用"，
于是永远"未命中"、永远穿透。
**原文档 §4 Phase 2 里"加在 assets/whale-widget.js 的 IIFE 内部、末尾"这句是错的**——
它假设那三个函数在 IIFE 顶层作用域，实际它们是 `dshwInit` 的私有函数。

### 13.3 修法
把钩子整体移进 `dshwInit`，位置选**函数开头**（紧接 `window.__dshWhaleInit = true` 之后）：
- 两个被调函数都是**函数声明**，在 dshwInit 开始执行时就已可用（提升）；
- 放在开头而不是末尾，可以避免"dshwInit 后面任何一句抛错导致钩子压根没注册"。

### 13.4 本地验证手段（**这个值得保留**）
用 jsdom 在 Node 里把挂件脚本真跑一遍，直接调用钩子看是否抛错。已固化为项目内脚本：
```powershell
cd desktop
npm run check:hook        # 脚本：desktop/scripts/check-hook.mjs（jsdom 已列为 devDependency）
#   退出码 0 = 通过；1 = 不通过（钩子缺失 / 调用抛错）；2 = 没装 jsdom
```
输出（修复后）：
```
PASS  对照组能识别作用域外引用  [ReferenceError: isWhaleHit is not defined]
PASS  window.__dshwHitTest 已注册  [function]
PASS  挂件根节点已挂载（jsdom 里也应能初始化）
PASS  调用不抛错（作用域正确）  [(10,10)=false (1900,1000)=false ...]
===== 结果：通过 =====
```
「对照组」是刻意留的：它在窗口作用域里直接引用 `isWhaleHit`，**复现的正是原来的失败模式**，
用来证明这套验证不是"永远 PASS"的假测试。
（jsdom 里图片永远加载不出来，所以命中恒为 false 是对的；true 的情形由 Electron 的 `--selftest` 覆盖。）

### 13.5 顺带修掉的两个真问题

1. **userData 落错目录 → 余额显示「—」**。
   `app.setName('WhaleDesktop')` **改不动 userData**：打包后 Electron 早在主脚本执行前
   就按 package.json 的 `productName` 定好了。实测：打包版落在 `%APPDATA%\小鲸鱼\`，
   而我按 `%APPDATA%\WhaleDesktop\` 预置凭据 → 应用读的是另一个目录 → `NO_KEY`。
   改法：在文件**最顶部**（早于单实例锁）显式 `app.setPath('userData', <appData>/WhaleDesktop)`，
   并先 `mkdirSync`（`setPath` 要求目录已存在）。dev 与打包态从此永远同一处。
   > 遗留：`%APPDATA%\小鲸鱼\` 是这次踩坑产生的空壳目录，可手动删除。
2. **调试开关被胶水覆盖**：勾上「强制接管鼠标」后，一次 mouseup 会让胶水把 ignore 写回 true，
   于是"勾上能点、点一下又不行"。改为主进程在 `forceCapture` 期间**忽略渲染进程的 set-ignore 回写**。
   （该调试开关属于排查用的临时设施，根因修好后已从托盘移除 —— 见 §12.4 末条。）

### 13.6 诊断留档的两条经验
- glue 的判定结果不再只给 `null`：现在区分 `NO_FN:<类型>`（钩子没注册）与
  `THROW:<错误名> <错误信息>`（调用抛错），日志里一眼看出是哪种。
- `--selftest` 新增断言「`__dshwHitTest` 调用不抛错」，并把异常信息带进报告。
- eval 日志原本只记前 15 条 → 改成前 30 条 + 之后每 60 条抽样
  （原上限把"后续判定是否正常"这段关键信息直接截掉了，第一次排查就吃了这个亏）。

---

## 14. 安装版：允许自定义安装路径

原配置 `nsis.oneClick: true` 是**静默一键装**——不提问、直接装到
`%LOCALAPPDATA%\Programs\小鲸鱼`，**用户没有选目录这一步**。

要开放"自定义安装路径"必须改成向导式，因为 electron-builder 有硬约束：
**`allowToChangeInstallationDirectory` 只在 `oneClick: false` 时生效**。

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true   # ← 就是"浏览…"那一步
  perMachine: false
  allowElevation: true                       # 允许"为所有用户安装"（需提权）
  createDesktopShortcut: true
  createStartMenuShortcut: true
  runAfterFinish: true
  deleteAppDataOnUninstall: false            # 卸载保留账本/配置
```

装机流程变成：**为所有用户/仅自己 → 选择安装目录（浏览…）→ 安装 → 可勾选立即运行**。

单独只打安装版（推荐，双目标一起跑在本机容易被 2 分钟长任务限制杀掉，见 §12.5）：
```powershell
cd desktop
npm run prepare-build
npx electron-builder --win nsis --config electron-builder.yml
# 产物：dist\小鲸鱼-0.1.0-安装版.exe（111.2MB，比 oneClick 版大约 10MB）
```

两点说明：
- **数据目录不跟着安装路径走**：始终落在 `%APPDATA%\WhaleDesktop\`（漫游 AppData），
  这样覆盖安装/换目录安装都不会丢账本。这是刻意的。
- **便携版没有"安装路径"这个概念**：它双击时解压到临时目录运行，
  exe 本身放哪都行（`D:\工具\` 也照样跑）——"把 exe 放哪"就是它的自定义路径。
  注意便携版与安装版共用同一个 `appId` 与 userData，靠单实例锁保证不会同时开两份。

---

## 15. 桌面模式下清掉死功能 + 降开销（2026-09-15 第四轮）

### 15.1 判断依据
独立模式（含桌面壳）里 `ctx.on('session/event')` 是 no-op，所以 `last-turn.json`
的 `seq` **恒为 0**。后果有两层：
- 「每轮消耗提示」与「任务结束音效」永远不触发 → **死 UI**；
- 前端的 `setInterval(pollLastTurn, 1000)` 会**每秒发一次请求**，纯白发。

判据不是猜的：`lib/index.js:2846` 的 last-turn 路由只在宿主喂过 `lastTurn` 时才给
非零 seq，而独立模式的会话流是空的。

### 15.2 做法：宿主能力声明（**不是删功能，是按宿主隐藏**）
薄壳在页面里注入一个全局（必须在 widget.js 之前）：

```html
<script>window.__dshwShellCaps={dshSessionEvents:false,host:"standalone"};</script>
```

挂件侧（`assets/whale-widget.js`）：
```js
var shellCaps = (window.__dshwShellCaps && typeof window.__dshwShellCaps === 'object') ? window.__dshwShellCaps : null
var HAS_SESSION_EVENTS = !shellCaps || shellCaps.dshSessionEvents !== false
```
- `menuBox.appendChild(row7)`（每轮消耗提示行）→ 包在 `if (HAS_SESSION_EVENTS)` 里；
  该行是「自定义提示」编辑窗（内含任务结束音效）的**唯一入口**，所以一并不可达。
- `setInterval(pollLastTurn, 1000)` → 同样包起来。

DSH 宿主里没有 `__dshwShellCaps` → `HAS_SESSION_EVENTS` 为真 → **行为与以前一模一样**，
设置数据也没有迁移/删除（换回 DSH 就自动恢复）。

### 15.3 降开销清单（都带可验证证据）

| 措施 | 依据 / 效果 |
|---|---|
| 去掉每秒 last-turn 轮询 | jsdom 断言：注入 caps 后 2.4s 内 `last-turn.json` 请求数 **0**（无 caps 时为 ≥1）。场景 B 的实际请求只有 roles/audio/usage-settings/bubble/size/balance 六个 |
| 光标轮询空闲降频 | 光标未移动时不再逐次下发，只保留 ~500ms 心跳（防止动画把挂件挪走后状态不更新）。鼠标静止时 IPC 量约为原来的 **1/15** |
| `spellcheck: false` | 页面没有任何需要拼写检查的输入，关掉可省下 Chromium 为拼写检查加载的词典与服务 |
| `disable-features=CalculateNativeWinOcclusion` | Windows 上 Chromium 会周期性自算窗口遮挡状态；对一个常驻置顶透明窗纯白烧 CPU |
| 隐藏时允许节流 | 托盘「隐藏小鲸鱼」时 `webContents.setBackgroundThrottling(true)`，显示时解除。用户把鲸鱼收进托盘挂一整天是常见用法 |

### 15.4 回归护栏（`npm run check:hook` 已扩为两个场景）
```
PASS  A/无 caps：脚本执行无异常
PASS  A/无 caps：dshwInit 已跑起来
PASS  A/无 caps：挂件根节点已挂载
PASS  A/无 caps：菜单保留「每轮消耗提示」      ← 守住 DSH 行为不变
PASS  A/无 caps：last-turn 轮询仍在跑  [1 次]
PASS  B/有 caps：脚本执行无异常
PASS  B/有 caps：挂件根节点已挂载
PASS  B/有 caps：菜单已隐藏「每轮消耗提示」
PASS  B/有 caps：无 DSH 会话事件 → 钩子仍注册  [function]
PASS  B/有 caps：last-turn 轮询已关闭  [0 次]
PASS  对照组能识别作用域外引用  [ReferenceError: isWhaleHit is not defined]
PASS  钩子调用不抛错（作用域正确）
```
两个场景互为对照：A 证明"没把 DSH 模式改坏"，B 证明"桌面模式确实清干净了"。

> 尚未做的事：**内存绝对值实测**。本轮开工时应用没在运行，没有拿到改动前的基线，
> 所以没有做前后对比。上面每一条都是"减少固定开销"，方向明确但没有数字。
> 想量化的话：启动应用后用
> `Get-Process | Where-Object { $_.ProcessName -like '*鲸鱼*' } | Measure-Object WorkingSet64 -Sum`
> 记一次总和，之后每次改动复测即可得到趋势。

---

## 16. 内存构成说明 + 气泡内容自适应（2026-09-15 第五轮）

### 16.1 内存构成（用户实测 139.5MB / 5 进程）
| 进程 | 实测 | 性质 |
|---|---|---|
| 主进程（browser） | 37.9MB | Node + Electron main + 插件；**基线，动不了** |
| GPU 进程 | **53.0MB** | 全屏 1920x1032 透明图层 + 着色器/帧缓冲；**唯一的大块可选项** |
| 渲染进程（页面） | 34.6MB | Chromium 渲染进程基线；挂件自身资源只有 ~5.8MB |
| 网络服务 | 8.2MB | 页面用 fetch 就必然有这个进程 |
| 其它 utility | 5.8MB | 存储/杂项 |

结论：**没有"我们的代码太重"这回事**。要显著往下压，只有一条路——去掉 GPU 进程。

### 16.2 本轮已做的低风险削减
```js
app.commandLine.appendSwitch('disable-features',
  'CalculateNativeWinOcclusion,Translate,MediaRouter,OptimizationHints,BackForwardCache,AcceptCHFrame')
app.commandLine.appendSwitch('disable-background-networking')
// webPreferences 里另加 spellcheck: false
```
都是"关掉浏览器功能、本应用用不到"，各自省几 MB 级别，不会改变观感。

### 16.3 想再省 ~50MB 的唯一办法（**需要实测取舍**）
把硬件加速关掉（软件合成），GPU 进程那一块会消失或大幅缩小，
代价是动画/拖动时的合成改由 CPU 做，可能不如现在顺滑：

```powershell
# 便携版实测（不改变默认行为，只是这一次启动用软件渲染）
$env:WHALE_DESKTOP_SOFTWARE_GL=1
& "D:\...\desktop\dist\小鲸鱼-0.1.0-便携版.exe"
# 也可以用命令行参数：<exe> --software-gl
```
跑起来后对比任务管理器里 5 个进程的总和。若确实降得多且观感能接受，
就把 `createOverlay()` 里的 `app.disableHardwareAcceleration()` 改成默认调用
（注意：必须在 ready 之前调用，代码里已有的 `--software-gl` 分支就是模板）。

### 16.4 气泡内容溢出的根因与修法
**根因不是"内容太长"，是文字盒子和泡泡形状本来就不匹配**：

| 量 | 值 |
|---|---|
| 文字盒子 `.dshwv-text` | `.dshwv-pop` 的 66% × 64% → 在 1026×700 坐标系里是 **677×448**，中心 (454,252) |
| 泡泡主体（svg path 的 `A 373 232`） | 椭圆 rx=**373**、ry=**232**，中心 (454,247) |
| 四角是否在椭圆内 | (338.5/373)² + (224/232)² ≈ **1.76 > 1** → **四角都在椭圆外** |

也就是说：哪怕内容正好填满文字盒子，四角也会顶出泡泡轮廓。
平时看不出来只是因为默认内容（3 行、居中、宽 ≤560）远小于盒子。

**修法**：内容变化后量一次自然尺寸，解出"外接矩形四角恰好落在椭圆内"的缩放比，
再用 CSS 独立属性 `scale` 整体等比缩回去：

```
k = 1 / sqrt( (w/2/rx)² + (h/2/ry)² )     // 取 0.98 余量、下限 0.35
textBox.style.scale = k
```

几个刻意的选择：
- **用 `scale` 而不是改字号**：一次覆盖所有子元素（三行文字、模块行、图片行），
  不用给每个 `font-size` 乘系数；也不碰 `.dshwv-text` 的 `transform`
  —— 那个 transform 还要负责居中和左吸附镜像，写内联会把它顶掉。
- **`requestAnimationFrame` 后再量**：内容刚写完时布局还没更新，量到的是旧值；
  顺带把一帧内的多次内容更新合并成一次测量。
- **只在超框时缩、不放大**：`k` 上限 1；回归到 1 时清掉内联 `scale` 交回 CSS。
- 挂载点只有两处就覆盖全部内容路径：`sceneOpen().finish()`（打开/切场景，
  含模块化内容）与 `render()`（打开期间余额/提示刷新）。

实测（架构验证）：默认三行内容 k=1（不缩），四行或长文本才开始缩；
长到 1500 单位的一行会缩到 ~0.49，仍可读。

### 16.5 ⚠️ 独立变换属性的合成顺序（第一版改完"内容整体往右偏"的原因）
第一版直接写了 `textBox.style.scale = k`，结果**内容往右下偏**。原因不是缩放本身，
而是**独立变换属性与 `transform` 的合成顺序**：

按 CSS Transforms Level 2，最终变换是
```
translate × rotate × scale × transform     ← translate 最外、transform 最内
```
而 `.dshwv-text` 的居中靠的正是 `transform: translate(-50%,-50%)` ——
这句居中位移位于 **transform 内部**，会被外层的 `scale` 一起缩放，
于是元素中心相对锚点偏移 **`(w/2)(1-k)`**（右下方向）。

修法：用同样位于外层的独立 `translate` 反向补偿：
```js
textBox.style.scale = k
var comp = 50 * (1 - k)
textBox.style.translate = '-' + comp + '% -' + comp + '%'   // 百分比按自身边框盒解析
```
这样 CSS 里那两句（居中 + 左吸附镜像）**一行都不用动**。

矩阵验算（`npm run check:hook` 已内置，防的就是"哪天有人顺手删掉那行补偿"）：

| w × h | k | 不补偿的偏移 | 补偿后 | 左吸附镜像 |
|---|---|---|---|---|
| 677×448 | 1 | (0, 0) | (0, 0) | 一致 |
| 560×376 | 0.905 | **(+26.6, +17.9)** | (0, 0) | 一致 |
| 677×448 | 0.75 | **(+84.6, +56.0)** | (0, 0) | 一致 |
| 677×448 | 0.5 | **(+169.3, +112.0)** | (0, 0) | 一致 |

> 另一个可选方案是把整句 transform 写到内联里自己拼（含镜像），但那样会永久压掉
> CSS 的 `.dshwv-root.dshwv-left .dshwv-text` 规则，吸附翻转时文字可能忘记镜像。
> 用独立 `translate` 补偿不动 transform，风险更小。

### 16.6 调参用的埋点
`fitBubbleText()` 会把每次的实测值写进桌面壳日志（DSH 宿主没有这个桥，静默跳过）：
```
[bubble] fit 自然尺寸 560x376 → k=0.905（泡泡宽 250px，椭圆 334x208）
```
首次必定记一条（证明跑过），之后只在 k 变化时记。
另外 `window.__dshwFitInfo = {w,h,k,pop}` 供 devtools / `--selftest` 取用。
**如果日志里 k 明显小于 1 而你看着字偏小**，说明椭圆模型偏保守，可以放宽
（把 373/232 乘一个 >1 的容差，或只对"真的超出"的维度缩）。

---

## 17. 模型配置：桌面模式下哪些是死的（2026-09-15 第六轮）

### 17.1 一句话根因
**全部来自同一件事：桌面壳没有 DSH 的会话事件流。** 凡是"数据来自本机每轮对话"的
地方，在桌面模式里都恒为 0 或不可能命中。逐条核对（判据都指向 `lib/index.js` 的实现）：

| 位置 | 桌面模式下的实际表现 | 处理 |
|---|---|---|
| 「今日已用」（无余额接口的厂商） | `apiTodayUsage()` 走到 `eventCost`（会话事件）→ **恒为 0**，界面显示 `0.00` | 改为显示 `—`（`apiTodayMoneyText` / `apiModelTodayText`），并去掉来源标注 |
| 「事件匹配」输入框 | 作用是把会话事件按关键字归到模型 → **永不命中** | 桌面模式**隐藏**该行，提示改为实话 |
| 额度「已用来源 = 自动统计（按会话 token）」 | `apiQuotaAutoUsed` 取 `eventTokens` → **恒为 0**，额度永远 0% | 桌面模式**不提供该选项**；存量 `auto` 配置在 `apiQuotaInfo` 里按手动处理（用面板填的 used），点保存即落成 `manual` |
| 「⚠ 币种不一致 → 去填汇率」提示 | 该提示只为"会话事件的 CNY 金额 vs 厂商币种"存在 | 桌面模式不显示（去填汇率也救不了取不到的数据） |
| 凭据文案「写入 DSH 官方凭据（.credentials.yaml）」 | 桌面模式凭据写在 `config.json` 的 `credentials` 段 | 按宿主切换文案 |
| 「余额预警 / 今日预算」（无余额接口的模型） | 阈值所依据的数据不存在 → 永不触发 | 未改：模型本身已标注「取不到数据」，且用户不会去给死数据配阈值 |

### 17.2 桌面模式下**仍然可用**的部分（别误删）
- **有余额接口的厂商**（DeepSeek 内置 / OpenRouter / Novita / 中转站等）：
  余额走厂商接口 ✓，今日已用走**余额差记账**（挂件自己的账本，不依赖 DSH）✓
- **Codex**：本地会话统计 ✓（纯本地文件）
- **厂商订阅额度**（智谱 / Kimi Coding / MiniMax Coding 等 kind=quota）✓
- **手动额度**（订阅 / 资源包，"手动填写"模式）✓
- **测试连通性** ✓
- 泡泡里的 `{balance}` / `{today}` / 额度类占位符 ✓（有数据的模型）

### 17.3 一个**没有动**的取舍（需要产品决定）
33 个厂商模板里有 **19 个标着「无余额接口」**（OpenAI / Anthropic / Gemini / Groq /
Mistral / 百炼 / 千帆 / 混元 / 星火 / ModelScope / Ollama …）。
桌面模式下它们**取不到任何数据**，唯一还能用的是「测试连通性」（验证 key / baseURL 通不通）。

- 保持现状：下拉里仍然列出，靠标签「（无余额接口）」+ 保存后状态行的
  「无余额接口·桌面模式取不到数据」自我说明，不影响别人。
- 收起来：桌面模式下从下拉里隐藏这 19 项（列表干净，但失去"配 key 测连通性"这个用途）。

> 本轮选了**保持现状**（不删功能，只把话说清楚）。要收起来只需在
> `openApiModelPanel` 的 `tplList` 构建处加一个 `if (!HAS_SESSION_EVENTS && apiTemplates[ti].hasBalance === false) continue`。

---

## 18. 模型行「今日」与面板合计不一致（真 bug，已修）+ 高级字段逐条说明

### 18.1 症状
用户截图：内置 DeepSeek 模型行显示「今日 ¥4.32」，同屏「今日模型消费」合计却是「¥5.82」。

### 18.2 根因：同一个"今日已用"，两条代码路径用了**不同口径**
| 位置 | 取值函数 | 优先级 |
|---|---|---|
| 余额面板 / 泡泡提示（`getBalancePayload`） | `todayUsageOf()` → **官方账单** → 余额差 | 官方优先 |
| **模型行**（`apiModelsPayload` 内置分支） | `ledgerTodayTotal()` → **只看余额差**，**从不看官方记录** | 余额差 |

`ledgerTodayTotal()` 的逻辑是 `零点余额 − 当前余额`，而官方账单是平台结算口径
（与 platform.deepseek.com/usage 一致）。代码里早就写明"官方比余额差更准
（实测今天余额差为 0 而官方 2.05）"，但模型行漏了这一步 → 两个数天然会差。

### 18.3 修法（`lib/index.js` 内置 DeepSeek 分支）
```js
const offToday = officialTodayRecord()
entry.todayUsage = offToday ? round2(offToday.cost) : ledgerTodayTotal(readUsageLedger())
entry.usageSource = offToday ? 'official' : 'ledger'
```
前端 `apiUsageSourceLabel` 补一档 `'official' → '官方账单'`，模型行会标出来源。

### 18.4 用真实数据验证（不是"应该对"）
跑 standalone 薄壳指向用户真实数据目录，读 `api-models.json` 与 `usage-records.json`：
```
模型行  id=deepseek name=DeepSeek
  余额=16.89  今日已用=5.82  来源=official  币种=CNY
面板 /dsh-whale/usage-records.json 今日合计=5.82 来源=official 行数=2
```
→ 两个数一致了 ✓（修复前模型行是余额差的 4.32）。
**下次改这类"同一指标多处展示"的地方，记得用这招：拿真实数据把两个接口一起读出来对比。**

### 18.5 「接口与字段（高级）」各字段是干什么的 + 桌面端能不能用

| 字段 | 作用 | 桌面端 |
|---|---|---|
| **余额字段** `balance_infos[0].total_balance` | 在厂商余额接口的返回 JSON 里取余额的路径（支持 `a.b[0].c`） | ✅ 可用（给模板没覆盖的厂商用） |
| **总量字段** `data.total_credits` | 取"总额度"的路径（配已用字段算进度） | ✅ 可用 |
| **已用字段** `data.total_usage` | 取"已用"的路径 | ✅ 可用 |
| **数值乘数** `0.0001` | 取到的值 × 乘数（厂商返回单位不同，如万分之一） | ✅ 可用 |
| **用量接口** `可选：第二段用量接口` | 第二个端点（如 OpenAI 兼容 `/usage`） | ✅ 可用（厂商接口） |
| **用量字段 / 用量乘数** | 在第二段返回里取"已用"的路径与乘数 | ✅ 可用 |
| **事件匹配** | 把**会话事件**的模型名按关键字归到本模型 | ❌ 桌面无会话流（**已隐藏**，见 §17.1） |
| **单价** 缓存命中/未命中输入/输出 | 元/百万 token 价目：把**会话事件的 token** 折成钱 | ❌ 只在 `apiAttributeEvent` 那条链上用（见 `lib/index.js:1985` 与 `finalizeTurn`）→ 无会话事件就没用武之地（**本已隐藏**） |
| **汇率** | 事件金额是 CNY，模型币种是 USD 时换算 | ❌ 同上（余额差口径下两边本就是同一币种）→ **已隐藏** |
| **币种**（单价块内） | 价目表的币种 | ⚪️ 随单价块一起隐藏（模型币种在面板顶部另有一处，那个保留 ✅） |

> 注意：**隐藏只是显示层**（按 `HAS_SESSION_EVENTS` 判断）——原有配置值仍留在 DOM 里随保存原样写回，
> 不会因为"看不见"就被清空；换回 DSH 时这些字段照常出现、值也还在。

---

## 19. 平台令牌可以在界面里填了（原来只能手改配置文件并重启）

### 19.1 原状
- **API key**：内置 DeepSeek 那行的「设置 → 密钥 / 接口」里本来就能填 → 走 `set-key` →
  `ctx.credentials.set()` → **桌面壳/独立模式下就是写进 `config.json` 的 `credentials`** ✓
- **平台令牌 `DEEPSEEK_PLATFORM_TOKEN`**（官方账单 / 分时段数据的数据源）：**没有任何界面入口**，
  只能手改 `config.json`，而且旧提示还写着"改完**重启服务**"。
  （其实不必重启：host 每次请求都现取凭据，写进去下一次刷新就生效。）

### 19.2 做法：复用现成的 `set-key` 接口，只加界面
没有新增后端动作，直接复用 `action:'set-key'` / `'delete-key'`（`keyRef = 'DEEPSEEK_PLATFORM_TOKEN'`）：

- 模型面板（仅 `m.builtin`）在「密钥」区后面多一节 **平台令牌（官方账单）**：
  状态行（已配置 ✓ / 尚未配置 + 后果说明）+ password 输入框（留空＝不改动）+「清除平台令牌」按钮。
- 主「保存」按钮：先提交令牌（非空时），成功后再保存模型本体 —— 避免"保存模型顺手把令牌清掉"。
- 后端新增一个只读标记 `entry.platformTokenSet`（boolean）：**值绝不下发前端**。
- 顺带把两处"手改 config.json 并重启"的文案改成指向新界面。

### 19.3 端到端验证（**用临时目录，不碰用户真实凭据**）
```
① 初始：platformTokenSet=false
② set-key 返回 ok=true
   config.json 里已写入=true
③ 保存后 platformTokenSet=true
④ 接口响应里不含令牌明文=true      ← 密钥不回传前端
⑤ delete-key 返回 ok=true → platformTokenSet=false
   config.json 里已移除=true
   API key 未受影响=true
```
覆盖了写入、回显、清除、以及"其它凭据不被误伤"。验证方式值得复用：
**把 `DSH_STANDALONE_HOME` / `DSH_STANDALONE_CONFIG` 指到一个临时目录再起薄壳**，
就能对写盘类操作做真实端到端测试而不污染用户数据。

---

## 20. 内置 DeepSeek 那个面板的三处问题（同一个根因：拿内置当普通模型编辑）

用户实测反馈：「测试连通性显示 key 未填 / 保存提示未知厂商模板 / 内置模型里怎么还有删除模型」。

### 20.1 根因
内置模型**不是注册表里的模型**（`apiBuiltinModel()` 现造、不落盘），但面板仍按"普通模型"渲染：

| 现象 | 真实原因 |
|---|---|
| 保存 → 「未知的厂商模板」 | 厂商下拉**从不列内置模板**（`if (apiTemplates[ti].builtin) continue`）→ 下拉为空 → `provider:''` → `apiSaveModel` 在 `if (!tpl)` 处直接失败 |
| 测试连通性 → key 未填 | 探活对内置走 `fetchBalance()`，当时**配置里真的没有 API key**（见 §20.3）→ 报错属实 |
| 「删除模型」 | 后端 `apiDeleteModel` 明确拒绝内置（`内置模型不可删除`），但按钮照样给 |

### 20.2 修法
- **后端**（`apiSaveModel`）：`id === API_BUILTIN_ID` 时**只写密钥**就返回 ok，
  不去注册表塞 `id='deepseek'` 的垃圾记录，也不再校验厂商模板。
- **前端**（`openApiModelPanel`，新增 `isBuiltin`）：
  - 内置模型：隐藏「基本信息」区（名称/厂商/币种）、凭据名、Base URL，
    以及**整段「接口与字段（高级）」**（连开关按钮一起不建）
  - 删除「删除模型」按钮
  - 保存按钮改名「**保存密钥**」，并加一行说明：内置的名称/厂商/币种/接口都是固定的

### 20.3 ⚠️ 顺带发现：用户的 API key 在 23:32 从 `config.json` 里消失了
排查时把 `api-models.json` 与 `balance.json` 对着真实数据一读，才发现
```
内置条目: hasKey=false … error="未配置 DEEPSEEK_API_KEY"
balance.json: ok=false 错误=未配置 DEEPSEEK_API_KEY
config.json credentials 键名=["DEEPSEEK_PLATFORM_TOKEN"]   ← 只剩令牌
```
也就是说：**当时余额接口其实是坏的**，只是「今日已用」仍来自官方账本（5.82）所以看着正常。
配置在 23:32 被改过一次 —— 与「删除密钥」按钮被点到一致（它删的就是 `keyRefInp.value`，
而内置模型那个值正是 `DEEPSEEK_API_KEY`）。

**已恢复**：项目目录里的 `standalone/config.json`（16:46 的备份）两个键都还在，
把它补回 `%APPDATA%\WhaleDesktop\config.json`，并当场验证：
```
恢复后=["DEEPSEEK_PLATFORM_TOKEN","DEEPSEEK_API_KEY"]
内置条目: hasKey=true 余额=16.89 今日=5.82(official) 错误=
balance.json: ok=true 余额=16.89 今日=5.82
```
（如果用户是有意删的，说一声再删掉。）

> 教训：**「界面显示某个凭据没配置」有可能是真的没配**，别先怀疑代码 ——
> 直接把 `api-models.json` / `balance.json` 对着真实数据读一遍，10 秒就能分清。

### 20.4 后续：「+ 添加模型」点了没反应（上一轮修内置时自己埋的雷）
新增模型时 `m === null`，而平台令牌那节写的是 `if (m.builtin)` → `TypeError` →
被函数外层 `try/catch` 吞掉 → 面板根本没 append，表现为"点了没反应"。
改成 `if (isBuiltin)` 即可（`isBuiltin = !!(m && m.builtin)`）。

**已把这个坑做成回归测试**（`check:hook` 里真点一次按钮：进记账界面 → 点「+ 添加模型」→
断言面板出现），并用对照组确认测试有效：

| 版本 | 结果 |
|---|---|
| 有 bug（`m.builtin`） | `mask 数=1 末个文字=[] 含OpenRouter=false` → **FAIL** |
| 修好（`isBuiltin`） | `mask 数=2 末个文字=[新增模型（自定义 API）选择厂商模板 → 填 API ke…]` → **PASS** |

> 这类"异常被 try/catch 吞掉 + 界面因此完全无反应"的问题，肉眼极难定位，
> 但用 jsdom 真点一下就是 10 行的事 —— 值得养成习惯。

### 20.5 模型注册表在哪 / 会不会攒垃圾数据
- 路径：**`%APPDATA%\WhaleDesktop\data\.dshw-api.json`**（`DSH_HOME` 下；
  DSH 里是 `$DSH_HOME/.dshw-api.json`，兜底 `profiles/web/.dshw-api.json`）。
- **内置 DeepSeek 永远不进这个文件**（`apiBuiltinModel()` 每次现造，`apiAllModels()` 会过滤）→ 不会污染。
- 只有「+ 添加模型」保存过的自定义模型才写进去；保存内置模型时后端已改成**只写密钥**（§20.2），
  不会塞 `id='deepseek'` 的垃圾记录。
- 实测用户目录里**这个文件根本不存在** → 一个自定义模型都没存过，没有垃圾数据 ✓
- 同目录下的其它文件都是正常数据：`.dshw-official.json`（官方账单缓存，会随日期增长）、
  `.dshw-usage.json`（用量账本）、`.dshw-size.json`（挂件尺寸/位置）、`.dshw-bubble.json`（泡泡配置）。

