// CLI 文案的**中文版**。CLI 当前不使用它，保留给未来的 GUI（tavern studio / packages/studio）——
// 那里的用户不是开发者，中文才是合适的默认。
//
// 与 `cli-text-en.ts` 的 key 一一对应（`ZH: typeof EN` 把它变成编译期约束，少一个 key 就不过）；
// 改一侧时同步改另一侧，否则 GUI 会缺文案。
// 中文标点用全角（：·——「」），参数占位与英文版保持一致；命令名 / 参数名保持原样。

import type { CliLabels, EN } from "./cli-text-en.ts";

export const ZH: typeof EN = {
	// ---- 启动与退出 ----
	lockedBadge: " · 已锁定",
	untitled: "未命名故事",
	modeNoteLocked: "已锁定，不可切换",
	modeNoteNormal: "story 阶段与输入校验生效",
	modeRestoredFromMeta: "由 story.meta.json 恢复",
	hint: "直接输入行动或对话开始。命令见 /help，空行退出。",
	labelSession: "会话",
	labelStoryDir: "故事目录",
	labelClock: "时钟",
	labelTools: "工具",
	labelPacks: "世界包",
	labelEntry: "条目",
	toolsEmpty: "[]",
	toolsEmptyNote: "应为空：主叙事不挂数据库工具",

	// ---- 通用 ----
	unknownCommand: (cmd) => `未知命令 /${cmd}（见 /help）`,
	yes: "是",
	no: "否",
	none: "无",
	unset: "未设置",
	listSep: "、",

	// ---- /help ----
	helpTitle: "命令",
	helpGroups: [
		{
			title: "叙事",
			items: [
				["/tree [n]", "看故事树；带 n 跳到第 n 条"],
				["/fork <n>", "从第 n 条分叉出新故事"],
				["/swipe", "重生成最后一轮"],
				["/status", "时间 / 位置 / 模式 / 角色"],
				["/mode [模式]", "看模式；带模式则切换"],
				["/plot <大纲>", "写剧情大纲（仅创造模式）"],
				["/compact", "压缩会话（生成章节摘要）"],
				["/assist <问题>", "旁路顾问：只读，不进叙事"],
			],
		},
		{
			title: "世界",
			items: [
				["/packs", "已加载的世界包"],
				["/packs add|remove <目录>", "装载/卸载世界包（改的是装载关系，不动磁盘文件）"],
				["/pin <条目id>", "固定条目（每轮必注入）"],
				["/unpin <条目id>", "取消固定"],
				["/reload", "重载世界包"],
			],
		},
		{
			title: "配置",
			items: [
				["/agents", "子代理开关"],
				["/models", "各角色用的模型"],
				["/prompt", "提示词分层"],
				["/write <文件>", "直接写库（变更集文件）"],
				["/help", "本帮助"],
			],
		},
	],
	helpKeys: "空行退出 · Tab 补全 · ↑↓ 翻历史 · Ctrl+C 退出",
	helpModeNote: "模式：创造可写大纲；生存 / 冒险只收角色行动，越权输入会被拒。",
	helpForceNote: "打 /! 前缀可强制提交（留记录）。冒险模式只能看到自己经历过的事。",
	helpAgentNote: "子代理：story / npc / data 恒开；stylize 默认关，卡包声明文风时开。",

	// ---- /tree ----
	treeTitle: "故事树",
	treeEmpty: "（空故事，还没有条目）",
	treeSummary: "［摘要］",
	treeBranchSummary: "［分支摘要］",
	treeCurrent: "当前",
	treeOutOfRange: (arg, total) => `第 ${arg} 条超出范围（共 ${total} 条）`,
	treeNotFound: (arg) => `没有以 ${arg} 开头的条目 id`,
	treeNavigating: (id, role) => `跳转 ${id} · ${role} 消息`,

	// ---- /fork ----
	forkUsage: "用法：/fork <序号|条目id>",
	branchedSession: (id, file) => `新会话 ${id}（文件 ${file}）`,
	forkedStoryDb: (dir, events, snaps) => `分叉故事目录 ${dir}（事件 ${events} · 快照 ${snaps}）`,
	storySwitched: (from, to) => `已切换故事 ${from} → ${to}`,

	// ---- /status ----
	statusTitle: "状态",
	labelTime: "时间",
	labelLocation: "位置",
	labelMode: "模式",
	labelCounts: "计数",
	labelCharacters: "角色",
	statusNoNpc: "还没有角色",
	statusCounts: (turns, events, snaps, data) => `轮次 ${turns} · 事件 ${events} · 快照 ${snaps} · 数据 ${data}`,
	statusPacks: (dirs, pinned) => `${dirs}${pinned}`,
	statusPinnedSuffix: (pinned) => ` · 已固定 ${pinned}`,
	statusIds: (session, leaf) => `${session} · 条目 ${leaf}`,
	npcTrait: (trait, gauge, weight) => `${trait}  ${gauge}  ${weight}`,
	npcRelation: (name, sign, disposition) => `→ ${name}  ${sign}${disposition}`,
	npcMemory: (count, recent) => `记忆 ${count} 条 · 最近 ${recent}`,
	unlocated: "未定位",

	// ---- /packs ----
	packsTitle: "世界包",
	packsEmpty: "（没有世界包；检索注入已关闭）",
	packsEntryLine: (count, types, code) => `${count} 个条目（${types}）· ${code}`,
	packsHasCode: "含代码",
	packsContentOnly: "纯内容",
	packsStoryLine: (title, cal, gran) => `${title}（${cal} / ${gran}）`,
	packsReloaded: (list) => `已重载 ${list}`,
	packsReloadEntry: (name, count) => `${name}（${count} 个条目）`,
	reloadNone: "没有加载任何世界包",
	packsBadArg: "用法：/packs [add|remove] <目录>…（不给参数则列出已加载的包）",
	packsRemoveMiss: (dirs) => `没有装载这些目录，未做改动：${dirs}`,
	packsRejected: "换包失败（加载校验未过，未做任何改动）：",
	pinUsage: "用法：/pin <包名:类型:id>",
	pinnedList: (list) => `已固定 ${list}`,

	// ---- /agents ----
	agentsTitle: (s, n, st, mode) => `story ${s} · npc ${n} · stylize ${st} · ${mode} 模式`,
	agentsUsage: "用法：/agents <story|npc|stylize> <on|off>",
	agentsOn: "开",
	agentsOff: "关",
	agentsApplied: (s, n, st) => `已生效：story ${s} · npc ${n} · stylize ${st}`,
	agentsRejected: "当前模式下这个组合不合法：",
	agentsBadArg: (text) => `用法：${text}`,

	// ---- /models ----
	modelsTitle: "模型",
	modelsNote: "来自 ~/.tavernpi/settings.json 的 models；未设置则走 pi 默认",
	modelsUnset: "未设置 · pi 默认",

	// ---- /prompt ----
	promptTitle: "提示词分层",
	promptLayersNote: "优先级 story > 卡包 > 全局 > 内置",
	promptChain: (role, layer) => `${role}  生效层 ${layer}`,
	promptEffectiveMark: "← 生效",
	promptMissing: "无",
	promptChars: (n) => `${n} 字`,
	promptQueryFailed: (role, msg) => `${role}：${msg}`,
	promptCleared: (role) => `已清除 ${role} 的故事层覆盖`,
	promptSet: (role, chars, src) => `已设置 ${role} 的故事层覆盖（${chars} 字，来自 ${src}）`,
	promptSetHint: "故事层优先于卡包 / 全局 / 内置；下一轮生效。",
	promptLoadUsage: "用法：/prompt <角色> load <文件>",
	promptUsage: "用法：/prompt | /prompt <角色> | /prompt <角色> load <文件> | /prompt <角色> clear",

	// ---- /write ----
	writeUsage: "用法：/write <变更集.json>",
	writeHint: "受信任写入：用变更集文件直接写故事库（不经模型；校验不通过则一个字都不落库）。",
	writeDone: (turn, snap) => `已写入：第 ${turn} 轮 · 快照 ${snap}`,
	writeFailed: (msg) => `写入失败：${msg}`,

	// ---- /mode ----
	modeInvalid: (arg, options) => `模式无效：${arg}（可选：${options}）`,
	modeSwitched: (label) => `已切换到 ${label}（已写回 story.meta.json）`,
	modeSwitchFailed: (msg) => `切换失败：${msg}`,

	// ---- /plot ----
	plotUsage: "用法：/plot <大纲>",
	plotWrongMode: "不可用：/plot 仅限创造模式（生存 / 冒险不收非玩家输入）。",
	plotWritten: (id, text) => `已写入剧情指令 #${id}：${text}`,

	// ---- /swipe ----
	swipeUsage: "用法：/swipe（无参数；重生成最后一个玩家轮次）",
	swipeFailed: (msg) => `重骰失败：${msg}`,

	// ---- /compact ----
	compactUsage: "用法：/compact（无参数；触发章节摘要压缩）",
	compactDone: (summary) => `压缩完成：${summary}`,
	compactReplaced: (tokens) => `摘要替换了 ${tokens} tokens（压缩条目已写入会话）`,
	compactSkipped: (msg) => `跳过压缩：${msg}`,

	// ---- /assist ----
	assistUsage: "用法：/assist <问题>",
	assistTitle: "旁路顾问",
	assistHint: "只读、草稿制、不进叙事。下面这段是草稿，发不发由你。",
	assistFailed: (msg) => `顾问失败：${msg}`,

	// ---- 每轮报告 ----
	turnTitle: (n) => `第 ${n} 轮`,
	stageStory: "审查",
	stageNpc: "角色",
	stageStylize: "文风",
	stageData: "落库",
	stagePacks: "世界包",
	stageSnapshot: "快照",
	turnEmptyNarrative: "（本轮没有正文；原因见上方提示）",
	turnSceneFallback: "场景卡降级兜底",
	turnSceneOk: "场景卡正常",
	turnReview: (scene, conflicts, suspicions, revisions) =>
		`${scene} · 冲突 ${conflicts} · 存疑 ${suspicions} · 重写 ${revisions}`,
	turnReleasedNote: "重写次数用尽后放行（冲突已记录）",
	turnNpc: (onstage, off) => `在场 ${onstage} · 离线 ${off}`,
	turnCollection: (hit, warnings) => `${hit}${warnings}`,
	turnCollectionNone: "无命中",
	turnCollectionWarnings: (w) => ` · 警告 ${w}`,
	turnStylize: (state, drift) => `${state}${drift}`,
	turnStylized: "已润色",
	turnStylizeKept: "保持原文",
	turnDrift: (d) => ` · 偏离 ${d}`,
	turnDataOk: (events, newNpcs, time, dropped) => `事件 ${events} · 新增 NPC ${newNpcs} · ${time}${dropped}`,
	turnTimeAdvanced: "时间推进",
	turnTimeUnchanged: "时间未动",
	turnDropped: (n) => ` · 剔除 ${n}`,
	turnDataFailed: (attempts, err) => `尝试 ${attempts} 次后失败：${err}`,
	turnSnapshot: (taken: boolean): string => (taken ? "已保存" : "未保存"),

	// ---- 生成期活动行 ----
	activityThinking: "思考中",
	activityWriting: "落笔中",
	activityNpc: "角色推演",
	activityReview: "审查",
	activityStylize: "润色",
	activityData: "落库",

	// ---- 快照恢复 ----
	restoreTitle: "快照恢复",
	restoreSkipped: "未执行（没有快照钩子状态）",
	restoreFailed: (err) => `失败：${err}`,
	restoreUnknown: "未知错误",
	restoreOk: (turn, entry) => `第 ${turn} 轮（条目 ${entry}）`,
	restoreEmptyFallback: "空库兜底——故事数据已重置为初始态（该分支无快照）",
	restoreClock: (time, events) => `${time} · ${events} 个事件`,

	// ---- 中断与退出 ----
	ctrlCGenerating: "收到 Ctrl+C：当前轮还在生成，等它结束就退出。再按一次强制退出。",
	ctrlCIdle: "收到 Ctrl+C：正在退出（再按一次强制退出）。",
	forceExit: "强制退出（当前操作不再等待）",
	storyDirKept: (dir) => `故事目录已保留（未删除）：${dir}`,
	resumeHint: (cmd) => `续写命令：${cmd}`,
	navigatingBusy: "还在生成，无法跳转条目（等这一轮结束）",

	// ---- 输入被拒 ----
	inputRejected: (reason) => `输入被拒（输入渠道校验）：${reason}`,
	inputSuggestion: (s) => `可以改成：${s}`,
	inputForceHint: "要原样提交，就在前面加 /!（会留下记录）。",

	// ---- 交互通道 ----
	interactionConfirmPrompt: (prompt) => `${prompt}（y/n）> `,
	interactionBadConfirm: (answer) => `确认无效：${answer}（应为 y/n）`,
	interactionBadChoice: "choice 交互需要 payload.options（字符串数组）",
	interactionBadIndex: (line, max) => `选项序号无效：${line}（应为 1-${max}）`,
	interactionUnknownKind: (kind) => `未知的交互类型：${kind}`,
};

/** 模式与条目类型的显示名（`CliLabels` 约束两侧 key 一致；英文版就是 key 本身）。 */
export const ZH_LABELS: CliLabels = {
	mode: { creation: "创造", survival: "生存", adventure: "冒险" },
	entryType: {
		character: "角色",
		location: "地点",
		object: "物品",
		faction: "势力",
		plot: "剧情",
	},
	entryRole: { custom: "自定义", custom_message: "自定义消息" },
};
