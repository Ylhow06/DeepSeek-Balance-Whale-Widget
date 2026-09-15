// ============================================================================
// 独立模式启动器（脱离 DSH 宿主运行小鲸鱼挂件）
// ============================================================================
// 原理：lib/index.js 是 DSH bundle，靠 `inject: ['webServer','credentials',
// 'connection']` + `apply(ctx)` 挂在 DSH 运行时上。本文件伪造一个最小 ctx，
// 把这些宿主能力用 Node http + 本地配置替掉，核心 lib 代码一行不改。
//
//   ctx.webServer.register(route) → 挂进本文件的 node:http 路由表
//   ctx.webServer.tapIndex(fn)    → no-op（独立模式自带 index.html）
//   ctx.credentials.resolve(name) → 读配置文件的 credentials
//   ctx.on('session/event')       → no-op（拿不到 DSH 会话流；余额差记账仍可用）
//
// 两种用法：
//   1) CLI：  node standalone/server.js        → http://127.0.0.1:3081
//   2) 被引： import { start } from './server.js'
//            const srv = await start({ port: 0 })   // 动态端口，electron 壳用这路
//            // srv = { port, url, close() }
//
// 环境变量（Electron 桌面壳全部依赖这几个，见 HANDOVER-DESKTOP.md §4 Phase 0）：
//   DSH_STANDALONE_HOME     运行时数据目录（默认 <repo>/.dsh-standalone）
//   DSH_STANDALONE_CONFIG   配置文件路径（默认 <standalone>/config.json）
//   DSH_STANDALONE_OVERLAY  =1 时进入「桌面覆盖层」模式：
//                             去掉提示卡、页面背景设为透明（配合透明窗口）
// ============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'

const STANDALONE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(STANDALONE_DIR, '..')

// 配置路径可覆盖：打包进 asar 后脚本同级目录只读，必须能指到 userData
const CONFIG_PATH = process.env.DSH_STANDALONE_CONFIG || path.join(STANDALONE_DIR, 'config.json')
const CONFIG_EXAMPLE_PATH = path.join(STANDALONE_DIR, 'config.example.json')
const OVERLAY_MODE = process.env.DSH_STANDALONE_OVERLAY === '1'

// ---- 配置（key 走配置文件，不依赖 DSH 凭据 vault）----
// 配置文件不存在时从模板复制一份（Electron 首次启动在 userData 落地）
function ensureConfigFile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return
    if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
      fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH)
    }
  } catch (e) {
    console.warn('[standalone] 初始化配置文件失败：', e.message)
  }
}

function loadConfig() {
  const defaults = { host: '127.0.0.1', port: 3081, credentials: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return {
      ...defaults,
      ...raw,
      credentials: { ...defaults.credentials, ...(raw.credentials || {}) },
    }
  } catch {
    return defaults
  }
}
ensureConfigFile()
const cfg = loadConfig()
function persistConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (e) {
    console.warn('[standalone] 配置写回失败：', e.message)
  }
}

// ---- 伪造 DSH 宿主 ctx ----
const routes = new Map() // path -> handler
const effectDisposers = []
const noop = () => {}

const ctx = {
  webServer: {
    register(route) {
      const handler = route && route.handler
      const p = route && route.path
      if (p && handler) {
        routes.set(p, handler)
        return () => { if (routes.get(p) === handler) routes.delete(p) }
      }
      return noop
    },
    // 独立模式自带 index.html，不需要 DSH 把 widget.js 注入每个页面
    tapIndex() { return noop },
  },
  credentials: {
    // 注意：lib 期望 resolve 返回 { value } 记录对象（见 lib/index.js `cred.value`），
    // 而不是裸字符串 —— 返回裸字符串会让 `cred.value` 为 undefined，
    // 拼出 "Bearer undefined"，余额请求 401。
    resolve: async (name) => (name && cfg.credentials[name]) ? { value: String(cfg.credentials[name]) } : '',
    set: async (name, value) => {
      if (!name) return
      cfg.credentials[name] = String(value || '')
      persistConfig()
    },
    unset: async (name) => {
      if (name && Object.prototype.hasOwnProperty.call(cfg.credentials, name)) {
        delete cfg.credentials[name]
        persistConfig()
      }
    },
    deleteRecord: async (name) => {
      if (name && Object.prototype.hasOwnProperty.call(cfg.credentials, name)) {
        delete cfg.credentials[name]
        persistConfig()
      }
    },
  },
  get(key) {
    if (key === 'credentials') return ctx.credentials
    if (key === 'webServer') return ctx.webServer
    return undefined // connection 等本地没有 → 信任栅栏 fail-open 放行
  },
  connection: undefined, // 本地无浏览器信任栅栏；接口仅绑 127.0.0.1
  on() {
    // 无 DSH 会话事件流：失去「每轮消耗」的会话兜底，但余额差记账仍可用
    return noop
  },
  effect(fn) {
    let d
    try { d = fn() } catch {}
    if (typeof d === 'function') effectDisposers.push(d)
    return noop
  },
}

// ---- 惰性初始化：先定 DSH_HOME，再动态 import 核心 lib ----
// （lib/index.js 顶层就读 process.env.DSH_HOME，必须先设好，
//   否则运行时数据会写进真实 ~/.dsh）
let _home = null
let _initPromise = null

function ensureHome() {
  if (_home) return _home
  _home = process.env.DSH_STANDALONE_HOME || path.join(PROJECT_ROOT, '.dsh-standalone')
  try { fs.mkdirSync(_home, { recursive: true }) } catch {}
  process.env.DSH_HOME = _home
  return _home
}

function ensurePlugin() {
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    ensureHome()
    const plugin = (await import(pathToFileURL(path.join(PROJECT_ROOT, 'lib', 'index.js')).href)).default
    try {
      plugin.apply(ctx)
    } catch (e) {
      console.error('[standalone] 插件 apply 失败：', e)
    }
    return plugin
  })()
  return _initPromise
}

// ---- index.html（伪造聊天界面：#root 含一个隐藏 composer，让挂件自检通过）----
function buildIndexHtml() {
  const keySet = Boolean(cfg.credentials['DEEPSEEK_API_KEY'])
  const platSet = Boolean(cfg.credentials['DEEPSEEK_PLATFORM_TOKEN'])

  // 覆盖层模式：桌面壳是「全屏透明窗口」，页面只要有一块不透明底就会糊住整个桌面。
  const pageBg = OVERLAY_MODE ? 'transparent' : '#f5f6fa'
  // 覆盖层模式额外加载桌面壳胶水（鼠标穿透开关的翻译层）
  const glueTag = OVERLAY_MODE ? '\n<script defer src="' + SHELL_GLUE_ROUTE + '"></script>' : ''
  // 宿主能力声明：独立模式（含桌面壳）没有 DSH 会话事件流 →
  // last-turn.json 的 seq 恒为 0，挂件据此不渲染「每轮消耗提示 / 任务结束音效」
  // 并关掉每秒一次的 last-turn 轮询。必须排在 widget.js 之前。
  const capsTag = '\n<script>window.__dshwShellCaps={dshSessionEvents:false,host:"standalone"};</script>'
  const tipBlock = OVERLAY_MODE ? '' : `
<div class="tip">
  <h1>小鲸鱼 · 独立运行</h1>
  <div class="k">已脱离 DSH 宿主，由本地 Node 服务提供后端。</div>
  <div class="k" style="margin-top:6px">DeepSeek API Key：
    <span class="${keySet ? 'ok' : 'no'}">${keySet ? '已配置' : '未配置（余额将显示「—」）'}</span>
  </div>
  <div class="k" style="margin-top:6px">平台登录态 userToken：
    <span class="${platSet ? 'ok' : 'no'}">${platSet ? '已配置' : '未配置（消费历史不可用）'}</span>
  </div>
  <div class="k" style="margin-top:6px">右下角的小鲸鱼即挂件本体。改
    <b>standalone/config.json</b> 的 credentials 后重启本服务即可换 key。</div>
</div>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek 小鲸鱼 · 独立模式</title>
<style>
  html,body { margin:0; height:100%; background:${pageBg}; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .tip { position:fixed; top:12px; left:12px; z-index:9999; max-width:300px;
    background:#fff; border:1px solid #e2e5ea; border-radius:10px; padding:12px 14px;
    box-shadow:0 1px 4px rgba(0,0,0,.08); font-size:13px; color:#333; line-height:1.6; }
  .tip h1 { font-size:14px; font-weight:600; margin:0 0 6px; color:#111; }
  .tip .k { font-size:12px; color:#666; }
  .tip .ok { color:#0a7d3b; } .tip .no { color:#c0392b; }
  .fake-root { position:fixed; inset:0; }
  textarea.fake-composer { position:absolute; left:-9999px; top:-9999px; width:0; height:0; opacity:0; border:0; }
</style>
</head>
<body>${tipBlock}
<div id="root" class="fake-root">
  <textarea class="fake-composer" aria-hidden="true" tabindex="-1"></textarea>
</div>
${capsTag}
<script defer src="/dsh-whale/widget.js"></script>${glueTag}
</body>
</html>`
}

function serveIndex(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(buildIndexHtml())
}

// ---- 桌面壳胶水（覆盖层模式下由页面直接 <script> 加载）----
// 为什么要它走 HTTP 而不是 preload 注入：contextIsolation 下 preload 在隔离世界，
// 往页面注入内联 <script> 存在时序/世界归属的不确定性；直接作为页面自己的脚本
// 加载则 100% 在主世界、且一定早于挂件的初始化完成。详见 HANDOVER-DESKTOP.md §11.3。
const SHELL_GLUE_PATH = path.join(PROJECT_ROOT, 'desktop', 'overlay-glue.js')
const SHELL_GLUE_ROUTE = '/dsh-whale-shell/glue.js'
function serveShellGlue(res) {
  try {
    const src = fs.readFileSync(SHELL_GLUE_PATH, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(src)
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('shell glue not found: ' + e.message)
  }
}

// ---- HTTP 服务 ----
const server = http.createServer((req, res) => {
  let pathname
  try { pathname = new URL(req.url, 'http://localhost').pathname } catch { pathname = req.url }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveIndex(res)
  }
  if (req.method === 'GET' && pathname === SHELL_GLUE_ROUTE) {
    return serveShellGlue(res)
  }
  // 容错：路由按精确路径注册，若调用方误写尾部斜杠（如 /x.json/?q=1）会 miss 成 404。
  // 这里先按原样查，miss 后再去掉尾部斜杠查一次（不改动已注册的键）。
  let handler = routes.get(pathname)
  if (!handler && typeof pathname === 'string' && pathname.length > 1 && pathname.endsWith('/')) {
    handler = routes.get(pathname.replace(/\/+$/, ''))
  }
  if (handler) {
    try {
      handler(req, res)
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('handler error: ' + e.message)
    }
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

// ---- 启动 / 停止 ----
let _listenInfo = null
let _starting = null

/**
 * 启动 HTTP 服务（幂等：重复调用返回同一实例信息）。
 * @param {{host?:string, port?:number, quiet?:boolean}} [opts]
 *        port 传 0 → 由系统分配空闲端口（根除 EADDRINUSE）
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export async function start(opts = {}) {
  if (_listenInfo) return _listenInfo
  if (_starting) return _starting
  _starting = (async () => {
    await ensurePlugin()
    const host = opts.host || cfg.host || '127.0.0.1'
    const port = opts.port != null ? Number(opts.port) : (Number(cfg.port) || 3081)
    await new Promise((resolve, reject) => {
      const onError = (e) => reject(e)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
    const actual = server.address().port
    const info = {
      port: actual,
      url: `http://${host}:${actual}`,
      home: ensureHome(),
      configPath: CONFIG_PATH,
      close: () => new Promise((r) => {
        _listenInfo = null
        _starting = null
        if (!server.listening) return r()
        server.close(() => r())
      }),
    }
    _listenInfo = info
    if (!opts.quiet) {
      console.log('[standalone] 小鲸鱼独立模式已启动')
      console.log(`[standalone] 打开 ${info.url}`)
      console.log(`[standalone] 运行时数据目录：${info.home}`)
      console.log(`[standalone] 配置文件：${CONFIG_PATH}`)
      if (!cfg.credentials['DEEPSEEK_API_KEY']) {
        console.log('[standalone] 提示：DEEPSEEK_API_KEY 未配置，余额将显示「—」。' +
          '请在配置文件 credentials 里填入后重启。')
      }
    }
    return info
  })()
  try {
    return await _starting
  } catch (e) {
    _starting = null
    throw e
  }
}

export { CONFIG_PATH, OVERLAY_MODE, ensureConfigFile }
export const configPath = () => CONFIG_PATH
export const runtimeHome = () => ensureHome()
export const routeCount = () => routes.size

// ---- CLI：node standalone/server.js 照常直接起服务（行为不变）----
function isCliEntry() {
  try {
    const argv1 = process.argv[1]
    if (!argv1) return false
    return path.resolve(argv1) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isCliEntry()) {
  start().catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('[standalone] 端口被占用（多为上一次的 node 进程没退干净）。')
      console.error('[standalone] 处理：netstat -ano | Select-String \':<port>\\s+.*LISTENING\' 拿 PID → Stop-Process -Id <pid> -Force')
    } else {
      console.error('[standalone] 启动失败：', e)
    }
    process.exit(1)
  })
}
