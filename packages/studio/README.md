# tavern studio

tavernpi 内核的 GUI 外壳。**同进程嵌入** `@tavernpi/core`（不走 RPC），类比浏览器之于 Chromium：
故事引擎的全部能力在内核，studio 只做面向创作与游玩的图形外壳。

- **文档**：`docs/创作规划.md`（做什么 / UX 契约）、`docs/技术考察.md`（怎么实现 / 形态、契约、缺口）
- **当前状态**：**S1 纵切已通**——渲染层换成 React + Vite + TS；阅读流从 `story.db.turn_log`
  分页取（分页读 + 终稿覆写）；新增 `story:turns` / `db:query` 两条契约通道。
  S0 的验收钩子 `__s0Result` 原样保留为回归手段。

## 目录

```
src/
├── contract/         # 唯一契约面：channel 名 + 载荷类型 + Transport/IpcLike 接口（两侧共用，禁止各抄一份）
├── main/
│   ├── index.ts          # Electron 引导：开窗 → 注册 channel → 加载渲染产物
│   ├── session.ts        # StudioSession：持有内核装配态 + 在飞轮次的中止把手 + 阅读流/DB 查询
│   ├── handlers.ts       # channel → StudioSession 的唯一映射表（缺 channel 编译期就红）
│   ├── transport-ipc.ts  # createIpcHost：把契约 channel 注册到 IpcLike（可脱 electron 单测）
│   ├── s0-acceptance.ts  # S0 验收：真 LLM 一轮 + **独立**读盘核对（写入路径）
│   └── s1-acceptance.ts  # S1 验收：零 LLM，真 app 走只读路径（阅读流 / DB 浏览器）
├── renderer/         # React + Vite 渲染层（源码；产物在 dist/，已 gitignore）
│   ├── index.html        # 布局与 CSP（default-src 'none'：渲染进程无网络面）
│   ├── main.tsx          # 入口：挂 React + 保留 __s0Result 验收钩子
│   ├── App.tsx           # 呈现层（只读 state 画，不做判断）
│   ├── useStudio.ts      # 状态与两条数据纪律（流式草稿 vs 落库终稿；阅读流取 turn_log）
│   ├── transport.ts      # 通道实现（TS 版：channel 名与载荷类型由编译器保证）
│   └── s0-acceptance.ts  # S0 验收流程（从旧 shell.js 原样移植，判据字段不变）
├── preload.cjs       # contextBridge 白名单（不暴露 ipcRenderer 本体）
└── dev/transport-ws.ts   # 开发通道（壳，待接）
vite.config.ts        # 构建配置（产物到 src/renderer/dist，base 相对路径供 file:// 加载）
spike/
├── s0-smoke.cjs          # 环境冒烟（内核直载 / node:sqlite / 窗口渲染）
└── renderer-smoke.cjs    # 渲染产物冒烟（file:// + CSP 下 React 是否真挂上）
test/
├── boundary.test.ts       # renderer / dev / preload 不得值导入内核（扫 .ts/.tsx/.js/.cjs）
├── bundle-boundary.test.ts # **产物**里不得含内核标识（源码扫描的兜底）
├── ipc-host.test.ts       # IPC 适配器：注册完整性 / 失败原子性 / 异常透传 / 推送
└── session-read.test.ts   # 阅读流 + DB 查询 + 边界形状 + 「handler 一律返回 Promise」不变量
```

## 开发与验证

```bash
npm --workspace @tavernpi/studio run build:renderer  # 构建渲染产物（**改渲染层后必跑**）
npm --workspace @tavernpi/studio run start           # 开真窗口
npm --workspace @tavernpi/studio run accept:s1       # S1 验收：零 LLM，秒级（只读路径）
npm --workspace @tavernpi/studio run accept:s0       # S0 验收：真 LLM 一轮 + 独立读盘核对（写入路径）
npm --workspace @tavernpi/studio run spike           # 环境冒烟（隐藏窗口）
npm test && npm run typecheck                        # 全仓判据
```

**改渲染层后必须先 `build:renderer`**：main 进程直跑 `.ts` 源码，但渲染进程不能
（`file://` 下没有 TS 编译），故必须有 Vite 产物。产物缺失时启动会给出明确提示而不是难懂的加载失败。

**三条环境坑（已实测，别踩第二遍）**：

1. 装 Electron **必须**走镜像：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
   （默认从 github.com 拉二进制，本机不通）。二进制缺失时可补跑
   `ELECTRON_MIRROR=... node node_modules/electron/install.js`。
2. 本机默认导出 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node——窗口起不来、`--version`
   打印 Node 版本、`import { app } from "electron"` 不可用。npm scripts 里已带 `env -u`。
3. 容器里跑会有 `Failed to connect to the bus` 的 dbus 报错——那是容器没有 system bus，**不是缺陷**，
   不影响窗口与渲染。


## S0 收尾验收证据（2026-09-18，真跑；14 项判据全绿）

```
ok: true
renderer: sessionId 01a0b4ef… · creation · turnSeq 1 · 443 字
          流式 312 片 · turn:done 2 次 · pipeline: story_scene,data,narrator · 15.7s
          story:open 续写 → 同一 sessionId · 生成中切故事 → 被拒 · 中止 → TurnAbortedError
db:       turn_log 1 行 · events 1 · snapshots.db 4096B
```

判据分三组：

1. **链路**：渲染流程完成 / 流式增量到达 / turn:done 到达（终稿覆写路径）/ pipeline 事件到达。
2. **盘上事实**（主进程用 raw SQLite 直读，不复用内核读取路径——免得用被验对象证明自己）：
   story.db 可读 / turn_log 含本轮 / **盘上终稿与渲染终稿逐字符一致** / 本轮落快照 / data 落库 /
   story:list 给出会话文件路径 / story:open 续写打通。
3. **并发与中止**（缺口 1 的端到端覆盖）：生成中切故事被拒 / turn:abort 被接受且本轮以中止收场 /
   **中止后盘上零新增（turn_log 仍 1 行）**。

第 3 组做过变异检验：把 `StudioSession.create` 的并发守卫删掉后，那条判据立刻变红，
并且中止本身崩成 `database is not open`——正是守卫要防的「生成中换故事会把在飞 runtime 连库一起
dispose」。还原后复绿。

## S1 验收证据（2026-09-21，真跑；17 项判据全绿，零 LLM）

```
ok: true
fixture: sessionId 01a0c2c9… · turn_log 6 行（开场白 + 补写 5）· 16 张表
渲染层:   挂载 ✓ · 按钮齐备 ✓ · file:// + CSP 下零控制台错误 ✓
阅读流:   story:turns 与盘上 turn_log 逐行逐字符一致 ✓ · 默认倒序（首行即最新）✓
DB 浏览器: db:query 列出的表与盘上 sqlite_master 一致 ✓ · 翻页读出真实行 ✓
边界:     非法 limit / order 均以 rejection 到达渲染层 ✓
```

判据分四组：

1. **渲染层**：React 产物在 `file://` + CSP 下真挂上（`#root` 有子节点、`h1` 正确、按钮齐备）——
   这条专门覆盖「源码类型检查过 ≠ `file://` 下能加载」的两个陷阱（ESM 跨源、CSP `'self'` 判定）。
2. **阅读流**（S1 的核心）：通道读出的行与**独立 raw SQLite 读盘**的结果逐行逐字符比对；
   默认倒序契约（首行 = 最大 `turn_seq`）单独判一条。
3. **DB 浏览器**：`db:query` 的表清单与盘上 `sqlite_master` 集合相等；翻页读出的行数与首行 `turn_seq` 校验。
4. **边界与空态**：未打开故事时两条通道都回**空态**（走数据不走错误通道）；非法载荷以 rejection
   到达渲染层（错误通道未被吞）。

**变异检验**：把 `StudioSession.turns` 的默认倒序改成升序后，「默认倒序」那条立刻变红
（`首行 turn_seq=0 / 盘上最大 5`）；还原后复绿。


## 已知边界

- **验收期间会看到几条 `Error occurred in handler for '…'`**：那是 Electron 对 ipcMain.handle
  rejection 的常规日志，正是那些「刻意让守卫 / 边界校验失败」的探针产生的——预期之内，不是缺陷。
- **轮中交互未接通**：studio 未挂 broker handler，卡包代码工具向 UI 发起交互时会按内核既有语义降级
  （不崩、不挂死，但交互不可用）。`interaction:respond` 仍刻意留在 `ChannelMap` 之外
  （并进去就必须有真 handler），待接通时再加。
- **虚拟滚动未做**：阅读流现在是「取一页 + 载入更早」的分页按钮，不是虚拟滚动。
  轮次规模到千级后再评估——先量再优化，不预先造框架。
- **开发通道未接线**：`src/dev/transport-ws.ts` 仍大声抛错。浏览器里迭代需要它，
  但那要等有真需求时再写（现在 Electron 启动也就一两秒）。

## 三条纪律

1. **两边只有一份契约**：channel 名与载荷类型只在 `src/contract/` 定义。生产（IPC）与开发（HTTP/SSE）
   两个适配器共用它；channel 名的白名单就是 main 侧的注册表（preload 不另抄一份列表）。
2. **渲染进程不得值导入内核**：模式过滤（DbView）、唯一写路径（trustedWrite）、快照恢复都在 main 侧
   的内核实例里。允许 `import type`。由**两条**机器判据钉住：`test/boundary.test.ts` 扫源码
   （含 `.tsx`），`test/bundle-boundary.test.ts` 扫**构建产物**——后者防的是「源码看起来是 type-only、
   实际被打进了包里」这类源码扫描看不见的情况。
3. **传输层从第一天就是可替换的适配器**：若等到收尾再把 WebSocket 换成 IPC，那不叫切换，叫重写。

## 下一步

S1 纵切已通，剩下的是把它做厚：

1. **故事树线**：`tree:navigate` / `tree:fork` 通道与 `story:changed` 推送已就位，缺 UI
   （条目树、回溯确认、分叉入口）。
2. **DB 浏览器 UI**：`db:query` 通道已通（表清单 + 翻页 + 作者/冒险视图），缺界面的表选择器与行视图。
3. **编辑器线**：提示词分层写（内核缺口 5/9 已补，需加 `prompts:write` 类通道）、卡包管理。
4. **模式与配置 UX**：`mode:set`（内核 `applyModeSwitch` 已就位）、`settings:write` 已有通道缺表单。
5. **轮中交互**：把手游交互呈现出来（`interaction:request` 推送已在契约里）+ `interaction:respond`。
6. **开发通道接线**：见「已知边界」。


## 许可证

GPL-3.0-or-later（与内核一致）。copyleft 不认仓库边界：同进程嵌入内核并**对外分发**本外壳时，
整个作品须以 GPLv3 兼容条款发布并提供对应源码（仅自用不触发）。约束原文见 `docs/创作规划.md` §3。
