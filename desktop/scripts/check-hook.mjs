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
try {
  ({ JSDOM } = await import('jsdom'))
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
function runWidget(caps) {
  const dom = new JSDOM(HTML, { url: 'http://127.0.0.1:3082/', runScripts: 'outside-only', pretendToBeVisual: true })
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

console.log('===== 挂件桌面集成检查（jsdom 离线）=====')
for (const l of lines) console.log(l)
console.log(`===== 结果：${ok ? '通过' : '不通过'} =====`)
process.exit(ok ? 0 : 1)
