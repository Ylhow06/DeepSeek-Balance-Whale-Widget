// ============================================================================
// 开发期检查：挂件里的桌面壳钩子 window.__dshwHitTest 是否真的可调用
// ----------------------------------------------------------------------------
// 为什么需要它：这个钩子引用的 isWhaleHit / widgetUiHit 是 **dshwInit 的私有函数**。
// 一旦把它放到 dshwInit 之外（例如 IIFE 顶层），调用时就是
// `ReferenceError: isWhaleHit is not defined` —— 而调用方（overlay-glue.js）
// 的 try/catch 会把它吞成"判定不可用"，表现为**挂件永远穿透、点不动**，
// 且日志里只留一个 hit=null，非常难定位。本脚本把这一步做成离线断言。
//
// 跑法（需先装 jsdom，仅开发用，不进 dependencies）：
//   cd desktop && npm i -D jsdom && npm run check:hook
// 退出码：0 = 通过；1 = 不通过（钩子缺失/调用抛错/挂在鲸鱼上仍不命中）
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WIDGET = path.resolve(DESKTOP_DIR, '..', 'assets', 'whale-widget.js')

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

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"><textarea class="fake-composer"></textarea></div></body></html>',
  { url: 'http://127.0.0.1:3082/', runScripts: 'outside-only', pretendToBeVisual: true },
)
const { window } = dom
const doc = window.document

// jsdom 缺失的 API 补最小桩，避免噪声干扰结论
if (!doc.elementFromPoint) doc.elementFromPoint = () => null
window.fetch = () => Promise.reject(new Error('no fetch in jsdom'))
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
}
window.scrollTo = () => {}

// 对照组：在窗口作用域直接引用私有函数 —— 复现"钩子放错作用域"的失败模式。
// 它必须抛 ReferenceError，否则说明本测试没有识别该 bug 的能力（假 PASS 防护）。
window.eval('window.__ctrlOutOfScope = function () { return isWhaleHit({}) }')
let ctrlErr = ''
try { window.__ctrlOutOfScope({}) } catch (e) { ctrlErr = (e && e.name) + ': ' + (e && e.message) }
check('对照组能识别作用域外引用', ctrlErr.indexOf('ReferenceError') === 0, ctrlErr || '居然没抛错')

try {
  window.eval(src)
} catch (e) {
  check('执行挂件脚本', false, e.name + ': ' + e.message)
}

check('window.__dshwHitTest 已注册', typeof window.__dshwHitTest === 'function', typeof window.__dshwHitTest)
check('挂件根节点已挂载（jsdom 里也应能初始化）', !!doc.querySelector('.dshwv-root'))

if (typeof window.__dshwHitTest === 'function') {
  // 逐点调用：必须"不抛错"。jsdom 里图片永远加载不出来，
  // 所以返回 false 是正确答案；true 的情形由 Electron 的 --selftest 覆盖。
  let threw = ''
  const results = []
  for (const [x, y] of [[10, 10], [1900, 1000], [1800, 950], [960, 516]]) {
    try {
      results.push(`(${x},${y})=${String(window.__dshwHitTest(x, y))}`)
    } catch (e) {
      threw = (e && e.name) + ': ' + (e && e.message)
      results.push(`(${x},${y})=THROW`)
    }
  }
  check('调用不抛错（作用域正确）', !threw, threw || results.join(' '))
}

console.log('===== 桌面壳钩子检查（jsdom 离线）=====')
for (const l of lines) console.log(l)
console.log(`===== 结果：${ok ? '通过' : '不通过'} =====`)
process.exit(ok ? 0 : 1)
