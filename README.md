# tavernpi

故事引擎 harness——把 pi coding agent 的「编码 agent harness」范式平移到互动叙事领域。基于 pi SDK（`@earendil-works/pi-coding-agent`，npm 依赖不 fork）二次创作：一个主叙事 session 执笔，story/npc/data/stylize 四类 subagent 流水线协作，一切长期记忆落 SQLite（**对话历史是草稿，数据库才是事实**）。

- **当前状态**：M0–M6 全部验收通过（故事 DB / data / npc / story+stylize / 卡包系统 / 模式与体验）
- **内核对外 API**：`@tavernpi/core`（CORE_VERSION 0.6.0）

## 快速开始

前置：Node.js ≥ 24；`npm install`；pi 的 `auth.json` 配好模型 key（验收用 deepseek-v4-flash）。

```bash
# 开新故事（无卡包、默认创造模式）
npm run m6:cli

# 带卡包 + 生存模式
npm run m6:cli -- --pack ./my_world --mode survival

# 续写（每次退出时 CLI 会打印这行命令）
npm run m6:cli -- --resume <session 文件路径>
```

CLI 参数：`--pack <目录>`（可重复）· `--mode creation|survival|adventure`（仅创建时有效，冒险选定后锁定）· `--style <文风>`（开 stylize 润色）· `--root <目录>`（故事数据目录，默认 `~/.tavernpi`）。

玩法：直接输入角色行动/对话回车即一轮叙事。命令一览（`/help` 有完整版）：

| 命令 | 作用 |
|---|---|
| `/tree` `/tree <序号>` | 故事树浏览 / 跳节点回溯（DB 与时钟随快照恢复） |
| `/swipe` | 重骰最后一轮（旧稿留树） |
| `/fork <序号>` | 从节点分叉新故事（模式与锁定继承） |
| `/status` | 状态面板（时间/位置/NPC 卡） |
| `/mode <模式>` | 切换模式（创造↔生存；冒险锁定） |
| `/plot <大纲>` | 剧情大纲指令（仅创造模式） |
| `/! <输入>` | 强制提交被拦的输入（生存/冒险，留痕 warning） |
| `/assist <问题>` | 带外顾问（不进叙事流；冒险模式只知玩家该知道的） |
| `/compact` | 手动章节摘要（保留伏笔/在场 NPC/阶段目标） |

## 三个内置模式

| | 创造 | 生存 | 冒险 |
|---|---|---|---|
| 定位 | 小说创作辅助 | 高代入 RP（世界透明） | 高代入 RP（信息迷雾） |
| 输入 | 行动/对话 + 剧情大纲指令 | 仅 user 角色行动/对话 | 同生存，且 DB 查看仅「与 user 相关」 |
| subagent | story/npc/stylize 可关 | 仅 stylize 可关 | 全部强制开 |
| 切换 | ↔ 生存随时互切 | ↔ 创造 | 创建时选定后锁定 |

## 创建卡包（世界包）

一个世界包 = 一部作品的完整设定（设定集 YAML + SQL + 可选代码），纯内容包零代码：

```bash
node packages/tools/src/cli.ts init ./my_world     # 生成骨架
node packages/tools/src/cli.ts check ./my_world    # 全量校验 + 内存库试跑 SQL
node packages/tools/src/cli.ts templates           # SQL 表模板库（可抄改）
```

卡作者文档：`packages/tools/README.md`；活例子：`packages/app/acceptance/fixtures/shouling/`。

## 仓库结构

```
packages/
├── core/   # @tavernpi/core：turn pipeline 编排 + DB 层 + 快照 + subagent 体系
│           # + 提示词分层 + 卡包加载 + 模式预设/视图过滤 + assist + 对外 API
├── app/    # CLI（m6:cli 为当前形态）+ 里程碑验收脚本（acceptance/）+ spike 工件
└── tools/  # @tavernpi/tools：卡包校验/骨架/模板 CLI
```

## 开发

```bash
npm test              # core 单测（node --test）
npm run typecheck     # core + app
npm run m6:accept     # M6 故事驱动验收（真实 LLM；m1-m5 同理 m1:accept…m5:accept）
```

里程碑交付状态与验收证据见 `packages/app/acceptance/`（m1–m6 各一个验收脚本）。
