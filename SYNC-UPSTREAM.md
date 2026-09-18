# 与上游同步（fork 维护指南）

> 上游：**MeteorNOX/DeepSeek-Balance-Whale-Widget**
> `origin` = 你的 fork（Ylhow06），`upstream` = 上游。

## 分支模型（2026-09-16 起）

```
main      = 上游镜像，永远与 upstream/main 逐字节一致，只做 fast-forward
desktop   = 工作分支：独立运行薄壳 + 桌面宠物壳 + 配套修复（你实际用的就是这个）
```

这样做的理由：把"跟上游同步"和"自己的改动"放到两条线上。
`main` 干净 → `git pull upstream main` 永远是 fast-forward，**不可能冲突**；
冲突只发生在 `desktop` 分支上，而且由 **git 三方合并**处理（比手工往副本里打补丁安全，也不会漏）。

## 日常操作

### ① 同步上游（永远干净）

```powershell
git checkout main
git pull upstream main        # fast-forward，不会冲突
git push origin main          # 让 fork 的 main 也保持干净
```

### ② 把上游更新并进桌面端

```powershell
git checkout desktop
git merge main                # 冲突在这里解，main 不受影响
# 解完 → 见下面「合并后必做验证」
git push origin desktop
```

### ③ 桌面端自己开发

在 `desktop` 分支上正常 commit 即可。**别在 main 上写东西**。

> 想只拿上游某一个提交：`git cherry-pick <commit>`（在 desktop 分支上执行）。

## 冲突高发文件（我方相对上游的改动）

| 文件 | 我方改动 | 定位我方代码的关键词 |
|---|---|---|
| `lib/index.js` | +527 | `officialTodayRecord`、`platformTokenSet`、`API_BUILTIN_ID` 守卫、`usageSource = offToday`；另有你自己的官方消费历史（约 +498） |
| `assets/whale-widget.js` | +688 | `HAS_SESSION_EVENTS`、`__dwhHitTest`→`__dshwHitTest`、`fitBubbleText`、`isBuiltin`、`apiTodayMoneyText`、`apiNoBalanceLabel`、`scheduleManualFollow`、`widgetUiHit` 白名单里的 `.dshwv-rgbmenu` 一族 |
| `.gitignore` | +30 | `desktop/build`、`desktop/dist`、`desktop/.build`、`desktop/node_modules`、`standalone/config.json` |

**基本不会冲突**：`desktop/`、`standalone/` 整个目录、`HANDOVER.md`、`HANDOVER-DESKTOP.md`（都是我方新增，上游没有）。

**解冲突原则**：上游通用功能优先，但"桌面壳 / 独立模式"相关改动必须保住 —— 上面那几个关键词就是锚点。

> ⚠️ `assets/whale-widget.js` 里的 `__dshwHitTest` 是桌面端点击穿透的**命脉**
> （它要调用挂件内部的 `isWhaleHit`/`widgetUiHit`）。合并时若这段被覆盖，
> 表现是"点鲸鱼没反应、点击总是落到下层"，且日志里只有 `hit=null`。
> 详见 HANDOVER-DESKTOP §12.2 / §13.3。
>
> ⚠️ 同样必须保住的还有 **`widgetUiHit()` 的白名单**（`assets/whale-widget.js`，函数在
> `dshwInit` 内部，`__dshwHitTest` 依赖它）。上游的自绘下拉会被 `dshwDropOpen()`
> **搬到 `<body>` 下**（fixed 定位），因此白名单里必须包含这些**面板外**的浮层类名：
> `.dshwv-rgbmenu` / `.dshwv-rgbopt` / `.dshwv-rgbhead` / `.dshwv-rgbwrap` /
> `.dshwv-qcolwrap` / `.dshwv-fontwrap` / `.dshwv-custwrap` / `.dshwv-tplhelp`。
> 少了就是"下拉框点不动、点选项点到下层"（2026-09-18 实测，见 HANDOVER-DESKTOP §21）。
> **`check:hook` 的 D 组断言专门守这条**，合并后必跑。
>
> ⚠️ 另有一处**桌面端自己加的**前端逻辑，合并时别被上游版本盖掉：
> `refresh()` 开头的 `if (manual) scheduleManualFollow()`（点鲸鱼 2.5s 后补取一次今日账单）。

## 合并后必做验证（别省）

```powershell
# 1) 开发期自检：jsdom 离线跑真脚本，22 条断言
cd desktop && npm run check:hook
```
覆盖：钩子作用域（防"永远穿透"）、无/有 caps 双场景 gating、气泡居中补偿矩阵、点「+ 添加模型」能开面板、
**打开的下拉/说明浮层必须命中（含对照组）**、**点鲸鱼 → force=1 + 2.5s 补取一次今日账单**。

```powershell
# 2) 起一次独立薄壳，确认核心 lib 没被合并弄坏
cd standalone && node server.js      # 打开 http://127.0.0.1:3080
```

```powershell
# 3) 重打桌面包（必须先删空 dist；并挂国内镜像，否则 electron 下载会 10 分钟超时）
cd desktop
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run build
```

> 为什么必须先删空 `dist`：本机 Node 被注入 safe-delete 护栏，
> electron-builder 打包前 `fs.rm` 清 `win-unpacked(.tmp)`（100+ 文件）会被拒，
> 表现为"日志没结尾、无报错、耗时约两分钟"。详见 HANDOVER-DESKTOP §12.5。

4) 人工过一遍：点鲸鱼不穿透 / 点空白穿透、拖拽吸附、气泡内容不溢出、托盘菜单正常。

## 其它要留意

- **密钥与运行时数据不受合并影响**：桌面端的配置在 `%APPDATA%\WhaleDesktop\`，不在仓库里；
  仓库里只有 `standalone/config.example.json` 模板（真实 `config.json` 已被 `.gitignore` 排除）。
- **桌面壳的依赖在 `desktop/package.json`**，与上游无关；除非 `desktop/package-lock.json` 变了，否则不用重装。
- **上游有 CI**（npm 发布后自动建 Release）。你的 fork 上 Actions 默认不跑；启用前确认 secrets 不会外泄。
- **如果哪天上游也做了桌面壳 / 独立运行**：先读 `HANDOVER-DESKTOP.md` 的架构结论再决定合并方式，两套实现硬合会打架。
- **改默认分支**：fork 的默认分支建议在 GitHub 网页上切成 `desktop`（Settings → Branches），
  这样别人 clone 直接拿到桌面端。本机没有 `gh`，得在网页上改。

## 这次改造的记录

- `main` 已 reset 到 `40cebc2`（= upstream/main），并 force push 到 fork。
- 原 `main` 上的 5 个提交（`e0c7e59`、`6ffa759`、`17bef3d`、`1dd754f`、`d6113da`）**一个都没丢**，
  全部在 `desktop` 分支上；另留了 `backup/pre-split` 备份分支指向 `d6113da`。
- `README.md` 已回退为上游原版（桌面端用法改写在 Release 说明里）。
- 发行标记 `v0.1.0-desktop` 指向 `d6113da`（在 desktop 分支上）。
- **v0.1.1 发行（2026-09-18）**：`desktop/package.json` 版本 → 0.1.1，
  带下拉弹层修复与「点鲸鱼补取今日账单」；发行标记 `v0.1.1-desktop`，
  产物 `desktop/dist/小鲸鱼-0.1.1-{便携版,安装版}.exe`。
  ⚠️ 版本号只写 `desktop/package.json`（+ lock），**根 package.json 是上游插件版本，别动**。
