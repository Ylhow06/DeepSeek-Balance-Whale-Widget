# 交接文档：脱离 DSH 独立运行小鲸鱼挂件（方案 A 已完成）

> 面向接手的 agent / 开发者。读完本文即可继续开发，无需重查前文上下文。
> 生成时间：2026-09-15。

## 1. 项目是什么

- 仓库：`git@github.com:Ylhow06/DeepSeek-Balance-Whale-Widget`（克隆在 `D:\Document\MyProject\DeepSeek-Balance-Whale-Widget`，分支 `main`，工作树干净）。
- 本质：DSH（DeepSeek Harness）Web 界面的 **bundle 插件** —— 右下角"小鲸鱼"余额/记账挂件。
- 宿主入口：`lib/index.js`（Node ESM，约 3200 行，DSH DI：`inject: ['webServer','credentials','connection']` + `apply(ctx)`）。
- 前端本体：`assets/whale-widget.js`（由宿主按 mtime 热读取，硬刷新即生效；`lib/` 改动需重启宿主）。
- 完整规格见 `whale-widget-prompt.md`，安装/验证说明见 `README.md`。

## 2. 已完成的改动（只加了文件，零改核心）

新增 `standalone/` 目录（方案 A：本地 Node 薄壳 + 浏览器标签页）：

| 文件 | 作用 |
|---|---|
| `standalone/server.js` | 伪造最小 DSH `ctx` → 动态 import `lib/index.js` 并 `apply` → 路由挂进 `node:http` → `GET /` 出内联 `index.html`（含隐藏 fake-composer + key 状态提示卡） |
| `standalone/config.json` | 配置项：`host`/`port`/`credentials`（**key 放这里**，`set/unset` 会写回该文件，替代 DSH 凭据 vault） |

关键实现点（都在 `server.js` 注释里有说明）：

1. **`ctx` 伪造**（核心 lib 只用到这 5 类宿主能力）：
   - `ctx.webServer.register(route)` → 存进 `Map<path, handler>`；`tapIndex` → no-op（自带 index.html）
   - `ctx.credentials.{resolve,set,unset,deleteRecord}` → 读写 `config.json` 的 `credentials`
   - `ctx.on('session/event'|'session/disposed')` → no-op（**失去每轮消耗的会话兜底记账**，余额差记账仍可用）
   - `ctx.get` / `ctx.effect` → 最小实现；`ctx.connection = undefined`（信任栅栏 fail-open，仅 warn 日志）
2. **DSH_HOME 坑（重要）**：`lib/index.js` 顶层有 `const DSH_HOME = process.env.DSH_HOME || ~/.dsh`，
   **必须在 `import()` 之前**设置 `process.env.DSH_HOME`，否则运行时数据（`.dshw-*.json`、`whale-roles/` 等）会写进真实 `~/.dsh`。
   薄壳把它指到项目内 `.dsh-standalone/`（已隔离）。
3. **前端自检坑**：`whale-widget.js` 第 15–41 行只在 `#root` 里检测到 composer（`textarea` / `[contenteditable=true]`）才挂载挂件；独立页的 index.html 里放了隐藏 `<textarea class="fake-composer">` 骗过自检。
4. 路由 handler 全用 Node 原生 `req/res`（`writeHead`/`end`/`req.on('data')`），直接转发即可，21 个 `/dsh-whale/*` 路由。

## 3. 已验证（Node 22.22.2 实测）

```
GET /                      200 text/html
GET /dsh-whale/widget.js   200 application/javascript
GET /dsh-whale/image.png   200 image/png
GET /dsh-whale/rua.gif     200 image/gif
GET /dsh-whale/balance.json 200 {"ok":false,"code":"NO_KEY",...}   ← 未配 key 时优雅降级
GET /dsh-whale/audio.json  200 application/json
```

## 4. 如何运行

```powershell
node standalone/server.js      # 打开 http://127.0.0.1:3081
```

- 配 key：编辑 `standalone/config.json` → `"credentials": { "DEEPSEEK_API_KEY": "sk-xxx" }`，重启服务。
- 自定义模型凭据（`OPENROUTER_API_KEY` 等）同样放 `credentials` 里。
- 端口冲突（EADDRINUSE）：旧 node 进程没退干净，先结束 3081 监听进程再启动。
- 2026-09-15 起启动端口由 3080 改为 **3081**（`standalone/config.json` 的 `port` 已同步改）。

## 4.1 修复记录：余额请求 401
- 现象：独立模式下 `GET /dsh-whale/balance.json` 返回 401。
- 根因：`lib/index.js` 的 `fetchBalance()` 通过 `ctx.credentials.resolve('DEEPSEEK_API_KEY')` 取到凭据后，
  用 **`cred.value`** 拼 `Authorization: Bearer <key>`（见 lib/index.js L708）。
  而旧版 `standalone/server.js` 的 `resolve` 直接返回**裸字符串**，导致 `cred.value === undefined`，
  请求头变成 `Bearer undefined` → DeepSeek 侧 401。
- 修复：`standalone/server.js` 的 `resolve` 改为返回 `{ value: String(...) }` 记录对象（对齐 DSH 宿主凭据语义）。
- 验证：重启后 `balance.json` 返回 `{"ok":true,"totalBalance":21.21,"currency":"CNY",...}`，200。

## 4.2 新增：消费历史（平台官方账单口径，参考 dboycht/ds-usage-export）

小鲸鱼记账只能「估算」历史（余额差 + 会话事件），历史消费不全面。本次按参考仓库的
平台内部接口方案，补上**官方精确账单**的抓取与展示：

- **原理**（参考 `dboycht/ds-usage-export` 的 `dsusage/api.py` + `docs/api-notes.md`）：
  用 platform.deepseek.com 登录态 `userToken`（浏览器 `localStorage['userToken'].value`），
  调 `https://platform.deepseek.com/api/v0` 内部接口：
  - `/usage/by_api_key/amount?start=&end=&tz=28800` → 按 key×模型 的 token 分桶（小时/天桶）
  - `/usage/by_api_key/cost?start=&end=&tz=28800` → 按币种×key×模型 的**官方精确费用**
  - 时间语义：`start`=起始日当地 00:00 的 UTC 秒、`end`=结束日次日 00:00 的 UTC 秒、`tz`=时区偏移秒（北京 28800）
  - 平台 UI 前端限制 30 天 → **服务端按 ≤30 天分片**请求再合并（任意历史周期）
  - 响应外壳 `{code,msg,data:{biz_code,biz_msg,biz_data}}`；HTTP 200 也可能是业务错误（`code=40003`=令牌失效）
- **实现**（都在 `lib/index.js`，零改核心记账逻辑）：
  - 新增函数 `platformGet / platformFetchOneDay / platformFetchRange`：逐天抓取 amount+cost 合并，
    按天/模型聚合官方费用；`≤30天` 分片；失败天记 `failedDays`（令牌失效/业务错直接终止，不逐天浪费）。
  - 新增路由 `GET /dsh-whale/platform-usage.json?from=&to=`（缺省最近 30 天）：
    返回 `{ok, range, totalCost, totalTokens, costByDay, costByModel, days[], failedDays[], currency, fetchedAt}`；
    1 小时内存缓存（`platformUsageCache`，按 `from|to` 键）。
  - 读取新凭据 `DEEPSEEK_PLATFORM_TOKEN`（`ctx.credentials.resolve`，对齐 `{ value }` 记录对象语义）。
- **前端**（`assets/whale-widget.js`）：在「更多消费记录」窗口的图表区加第 ④ 块
  「消费历史（平台官方）」折叠面板：
  - 日期起/止输入 + 快捷（近7天/近30天/本月/自定义）+「拉取历史」按钮
  - 拉取后渲染：官方合计 + Token 汇总、模型占比条（复用 `usageRatioRows`）、每日明细（可展开模型占比/Token）
  - 面板默认折叠；范围存前端 `usagePlatRange`，「自定义」会记住输入。
- **凭据获取**（首次使用必做）：
  1. 浏览器登录 platform.deepseek.com 并打开 /usage 页
  2. F12 Console 执行 `copy(JSON.parse(localStorage.getItem('userToken')).value)`
  3. 把复制的 token 填进 `standalone/config.json` → `"credentials": { "DEEPSEEK_PLATFORM_TOKEN": "<token>" }`，重启服务
  4. 打开挂件 → 用量记录 → 更多消费记录 → 展开「消费历史（平台官方）」→ 选范围 → 拉取
  - token 等同登录密码，**勿外泄**；失效后需重新复制。
- **验证**：未配 token 时 `platform-usage.json` 返回 `{"ok":false,"code":"NO_KEY",...}`（优雅降级，不 500）；
  配 token 后返回官方账单（`totalCost`/`costByDay`/`costByModel` 与 platform.deepseek.com/usage 一致）。
- **边界**：平台接口只认登录态 token、不认 API key；`amount` 只返 token 数、`cost` 才是官方金额；
  逐天抓取耗时随天数线性增长（30 天约 30×2 次请求），1h 缓存避免重复抓取。
- **坑：拉取报 404（已修）** —— 前端查询串误写成 `'/?from=…'`，拼出
  `/dsh-whale/platform-usage.json/?from=…`（**路径尾部多了个 `/`**）。
  路由按**精确路径**注册，`new URL(req.url).pathname` 会保留尾部斜杠 → `routes.get()` miss → 404。
  - 修复①（根因）：`assets/whale-widget.js` 查询串改为 `'?from='`（不带前导 `/`）。
  - 修复②（防御）：`standalone/server.js` 查找路由时，miss 后再去掉尾部斜杠查一次，
    同类写法错误不会再变 404（不改注册键）。
  - 排查手法：404 先看**完整请求 URL**里的路径部分——带 `?` 前的 `/` 就是这类 bug；
    再用 `Invoke-WebRequest` 分别打「带斜杠 / 不带斜杠」两种形式对比状态码。
- **缓存注意**：`platformUsageCache` 只有**一个槽位**，切换范围会顶掉上一个；
  同一范围连续请求才命中（实测命中 ~19ms）。挂件里反复拉同一范围是常态，够用。

## 4.3 平台历史接口实测记录（2026-09-15 本机真实账号）

```
GET /dsh-whale/platform-usage.json?from=2026-08-17&to=2026-09-15
→ 200, 6.9s, 30/30 天成功, failedDays=0
   totalCost=53.26 CNY
   tokens: input=386,329,068  output=2,505,159  requests=2,404
   costByModel: deepseek-v4-flash=24.88 / v4-flash-vision-exp=16.02 /
                deepseek-flash=8.02 / v4-pro=2.65 / v4.1-flash-exp=1.70
```
- `costByModel` 会带上**全部模型键（含 0 值）**，前端已过滤零费用模型与无消费日，避免噪声。

## 4.4 官方记录覆盖记账 + 某日各时段消费

### （1）严重时区 bug：按日聚合必须「先加 tz 再取日期」（已修）

平台桶的 `time` 是**绝对 UTC 秒**，但桶按**当地整点**对齐 —— 当地 0 点的桶，
其 UTC 时刻是**前一天 16:00Z**。旧代码用 `new Date(tsec*1000).toISOString().slice(0,10)`
取 UTC 日期归组，把当地 0–7 点的桶全算到了前一天。

- 实测（2026-09-15 单日）：**正确 2.0499 vs 旧口径 1.5880**，单日少算 0.46 元（约 22%）。
- 修复：`bucketLocalParts(tsec)` = `new Date((tsec + 28800) * 1000)` 再取 `getUTCDate/getUTCHours`。
- 教训：**涉及「桶 → 当天」的聚合，先确认桶的对齐基准**；`toISOString()` 是 UTC，
  和「当地 00:00 对齐」的桶天生错位 8 小时。2026-09-14 那天碰巧没暴露（桶都落在 UTC 同一天）。

### （2）官方记录持久化 + 覆盖记账展示

- 新增缓存文件 `$DSH_HOME/.dshw-official.json`（独立模式落在 `.dsh-standalone/`）：
  ```json
  { "version":1, "updatedAt":"…", "days": { "YYYY-MM-DD": {
      "cost": 2.0499, "models": {"deepseek-flash":1.98,…},
      "tokens": {"input":…,"output":…,"requests":…},
      "hours": [ {"hour":0,"cost":0.46,"input":…,"output":…,"requests":33,"models":{…}}, … ],
      "fetchedAt":"…" } } }
  ```
  保留最近 400 天；每次拉取成功即 `mergeOfficialDays()` 写入（同一天以最新为准）。
- **覆盖落点**在 `usageRecordsPayload()` 内：
  - `totalDay(d)`：官方有该日数据就直接返回官方 `cost`（**覆盖**余额差/事件估算），否则退回原估算链。
  - `modelsFor(d)`：官方有按模型拆分就直接用（与官方合计同源，不再对齐余额差）。
  - `all.days` 的日期集合额外并入**官方记录的日期**（否则只有官方数据的日子不显示）。
  - 每个日条目新增 `src: 'official' | 'estimate'`；payload 新增
    `official: {updatedAt, days, hasToday, earliest}`。
- **后台自动同步** `maybeAutoSyncOfficial()`：`usage-records.json` 被请求时触发，
  拉**最近 3 天**（10 分钟冷却、失败静默、AUTH/BIZ 直接放弃），
  让「覆盖」无需手动拉取也保持最新 —— 今天的数据尤其需要（实测余额差为 0 时官方已是 2.05）。
- 前端：近 7 天与每日明细给官方日打绿色 `官方` 角标，并显示同步时间与天数。

### （3）某日各时段消费（新增）

- 单日请求平台返回 `bucket=3600`（小时桶），而本实现**本来就逐日抓取** →
  小时桶是**免费的**，旧代码把它丢了，现在按当地小时保留在 `hours[]`。
- 新增路由 `GET /dsh-whale/platform-hours.json?date=YYYY-MM-DD[&refresh=1]`：
  优先用官方缓存里的小时桶；缓存缺失（或 `refresh=1`）才现抓那一天并写回缓存。
- 前端 `usageRenderHours()` 渲染小时柱条（悬停显示 token/请求数）：
  - 消费历史块里展开某一天 → 直接用该次范围抓取带回的 `hours`（**零额外请求**）；
  - 每日与逐条明细里每天有「查看各时段消费」按钮 → 按需拉 `/platform-hours.json`。
- 实测：2026-09-15 → 5 个时段（h=0/9/12/13/17），合计 2.0499；
  2026-09-10（缓存外，走现抓）→ 12 个时段，合计 4.7415，并已落盘。

### （4）本轮验证（2026-09-15 本机真实账号）

```
平台单日(09-15)   : cost=2.0499（时区修复前 1.5880）
usage-records     : today total=2.05 src=official；09-13/14/15 = official，更早 = estimate
platform-hours    : 09-15 → 5 时段 / 2.0499（cached）
                    09-10 → 12 时段 / 4.7415（现抓 + 落盘）
官方缓存           : 4 天，含 hours 小时桶
```

## 4.5 只在你主动操作时拉取「当日详细数据」

原来 `balance.json`（挂件每 60s 轮询的那条）的 `todayUsage` 走 `ledgerTodayTotal()`
（余额差估算），而面板 `usage-records.json` 走官方覆盖 —— **同一个「今日已用」两个数**。
现在两者统一到官方口径，但**只在主动操作时**才回平台拉数据。

### 触发规则（重要）

| 场景 | 是否回平台拉数据 | 说明 |
|---|---|---|
| 自动轮询 `balance.json`（每 60s） | **否** | 用户没在看面板，拉了也看不到，纯白费请求 |
| 手动点小鲸鱼 `balance.json?force=1` | 是（当天） | 只抓今天一天，20s 下限防连点 |
| 打开用量面板 `usage-records.json` | 是（近 3 天） | 面板**打开着**才算，10 分钟冷却；面板关着时不会有这个请求 |
| 「拉取历史」按钮 | 是（所选范围） | 逐日抓取 |
| 「查看各时段消费」按钮 | 是（那一天） | 缓存没有才现抓 |

关键点：`usage-records.json` **只在用量面板打开期间**才被请求（`usageRefreshTimer` 仅在
`usagePanelOpen` 时跑），所以面板关着时不会有任何后台平台请求 —— 完全符合
「看不到就不拉」。

### 实现

- **新增** `maybeSyncTodayOfficial()`：只抓**今天一天**（amount+cost 两个请求），
  拿到的当天合计/分模型/**各时段小时桶**并入官方缓存；抓完把 `balanceCache` 置空，
  下一轮刷新立刻用上新值（非阻塞，本轮先用缓存里已有的官方值 → 最多滞后一轮）。
- **只在 `force=1` 时调用**（`balance.json` 路由里 `if (force) maybeSyncTodayOfficial()`）；
  `OFFICIAL_TODAY_SYNC_MIN_MS = 20s` 为连点下限。
- **今日已用改官方口径**：`getBalancePayload()` 里 `officialTodayRecord()` 有官方当天记录就用它，
  否则退回余额差；返回值新增 `todayUsageSource: 'official' | 'estimate'`。
- **前端**：`refresh(manual)` 手动时请求 `balance.json?force=1`，自动轮询不带该参数。

### 实测（2026-09-15）

```
手动 force=1     : 触发当天同步，fetchedAt 09:53:25 → 09:54:07，当天 cost 更新
自动轮询 x3      : refetched=False  ✓（不拉）
手动 force=1     : refetched=True   ✓（拉）
下一轮刷新       : todayUsage=… source=official（滞后一轮生效，符合设计）
一致性           : balance.json 的 todayUsage 与 usage-records 的 today.total 完全一致 ✓
```

### 代价

面板关着时**零**平台请求；面板打开时最多每 10 分钟一次近 3 天同步；
点一次小鲸鱼 = 2 个请求。不配 `DEEPSEEK_PLATFORM_TOKEN` 则整条链路静默跳过。




## 5. 当前环境状态（接手时注意）

- 2026-09-15 曾有两个后台 shell（task `TYVaBG` / `agLAwF`）起过服务：`TYVaBG` 报 failed 但 node 进程**没死**，一直占着 3080；`agLAwF` 因 EADDRINUSE 秒退。
- **接手先检查 3081**：`netstat -ano | Select-String ':3081\s'` 看是否有 `LISTENING`；没有就按 §4 重启。
  ⚠️ 用 `netstat -ano`，**不要信 `Get-NetTCPConnection`**——本机实测它在服务确实监听时仍返回 0 条
  （HTTP 200 与 netstat 都能证明在听，`Get-NetTCPConnection -LocalPort 3081 -State Listen` 却是空）。
- 本环境 PowerShell 输出捕获不稳定：命令输出经常为空，**可靠做法是把结果 `Out-File` 到临时 txt 再用 Read 读**；bash shim 报 `dirname/sleep/ls: command not found` 可无视（不影响命令本身执行）。
- **改完 `lib/` 必须重启，且必须确认旧进程真的死了**：只 `job_kill` 后台 job 不保证 node 进程退出，
  它会继续占 3081 并用**旧代码**应答（表现为"新加的路由 404"）。
  正确顺序：`netstat -ano | Select-String ':3081\s'` 拿到 PID（最后一列）→ `Stop-Process -Id <pid> -Force`
  → 再 `node standalone/server.js`（若仍 EADDRINUSE 说明还有残留，重复一次）。
  ⚠️ 别用 `Get-NetTCPConnection` 判断是否杀干净：它在本机不可靠（见上条），会误报 0 条。
  （`assets/whale-widget.js` 是按 mtime 热读的，改它只需浏览器硬刷新，不用重启。）

## 6. 功能边界（独立 vs 完整 DSH）

| 保留 | 丢失 |
|---|---|
| 余额 60s 刷新 + 手动刷新 | 「每轮对话消耗」的会话事件兜底（无 DSH 会话流） |
| 余额差记账（跨天归档 90 天/2 万条） | DSH 凭据 vault（改走 config.json，功能等价） |
| 峰谷定价、泡泡系统、音效/角色/图片 | 宿主 `tapIndex` 注入（改自带 index.html） |
| 自定义 API 模型、预算/预警 | 信任栅栏（本地仅绑 127.0.0.1，可接受） |
| Codex 本地会话统计（读 `$CODEX_HOME` 文件，纯本地不依赖 DSH） | |

## 7. 下一步（方案 B：Electron 桌面壳）

> **选型已定，实施文档见 [`HANDOVER-DESKTOP.md`](./HANDOVER-DESKTOP.md)** —— 交给执行 agent 直接照做。
> 该文档包含：已定决策（Electron 44.3.0 / 全屏透明覆盖层 / 先 node:http+动态端口 / `desktop/` 子目录 / 只主屏）、
> 已核实的事实与行号、分阶段实施步骤（含代码骨架）、Windows 坑清单、验证命令、安全红线。

要点速览：
- **不用 Tauri**：其 `set_ignore_cursor_events` 不支持转发鼠标移动（穿透后收不到 `mousemove`，
  只能轮询烧 CPU），且离线 WebView2 要 +127MB，再加 Node sidecar 反而比 Electron 大。
- **必须全屏覆盖层**，不能用小精灵窗：挂件的消费记录窗宽 `min(560px,92vw)`、遮罩 `inset:0`、
  吸附按视口 1/4 分区 —— 小视口会把它们全裁掉。全屏后挂件定位逻辑**零改动**。
- **端口动态分配**（`listen(0)`）根除 EADDRINUSE；核心 `lib/` 无需改动
  （所有写盘都从 `DSH_HOME` 派生，主进程把它指到 `userData` 即可）。
- 穿透开关可直接复用挂件已有的逐像素命中检测 `isWhaleHit()`（`assets/whale-widget.js:13935`，取 PNG alpha）。

## 8. 约定与记忆

- 工作区日志：`.workbuddy/memory/2026-09-15.md`；长期笔记：`.workbuddy/memory/MEMORY.md`（已含解耦要点与陷阱）。
- 用户偏好：直接给可跑的东西 + 简要说明，不要冗长解释；迭代式调试。
