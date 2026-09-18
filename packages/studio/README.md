# tavern studio

tavernpi 内核的 GUI 外壳。**同进程嵌入** `@tavernpi/core`（不走 RPC），类比浏览器之于 Chromium：
故事引擎的全部能力在内核，studio 只做面向创作与游玩的图形外壳。

- **文档**：`docs/创作规划.md`（做什么 / UX 契约）、`docs/技术考察.md`（怎么实现 / 形态、契约、缺口）
- **当前状态**：**S0 收尾已通**——Electron 44.4.2 起窗、主进程直跑内核 `.ts`、preload/IPC 通道打通、
  空壳里真跑「列故事 → 新建 → 发一轮（真 LLM）」并通过独立读盘核对（见下）。
  **S1 才是 UI**：现有 `src/renderer/` 只是验收用的最小壳（经典脚本、无构建、无框架）。

## 目录

```
src/
├── contract/         # 唯一契约面：channel 名 + 载荷类型 + Transport/IpcLike 接口（两侧共用，禁止各抄一份）
├── main/
│   ├── index.ts          # Electron 引导：开窗 → 注册 channel → 加载渲染进程
│   ├── session.ts        # StudioSession：持有内核装配态 + 在飞轮次的中止把手 + 推送转接
│   ├── handlers.ts       # channel → StudioSession 的唯一映射表（缺 channel 编译期就红）
│   ├── transport-ipc.ts  # createIpcHost：把契约 channel 注册到 IpcLike（可脱 electron 单测）
│   └── s0-acceptance.ts  # S0 验收：等渲染进程结果 + **独立**读盘核对
├── renderer/         # 最小壳（S0 验收用；S1 换 React + Vite）
│   ├── index.html        # 布局与 CSP（default-src 'none'：渲染进程无网络面）
│   ├── transport.js      # 通道实现（经典脚本：file:// 下不支持 ESM，故 S0 不引构建）
│   └── shell.js          # 故事列表 / 新建 / 输入 / 流式 / 中止 + 验收钩子
├── preload.cjs       # contextBridge 白名单（不暴露 ipcRenderer 本体）
└── dev/transport-ws.ts   # 开发通道（壳，S1 接）
spike/s0-smoke.cjs    # 环境冒烟（内核直载 / node:sqlite / 窗口渲染）
test/
├── boundary.test.ts  # renderer / dev / preload 不得值导入内核（扫 .ts/.js/.cjs，含判据自检）
└── ipc-host.test.ts  # IPC 适配器：注册完整性 / 失败原子性 / 异常透传 / 推送
```

## 开发与验证

```bash
npm --workspace @tavernpi/studio run start       # 开真窗口
npm --workspace @tavernpi/studio run spike       # 环境冒烟（隐藏窗口）
npm --workspace @tavernpi/studio run accept:s0   # S0 验收（真 LLM 一轮 + 独立读盘核对）
npm test && npm run typecheck                    # 全仓判据
```

**两条环境坑（已实测，别踩第二遍）**：

1. 装 Electron **必须**走镜像：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
   （默认从 github.com 拉二进制，本机不通）。二进制缺失时可补跑
   `ELECTRON_MIRROR=... node node_modules/electron/install.js`。
2. 本机默认导出 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node——窗口起不来、`--version`
   打印 Node 版本、`import { app } from "electron"` 不可用。npm scripts 里已带 `env -u`。

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

## 已知边界

- **验收期间会看到两行 `Error occurred in handler for '…'`**：那是 Electron 对 ipcMain.handle
  rejection 的常规日志，正是上面两条「刻意让守卫/中止失败」的探针产生的——预期之内，不是缺陷。
- **轮中交互未接通**：studio 未挂 broker handler，卡包代码工具向 UI 发起交互时会按内核既有语义降级
  （不崩、不挂死，但交互不可用）。S1 接 `interaction:respond`。
- **阅读流尚未从 turn_log 取**：S0 壳只把终稿画在气泡里；S1 才按「DB 是事实源」做分页阅读流。

## 三条纪律

1. **两边只有一份契约**：channel 名与载荷类型只在 `src/contract/` 定义。生产（IPC）与开发（HTTP/SSE）
   两个适配器共用它；channel 名的白名单就是 main 侧的注册表（preload 不另抄一份列表）。
2. **渲染进程不得值导入内核**：模式过滤（DbView）、唯一写路径（trustedWrite）、快照恢复都在 main 侧
   的内核实例里。允许 `import type`。由 `test/boundary.test.ts` 扫源码钉住（含 `.js/.cjs`——
   S0 的壳是经典脚本，纪律不能因扩展名换了就失效）。
3. **传输层从第一天就是可替换的适配器**：若等到收尾再把 WebSocket 换成 IPC，那不叫切换，叫重写。

## 下一步（S1）

1. 渲染进程换 React + Vite + TS（契约与边界判据不动，只换渲染层与构建；`shell.js` 的验收钩子
   `__s0Result` 保留为回归手段）。
2. 阅读流从 `story.db.turn_log` 取（分页 + 虚拟滚动）；流式增量只作「生成中」临时展示，轮末用
   `turn:done` 的终稿覆写。
3. 开发通道接线（本地 HTTP/SSE，只监听 127.0.0.1），挂同一份 `HostHandlers`。
4. 轮中交互通道：渲染进程呈现 + `interaction:respond` 回应（现在未挂 handler，卡包工具会按内核
   既有语义降级——不崩、不挂死，但也不能用）。
5. 故事树 / DB 浏览器 / 编辑器线：分别等内核缺口 3（通用只读查询）、6（阶段开始事件）、
   5/9/10（global 提示词写、卡包校验模块导出、pin 持久化），见 `docs/技术考察.md` §3.2。

## 许可证

GPL-3.0-or-later（与内核一致）。copyleft 不认仓库边界：同进程嵌入内核并**对外分发**本外壳时，
整个作品须以 GPLv3 兼容条款发布并提供对应源码（仅自用不触发）。约束原文见 `docs/创作规划.md` §3。
