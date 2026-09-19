// CLI 面向用户的文案表。
//
// 现状：**CLI 走英文**（EN）。ZH 是同一批文案的中文版，**留档给未来的 GUI**
// （tavern studio / packages/studio）复用——那里的用户不是开发者，中文才是合适的默认。
//
// 纪律：两侧 key 必须一一对应。改 EN 时同步改 ZH，否则 GUI 侧会缺文案。
// 只放**面向用户**的字符串；代码注释、字段名、命令名、参数名不进这里。
//
// 命名：`label*` 是字段名（视图左侧那一列），`stage*` 是每轮报告的阶段名，
// `turn*` 是每轮报告的措辞。视图只负责排版，措辞一律出自本表。

/** /help 的一组命令：组名 + [命令, 说明]。显式标注元组，视图解构时才不会退化成 string|undefined。 */
export interface HelpGroup {
	title: string;
	items: ReadonlyArray<readonly [string, string]>;
}

/** 带插值的文案用函数；纯静态的用字符串。 */
export const EN = {
	// ---- 启动与退出 ----
	lockedBadge: " · locked",
	untitled: "untitled",
	/** 模式补充行（非创造模式才打）。 */
	modeNoteLocked: "locked, cannot switch",
	modeNoteNormal: "story stage and input checks are on",
	modeRestoredFromMeta: "restored from story.meta.json",
	hint: "Type an action or a line of dialogue to begin. /help for commands, blank line to exit.",
	/** 启动事实块的字段名。 */
	labelSession: "session",
	labelStoryDir: "story",
	labelClock: "clock",
	labelTools: "tools",
	labelPacks: "packs",
	labelEntry: "entry",
	toolsEmpty: "[]",
	toolsEmptyNote: "expected empty: the narrator has no DB tools",

	// ---- 通用 ----
	unknownCommand: (cmd: string) => `Unknown command /${cmd} (see /help)`,
	yes: "yes",
	no: "no",
	none: "none",
	unset: "unset",
	/** 列表分隔符（中文版用「、」，英文用「, 」）。 */
	listSep: ", ",

	// ---- /help ----
	helpTitle: "Commands",
	/** 分组：组名 + [命令, 说明] 列表；视图按最宽命令对齐。 */
	helpGroups: [
		{
			title: "story",
			items: [
				["/tree [n]", "story tree; with n, jump to entry n"],
				["/fork <n>", "fork a new story from entry n"],
				["/swipe", "regenerate the last turn"],
				["/status", "time / location / mode / characters"],
				["/mode [mode]", "show mode; with mode, switch"],
				["/plot <outline>", "write a plot outline (creation only)"],
				["/compact", "compact the session (chapter summary)"],
				["/assist <q>", "side advisor: read-only, not in the narrative"],
			],
		},
		{
			title: "world",
			items: [
				["/packs", "loaded world packs"],
				["/pin <entry>", "pin an entry (injected every turn)"],
				["/unpin <entry>", "unpin"],
				["/reload", "reload world packs"],
			],
		},
		{
			title: "config",
			items: [
				["/agents", "sub-agent switches"],
				["/models", "model per role"],
				["/prompt", "prompt layers"],
				["/write <file>", "write to the DB directly (changeset file)"],
				["/help", "this help"],
			],
		},
	] as HelpGroup[],
	helpKeys: "Blank line to exit · Tab completes · ↑↓ history · Ctrl+C exits.",
	helpModeNote:
		"Modes: creation can take plot outlines; survival / adventure only take character actions and reject out-of-character input.",
	helpForceNote:
		"Prefix /! to force-submit anyway (recorded). In adventure you only see what you have been through.",
	helpAgentNote: "Sub-agents: story / npc / data always on; stylize off unless the pack declares a style.",

	// ---- /tree ----
	treeTitle: "story tree",
	treeEmpty: "(empty story, no entries yet)",
	treeSummary: "[summary]",
	treeBranchSummary: "[branch summary]",
	treeCurrent: "current",
	treeOutOfRange: (arg: string, total: number) => `index ${arg} out of range (${total} entries)`,
	treeNotFound: (arg: string) => `no entry id with prefix: ${arg}`,
	treeNavigating: (id: string, role: string) => `navigateTree(${id}) · ${role} message`,

	// ---- /fork ----
	forkUsage: "usage: /fork <index|entryId>",
	branchedSession: (id: string, file: string) => `new session ${id} (file ${file})`,
	forkedStoryDb: (dir: string, events: number, snaps: number) =>
		`forked story dir ${dir} (events ${events} · snapshots ${snaps})`,
	storySwitched: (from: string, to: string) => `story switched ${from} → ${to}`,

	// ---- /status ----
	statusTitle: "status",
	labelTime: "time",
	labelLocation: "location",
	labelMode: "mode",
	labelCounts: "counts",
	labelCharacters: "characters",
	statusNoNpc: "no characters yet",
	statusCounts: (turns: number, events: number, snaps: number, data: number) =>
		`turns ${turns} · events ${events} · snapshots ${snaps} · data ${data}`,
	statusPacks: (dirs: string, pinned: string) => `${dirs}${pinned}`,
	statusPinnedSuffix: (pinned: string) => ` · pinned ${pinned}`,
	statusIds: (session: string, leaf: string) => `${session} · entry ${leaf}`,
	npcTrait: (trait: string, gauge: string, weight: string) => `${trait}  ${gauge}  ${weight}`,
	npcRelation: (name: string, sign: string, disposition: number) => `→ ${name}  ${sign}${disposition}`,
	npcMemory: (count: number, recent: string) => `memory ${count} · latest ${recent}`,
	unlocated: "unlocated",

	// ---- /packs ----
	packsTitle: "world packs",
	packsEmpty: "(no world packs; retrieval injection is off)",
	packsEntryLine: (count: number, types: string, code: string) => `${count} entries (${types}) · ${code}`,
	packsHasCode: "has code",
	packsContentOnly: "content only",
	packsStoryLine: (title: string, cal: string, gran: string) => `${title} (${cal} / ${gran})`,
	packsReloaded: (list: string) => `reloaded ${list}`,
	packsReloadEntry: (name: string, count: number) => `${name} (${count} entries)`,
	reloadNone: "no world packs loaded",
	packsBadArg: "usage: /packs [add|remove] <dir>… (no args lists loaded packs)",
	packsRemoveMiss: (dirs: string) => `not loaded, nothing changed: ${dirs}`,
	packsRejected: "pack switch failed (load validation failed; nothing changed):",
	pinUsage: "usage: /pin <pack:type:id>",
	pinnedList: (list: string) => `pinned ${list}`,

	// ---- /agents ----
	agentsTitle: (s: string, n: string, st: string, mode: string) =>
		`story ${s} · npc ${n} · stylize ${st} · ${mode} mode`,
	agentsUsage: "usage: /agents <story|npc|stylize> <on|off>",
	agentsOn: "on",
	agentsOff: "off",
	agentsApplied: (s: string, n: string, st: string) =>
		`applied: story ${s} · npc ${n} · stylize ${st}`,
	agentsRejected: "this combination is not allowed in the current mode:",
	agentsBadArg: (text: string) => `usage: ${text}`,

	// ---- /models ----
	modelsTitle: "models",
	modelsNote: "from ~/.tavernpi/settings.json (models); unset falls back to the pi default",
	modelsUnset: "unset · pi default",

	// ---- /prompt ----
	promptTitle: "prompt layers",
	promptLayersNote: "priority story > pack > global > builtin",
	promptChain: (role: string, layer: string) => `${role}  effective ${layer}`,
	promptEffectiveMark: "← effective",
	promptMissing: "none",
	promptChars: (n: number) => `${n} chars`,
	promptQueryFailed: (role: string, msg: string) => `${role}: ${msg}`,
	promptCleared: (role: string) => `cleared the story-layer override for ${role}`,
	promptSet: (role: string, chars: number, src: string) =>
		`set the story-layer override for ${role} (${chars} chars, from ${src})`,
	promptSetHint: "the story layer outranks pack/global/builtin; takes effect next turn.",
	promptLoadUsage: "usage: /prompt <role> load <file>",
	promptUsage: "usage: /prompt | /prompt <role> | /prompt <role> load <file> | /prompt <role> clear",

	// ---- /write ----
	writeUsage: "usage: /write <changeset.json>",
	writeHint:
		"Trusted write: write straight to the story DB from a changeset file (skips the model; nothing is written if validation fails).",
	writeDone: (turn: number, snap: string) => `trusted write done: turn ${turn} · snapshot ${snap}`,
	writeFailed: (msg: string) => `write failed: ${msg}`,

	// ---- /mode ----
	modeInvalid: (arg: string, options: string) => `invalid mode: ${arg} (options: ${options})`,
	modeSwitched: (label: string) => `switched to ${label} (persisted to story.meta.json)`,
	modeSwitchFailed: (msg: string) => `switch failed: ${msg}`,

	// ---- /plot ----
	plotUsage: "usage: /plot <outline>",
	plotWrongMode: "not available: /plot is creation-mode only (survival / adventure reject non-player input).",
	plotWritten: (id: number, text: string) => `plot directive #${id} written: ${text}`,

	// ---- /swipe ----
	swipeUsage: "usage: /swipe (no args; regenerates the last player turn)",
	swipeFailed: (msg: string) => `swipe failed: ${msg}`,

	// ---- /compact ----
	compactUsage: "usage: /compact (no args; triggers chapter-summary compaction)",
	compactDone: (summary: string) => `compaction done: ${summary}`,
	compactReplaced: (tokens: number) => `summary replaced ${tokens} tokens (compaction entry written to the session)`,
	compactSkipped: (msg: string) => `compaction skipped: ${msg}`,

	// ---- /assist ----
	assistUsage: "usage: /assist <question>",
	assistTitle: "side advisor",
	assistHint: "Read-only, draft only, not part of the narrative. The draft below is yours to send or discard.",
	assistFailed: (msg: string) => `assist failed: ${msg}`,

	// ---- 每轮报告 ----
	turnTitle: (n: number) => `turn ${n}`,
	/** 阶段名（与 /agents 的开关名一致）。 */
	stageStory: "story",
	stageNpc: "npc",
	stageStylize: "stylize",
	stageData: "data",
	stagePacks: "packs",
	stageSnapshot: "snapshot",
	turnEmptyNarrative: "(no prose produced this turn; see the warning above)",
	turnSceneFallback: "scene card degraded",
	turnSceneOk: "scene card ok",
	turnReview: (scene: string, conflicts: number, suspicions: number, revisions: number) =>
		`${scene} · conflicts ${conflicts} · suspicions ${suspicions} · rewrites ${revisions}`,
	turnReleasedNote: "released after retries ran out (conflicts recorded)",
	turnNpc: (onstage: number, off: number) => `onstage ${onstage} · offscreen ${off}`,
	turnCollection: (hit: string, warnings: string) => `${hit}${warnings}`,
	turnCollectionNone: "no hits",
	turnCollectionWarnings: (w: string) => ` · warnings ${w}`,
	turnStylize: (state: string, drift: string) => `${state}${drift}`,
	turnStylized: "stylized",
	turnStylizeKept: "kept original",
	turnDrift: (d: string) => ` · drift ${d}`,
	turnDataOk: (events: number, newNpcs: number, time: string, dropped: string) =>
		`events ${events} · new NPCs ${newNpcs} · ${time}${dropped}`,
	turnTimeAdvanced: "time advanced",
	turnTimeUnchanged: "time unchanged",
	turnDropped: (n: number) => ` · dropped ${n}`,
	turnDataFailed: (attempts: number, err: string) => `failed after ${attempts} attempts: ${err}`,
	turnSnapshot: (taken: boolean): string => (taken ? "saved" : "not saved"),

	// ---- 生成期活动行 ----
	// 一行内的阶段词：回答「此刻在做什么」。pipeline 一到多阶段，末尾几个字是正文尾巴。
	activityThinking: "thinking",
	activityWriting: "writing",
	activityNpc: "rehearsing",
	activityReview: "checking",
	activityStylize: "stylizing",
	activityData: "recording",

	// ---- 快照恢复 ----
	restoreTitle: "restore",
	restoreSkipped: "not run (no snapshot hook state)",
	restoreFailed: (err: string) => `failed: ${err}`,
	restoreUnknown: "unknown error",
	restoreOk: (turn: number, entry: string) => `turn ${turn} (entry ${entry})`,
	restoreEmptyFallback: "empty-DB fallback — story data reset to initial state (no snapshot on this branch)",
	restoreClock: (time: string, events: number) => `${time} · ${events} events`,

	// ---- 中断与退出 ----
	ctrlCGenerating: "Ctrl+C received: a turn is still generating, will exit after it finishes. Press again to force quit.",
	ctrlCIdle: "Ctrl+C received: exiting (press again to force quit).",
	forceExit: "force exit (current operation not awaited)",
	storyDirKept: (dir: string) => `story dir kept (not deleted): ${dir}`,
	resumeHint: (cmd: string) => `resume with: ${cmd}`,
	navigatingBusy: "still generating; cannot jump to an entry (wait for this turn to finish)",

	// ---- 输入被拒 ----
	inputRejected: (reason: string) => `input rejected (input-channel check): ${reason}`,
	inputSuggestion: (s: string) => `try instead: ${s}`,
	inputForceHint: "to submit as-is, prefix it with /! (a warning will be recorded).",

	// ---- 交互通道 ----
	interactionConfirmPrompt: (prompt: string) => `${prompt} (y/n)> `,
	interactionBadConfirm: (answer: string) => `invalid confirmation: ${answer} (expected y/n)`,
	interactionBadChoice: "choice interaction needs payload.options (string[])",
	interactionBadIndex: (line: string, max: number) => `invalid option index: ${line} (expected 1-${max})`,
	interactionUnknownKind: (kind: string) => `unknown interaction kind: ${kind}`,
};

/** 参数校验类错误（面向开发者，CLI 与 GUI 都用得到）。 */
export const EN_ERRORS = {
	badModeArg: (options: string) => `--mode accepts only ${options}`,
	unknownArg: (arg: string) => `unknown argument: ${arg}`,
} as const;

/** 模式显示名与条目类型显示名（值与 key 相同；中文版换成「创造 / 角色」等）。
 *
 *  这三项刻意不进 EN/ZH 主体：它们不是「一句话」，而是**标识符到显示名的映射**，
 *  形状固定（CLI 与 GUI 都要按 key 取），所以用接口约束两侧 key 集合一致。 */
export type ModeName = "creation" | "survival" | "adventure";

export interface CliLabels {
	mode: Record<ModeName, string>;
	/** 卡包条目类型：域来自 core 的 ENTRY_TYPES，未收录的类型原样显示，故是开放键集。 */
	entryType: Record<string, string>;
	/** story 树里非消息条目（消息条目直接显示 role）。 */
	entryRole: Record<string, string>;
}

export const EN_LABELS: CliLabels = {
	mode: { creation: "creation", survival: "survival", adventure: "adventure" },
	entryType: {
		character: "character",
		location: "location",
		object: "object",
		faction: "faction",
		plot: "plot",
	},
	entryRole: { custom: "custom", custom_message: "custom message" },
};
