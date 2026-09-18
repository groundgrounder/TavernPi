# tavern studio

tavernpi 内核的 GUI 外壳。**同进程嵌入** `@tavernpi/core`（不走 RPC），类比浏览器之于 Chromium：
故事引擎的全部能力在内核，studio 只做面向创作与游玩的图形外壳。

- **文档**：`docs/创作规划.md`（做什么 / UX 契约）、`docs/技术考察.md`（怎么实现 / 形态、契约、缺口）
- **当前状态**：**骨架**——契约层、IPC 通道适配器、边界纪律判据、S0 冒烟脚本已就位；**未接 UI**，
  main 侧 handler（openStory / runTurn / forkFrom 的接线）与渲染进程应用是 S1 的事。

## 目录

```
src/
├── contract/   # 唯一契约面：channel 名 + 载荷类型 + Transport 接口（两侧共用，禁止各自抄一份）
├── main/       # 主进程侧：transport-ipc.ts（把契约 channel 注册到 IpcLike 上）
├── renderer/   # 渲染进程侧：transport-ipc.ts（经 preload 的 contextBridge 说话）
├── dev/        # 开发脚手架：transport-ws.ts（**壳**，见文件头）
└── ../../spike/s0-smoke.cjs   # S0 环境冒烟（Electron 内跑通内核 + 渲染，已全绿）
test/
├── boundary.test.ts   # 渲染进程不得值导入内核（扫源码，含判据自检）
└── ipc-host.test.ts   # IPC 适配器：注册完整性 / 失败原子性 / 异常透传 / 推送
```

## 三条纪律

1. **两边只有一份契约**：channel 名与载荷类型只在 `src/contract/` 定义。生产（IPC）与开发（HTTP/SSE）
   两个适配器共用它——否则两条通道必然漂移。
2. **渲染进程不得值导入内核**：模式过滤（DbView）、唯一写路径（trustedWrite）、快照恢复都在 main 侧
   的内核实例里；渲染进程只要能值导入内核就等于把信任边界搬到了页面上。允许 `import type`
   （类型剥离后不留运行时代码，而类型必须共用一份）。这条由 `test/boundary.test.ts` 扫源码钉住——
   刻意做成机器判据，不写在文档里当君子协定。
3. **传输层从第一天就是可替换的适配器**：开发期用浏览器 + 系统 Node 跑内核（改一行刷新，不必反复
   重启 200MB 的 Electron），交付形态仍是 Electron。若等到收尾再把 WebSocket 换成 IPC，那不叫切换，
   叫重写。

## 开发与验证

```bash
npm test                              # 含本包的两份判据（边界扫描 + IPC 适配器）
npm run typecheck                     # core / app / tools / studio(main) / studio(renderer) 五份配置
```

本包的 TS 配置刻意分两份：`tsconfig.main.json`（Node 侧）与 `tsconfig.renderer.json`（DOM 侧，`lib` 加 DOM）。
渲染那份仍需 `@types/node`——因为契约层 `import type` 了内核源码，而内核源码自身引用 `node:*`。
运行期隔离不靠 TS 配置保证，靠上面第 2 条纪律的扫描判据。

## 下一步（S0 收尾 → S1）

1. **S0 收尾**：装 Electron（**必须** `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，
   本机直连 github.com 不通，见 `docs/技术考察.md` §1）、写 preload（contextBridge 白名单）、
   开窗口、空壳里真跑「列故事 → 打开 → 发一轮（真 LLM）」。判据取盘上 `story.db` 的 `turn_log`，
   不是界面上出现了什么字。
2. **S1 游玩主线**：main 侧实现 `HostHandlers`（把每个 channel 接到内核 API 上）+ 渲染进程应用
   （推荐 React + Vite + TS：长叙事流的虚拟滚动、故事树、DB 表格、表单密集的编辑器线都有成熟件）。
3. **开发通道接线**：main 侧同进程起本地 HTTP 服务（POST /rpc + SSE /events），挂同一份 `HostHandlers`；
   只监听 127.0.0.1。

## 许可证

GPL-3.0-or-later（与内核一致）。copyleft 不认仓库边界：同进程嵌入内核并**对外分发**本外壳时，
整个作品须以 GPLv3 兼容条款发布并提供对应源码（仅自用不触发）。约束原文见 `docs/创作规划.md` §3。
