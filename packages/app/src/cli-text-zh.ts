// CLI 文案的**中文版**。CLI 当前不使用它，保留给未来的 GUI（tavern-studio）——
// 那里的用户不是开发者，中文才是合适的默认。
//
// 与 `cli-text-en.ts` 的 key 一一对应；改一侧时同步改另一侧，否则 GUI 会缺文案。
// 中文标点用全角（：·——「」），参数占位与英文版保持一致。

import type { EN } from "./cli-text-en.ts";

export const ZH: typeof EN = {
	// ---- 启动与退出 ----
	banner: (title, mode, locked) => `═══ 《${title}》 · ${mode}${locked} ═══`,
	modeNote: (mode, info) => `模式：${mode}（${info}）`,
	modeNoteLocked: "已锁定，不可切换",
	modeNoteNormal: "story 阶段 / 输入校验生效",
	hint: "直接输入行动或对话开始。命令见 /help，空行退出。",
	lockedBadge: " · 已锁定",
	untitled: "未命名故事",
	sessionId: (id) => `> 会话：${id}`,
	storyDir: (dir) => `> 故事目录：${dir}`,
	toolWhitelist: (tools) => `工具白名单：[${tools}]（应为空：主叙事不挂 DB 工具）`,
	modeRestoredFromMeta: (mode) => `> 恢复模式：${mode}（来自 story.meta.json）`,
	clockInit: (t, cal, gran) => `> clock 初值：${t}（${cal}/${gran}）`,
	packsLoaded: (names) => `> 已加载世界包：${names}`,

	// ---- 通用 ----
	unknownCommand: (cmd) => `未知命令 /${cmd}（见 /help）`,
	usage: (text) => `用法：${text}`,
	yes: "是",
	no: "否",
	none: "无",
	unset: "未设置",
	listSep: "、",

	// ---- /help ----
	helpTitle: "命令：",
	helpGroups: [
		"  /tree [n]       看故事树；带 n 跳到第 n 条",
		"  /fork <n>       从第 n 条分叉新故事",
		"  /swipe          重生成最后一轮",
		"  /status         时间 / 位置 / 模式 / NPC",
		"  /mode [模式]    看模式；带模式则切换",
		"  /plot <大纲>    写剧情大纲（仅创造模式）",
		"  /compact        压缩会话（生成章节摘要）",
		"  /assist <问题>  旁路顾问：只读，不进叙事",
		"",
		"  /packs          已加载的世界包",
		"  /pin <条目id>   固定条目（每轮必注入）",
		"  /unpin <条目id> 取消固定",
		"  /reload         重载世界包",
		"",
		"  /agents         子代理开关",
		"  /models         各角色用的模型",
		"  /prompt         提示词分层",
		"  /write <文件>   直接写库（变更集文件）",
		"  /help           本帮助",
	],
	helpKeys: "空行退出。Tab 补全，↑↓ 翻历史，Ctrl+C 退出。",
	helpModeNote: "模式：创造可写大纲；生存 / 冒险只收角色行动，越权输入会被拒。",
	helpForceNote: "  打 /! 前缀可强制提交（留记录）。冒险模式只能看到自己经历过的事。",
	helpAgentNote: "子代理：story / npc / data 恒开；stylize 默认关，卡包声明文风时开。",

	// ---- /tree ----
	treeTitle: "── 故事树 ──",
	treeEmpty: "（空故事，尚无叙事条目）",
	treeSummary: "[摘要]",
	treeBranchSummary: "[分支摘要]",
	treeCurrent: "当前",
	treeOutOfRange: (arg, total) => `序号 ${arg} 超出范围（共 ${total} 条消息）`,
	treeNotFound: (arg) => `找不到 entry id 前缀：${arg}`,
	treeNavigating: (id, role) => `> navigateTree(${id})（${role} 消息）`,

	// ---- /fork ----
	forkUsage: "用法：/fork <序号|entryId>",
	branchedSession: (id, file) => `> createBranchedSession → 新 sessionId=${id}（文件 ${file}）`,
	forkedStoryDb: (dir, events, snaps) =>
		`> forkStoryDb → 新故事目录 ${dir}（events=${events}，snapshots=${snaps} 份）`,
	storySwitched: (from, to) => `> 已切换故事：${from} → ${to}`,

	// ---- /status ----
	statusTitle: "── 状态 ──",
	statusLine: (time, pos, mode) => `时间：${time} · 位置：${pos} · 模式：${mode}`,
	statusNoNpc: "暂无登场角色。",
	statusNpc: (name, id, status, loc) => `◆ ${name} #${id}（${status}）@ ${loc}`,
	statusCounts: (turns, events, snaps, data) =>
		`轮数：${turns} · 事件：${events} · 快照：${snaps} · 落库：${data}`,
	statusPacks: (dirs, pinned) => `世界包：${dirs}${pinned}`,
	statusPinnedSuffix: (pinned) => ` · 固定：${pinned}`,
	statusIds: (session, leaf) => `会话：${session} · 条目：${leaf}`,
	npcTrait: (trait, gauge, weight) => `    特征 ${trait} ${gauge} ${weight}`,
	npcRelation: (name, sign, disposition) => `    关系 对 ${name} ${sign}${disposition}`,
	npcMemory: (count, recent) => `    记忆：${count} 条 · 最近：${recent}`,
	unlocated: "未定位",

	// ---- /packs ----
	packsTitle: "世界包：",
	packsNone: "── 世界包：无（未启用检索注入）──",
	packsEntry: (name, dir) => `  ${name}  ${dir}`,
	packsEntryLine: (count, types, code) => `    ${count} 条目（${types}）· ${code}`,
	packsHasCode: "含代码",
	packsContentOnly: "纯内容包",
	packsStoryLine: (title, cal, gran) => `    ${title}（${cal} / ${gran}）`,
	packsReloaded: (list) => `> 已重载：${list}`,
	packsReloadEntry: (name, count) => `${name}(${count} 条目)`,
	reloadNone: "> 无卡包",
	pinUsage: "用法：/pin <包名:type:id>",

	// ---- /agents ----
	agentsTitle: (s, n, st, mode) => `子代理：story ${s} · npc ${n} · stylize ${st}（${mode}模式）`,
	agentsUsage: "  用法：/agents <story|npc|stylize> <on|off>",
	agentsOn: "开",
	agentsOff: "关",
	agentsApplied: (s, n, st) => `子代理：story ${s} · npc ${n} · stylize ${st}（已生效）`,
	agentsRejected: "! 该开关组合不符合当前模式预设：",
	agentsBadArg: (text) => `用法：${text}`,

	// ---- /models ----
	modelsTitle: "各角色模型（配置：~/.tavernpi/settings.json 的 models）",
	modelsUnset: "未配置 · 用 pi 默认",

	// ---- /prompt ----
	promptLayers: "提示词生效层（优先级 story > pack > global > builtin）：",
	promptChain: (role, layer) => `${role}（生效层：${layer}）`,
	promptEffectiveMark: " ←生效",
	promptMissing: "无",
	promptChars: (n) => `${n} 字符`,
	promptQueryFailed: (role, msg) => `  ${role}：${msg}`,
	promptCleared: (role) => `> 已清除 ${role} 的 story 层覆盖`,
	promptSet: (role, chars, src) => `> 已设置 ${role} 的 story 层覆盖（${chars} 字符，来源 ${src}）`,
	promptSetHint: "  提示：story 层优先于 pack/global/builtin；下一轮生效。",
	promptBadRole: (msg) => `! ${msg}`,
	promptLoadUsage: "用法：/prompt <角色> load <文件路径>",
	promptUsage: "用法：/prompt | /prompt <角色> | /prompt <角色> load <文件> | /prompt <角色> clear",

	// ---- /write ----
	writeUsage: "用法：/write <changeset.json>",
	writeHint: "  受信任写入：按变更集格式直接写入故事库（跳过模型，校验不通过则完全不写入）。",
	writeDone: (turn, snap) => `> 受信任写入完成：第 ${turn} 轮 · 快照：${snap}`,
	writeFailed: (msg) => `! 写入失败：${msg}`,

	// ---- /mode ----
	modeCurrent: (label, mode) => `> 当前模式：${label}（${mode}）`,
	modeInvalid: (arg, options) => `> 非法模式：${arg}（可选：${options}）`,
	modeSwitched: (label) => `> 已切换到 ${label}（story.meta.json 已持久化）`,
	modeSwitchFailed: (msg) => `> 切换失败：${msg}`,

	// ---- /plot ----
	plotUsage: "用法：/plot <剧情大纲>",
	plotWrongMode: "! 该模式不可用：/plot 仅创造模式合法（剧情大纲指令；生存 / 冒险拒绝非玩家输入）。",
	plotWritten: (id, text) => `> 已写入剧情指令 #${id}：${text}`,

	// ---- /swipe ----
	swipeUsage: "用法：/swipe（无参数，重生成最后一个玩家轮次）",
	swipeFailed: (msg) => `> swipe 失败：${msg}`,

	// ---- /compact ----
	compactUsage: "用法：/compact（无参数，触发章节摘要压缩）",
	compactDone: (summary) => `> 压缩完成：${summary}`,
	compactReplaced: (tokens) => `> 摘要替换 ${tokens} tokens（压缩条目已写入会话）`,
	compactSkipped: (msg) => `> 压缩已跳过：${msg}`,

	// ---- /assist ----
	assistUsage: "用法：/assist <问题>",
	assistTitle: "── 旁路顾问 ──",
	assistHint: "只读、只出草稿、不进叙事。下面是草稿，发不发由你决定。",
	assistFailed: (msg) => `> assist 失败：${msg}`,

	// ---- 每轮报告 ----
	turnHeader: (n) => `\n────────── 第 ${n} 轮 ──────────`,
	turnEmptyNarrative: "（本轮没有产出正文，无内容可显示；原因见上方警告）",
	turnCollectionNone: "无命中",
	turnCollectionWarnings: (w) => ` · 警告：${w}`,
	turnCollection: (hit, warnings) => `· 世界包：${hit}${warnings}`,
	turnNpc: (onstage, off) => `· NPC：在场 ${onstage} · 离线 ${off}`,
	turnReview: (scene, conflicts, suspicions, revisions) =>
		`· 审查：${scene} · 冲突 ${conflicts} · 存疑 ${suspicions} · 重写 ${revisions}`,
	turnSceneFallback: "场景卡降级",
	turnSceneOk: "场景卡正常",
	turnReleasedNote: "! 重写用尽后放行（冲突已记录）",
	turnStylize: (state, drift) => `· 润色：${state}${drift}`,
	turnStylized: "已润色",
	turnStylizeKept: "保持原文",
	turnDrift: (d) => ` · 偏离：${d}`,
	turnDataOk: (events, newNpcs, time, dropped) =>
		`· 落库：成功 · 事件 ${events} · 新增 NPC ${newNpcs} · ${time}${dropped}`,
	turnTimeAdvanced: "已推进时间",
	turnTimeUnchanged: "时间未动",
	turnDropped: (n) => ` · 剔除 ${n} 项`,
	turnDataFailed: (attempts, err) => `! 落库失败（试了 ${attempts} 次）：${err}`,
	turnSnapshot: (taken) => `· 快照：${taken ? "已保存" : "未保存"}`,

	// ---- 快照恢复 ----
	restoreSkipped: "> 恢复：未执行（无快照钩子状态）",
	restoreFailed: (err) => `> 恢复失败：${err}`,
	restoreUnknown: "未知错误",
	restoreOk: (turn, entry) => `> 恢复成功：turn${turn}（entry ${entry}）`,
	restoreEmptyFallback: "> 恢复成功（空库兜底）",
	restoreClock: (time, events) => `> 当前 clock：${time} · 事件 ${events} 条`,

	// ---- 中断与退出 ----
	ctrlCGenerating: "\n> 已收到 Ctrl+C：当前轮仍在生成，会在它结束后退出；再按一次立即强制退出。",
	ctrlCIdle: "\n> 已收到 Ctrl+C：正在退出（再按一次可强制立即退出）。",
	forceExit: "\n> 强制退出（未等当前操作完成）",
	storyDirKept: (dir) => `> 故事目录保留（未删）：${dir}`,
	resumeHint: (cmd) => `> 可续写：${cmd}`,
	navigatingBusy: "> 正在生成中，此时不能跳转条目（请等这一轮结束）",

	// ---- 输入被拒 ----
	inputRejected: (reason) => `! 输入被拒绝（输入渠道校验）：${reason}`,
	inputSuggestion: (s) => `! 建议改写：${s}`,
	inputForceHint: "! 如确需原样提交，以 /! 开头强制提交（将留痕 warning）。",

	// ---- 交互通道 ----
	interactionBadConfirm: (answer) => `非法确认输入：${answer}（应为 y/n）`,
	interactionConfirmPrompt: (prompt) => `${prompt}（y/n）> `,
	interactionBadChoice: "choice 交互缺合法 payload.options（string[]）",
	interactionBadIndex: (line, max) => `非法选项序号：${line}（应为 1-${max}）`,
	interactionUnknownKind: (kind) => `未知交互 kind：${kind}`,
};
