// ============================================================================
// 打包前准备：把「Electron 壳 + 核心插件」拼成一个可以直接打包的 app 目录
// ----------------------------------------------------------------------------
// 为什么要这一步：electron-builder 只能打包「app 目录内部」的文件，而本仓库
// 的 app 目录是 desktop/，源代码（lib/ assets/ standalone/）在上一层。
// 直接把 desktop/ 当 app 目录会打包出一个跑不起来的空壳。
//
// 于是先在 desktop/.build/app/ 下铺一份「镜像仓库根目录结构」的暂存目录：
//
//   .build/app/
//     package.json          ← 自动生成（main 指向 desktop/main.js）
//     desktop/{main.js, preload.cjs, overlay-glue.js}
//     standalone/{server.js, config.example.json}
//     lib/index.js
//     assets/*
//
// 这样 main.js 里 `path.resolve(DESKTOP_DIR, '..')` 得到的 PROJECT_ROOT
// 正好是 asar 根，lib/ 与 assets/ 的相对路径与开发态完全一致（零改动）。
//
// ⚠️ 安全：**绝不复制 standalone/config.json**（里面有真实 API key 与平台 token）。
//          并且会校验 config.example.json 里没有残留密钥，有就中止打包。
// 运行：node scripts/prepare-build.mjs
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(DESKTOP_DIR, '..')
const OUT = path.join(DESKTOP_DIR, '.build', 'app')

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }) }
function cp(src, dest) {
  if (!fs.existsSync(src)) throw new Error('缺少源文件/目录：' + src)
  fs.cpSync(src, dest, { recursive: true })
}

// ---- 0. 密钥自检：模板里不允许出现非空凭据 ----
try {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'standalone', 'config.example.json'), 'utf8'))
  const leaked = Object.entries(tpl.credentials || {}).filter(([, v]) => String(v || '').length > 0)
  if (leaked.length) {
    console.error('❌ 中止：standalone/config.example.json 里存在非空凭据 →', leaked.map(([k]) => k).join(', '))
    process.exit(1)
  }
} catch (e) {
  if (e && e.code !== 'ENOENT') { console.error('❌ 读取 config.example.json 失败：', e.message); process.exit(1) }
}

// ---- 1. 铺目录 ----
rmrf(OUT)
fs.mkdirSync(path.join(OUT, 'desktop'), { recursive: true })

cp(path.join(ROOT, 'lib'), path.join(OUT, 'lib'))
cp(path.join(ROOT, 'assets'), path.join(OUT, 'assets'))

// standalone：只拷 server.js 与模板，**排除 config.json / 运行时数据**
fs.mkdirSync(path.join(OUT, 'standalone'), { recursive: true })
cp(path.join(ROOT, 'standalone', 'server.js'), path.join(OUT, 'standalone', 'server.js'))
cp(path.join(ROOT, 'standalone', 'config.example.json'), path.join(OUT, 'standalone', 'config.example.json'))

// 桌面壳自身
for (const f of ['main.js', 'preload.cjs', 'overlay-glue.js']) {
  cp(path.join(DESKTOP_DIR, f), path.join(OUT, 'desktop', f))
}

// ---- 2. 生成暂存目录的 package.json（Electron 从这里读 main / type）----
const selfPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'))
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: selfPkg.name,
  productName: selfPkg.productName || '小鲸鱼',
  version: selfPkg.version,
  private: true,
  description: selfPkg.description,
  type: 'module',
  main: 'desktop/main.js',
  license: 'MIT',
}, null, 2), 'utf8')

// ---- 3. 应用图标：鲸鱼图 alpha 包围盒占画幅 93%×98%，直接复用即可 ----
fs.mkdirSync(path.join(DESKTOP_DIR, 'build'), { recursive: true })
cp(path.join(ROOT, 'assets', 'DSniang1.png'), path.join(DESKTOP_DIR, 'build', 'icon.png'))

// ---- 4. 报告 ----
function dirSizeMB(p) {
  let sum = 0
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name)
    if (e.isDirectory()) sum += dirSizeMB(f)
    else sum += fs.statSync(f).size
  }
  return sum
}
console.log('[prepare-build] 暂存目录：', OUT)
console.log('[prepare-build] 应用资源体积：', (dirSizeMB(OUT) / 1048576).toFixed(1) + ' MB')
console.log('[prepare-build] 已生成图标：', path.join(DESKTOP_DIR, 'build', 'icon.png'))
