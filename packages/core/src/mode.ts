// 内核级模式预设（★信任边界）。
//
// 三模式（creation/survival/adventure）是内核级声明式预设，不是 UI 层的隐藏：TUI 与外部 UI
// （如 tavern studio）走同一套内核强制执行——subagent 启用集合、切换规则、锁定，均由内核判定，
// 绕过界面也无法越权。
//
// 本模块为「纯」模式描述与校验（无 I/O、无副作用）：MODE_PRESETS 描述各模式的强制项与切换面；
// validateSubagentSwitches 校验 subagent 开关组合；canSwitchMode/assertCanSwitchMode 判定切换规则。
// 持久化（story.meta.json）与运行时接线（mode 解析、setMode、构建期校验）见 story.ts / pipeline/runtime.ts。
//
// 【交互响应开关】属 UI 层（不注册 handler 即关；broker 已有 InteractionUnavailableError 降级路径），
// 本模块不做运行时强制，仅在 ModePreset.toggleable 以声明性字段指示该开关在对应模式下的可关性。

export type StoryMode = "creation" | "survival" | "adventure";

/** 精确匹配三值的类型守卫（★信任边界）：拒绝非法字符串形态（如 "Survival"）。
 *  供 resolveStoryMode / createStory / setMode 等入口统一校验，非法值构建期报错而非首次消费时的 TypeError。 */
export function isStoryMode(v: unknown): v is StoryMode {
	return v === "creation" || v === "survival" || v === "adventure";
}

/** subagent 开关组合（validateSubagentSwitches 的输入；data 不可关，runtime 本无 data 开关，天然满足）。 */
export interface SubagentSwitchFlags {
	story: boolean;
	npc: boolean;
	stylize: boolean;
}

/**
 * 模式预设（声明式）。只描述「该模式强制什么、允许切换什么」，不做任何副作用。
 * 字段语义：
 * - toggleable：可关闭的 subagent/交互开关白名单（data 不在内 = 不可关）。adventure 为空 = 全锁。
 * - directivesAllowed：剧情大纲指令是否合法（仅创造；生存/冒险拒绝非 user 角色行为）。
 * - inputValidation：是否做输入渠道校验（生存/冒险 true；创造 false，允许剧情大纲指令）。
 * - dbViewFilter：冒险为 user-related，其余 none。本模块只做声明，实际过滤由查询层落实
 *   （DbView；assist 与 CLI 的 /status 都按此字段取值）。
 * - switchableTo：可切换到的模式；adventure 为空数组（锁定，不可切入切出）。
 * - locked：adventure true（创建时选定后锁定）。
 */
export interface ModePreset {
	toggleable: ReadonlySet<"story" | "npc" | "stylize" | "interaction">;
	directivesAllowed: boolean;
	inputValidation: boolean;
	dbViewFilter: "none" | "user-related";
	switchableTo: readonly StoryMode[];
	locked: boolean;
}

export const MODE_PRESETS: Record<StoryMode, ModePreset> = {
	creation: {
		toggleable: new Set(["story", "npc", "stylize", "interaction"]),
		directivesAllowed: true,
		inputValidation: false,
		dbViewFilter: "none",
		switchableTo: ["survival"],
		locked: false,
	},
	survival: {
		toggleable: new Set(["stylize"]),
		directivesAllowed: false,
		inputValidation: true,
		dbViewFilter: "none",
		switchableTo: ["creation"],
		locked: false,
	},
	adventure: {
		toggleable: new Set(),
		directivesAllowed: false,
		inputValidation: true,
		dbViewFilter: "user-related",
		switchableTo: [],
		locked: true,
	},
};

/**
 * 校验 subagent 开关组合是否合法（返回中文违规问题列表；空数组 = 合法）。
 * 规则：
 * - creation：story/npc/stylize 可关；但 story 可关的前提 = stylize 与 npc 均已关
 *   （审查的主要对象不存在时审查才可关）；data 不可关（runtime 本无 data 开关）。
 * - survival：story/npc 必须开，仅 stylize 可关。
 * - adventure：story/npc/stylize 全部强制开。
 */
export function validateSubagentSwitches(mode: StoryMode, flags: SubagentSwitchFlags): string[] {
	const problems: string[] = [];
	switch (mode) {
		case "creation": {
			if (!flags.story) {
				if (flags.npc) problems.push("story 已关，但 npc 仍开——创造模式下 story 可关的前提是 npc 与 stylize 均已关");
				if (flags.stylize) problems.push("story 已关，但 stylize 仍开——创造模式下 story 可关的前提是 npc 与 stylize 均已关");
			}
			break;
		}
		case "survival": {
			if (!flags.story) problems.push("survival（生存）模式下 story 必须开");
			if (!flags.npc) problems.push("survival（生存）模式下 npc 必须开");
			break;
		}
		case "adventure": {
			if (!flags.story) problems.push("adventure（冒险）模式下 story 必须开");
			if (!flags.npc) problems.push("adventure（冒险）模式下 npc 必须开");
			if (!flags.stylize) problems.push("adventure（冒险）模式下 stylize 必须开");
			break;
		}
	}
	return problems;
}

/** 是否可从 from 切换到 to。adventure 锁定（switchableTo 空数组 → 任何切换含「切出」都拒绝）。 */
export function canSwitchMode(from: StoryMode, to: StoryMode): boolean {
	return MODE_PRESETS[from].switchableTo.includes(to);
}

/** 断言可切换；非法抛中文 Error。 */
export function assertCanSwitchMode(from: StoryMode, to: StoryMode): void {
	if (canSwitchMode(from, to)) return;
	if (MODE_PRESETS[from].locked) {
		throw new Error(`故事模式已锁定为 ${from}（冒险），不能切换（含切出）；如确需更换请新建故事。`);
	}
	throw new Error(
		`不能从 ${from} 切换到 ${to}（${from} 仅允许 → ${MODE_PRESETS[from].switchableTo.join(" / ") || "无"}）。`,
	);
}
