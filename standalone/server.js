// ============================================================================
// 独立模式启动器（脱离 DSH 宿主运行小鲸鱼挂件）
// ============================================================================
// 原理：lib/index.js 是 DSH bundle，靠 `inject: ['webServer','credentials',
// 'connection']` + `apply(ctx)` 挂在 DSH 运行时上。本文件伪造一个最小 ctx，
// 把这些宿主能力用 Node http + 本地配置替掉，核心 lib 代码一行不改。
//
//   ctx.webServer.register(route) → 挂进本文件的 node:http 路由表
//   ctx.webServer.tapIndex(fn)    → no-op（独立模式自带 index.html）
//   ctx.credentials.resolve(name) → 读 standalone/config.json 的 credentials
//   ctx.on('session/event')       → no-op（拿不到 DSH 会话流；余额差记账仍可用）
//
// 启动：
//   node standalone/server.js
// 然后浏览器打开 http://127.0.0.1:3080
// ============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'

const STANDALONE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(STANDALONE_DIR, '..')
const CONFIG_PATH = path.join(STANDALONE_DIR, 'config.json')

// ---- 配置（key 走配置文件，不依赖 DSH 凭据 vault）----
function loadConfig() {
  const defaults = { host: '127.0.0.1', port: 3080, credentials: {} }
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
const cfg = loadConfig()
function persistConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (e) {
    console.warn('[standalone] 配置写回失败：', e.message)
  }
}

// ---- 隔离运行时数据目录（默认 $DSH_HOME 会落 ~/.dsh，污染真实 DSH）----
const DSH_HOME = process.env.DSH_STANDALONE_HOME || path.join(PROJECT_ROOT, '.dsh-standalone')
try { fs.mkdirSync(DSH_HOME, { recursive: true }) } catch {}
process.env.DSH_HOME = DSH_HOME

// 动态 import：确保 DSH_HOME 已生效（lib 顶层才读取）
const plugin = (await import(pathToFileURL(path.join(PROJECT_ROOT, 'lib', 'index.js')).href)).default

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

try {
  plugin.apply(ctx)
} catch (e) {
  console.error('[standalone] 插件 apply 失败：', e)
}

// ---- index.html（伪造聊天界面：#root 含一个隐藏 composer，让挂件自检通过）----
function serveIndex(res) {
  const keySet = Boolean(cfg.credentials['DEEPSEEK_API_KEY'])
  const platSet = Boolean(cfg.credentials['DEEPSEEK_PLATFORM_TOKEN'])
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek 小鲸鱼 · 独立模式</title>
<style>
  html,body { margin:0; height:100%; background:#f5f6fa; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
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
<body>
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
</div>
<div id="root" class="fake-root">
  <textarea class="fake-composer" aria-hidden="true" tabindex="-1"></textarea>
</div>
<script defer src="/dsh-whale/widget.js"></script>
</body>
</html>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

// ---- HTTP 服务 ----
const server = http.createServer((req, res) => {
  let pathname
  try { pathname = new URL(req.url, 'http://localhost').pathname } catch { pathname = req.url }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveIndex(res)
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

const host = cfg.host || '127.0.0.1'
const port = Number(cfg.port) || 3080
server.listen(port, host, () => {
  console.log('[standalone] 小鲸鱼独立模式已启动')
  console.log(`[standalone] 打开 http://${host}:${port}`)
  console.log(`[standalone] 运行时数据目录：${DSH_HOME}`)
  if (!cfg.credentials['DEEPSEEK_API_KEY']) {
    console.log('[standalone] 提示：DEEPSEEK_API_KEY 未配置，余额将显示「—」。' +
      '请在 standalone/config.json 的 credentials 里填入后重启。')
  }
})
