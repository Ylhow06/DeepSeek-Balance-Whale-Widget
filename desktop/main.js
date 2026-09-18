// ============================================================================
// 小鲸鱼桌面宠物 —— Electron 主进程
// ----------------------------------------------------------------------------
// 方案 B（见 HANDOVER-DESKTOP.md）：全屏透明覆盖层 + 托盘 + 单实例锁。
// 后端复用 standalone/server.js（伪造 DSH ctx 跑核心 lib），端口动态分配。
//
// 启动（开发）：
//   cd desktop && npx electron .
// 软件渲染兜底（透明窗黑屏/崩溃时加）：
//   npx electron . --software-gl
// ============================================================================

// ⚠️ Electron 的 ESM 取模块要用 createRequire：
//    - `import { app } from 'electron'` 会报 "does not provide an export named ..."
//    - `import electron from 'electron'` 拿到的是 undefined/字符串
//      （两者都会错误地回落到 node_modules/electron/index.js —— 那个文件导出的
//        只是 electron.exe 的路径字符串）
//    - 只有走 CJS 的 require，Electron 才会把它换成内置模块（resolved 打印为 "electron"）
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, shell, nativeImage, dialog, globalShortcut } = require('electron')

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(DESKTOP_DIR, '..')
const APP_DISPLAY_NAME = '小鲸鱼'

// ---- 诊断日志（userData/desktop.log，超过 512KB 自动清空）----
let LOG_PATH = null
function flog(msg) {
  if (!LOG_PATH) return
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 512 * 1024) fs.writeFileSync(LOG_PATH, '')
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

// ---------------------------------------------------------------------------
// ① userData 必须最先定死（单实例锁、Chromium 配置、localStorage、日志都落在它下面）
// ---------------------------------------------------------------------------
// ⚠️ 别用 app.setName() 去改 userData —— 打包后 Electron 早在主脚本执行前就按
//    package.json 的 productName 把 userData 定好了，setName 改不动它。
//    本机实测踩过：dev 落 %APPDATA%\whale-desktop、打包态落 %APPDATA%\小鲸鱼，
//    而我按 %APPDATA%\WhaleDesktop 预置凭据 → 应用读的是另一个目录 → 余额显示「—」。
//    这里显式 setPath，dev 与打包态永远同一处，且路径保持 ASCII。
//    （setPath 要求目录已存在，否则抛错 → 先 mkdir）
//    另外支持 WHALE_USER_DATA 覆盖：单实例锁就落在这个目录下，所以想"在正式版正开着的时候
//    跑一次 --selftest"必须换一个目录，否则第二个实例会被锁直接挡掉、静默退出（本机实测：
//    用户装着正式版在跑时，`electron . --selftest` 秒退、退出码 0、什么报告都没有）。
const USER_DATA = process.env.WHALE_USER_DATA
  ? path.resolve(process.env.WHALE_USER_DATA)
  : path.join(app.getPath('appData'), 'WhaleDesktop')
const DATA_HOME = path.join(USER_DATA, 'data')
const CONFIG_PATH = path.join(USER_DATA, 'config.json')
try {
  fs.mkdirSync(USER_DATA, { recursive: true })
  app.setPath('userData', USER_DATA)
} catch (e) {
  console.warn('[desktop] 设置 userData 失败，沿用默认目录：', e.message)
}
LOG_PATH = path.join(app.getPath('userData'), 'desktop.log')

// ---------------------------------------------------------------------------
// ② 单实例锁：越早越好（多开会导致两条托盘图标 + 两个覆盖层互相抢穿透）
//    打包后是 GUI 进程，stderr 没人看得到 → 启动期任何未捕获错误都弹窗，
//    否则表现为"双击图标毫无反应"，极难排查。
// ---------------------------------------------------------------------------
function fatal(where, err) {
  const msg = err && err.stack ? err.stack : String(err)
  try { console.error(`[desktop] 致命错误(${where})：`, msg) } catch {}
  flog(`[fatal:${where}] ${msg}`)
  try { dialog.showErrorBox('小鲸鱼启动失败', `${where}\n\n${msg}`) } catch {}
}
process.on('uncaughtException', (err) => { fatal('uncaughtException', err); app.exit(1) })
process.on('unhandledRejection', (err) => { fatal('unhandledRejection', err) })

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  try {
    main()
  } catch (err) {
    fatal('main()', err)
    app.exit(1)
  }
}

function main() {
  // -------------------------------------------------------------------------
  // ③ 必须在 ready 之前、同步执行的环境准备
  //    （standalone/server.js 顶层就读 DSH_HOME / CONFIG，动态 import 在 ready 后，
  //      但环境变量必须在 import 那一刻已就位 —— 所以在这里同步设好）
  // -------------------------------------------------------------------------
  const wantSoftwareGl = process.argv.includes('--software-gl') ||
    process.env.WHALE_DESKTOP_SOFTWARE_GL === '1'
  if (wantSoftwareGl) {
    // 两个都必须在 ready 之前调用
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu-compositing')
    console.log('[desktop] 已启用软件渲染兜底（--software-gl）')
  }

  const SELFTEST = process.argv.includes('--selftest')

  // —— 桌面宠物用不到的东西，启动前先关掉 ——
  // CalculateNativeWinOcclusion：Windows 上 Chromium 会周期性地自己算"窗口有没有被遮挡"，
  //   对一个常驻置顶的透明窗来说是纯白烧 CPU。关掉在本机是常规做法（VS Code 同款）。
  // 其余几个都是浏览器功能（翻译、投屏、优化提示、前后退缓存、客户端提示帧），
  // 本应用只加载一个本地页，全部用不到 → 少几个后台服务与一点常驻内存。
  // 注意：switch 必须在 ready 之前追加，所以放在这里（main() 早于 whenReady）。
  app.commandLine.appendSwitch('disable-features',
    'CalculateNativeWinOcclusion,Translate,MediaRouter,OptimizationHints,BackForwardCache,AcceptCHFrame')
  // 关掉 Chromium 的后台联网（组件更新、域名可靠性上报等）；页面自己的 fetch 不受影响
  app.commandLine.appendSwitch('disable-background-networking')

  process.env.DSH_STANDALONE_HOME = DATA_HOME
  process.env.DSH_STANDALONE_CONFIG = CONFIG_PATH
  process.env.DSH_STANDALONE_OVERLAY = '1'

  console.log('[desktop] userData   :', USER_DATA)
  console.log('[desktop] 数据目录    :', DATA_HOME)
  console.log('[desktop] 配置文件    :', CONFIG_PATH)

  // 日志落文件：GUI 进程看不到 stderr，"点了没反应"这类问题只能靠日志定位。
  // 托盘菜单有「打开日志文件」，so 排查不需要终端。
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k].bind(console)
    console[k] = (...args) => {
      try { orig(...args) } catch {}
      flog('[' + k + '] ' + args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' '))
    }
  }
  flog('================ 启动 ================')
  flog('exe=' + process.execPath)
  flog('packaged=' + app.isPackaged + ' electron=' + process.versions.electron + ' chrome=' + process.versions.chrome)

  migrateLegacyDataOnce(DATA_HOME)

  /** @type {BrowserWindow|null} */
  let overlayWin = null
  /** @type {Tray|null} */
  let tray = null
  /** @type {{url:string, close:()=>Promise<void>}|null} */
  let srv = null
  let lastIgnore = null
  let quitting = false
  /** @type {NodeJS.Timeout|null} */
  let cursorTimer = null
  let lastCursorPt = null
  let lastCursorSentAt = 0
  let freezeCursorPoll = false // 自检期间冻结光标轮询（见 startCursorPolling 里的说明）
  let ignoreMsgCount = 0       // 渲染进程发来的 set-ignore 消息条数（自检断言"通道畅通"用）

  // -------------------------------------------------------------------------
  // ③ ready 之后：起后端 → 开覆盖层 → 托盘
  // -------------------------------------------------------------------------
  app.whenReady().then(async () => {
    try {
      const { start } = await import('../standalone/server.js')
      // 端口策略：**优先固定端口**，被占用才退回随机端口。
      // 为什么要固定：挂件把「位置 / 选中角色 / 已看轮次」都存在 localStorage，
      // 而 localStorage 是按**源（scheme+host+port）**隔离的 —— 端口每次都变
      // 等于每次都是全新储物柜，用户拖好的位置和选好的角色重启就没了。
      // 单实例锁 + 专用端口（默认 3082，与浏览器独立模式的 3081 错开）通常都能拿到；
      // 拿不到时退回 listen(0)，"绝不 EADDRINUSE" 这一条仍然成立。
      const preferred = Number(process.env.WHALE_DESKTOP_PORT || 3082)
      try {
        srv = await start({ port: preferred })
      } catch (e) {
        if (e && e.code === 'EADDRINUSE') {
          console.warn(`[desktop] 端口 ${preferred} 被占用 → 本次改用随机端口（该次启动的位置/角色不会记住）`)
          srv = await start({ port: 0 })
        } else {
          throw e
        }
      }
      console.log('[desktop] 后端已就绪：', srv.url)
    } catch (e) {
      console.error('[desktop] 后端启动失败：', e)
      dialog.showErrorBox(`${APP_DISPLAY_NAME}启动失败`, '本地服务未能启动：\n' + (e && e.message ? e.message : String(e)))
      app.exit(1)
      return
    }

    createOverlay(srv.url)
    createTray()
    startCursorPolling()

    try {
      const ok = globalShortcut.register('Alt+Shift+W', () => toggleOverlay())
      console.log('[desktop] 全局快捷键 Alt+Shift+W 显示/隐藏：', ok ? '已注册' : '被占用，跳过')
    } catch (e) {
      console.warn('[desktop] 注册全局快捷键失败：', e.message)
    }
  })

  // -------------------------------------------------------------------------
  // 自检模式（--selftest）：不开窗口肉眼验证，也能确认「窗口属性 / 挂件挂载 /
  // 命中判定 → 穿透开关」整条链路是通的。跑完打印报告并退出。
  // -------------------------------------------------------------------------
  async function runSelfTest() {
    const report = { checks: [], ok: true }
    const check = (name, pass, extra) => {
      report.checks.push({ name, pass: !!pass, extra: extra === undefined ? '' : String(extra) })
      if (!pass) report.ok = false
    }
    try {
      // 胶水是以 <script src> 由页面自己加载的，先确认这条路由通
      try {
        const r = await fetch(srv.url + '/dsh-whale-shell/glue.js')
        const body = await r.text()
        check('胶水路可访问', r.status === 200 && body.indexOf('__whaleGlueInstalled') !== -1,
          `status=${r.status} bytes=${body.length}`)
      } catch (e) {
        check('胶水路可访问', false, e.message)
      }

      check('窗口可见', overlayWin.isVisible(), `bounds=${JSON.stringify(overlayWin.getBounds())}`)
      check('置顶(screen-saver)', overlayWin.isAlwaysOnTop())
      check('覆盖主屏', overlayWin.getBounds().width === screen.getPrimaryDisplay().bounds.width,
        `primary=${screen.getPrimaryDisplay().bounds.width}x${screen.getPrimaryDisplay().bounds.height}`)

      const probe = await overlayWin.webContents.executeJavaScript(`(function () {
        var img = document.querySelector('.dshwv-img')
        var r = img ? img.getBoundingClientRect() : null
        var res = {
          rootMounted: !!document.querySelector('.dshwv-root'),
          hitTestType: typeof window.__dshwHitTest,
          glueInstalled: !!window.__whaleGlueInstalled,
          shellBridge: !!(window.__whaleShell && typeof window.__whaleShell.setIgnore === 'function'),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          tipVisible: !!document.querySelector('.tip'),
          imgRect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
        }
        var hitErr = ''
        function callHit(hx, hy) {
          try { return window.__dshwHitTest(hx, hy) }
          catch (e) { if (!hitErr) hitErr = ((e && e.name) || 'Error') + ': ' + ((e && e.message) || ''); return null }
        }
        if (r && typeof window.__dshwHitTest === 'function') {
          // 鲸鱼 bbox 中心未必是不透明像素（鲸鱼是不规则形状），这里扫描 bbox 找命中点。
          // ⚠️ 必须找**整像素四邻都命中**的点，不能拿"扫到的第一个命中点"：
          //    ① MouseEvent.clientX/Y 是整数（小数会被截断），拿边缘上的浮点坐标去派发事件，
          //       截断后就落到抗锯齿的半透明像素上 → 判定翻转（本机实测踩过）；
          //    ② 退化到"最边缘"也会让断言变成碰运气。
          var found = null
          for (var dy = 4; dy < r.height && !found; dy += 4) {
            for (var dx = 4; dx < r.width; dx += 4) {
              var ix = Math.round(r.left + dx)
              var iy = Math.round(r.top + dy)
              if (callHit(ix, iy) && callHit(ix + 1, iy) && callHit(ix, iy + 1) && callHit(ix + 1, iy + 1)) {
                found = { x: ix, y: iy }
                break
              }
            }
          }
          res.hitPoint = found
          res.hitAt0 = callHit(2, 2)
        }
        res.hitError = hitErr
        return res
      })()`)

      check('挂件已挂载(.dshwv-root)', probe.rootMounted)
      check('胶水已加载(主世界)', probe.glueInstalled)
      check('contextBridge 通道存在', probe.shellBridge)
      check('__dshwHitTest 已暴露', probe.hitTestType === 'function', probe.hitTestType)
      check('__dshwHitTest 调用不抛错', !probe.hitError, probe.hitError || 'ok')
      check('页面无提示卡', !probe.tipVisible)
      check('页面背景透明', probe.bodyBg === 'rgba(0, 0, 0, 0)', probe.bodyBg)
      check('鲸鱼图片已渲染', !!probe.imgRect && probe.imgRect.w > 0, JSON.stringify(probe.imgRect))
      check('找到不透明命中点', !!probe.hitPoint, JSON.stringify(probe.hitPoint))
      check('空白处不命中', probe.hitAt0 === false, String(probe.hitAt0))

      // 「点开的下拉弹层」算不算命中 —— 真 Chromium 的 elementFromPoint，
      // jsdom 里的同款断言是桩出来的，覆盖不到真实命中行为。
      // 背景：自绘下拉被 dshwDropOpen() 搬到 <body> 下，白名单漏了它就会出现
      // "点选项点到下层"（HANDOVER-DESKTOP §21）。
      const dropProbe = await overlayWin.webContents.executeJavaScript(`(function () {
        var pt = { x: 340, y: 340 }
        function callHit() {
          try { return window.__dshwHitTest(pt.x, pt.y) } catch (e) { return 'THROW:' + ((e && e.message) || '') }
        }
        var before = callHit()
        var m = document.createElement('div')
        m.className = 'dshwv-rgbmenu dshwv-rgbopen'
        m.style.cssText = 'position:fixed;left:300px;top:300px;width:120px;height:120px;background:#fff'
        var o = document.createElement('div')
        o.className = 'dshwv-rgbopt'
        o.textContent = '纯色'
        m.appendChild(o)
        document.body.appendChild(m)
        var on = callHit()
        document.body.removeChild(m)
        var after = callHit()
        return { before: before, on: on, after: after }
      })()`)
      check('打开的下拉弹层算命中（点得动）', dropProbe.on === true,
        `弹层前=${dropProbe.before} 弹层中=${dropProbe.on} 移除后=${dropProbe.after}`)
      check('弹层移除后回到原判定（无死区）', dropProbe.after === dropProbe.before,
        `前=${dropProbe.before} 后=${dropProbe.after}`)

      // 主触发源：主进程光标轮询 → IPC → 页面胶水，是否真的在跑
      await new Promise((r) => setTimeout(r, 400))
      const cursorCount = await overlayWin.webContents.executeJavaScript('window.__whaleGlueCursorCount || 0')
      check('光标轮询已到达页面', cursorCount > 0, 'count=' + cursorCount)

      // 命中判定 → IPC → 主进程 setIgnore 的完整链路
      if (probe.hitPoint) {
        // ⚠️ 这里不能"派发 → 睡 250ms → 读主进程状态"：**物理鼠标的真实 mousemove**
        //    （forward:true 会把它们送进页面）会在等待期间把状态改写掉 —— 本机实测就是
        //    "自检跑起来时用户正在动鼠标" → 断言随鼠标位置时灵时不灵（拿到 lastIgnore=null）。
        //    改法：① 冻结光标轮询；② 派发与读回放在**同一个同步块**里（DOM 派发是同步的，
        //    中间插不进别的任务）；③ 到主进程这一段只断言"IPC 消息数增加"（单调，干扰不了）。
        //    附带诊断字段（src/xy/direct）是排查这类"判定为什么会变"用的，留着别删。
        const circle = (x, y) => `(function () {
          window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }))
          return { hit: window.__whaleGlueHit, ignore: window.__whaleGlueIgnore, src: window.__whaleGlueLastSrc,
                   xy: window.__whaleGlueLastXY, direct: (function () { try { return window.__dshwHitTest(${x}, ${y}) } catch (e) { return 'THROW' } })() }
        })()`
        freezeCursorPoll = true
        const n0 = ignoreMsgCount
        const onWhale = await overlayWin.webContents.executeJavaScript(circle(probe.hitPoint.x, probe.hitPoint.y))
        check('移到鲸鱼上 → 胶水判定命中（不穿透）', onWhale.direct === true && onWhale.hit === true && onWhale.ignore === false,
          JSON.stringify(onWhale))
        await new Promise((r) => setTimeout(r, 150))

        const onBlank = await overlayWin.webContents.executeJavaScript(circle(2, 2))
        check('移到空白处 → 胶水判定未命中（恢复穿透）', onBlank.direct === false && onBlank.hit === false && onBlank.ignore === true,
          JSON.stringify(onBlank))
        await new Promise((r) => setTimeout(r, 250))
        // 整段只断言"至少有一条 IPC"：盯单步是否发消息会被物理鼠标的同值去抖吃掉
        // （那一步如果状态早就一样，胶水不会重复下发）。两步一合，必定至少切换一次。
        check('判定结果 → IPC → 主进程（通道畅通）', ignoreMsgCount > n0, `整段收到 ${ignoreMsgCount - n0} 条 set-ignore`)
        freezeCursorPoll = false
      }
    } catch (e) {
      check('自检执行异常', false, e && e.message)
    }

    console.log('\n===== 桌面壳自检报告 =====')
    for (const c of report.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.extra ? '  [' + c.extra + ']' : ''}`)
    console.log(`===== 结果：${report.ok ? '全部通过' : '存在失败项'} =====\n`)
    // Windows 上 Electron 的 stdout 有时抓不到，落一份文件做保险
    try {
      fs.writeFileSync(path.join(app.getPath('temp'), 'whale-desktop-selftest.txt'),
        report.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.extra ? '  [' + c.extra + ']' : ''}`).join('\n') +
        `\nRESULT=${report.ok ? 'OK' : 'FAIL'}\n`, 'utf8')
    } catch (e) { console.warn('[desktop] 写入自检报告失败：', e.message) }
    quitting = true
    app.exit(report.ok ? 0 : 1)
  }

  // -------------------------------------------------------------------------
  // 覆盖层窗口
  // -------------------------------------------------------------------------
  function createOverlay(url) {
    const b = screen.getPrimaryDisplay().bounds
    overlayWin = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      transparent: true, frame: false, backgroundColor: '#00000000',
      thickFrame: false, roundedCorners: false, hasShadow: false,
      skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      // 覆盖层不能被用户拖动/缩放，但需要能接收焦点（菜单里的输入框要能打字）
      alwaysOnTop: true, show: false,
      title: APP_DISPLAY_NAME,
      webPreferences: {
        preload: path.join(DESKTOP_DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // 页面里没有任何可输入文本（挂件菜单那点输入框用不到拼写检查），
        // 关掉能省下 Chromium 为拼写检查加载的词典与相关服务。
        spellcheck: false,
        // 挂件会在交互时播提示音；默认策略下未交互前会被拒
        autoplayPolicy: 'no-user-gesture-required',
      },
    })

    overlayWin.setAlwaysOnTop(true, 'screen-saver')
    // 默认全穿透；forward:true 是「穿透时仍能收到 mousemove」的地基
    setIgnore(true)
    overlayWin.once('ready-to-show', () => overlayWin.show())
    overlayWin.on('closed', () => { overlayWin = null })
    overlayWin.webContents.on('render-process-gone', (_e, d) => {
      console.error('[desktop] 渲染进程退出：', d && d.reason)
      if (!quitting) {
        console.warn('[desktop] 尝试重载覆盖层…')
        setTimeout(() => { try { overlayWin && overlayWin.reload() } catch {} }, 1500)
      }
    })
    overlayWin.webContents.on('did-finish-load', () => {
      console.log('[desktop] 覆盖层页面已加载')
      if (SELFTEST) setTimeout(() => runSelfTest(), 2500)
    })
    overlayWin.loadURL(url)

    // 分辨率/主屏变化：跟随铺满
    screen.on('display-metrics-changed', fitToPrimary)
    screen.on('display-added', fitToPrimary)
    screen.on('display-removed', fitToPrimary)
    return overlayWin
  }

  function fitToPrimary() {
    if (!overlayWin || overlayWin.isDestroyed()) return
    try {
      const b = screen.getPrimaryDisplay().bounds
      overlayWin.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
    } catch (e) { console.warn('[desktop] 适配主屏失败：', e.message) }
  }

  function setIgnore(ignore) {
    if (!overlayWin || overlayWin.isDestroyed()) return
    if (ignore === lastIgnore) return
    lastIgnore = ignore
    flog('[main] setIgnoreMouseEvents(' + ignore + ')')
    try { overlayWin.setIgnoreMouseEvents(ignore, { forward: true }) } catch (e) {
      console.warn('[desktop] setIgnoreMouseEvents 失败：', e.message)
    }
  }

  function toggleOverlay() {
    if (!overlayWin || overlayWin.isDestroyed()) return
    if (overlayWin.isVisible()) {
      overlayWin.hide()
      setIgnore(true) // 隐藏时把状态归位，避免下次显示时带着旧值
      lastIgnore = null // 强制下次 show 后重新下发
      setHiddenMode(true)
    } else {
      overlayWin.show()
      lastIgnore = null
      setIgnore(true)
      setHiddenMode(false)
    }
    refreshTrayMenu()
  }

  // 隐藏时允许 Chromium 节流这个渲染进程（定时器降频、少占 CPU/内存），
  // 显示时必须解除，否则 60s 余额刷新与动画会被拖慢。
  // 常见场景：用户把鲸鱼收进托盘挂一整天。
  function setHiddenMode(hidden) {
    if (!overlayWin || overlayWin.isDestroyed()) return
    const wc = overlayWin.webContents
    if (!wc || typeof wc.setBackgroundThrottling !== 'function') return
    try { wc.setBackgroundThrottling(!!hidden) } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------
  ipcMain.on('whale:set-ignore', (_e, ignore) => { ignoreMsgCount++; setIgnore(!!ignore) })
  ipcMain.on('whale:log', (_e, msg) => flog('[renderer] ' + msg))

  // -------------------------------------------------------------------------
  // 光标轮询（穿透判定的**主**触发源）
  // -------------------------------------------------------------------------
  // 为什么不靠 mousemove：窗口处于穿透态时，浏览器侧能否收到 mousemove 取决于
  // Electron 的 forward 实现；一旦收不到，就永远无法把 ignore 切回来，
  // 表现正是"点击总是落到下层"。主进程读光标位置是纯 system call，与窗口是否
  // 穿透无关，因此这里用 ~33ms 轮询兜底：命中判定仍在页面里做（需要 DOM/像素），
  // 主进程只负责把坐标送过去。
  //
  // 省开销：光标**没动**时不重复下发（那多半是在发呆），只保留 ~500ms 一次的
  // 心跳重算（万一挂件在光标静止时被吸附动画挪开，也能在 0.5s 内纠正）。
  // 实测鼠标静止时 IPC 量降到原来的 ~7%。
  const IDLE_HEARTBEAT_MS = 500
  function startCursorPolling() {
    if (cursorTimer) return
    cursorTimer = setInterval(() => {
      if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return
      // 自检期间冻结：物理鼠标位置会盖掉测试注入的合成 mousemove，
      // 让「移到鲸鱼上→取消穿透」这类断言变成"看鼠标当时在哪"的碰运气（本机实测踩过）
      if (freezeCursorPoll) return
      try {
        const b = overlayWin.getBounds()
        const p = screen.getCursorScreenPoint()
        const moved = !lastCursorPt || p.x !== lastCursorPt.x || p.y !== lastCursorPt.y
        if (!moved && Date.now() - lastCursorSentAt < IDLE_HEARTBEAT_MS) return
        lastCursorPt = { x: p.x, y: p.y }
        lastCursorSentAt = Date.now()
        overlayWin.webContents.send('whale:cursor', { x: p.x - b.x, y: p.y - b.y })
      } catch (e) {
        // 窗口正在销毁等瞬时错误：忽略，下一轮继续
      }
    }, 33)
  }

  // -------------------------------------------------------------------------
  // 托盘
  // -------------------------------------------------------------------------
  function loadTrayIcon() {
    const candidates = [
      path.join(PROJECT_ROOT, 'assets', 'DSniang1.png'),
      path.join(PROJECT_ROOT, 'assets', 'DSniang02.png'),
      path.join(DESKTOP_DIR, 'build', 'icon.png'),
    ]
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue
        // 先读字节再 createFromBuffer：哪怕将来改回 asar 打包也不受影响
        const buf = fs.readFileSync(p)
        if (!buf || !buf.length) continue
        const img = nativeImage.createFromBuffer(buf)
        if (img.isEmpty()) continue
        return img.resize({ width: 16, height: 16, quality: 'best' })
      } catch (e) {
        console.warn('[desktop] 托盘图标候选不可用：', p, e.message)
      }
    }
    console.warn('[desktop] 未找到可用的托盘图标')
    return nativeImage.createEmpty()
  }

  function refreshTrayMenu() {
    if (!tray) return
    const visible = !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible())
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: visible ? '隐藏小鲸鱼' : '显示小鲸鱼', click: () => toggleOverlay() },
      { label: '刷新页面', click: () => { try { overlayWin && overlayWin.reload() } catch {} } },
      { type: 'separator' },
      { label: '打开配置文件…', click: () => openPath(CONFIG_PATH) },
      { label: '打开数据目录…', click: () => openPath(DATA_HOME) },
      { label: '打开日志文件…', click: () => openPath(LOG_PATH) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit() } },
    ]))
  }

  function openPath(p) {
    try {
      if (!fs.existsSync(p)) {
        // 有扩展名 → 当文件（如日志）先建空文件；否则当目录
        if (path.extname(p)) fs.writeFileSync(p, '')
        else fs.mkdirSync(p, { recursive: true })
      }
      shell.openPath(p)
    } catch (e) { console.warn('[desktop] 打开路径失败：', e.message) }
  }

  function createTray() {
    const icon = loadTrayIcon()
    if (icon.isEmpty()) {
      console.warn('[desktop] 托盘未创建（图标为空）。仍可用 Alt+Shift+W 显示/隐藏；退出请用任务管理器。')
      return
    }
    try {
      tray = new Tray(icon)
    } catch (e) {
      console.error('[desktop] 托盘创建失败：', e.message)
      return
    }
    tray.setToolTip('DeepSeek 小鲸鱼')
    tray.on('click', () => toggleOverlay())
    refreshTrayMenu()
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------
  app.on('second-instance', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return
    overlayWin.show()
    lastIgnore = null
    setIgnore(true)
    refreshTrayMenu()
  })

  // 托盘常驻：关掉覆盖层不退出
  app.on('window-all-closed', (e) => { e.preventDefault && e.preventDefault() })

  app.on('before-quit', () => { quitting = true })

  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll() } catch {}
    try { srv && srv.close() } catch (e) { console.warn('[desktop] 关闭后端失败：', e.message) }
  })
}

// ---------------------------------------------------------------------------
// 首次启动：把旧的 standalone 数据搬过来（仅开发机上存在，打包后为空操作）
// ---------------------------------------------------------------------------
function migrateLegacyDataOnce(destHome) {
  try {
    if (fs.existsSync(destHome)) return
    const legacy = path.join(PROJECT_ROOT, '.dsh-standalone')
    if (!fs.existsSync(legacy)) return
    fs.mkdirSync(destHome, { recursive: true })
    fs.cpSync(legacy, destHome, { recursive: true })
    console.log('[desktop] 已从旧目录迁移运行时数据：', legacy, '→', destHome)
  } catch (e) {
    console.warn('[desktop] 迁移旧数据失败（忽略）：', e.message)
  }
}
