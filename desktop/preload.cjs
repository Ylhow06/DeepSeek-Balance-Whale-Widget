// ============================================================================
// 覆盖层 preload
// ----------------------------------------------------------------------------
// 职责很窄（胶水本身**不在这里注入**了 —— 改由页面自己
// `<script src="/dsh-whale-shell/glue.js">` 加载，见 desktop/overlay-glue.js
// 头部注释与 HANDOVER-DESKTOP.md §11.3；跨世界注入内联脚本有世界归属/时序的
// 不确定性，是"点了没反应"的高风险来源）：
//   1. 向「主世界」暴露 __whaleShell.setIgnore(bool)   ← 穿透开关
//   2. 向「主世界」暴露 __whaleShell.onCursor(cb)      ← 主进程光标轮询（兜底触发源）
//   3. 暴露 __whaleShell.log(msg)                      ← 诊断日志落到主进程文件
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__whaleShell', {
  version: '1.1.0',

  /** 切换窗口鼠标穿透：true = 穿透到下层 */
  setIgnore(ignore) {
    try { ipcRenderer.send('whale:set-ignore', !!ignore) } catch (e) {}
  },

  /** 订阅主进程的光标位置（窗口内 CSS 像素坐标）。返回取消订阅函数。 */
  onCursor(cb) {
    if (typeof cb !== 'function') return () => {}
    const handler = (_e, pt) => { try { cb(pt) } catch (err) {} }
    ipcRenderer.on('whale:cursor', handler)
    return () => ipcRenderer.removeListener('whale:cursor', handler)
  },

  /** 诊断日志 */
  log(msg) {
    try { ipcRenderer.send('whale:log', String(msg)) } catch (e) {}
  },
})

ipcRenderer.send('whale:log', '[preload] loaded, bridge exposed')
