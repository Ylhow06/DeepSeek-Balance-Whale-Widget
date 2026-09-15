// ============================================================================
// 桌面壳胶水 —— 鼠标穿透开关的「翻译层」
// ----------------------------------------------------------------------------
// **运行在页面主世界**，由覆盖层页面以 <script defer src="/dsh-whale-shell/glue.js">
// 直接加载（不再由 preload 注入内联脚本）。唯一职责：
//     光标落点 → 是否命中（鲸鱼不透明像素 / 已打开的菜单面板）→ 窗口是否穿透
//        命中   → setIgnore(false)：窗口接管鼠标，鲸鱼可点可拖、菜单可操作
//        未命中 → setIgnore(true) ：点击落到下层桌面/其它窗口
//
// 两个触发源（互为兜底，都汇入同一个 applyIgnore，带同值去抖，不会打架）：
//   ① 主进程光标轮询（whale:cursor，~33ms）—— 不依赖 Electron 的 mousemove 转发。
//      "点击总是落到下层"最可能的失效点就是转发没生效，故把它作为**主**触发源。
//   ② 本地 mousemove —— 转发正常时延迟更低。
//
// 依赖：
//   window.__dshwHitTest(x, y)   ← assets/whale-widget.js 末尾的附加式钩子
//   window.__whaleShell          ← desktop/preload.cjs 经 contextBridge 暴露
// 两者缺一 → 本脚本静默退出（例如在普通浏览器里打开独立模式）。
// ============================================================================

;(function () {
  var shell = window.__whaleShell
  if (!shell || typeof shell.setIgnore !== 'function') {
    try { console.log('[whale-glue] 未发现 __whaleShell，胶水不启用（非桌面壳环境）') } catch (e) {}
    return
  }
  if (window.__whaleGlueInstalled) return
  window.__whaleGlueInstalled = true

  var lastIgnore = null   // 已下发给主进程的穿透状态
  var pressed = false     // 按住鼠标期间强制接管：否则拖动中光标滑出鲸鱼轮廓就断线
  var lastX = -1
  var lastY = -1
  var lastHit = null
  var evalCount = 0      // 判定次数（前若干次全记，之后抽样记）
  var beatLeft = 12      // 心跳日志条数上限

  function log(msg) {
    try { if (shell.log) shell.log(msg) } catch (e) {}
  }

  function applyIgnore(v) {
    v = !!v
    if (v === lastIgnore) return
    lastIgnore = v
    log('[glue] ignore=' + v + ' @' + Math.round(lastX) + ',' + Math.round(lastY) +
        ' hit=' + lastHit + ' pressed=' + pressed)
    try { shell.setIgnore(v) } catch (e) {}
  }

  function hitTest(x, y) {
    var fn = window.__dshwHitTest
    if (typeof fn !== 'function') return 'NO_FN:' + (typeof fn)
    try {
      return !!fn(x, y)
    } catch (e) {
      // 区分"判定不可用"与"判定返回 false"，否则日志里都是一个 null，很难定位
      return 'THROW:' + ((e && e.name) || '') + ' ' + ((e && e.message) || '')
    }
  }

  function evaluate(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return
    lastX = x
    lastY = y
    var h = hitTest(x, y)
    lastHit = h
    evalCount++
    // 只记启动期前 30 次：用来确认"判定到底跑没跑"。之后的持续信息由
    // applyIgnore() 的穿透切换日志承担，不必逐次刷屏（日志会长期留在用户机器上）。
    if (evalCount <= 30) {
      log('[glue] eval#' + evalCount + ' x=' + Math.round(x) + ' y=' + Math.round(y) +
          ' hit=' + h + ' pressed=' + pressed)
    }
    // h === null（判定能力缺失）时**保持穿透**：宁可鲸鱼点不动，
    // 也不能把整块屏幕变成"看不见却吃鼠标"的死区。
    applyIgnore(!(pressed || h === true))
  }

  log('[glue] installed, version=' + shell.version +
      ' hitTest=' + (typeof window.__dshwHitTest) +
      ' onCursor=' + (typeof shell.onCursor) +
      ' viewport=' + window.innerWidth + 'x' + window.innerHeight)
  applyIgnore(true) // 默认穿透

  // ① 主进程光标轮询（主触发源）
  if (typeof shell.onCursor === 'function') {
    shell.onCursor(function (pt) {
      // 计数器供自检断言"轮询确实到达了页面"
      window.__whaleGlueCursorCount = (window.__whaleGlueCursorCount || 0) + 1
      if (pt) evaluate(pt.x, pt.y)
    })
  } else {
    log('[glue] 警告：桥上没有 onCursor，只能依赖 mousemove 转发')
  }

  // ② 本地 mousemove（次触发源）
  window.addEventListener('mousemove', function (e) {
    evaluate(e.clientX, e.clientY)
  }, { passive: true, capture: true })

  // 按住期间锁死接管（拖拽不断线）；松开时按当前位置重算
  window.addEventListener('mousedown', function () {
    pressed = true
    applyIgnore(false)
  }, true)
  window.addEventListener('mouseup', function (e) {
    pressed = false
    evaluate(e.clientX, e.clientY)
  }, true)
  window.addEventListener('blur', function () { pressed = false }, true)

  // 光标移出窗口（多屏/边缘）：回到穿透
  window.addEventListener('mouseout', function (e) {
    if (e.relatedTarget) return
    pressed = false
    applyIgnore(true)
  }, true)

  // 心跳：确认"轮询到底有没有在跑"，只在启动早期记若干条
  var beat = setInterval(function () {
    if (beatLeft <= 0) { clearInterval(beat); return }
    beatLeft--
    log('[glue] heartbeat x=' + Math.round(lastX) + ' y=' + Math.round(lastY) +
        ' hit=' + lastHit + ' ignore=' + lastIgnore +
        ' hitTestReady=' + (typeof window.__dshwHitTest === 'function') +
        ' whaleMounted=' + !!document.querySelector('.dshwv-root'))
  }, 3000)
})()
