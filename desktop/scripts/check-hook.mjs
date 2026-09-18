// ============================================================================
// 开发期检查：挂件在桌面壳/独立模式下的两处集成点，用 jsdom 离线跑真脚本断言
// ----------------------------------------------------------------------------
// ① 桌面壳钩子 window.__dshwHitTest 必须可调用
//    它引用的 isWhaleHit / widgetUiHit 是 **dshwInit 的私有函数**。一旦放到
//    dshwInit 之外（例如 IIFE 顶层），调用就是 ReferenceError，而调用方
//    （overlay-glue.js）的 try/catch 会把它吞成"判定不可用" → 挂件永远穿透、
//    点不动，日志里只留一个 hit=null。这个坑踩过一次，做成断言。
// ② 宿主能力 gating：注入 window.__dshwShellCaps={dshSessionEvents:false} 时
//    （独立模式/桌面壳）
//      · 不渲染「每轮消耗提示」行 —— 没有 DSH 会话事件流，它永远不会触发
//      · 不注册每秒一次的 last-turn 轮询 —— 该接口的 seq 恒为 0，纯白发请求
//    DSH 宿主里没有这个全局 → 行为必须与以前完全一致（场景 A 负责守住这点）。
//
// ③ 气泡内容自适应的**居中补偿公式**（纯矩阵运算，与浏览器无关）
//    背景：`.dshwv-text` 用 `transform: translate(-50%,-50%)` 居中，而自适应用的是
//    **独立**变换属性 scale。按 CSS Transforms L2，合成顺序是
//    translate × rotate × scale × transform —— scale 在 transform **外层**，
//    于是那句 -50% 的居中位移也被一起缩放了，元素中心会右移/下移 (w/2)(1-k)。
//    修法是加一个同样外层的 translate 反向补偿。这里用矩阵验算，防止哪天有人
//    "顺手清理"掉那行补偿（症状是内容整体往右偏，很难一眼看出原因）。
//
// 跑法：cd desktop && npm run check:hook     （退出码 0=通过 1=失败 2=缺 jsdom）
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIDGET = path.resolve(DESKTOP_DIR, '..', 'assets', 'whale-widget.js')
const HTML = '<!doctype html><html><body><div id="root"><textarea class="fake-composer"></textarea></div></body></html>'

let JSDOM
let VirtualConsole
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'))
} catch {
  console.error('缺少 jsdom。先执行：cd desktop && npm i -D jsdom')
  process.exit(2)
}

const src = fs.readFileSync(WIDGET, 'utf8')
const lines = []
let ok = true
const check = (name, pass, extra) => {
  lines.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
  if (!pass) ok = false
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个 jsdom，把挂件脚本真跑一遍，并记录它发出的所有 fetch URL */
function runWidget(caps, setup) {
  // 静音 jsdom 的 "Not implemented"（Audio.play/pause 之类）：那是桩环境限制，
  // 不是脚本错误，但混在输出里极易被误读成检查失败。页面自身的 console.* 照常打印。
  const vc = new VirtualConsole()
  // jsdom 新版把 sendTo 改名成了 forwardTo；`omitJSDOMErrors`（旧）/ `jsdomErrors:'none'`（新）都兜一下
  const opts = { omitJSDOMErrors: true, jsdomErrors: 'none' }
  if (typeof vc.forwardTo === 'function') vc.forwardTo(console, opts)
  else if (typeof vc.sendTo === 'function') vc.sendTo(console, opts)
  const dom = new JSDOM(HTML, { url: 'http://127.0.0.1:3082/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc })
  const w = dom.window
  const d = w.document
  const calls = []

  // jsdom 缺失的 API 补最小桩
  if (!d.elementFromPoint) d.elementFromPoint = () => null
  w.fetch = (u) => {
    calls.push(String(u))
    // api-models.json 要给真结构：模型面板要用它填厂商下拉，
    // 否则「+ 添加模型」会因拿不到模板而走"先拉取"分支，测试就测不到面板本身了
    if (String(u).indexOf('api-models.json') !== -1) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          ok: true, builtinId: 'deepseek',
          models: [{
            id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', currency: 'CNY',
            keyRef: 'DEEPSEEK_API_KEY', builtin: true, hasKey: true,
            balance: 16.89, todayUsage: 5.82, usageSource: 'official', balanceMode: 'api',
          }],
          templates: [{
            id: 'openrouter', name: 'OpenRouter', currency: 'USD', keyRef: 'OPENROUTER_API_KEY',
            builtin: false, hasBalance: true, needsBaseUrl: false, kind: 'balance',
            balance: { url: 'https://openrouter.ai/api/v1/credits', auth: 'Bearer {key}', json: { remaining: 'data.total_credits' } },
            quota: null, matchIds: [], noBalanceApi: false, apiNote: '', sortKey: 'openrouter',
          }],
        }),
      })
    }
    return Promise.reject(new Error('stub fetch'))
  }
  if (!w.matchMedia) {
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
  }
  w.scrollTo = () => {}
  if (caps) w.__dshwShellCaps = caps
  if (setup) setup(w, d)

  let evalErr = ''
  try { w.eval(src) } catch (e) { evalErr = (e && e.name) + ': ' + (e && e.message) }
  return { w, d, calls, evalErr }
}

// ---------------------------------------------------------------- 场景 A：DSH 式（无 caps）
const A = runWidget(null)
check('A/无 caps：脚本执行无异常', !A.evalErr, A.evalErr || 'ok')
check('A/无 caps：dshwInit 已跑起来', A.w.__dshWhaleInit === true)
check('A/无 caps：挂件根节点已挂载', !!A.d.querySelector('.dshwv-root'))
const aMenu = A.d.body.textContent || ''
check('A/无 caps：菜单保留「每轮消耗提示」', aMenu.indexOf('每轮消耗提示') !== -1)
await sleep(1400)
const aLastTurn = A.calls.filter((u) => u.indexOf('last-turn') !== -1).length
check('A/无 caps：last-turn 轮询仍在跑', aLastTurn >= 1, aLastTurn + ' 次')
try { A.w.close() } catch {}

// ---------------------------------------------------------------- 场景 B：桌面壳（注入 caps）
const B = runWidget({ dshSessionEvents: false, host: 'standalone' })
check('B/有 caps：脚本执行无异常', !B.evalErr, B.evalErr || 'ok')
check('B/有 caps：挂件根节点已挂载', !!B.d.querySelector('.dshwv-root'))
const bMenu = B.d.body.textContent || ''
check('B/有 caps：菜单已隐藏「每轮消耗提示」', bMenu.indexOf('每轮消耗提示') === -1)
check('B/有 caps：无 DSH 会话事件 → 钩子仍注册', typeof B.w.__dshwHitTest === 'function', typeof B.w.__dshwHitTest)
await sleep(2400)
const bLastTurn = B.calls.filter((u) => u.indexOf('last-turn') !== -1).length
check('B/有 caps：last-turn 轮询已关闭', bLastTurn === 0, bLastTurn + ' 次')

// 对照组 / 钩子作用域断言（放在最后，用场景 B 的实例）
B.w.eval('window.__ctrlOutOfScope = function () { return isWhaleHit({}) }')
let ctrlErr = ''
try { B.w.__ctrlOutOfScope({}) } catch (e) { ctrlErr = (e && e.name) + ': ' + (e && e.message) }
check('对照组能识别作用域外引用', ctrlErr.indexOf('ReferenceError') === 0, ctrlErr || '居然没抛错')

if (typeof B.w.__dshwHitTest === 'function') {
  let threw = ''
  const res = []
  for (const [x, y] of [[10, 10], [1900, 1000], [1800, 950], [960, 516]]) {
    try { res.push(`(${x},${y})=${String(B.w.__dshwHitTest(x, y))}`) } catch (e) { threw = (e && e.name) + ': ' + (e && e.message); res.push(`(${x},${y})=THROW`) }
  }
  check('钩子调用不抛错（作用域正确）', !threw, threw || res.join(' '))
}
try { B.w.close() } catch {}

const sample = B.calls.filter((u) => u.indexOf('last-turn') === -1).map((u) => u.replace(/^https?:\/\/[^/]+/, ''))
lines.push('（场景 B 实际发出的请求：' + (sample.join(', ') || '无') + '）')

// ------------------------------------------------ 气泡居中补偿公式（矩阵验算）
{
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ]
  const T = (x, y) => [1, 0, 0, 1, x, y]
  const S = (x, y) => [x, 0, 0, y, 0, 0]
  const at = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
  // 元素中心经完整变换后的落点（相对锚点）：0 表示仍精确居中
  const centre = (w, h, k, compensate, flip) => {
    const o = [w / 2, h / 2]
    let css = T(-w / 2, -h / 2)
    if (flip) css = mul(css, S(-1, 1))
    const tx = compensate ? -(1 - k) * (w / 2) : 0
    const ty = compensate ? -(1 - k) * (h / 2) : 0
    // M = T(origin) · translate · rotate · scale · transform · T(-origin)
    let m = mul(T(o[0], o[1]), T(tx, ty))
    m = mul(m, S(k, k))
    m = mul(m, css)
    m = mul(m, T(-o[0], -o[1]))
    return at(m, [w / 2, h / 2])
  }
  const eps = 1e-9
  let rawShiftSeen = false
  let fixedOk = true
  for (const [w, h, k] of [[677, 448, 1], [560, 376, 0.905], [677, 448, 0.75], [677, 448, 0.5]]) {
    for (const flip of [false, true]) {
      const raw = centre(w, h, k, false, flip)
      const fixed = centre(w, h, k, true, flip)
      if (k < 1 && (Math.abs(raw[0]) > 1 || Math.abs(raw[1]) > 1)) rawShiftSeen = true
      if (Math.abs(fixed[0]) > eps || Math.abs(fixed[1]) > eps) fixedOk = false
    }
  }
  check('不补偿时确实会偏移（说明这个坑存在）', rawShiftSeen)
  check('补偿后中心精确归零（含左吸附镜像）', fixedOk)
}

// ---------------------------------------- 「+ 添加模型」必须真的能打开面板
// 踩过一次：面板里写 `if (m.builtin)`，而**新增模型时 m 是 null** → TypeError 被
// 外层 try/catch 吞掉 → 面板根本没 append（表现为"点添加模型没反应"）。这类错误
// 在真机上极难看出原因，所以这里用 jsdom 真点一次按钮来兜住。
{
  const C = runWidget(null)
  await sleep(60)
  const findBtn = (txt) => [...C.d.querySelectorAll('button')].find((b) => (b.textContent || '').indexOf(txt) !== -1)
  let err = ''
  try {
    const usageBtn = findBtn('小鲸鱼记账')
    if (!usageBtn) throw new Error('没找到记账入口按钮')
    usageBtn.click()
    await sleep(60)
    const addBtn = findBtn('添加模型')
    if (!addBtn) throw new Error('没找到「+ 添加模型」按钮')
    addBtn.click()
    await sleep(80)
  } catch (e) { err = (e && e.message) || String(e) }
  check('点「+ 添加模型」不抛错', !err, err || 'ok')
  const masks = [...C.d.querySelectorAll('.dshwv-usage-mask')]
  const last = masks.length ? masks[masks.length - 1] : null
  const cardTxt = last ? (last.textContent || '') : ''
  const allTxt = C.d.body.textContent || ''
  lines.push('（诊断：mask 数=' + masks.length + ' 末个文字=[' + cardTxt.slice(0, 30) + '] 含OpenRouter=' +
    (allTxt.indexOf('OpenRouter') !== -1) + ' 含新增模型=' + (allTxt.indexOf('新增模型') !== -1) + '）')
  check('新增模型面板确实打开了', allTxt.indexOf('新增模型') !== -1,
    'mask数=' + masks.length + ' 末个=[' + cardTxt.slice(0, 20) + ']')
  try { C.w.close() } catch {}
}

// -------------------------------- 弹出下拉（被搬到 body 的弹层）必须算作命中
// 踩过一次：dshwDropOpen() 把自绘下拉搬到 <body> 下（fixed，避免被滚动容器裁剪），
// 而命中白名单 widgetUiHit() 里只列了「面板内」的元素 → 光标一进弹层就判未命中 →
// 覆盖层整窗穿透 → 点选项"点到下层"，下拉框像坏了一样（用户实测截图 2026-09-18）。
// 这里用手工构造的弹层断言白名单契约（真实弹层同样是 .dshwv-rgbmenu > .dshwv-rgbopt）。
{
  const D = runWidget({ dshSessionEvents: false, host: 'standalone' })
  await sleep(60)

  const mkMenu = (hidden) => {
    const m = D.d.createElement('div')
    m.className = 'dshwv-rgbmenu dshwv-qcolmenu' + (hidden ? '' : ' dshwv-rgbopen')
    m.style.position = 'fixed'
    m.style.left = '0px'
    m.style.top = '0px'
    m.style.width = '120px'
    m.style.height = '120px'
    const o = D.d.createElement('div')
    o.className = 'dshwv-rgbopt'
    o.textContent = '✓ 纯色'
    m.appendChild(o)
    D.d.body.appendChild(m)
    return o
  }
  const hitWith = (el) => {
    D.d.elementFromPoint = () => el
    try { return D.w.__dshwHitTest(400, 400) } catch (e) { return 'THROW:' + e.message }
  }

  const openOpt = mkMenu(false)
  check('D/打开的下拉弹层（位于 body 下）判定命中', hitWith(openOpt) === true, String(hitWith(openOpt)))
  // 「?」占位符说明/悬浮提示浮层：同样挂在 body 下，同样是可点浮层
  const help = D.d.createElement('div')
  help.className = 'dshwv-tplhelp'
  help.style.display = 'block'
  D.d.body.appendChild(help)
  check('D/「?」说明浮层（位于 body 下）判定命中', hitWith(help) === true, String(hitWith(help)))
  // 对照组 1：同一位置的普通 body 元素 → 必须未命中（否则整屏变"看不见却吃鼠标"的死区）
  const plain = D.d.createElement('div')
  D.d.body.appendChild(plain)
  check('D/对照组：普通元素未命中', hitWith(plain) === false, String(hitWith(plain)))
  // 对照组 2：关着的弹层（display:none）→ 未命中
  const hid = mkMenu(true)
  check('D/对照组：关闭态弹层未命中', hitWith(hid) === false, String(hitWith(hid)))
  try { D.w.close() } catch {}
}

// ---------------------- 点鲸鱼：余额强制刷新一次 + 2.5s 后补取一次（当天官方账单）
// 契约：点鲸鱼 → balance.json?force=1（后端顺带拉当日官方账单，平台侧 20s 冷却）
//       → 2.5s 后再取一次**不带 force** 的 balance.json，把刚拉到的今日账单显示出来。
// 真点鲸鱼需要 isWhaleHit 为真：jsdom 里命中图加载不出来，这里让 probe 走 onerror
// （命中判定退回图像矩形），并把 .dshwv-img 的矩形桩成非零值。
{
  const RECT = { left: 900, top: 700, right: 1500, bottom: 1300, width: 600, height: 600, x: 900, y: 700 }
  const E = runWidget({ dshSessionEvents: false, host: 'standalone' }, (w) => {
    class FakeImage {
      constructor() { this.onload = null; this.onerror = null; this.width = 610; this.height = 610 }
      set src(v) { this._src = v; setTimeout(() => { try { this.onerror && this.onerror() } catch (e) {} }, 0) }
      get src() { return this._src }
    }
    w.Image = FakeImage
    w.Element.prototype.getBoundingClientRect = function () {
      if (this.classList && this.classList.contains('dshwv-img')) return RECT
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
    }
  })
  await sleep(120)
  const mk = (type, x, y) => new E.w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 })
  const base = E.calls.length
  E.d.dispatchEvent(mk('pointerdown', 1200, 1000))
  E.d.dispatchEvent(mk('pointerup', 1200, 1000))
  await sleep(60)
  const afterClick = E.calls.slice(base)
  check('E/点鲸鱼 → 余额强制刷新（force=1）', afterClick.some((u) => u.indexOf('balance.json?force=1') !== -1),
    afterClick.join(', ') || '没有发出任何 balance 请求')
  await sleep(3000)
  const afterFollow = E.calls.slice(base)
  check('E/点鲸鱼后补取一次今日账单（无 force 的第二次）',
    afterFollow.filter((u) => u.indexOf('balance.json') !== -1).length >= 2 && afterFollow.some((u) => u.indexOf('balance.json') !== -1 && u.indexOf('force=1') === -1),
    afterFollow.filter((u) => u.indexOf('balance.json') !== -1).join(', '))
  try { E.w.close() } catch {}
}

console.log('===== 挂件桌面集成检查（jsdom 离线）=====')
for (const l of lines) console.log(l)
console.log(`===== 结果：${ok ? '通过' : '不通过'} =====`)
process.exit(ok ? 0 : 1)
