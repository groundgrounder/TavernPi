// M6 交互 CLI（人工验收入口，三模式 +「输入渠道校验判定」）：模式切换 + 输入校验叙事循环。
//
// 与 m5-cli 的关系：命令/LineQueue/fork 重建全同，差异是内核级模式连通——
//   新故事经 createStory 传 mode（仅创建时有效）；runtime 模式解析（option → story.meta.json → creation）；
//   `/mode` 查看/切换模式（catch 非法切换错）；`/plot` 创造模式专属（剧情大纲指令）；
//   用户输入以 `/! ` 开头 → 去前缀 + force:true（输入渠道校验强制提交，留痕 warning）；
//   catch InputRejectedError → 打印 reason/suggestion（叙事不产生）；`--resume` 从 meta 恢复 mode。
// 目的：验收契约——三模式预设/切换规则/adventure 锁定/fork 继承模式；输入渠道校验
//   （生存/冒险拒非 user 输入、`/!` 强制提交、创造不校验、/plot 指令）。
//
// 接线（app 层只消费 core API）：
//   SessionManager ↔ StoryDb ↔ SnapshotsDb ↔ createStoryRuntime（API 面 + mode + story/npc/stylize/data）
// subagent 开关：story/npc 恒开、data 无开关恒开；stylize 默认关——传 --style 才开，
//   故事模式为 adventure 时强制开（预设要求全开，关闭会被 build-time 校验拒）。
//
// 坑（同 m4/m5-cli）：session.prompt 必须 await 完才能 navigateTree；退出不删故事目录。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import {
	assertValidRole,
	buildAncestorChain,
	clearStoryPromptOverride,
	computeNextTurnSeq,
	createDbView,
	createPipelineEventLog,
	createStory,
	createStoryRuntime,
	defaultGlobalPromptsDir,
	defaultStoriesRoot,
	forkStoryDb,
	inheritStoryMeta,
	loadSettings,
	MODE_PRESETS,
	openSnapshotsDb,
	openStoryDb,
	PackCache,
	resolvePromptChain,
	resolveStoryMode,
	setStoryPromptOverride,
	snapshotsDbPath,
	storyDbPath as coreStoryDbPath,
	validateSubagentSwitches,
	type DbView,
	type InteractionRequest,
	type LocationRow,
	type NpcRow,
	type NpcTraitRow,
	type PromptLayerDirs,
	type SnapshotRestoreResult,
	type StoryMetaFile,
	type StoryMode,
	type StoryRuntime,
	type StoryState,
	type StylizeRuntimeOptions,
	type TavernSettings,
	type TurnResult,
	type WorldPack,
} from "@tavernpi/core";
import { InputRejectedError } from "@tavernpi/core";
import { EN } from "./cli-text-en.ts";

// ---------------------------------------------------------------------------
// 常量与参数
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, "../../..");
const MODE_SET: readonly StoryMode[] = ["creation", "survival", "adventure"];

interface CliArgs {
	root?: string;
	resume?: string;
	pack: string[];
	mode?: StoryMode;
	style?: string;
}

interface CliCtx {
	storiesRoot: string;
	cwd: string;
	settings: TavernSettings;
	modelRuntime: ModelRuntime;
	prompts: PromptLayerDirs;
	/** 文风（--style：启用 stylize 阶段，并把该值作为 styleHint 注入）。 */
	style?: string;
	/** subagent 开关（会话级，不持久化）：story/npc 默认开；stylize 缺省 undefined = 按规则自动。 */
	agents: { story: boolean; npc: boolean; stylize?: boolean };
	/** 行输入队列：轮中交互 handler 要用，fork / 重建 runtime 后也靠它重新挂载。 */
	queue: LineQueue;
	/** 卡包检索注入（packDirs 为空 = undefined，无注入形态）。 */
	packs?: { cache: PackCache; pinned: () => string[] };
	/** 会话级手动钉列表（/pin /unpin 维护；经 getter 传入 runtime）。 */
	pinned: string[];
	/** 已加载包目录（/packs 展示；fork 重建复用同一列表重建 cache）。 */
	packDirs: string[];
}

/** stylize 是否启用。/agents 的显式设置优先；否则按规则：
 *  显式 --style ／ 故事模式为 adventure（预设强制全开、不可关）／
 *  卡包在 story.yaml 里声明了 defaultStyle（作者写下它就是想让这部作品用它，
 *  否则该字段对「没传 --style」的玩家形同虚设）。 */
function stylizeEnabled(ctx: CliCtx, storyDir: string): boolean {
	if (ctx.agents.stylize !== undefined) return ctx.agents.stylize;
	const meta = readStoryMeta(storyDir);
	return (
		resolveStoryMode(undefined, storyDir) === "adventure" ||
		ctx.style !== undefined ||
		meta?.defaultStyle !== undefined
	);
}

/** subagent 开关 combo：story/npc 由 /agents 控制（创造模式下可关，缺省全开）；
 *  stylize 由 stylizeEnabled 判定。组合合法性由 runtime 构建期校验（validateSubagentSwitches）。 */
function runtimeExtras(ctx: CliCtx, storyDir: string): {
	npc?: { enabled: boolean };
	story?: { enabled: boolean };
	stylize?: StylizeRuntimeOptions;
	packs?: { cache: PackCache; pinned: () => string[] };
} {
	return {
		...(ctx.agents.npc ? { npc: { enabled: true } } : {}),
		...(ctx.agents.story ? { story: { enabled: true } } : {}),
		...(stylizeEnabled(ctx, storyDir)
			? { stylize: { enabled: true, ...(ctx.style ? { styleHint: ctx.style } : {}) } }
			: {}),
		...(ctx.packs !== undefined ? { packs: ctx.packs } : {}),
	};
}

// ---------------------------------------------------------------------------
// 文本/转录工具（沿 m5-cli）
// ---------------------------------------------------------------------------

function messageText(message: { role: string; content?: unknown }): string {
	if (Array.isArray(message.content)) {
		return (message.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

function messageEntries(sessionManager: SessionManager): Array<Extract<SessionEntry, { type: "message" }>> {
	return sessionManager.getEntries().filter((e) => e.type === "message") as Array<
		Extract<SessionEntry, { type: "message" }>
	>;
}

function resolveTreeTarget(sessionManager: SessionManager, arg: string): Extract<SessionEntry, { type: "message" }> {
	const entries = messageEntries(sessionManager);
	if (/^\d+$/.test(arg)) {
		const idx = Number(arg);
		const entry = entries[idx - 1];
		if (!entry) throw new Error(`序号 ${arg} 超出范围（共 ${entries.length} 条消息）`);
		return entry;
	}
	const hit = entries.find((e) => e.id.startsWith(arg));
	if (!hit) throw new Error(`找不到 entry id 前缀: ${arg}`);
	return hit;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// 呈现层工具（呈现美化：显示宽 / 模式文案 / 树形引导线 / 度量徽章）
// ---------------------------------------------------------------------------

/** 模式中文名（三模式；adventure 追加「已锁定」徽章）。 */
const MODE_LABEL: Record<StoryMode, string> = {
	creation: "creation",
	survival: "survival",
	adventure: "adventure",
};

/** 斜杠命令名（与 /help 一致；供 Tab 补全）。 */
const COMMANDS = [
	"/tree",
	"/fork",
	"/status",
	"/packs",
	"/pin",
	"/unpin",
	"/reload",
	"/agents",
	"/models",
	"/prompt",
	"/write",
	"/mode",
	"/plot",
	"/swipe",
	"/compact",
	"/assist",
	"/help",
] as const;

/** 卡包条目类型的显示名（值域见 core 的 ENTRY_TYPES；未收录的原样显示）。
 *  英文下与原值相同；切中文时这里换成「角色 / 地点 / 物品 / 势力 / 剧情」。 */
const ENTRY_TYPE_LABEL: Record<string, string> = {
	character: "character",
	location: "location",
	object: "object",
	faction: "faction",
	plot: "plot",
};

/** 提示词角色清单（与 core/prompts/*.md 的文件名一一对应；/prompt 用它列出生效层）。 */
const PROMPT_ROLES = [
	"narrator",
	"story_scene",
	"story_review",
	"story_oversee",
	"npc_onstage",
	"npc_offscreen",
	"data",
	"stylize",
	"chapter_summary",
	"assist_creation",
	"assist_survival",
	"assist_adventure",
] as const;

/** 会话条目类型 → 树形展示的角色标签；非消息条目尽量平实中文。 */
const ENTRY_ROLE_LABEL: Record<string, string> = {
	custom: "custom",
	custom_message: "custom message",
};

/** 故事树可见条目类型（其余如模型/思考变更等簿记条目透视隐藏，不破坏缩进）。 */
const STORY_TREE_TYPES = new Set<string>(["message", "compaction", "branch_summary", "custom", "custom_message"]);

/** 单个字符的显示宽度（自写最小 wcwidth：CJK/全角按 2 列，控制字符 0，其余 1）。不依赖外部库。 */
function charWidth(ch: string): number {
	const code = ch.codePointAt(0)!;
	if (code === 0) return 0;
	if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
	// East Asian Wide / Fullwidth 区间：按 2 列排版，保证中文列表对齐。
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xa960 && code <= 0xa97f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x2fffd) ||
		(code >= 0x30000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** 文本的显示宽度（CJK 计 2；供对齐与截断）。 */
function displayWidth(text: string): number {
	let w = 0;
	for (const ch of text) w += charWidth(ch);
	return w;
}

/** 按显示宽度截断到 max：超出部分以省略号收尾；按码点走，绝不切断多字节字符。 */
function truncateByWidth(text: string, max: number): string {
	if (displayWidth(text) <= max) return text;
	let w = 0;
	let out = "";
	for (const ch of text) {
		const cw = charWidth(ch);
		if (w + cw > max) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/** 权重（0–1）映射为 5 格度量徽章，如 0.6 → ▰▰▰▱▱。 */
function weightGauge(weight: number): string {
	const clamped = Math.max(0, Math.min(1, weight));
	const filled = Math.round(clamped * 5);
	return "▰".repeat(filled) + "▱".repeat(5 - filled);
}

/** 从地点沿 parent_id 上溯解析父链（如「王城 > 庭院」）；未登记父名断链；无地点返回「未定位」。 */
function locationChain(loc: LocationRow | undefined, byId: Map<number, LocationRow>): string {
	if (!loc) return "未定位";
	const chain: string[] = [];
	const seen = new Set<number>();
	let cur: LocationRow | undefined = loc;
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		chain.push(cur.name);
		cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
	}
	chain.reverse();
	return chain.join(" > ");
}

function readStoryMeta(storyDir: string): StoryMetaFile | undefined {
	try {
		return JSON.parse(readFileSync(join(storyDir, "story.meta.json"), "utf8")) as StoryMetaFile;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// CLI 命令（沿 m5-cli，增 /mode /plot）
// ---------------------------------------------------------------------------

/** 会话条目 → 树行文本：消息给 `#轮号 [角色] 摘要`，compaction/分支摘要给 ◆ 摘要，其余给平实角色标签。 */
function formatTreeEntry(entry: SessionEntry, currentId: string | null, msgIndex: Map<string, number>): string {
	const isLeaf = entry.id === currentId;
	let line: string;
	if (entry.type === "message") {
		const idx = msgIndex.get(entry.id) ?? "?";
		line = `#${idx} [${entry.message.role}] ${truncateByWidth(messageText(entry.message), 40)}`;
	} else if (entry.type === "compaction") {
		line = `◆ [摘要] ${truncateByWidth(entry.summary, 40)}`;
	} else if (entry.type === "branch_summary") {
		line = `◆ [分支摘要] ${truncateByWidth(entry.summary, 40)}`;
	} else {
		const role = ENTRY_ROLE_LABEL[entry.type] ?? entry.type;
		line = `[${role}]`;
	}
	return isLeaf ? `▸ ${line}（当前）` : line;
}

/** 收集「故事树可见节点」：簿记条目（模型/思考变更等）透视展开，其可见后代提升到当前层（不增深）。 */
function collectTreeNodes(nodes: SessionTreeNode[]): SessionTreeNode[] {
	const out: SessionTreeNode[] = [];
	for (const n of nodes) {
		if (STORY_TREE_TYPES.has(n.entry.type)) out.push(n);
		else out.push(...collectTreeNodes(n.children));
	}
	return out;
}

/** 递归渲染会话树：│ / ├─ / └─ 表达嵌套分支缩进；隐藏条目不占缩进层级。 */
function renderTreeNodes(
	nodes: SessionTreeNode[],
	prefix: string,
	isTop: boolean,
	out: string[],
	currentId: string | null,
	msgIndex: Map<string, number>,
): void {
	const visible = collectTreeNodes(nodes);
	for (const [i, node] of visible.entries()) {
		const isLast = i === visible.length - 1;
		const connector = isTop && visible.length === 1 ? "" : isLast ? "└─ " : "├─ ";
		const entryText = formatTreeEntry(node.entry, currentId, msgIndex);
		out.push(`${prefix}${connector}${entryText}`);
		const childPrefix = isTop && visible.length === 1 ? "" : prefix + (isLast ? "   " : "│  ");
		renderTreeNodes(node.children, childPrefix, false, out, currentId, msgIndex);
	}
}

function printTree(sessionManager: SessionManager): void {
	const tree = sessionManager.getTree();
	const leafId = sessionManager.getLeafId();
	// #轮号 与 /tree <序号> 导航对齐：按 messageEntries（同 resolveTreeTarget）过滤顺序编号。
	const msgIndex = new Map<string, number>();
	{
		let idx = 0;
		for (const e of sessionManager.getEntries()) {
			if (e.type === "message") {
				idx++;
				msgIndex.set(e.id, idx);
			}
		}
	}
	// 当前 leaf 可能是簿记条目（如 model/thinking 变更），在故事树中不可见；
	// 向上找到最近的可见祖先作为「当前」标记位，让 ▸（当前）仍可见。
	let currentId: string | null = null;
	{
		let cur = leafId ? sessionManager.getEntry(leafId) : undefined;
		while (cur && !STORY_TREE_TYPES.has(cur.type)) {
			cur = cur.parentId ? sessionManager.getEntry(cur.parentId) : undefined;
		}
		currentId = cur?.id ?? null;
	}
	console.log("── 故事树 ──");
	const rootNodes = collectTreeNodes(tree);
	if (rootNodes.length === 0) {
		console.log("（空故事，尚无叙事条目）");
		return;
	}
	const out: string[] = [];
	renderTreeNodes(rootNodes, "", true, out, currentId, msgIndex);
	console.log(out.join("\n"));
}

function printRestoreResult(result: SnapshotRestoreResult | undefined, runtime: ReturnType<typeof createStoryRuntime> extends Promise<infer T> ? T : never): void {
	const clock = runtime.storyState.storyDb.reader.getClock();
	const events = runtime.storyState.storyDb.reader.listEvents();
	if (result === undefined) {
		console.log(EN.restoreSkipped);
	} else if (!result.ok) {
		console.log(EN.restoreFailed(result.error ?? EN.restoreUnknown));
	} else if (result.restoredTurnSeq !== undefined) {
		console.log(EN.restoreOk(result.restoredTurnSeq, result.restoredEntryId ?? ""));
	} else {
		console.log(EN.restoreEmptyFallback);
	}
	console.log(EN.restoreClock(clock?.current_time ?? EN.unset, events.length));
}

function printPacks(packs: WorldPack[]): void {
	if (packs.length === 0) {
		console.log(EN.packsNone);
		return;
	}
	console.log("世界包：");
	for (const p of packs) {
		const byType = new Map<string, number>();
		for (const e of p.entries) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
		const typeSummary = [...byType.entries()].map(([t, n]) => `${ENTRY_TYPE_LABEL[t] ?? t} ${n}`).join("、");
		console.log(EN.packsEntry(p.name, p.dir));
		console.log(
			EN.packsEntryLine(p.entries.length, typeSummary, p.hasCode ? EN.packsHasCode : EN.packsContentOnly),
		);
		if (p.story.title) {
			console.log(
				EN.packsStoryLine(
					p.story.title,
					p.story.calendar ?? "default calendar",
					p.story.granularity ?? "default granularity",
				),
			);
		}
	}
}

function printNpcDetails(view: DbView, npc: NpcRow, npcNameById: Map<number, string>): void {
	const comp = view.getNpc(npc.id);
	// 越集防御：DbView 在 user-related 模式下对集合外 NPC 返回 undefined。
	if (comp === undefined) return;
	// 特征：同名单取最新一次演化（turn_seq 最大），权重 0–1 映射 5 格。
	const traitByLatest = new Map<string, NpcTraitRow>();
	for (const t of comp.traits) {
		const cur = traitByLatest.get(t.trait);
		if (!cur || t.turn_seq > cur.turn_seq) traitByLatest.set(t.trait, t);
	}
	for (const t of traitByLatest.values()) {
		console.log(EN.npcTrait(t.trait, weightGauge(t.weight), t.weight.toFixed(1)));
	}
	// 关系：对房另一侧 id → 姓名，好感带符号。
	for (const rel of comp.relations) {
		const other = rel.npc_a === npc.id ? rel.npc_b : rel.npc_a;
		const otherName = npcNameById.get(other) ?? `#${other}`;
		const sign = rel.disposition >= 0 ? "+" : "";
		console.log(EN.npcRelation(otherName, sign, rel.disposition));
	}
	// 记忆：条数 + 最近一条（turn_seq 最大）内容按显示宽截断。
	if (comp.memories.length > 0) {
		const recent = comp.memories.reduce((a, b) => (b.turn_seq > a.turn_seq ? b : a));
		console.log(EN.npcMemory(comp.memories.length, truncateByWidth(recent.content, 30)));
	}
}

function printStatus(runtime: StoryRuntime, ctx: CliCtx): void {
	const reader = runtime.storyState.storyDb.reader;
	// 走模式视图（与 /assist 同一套口径）：冒险（信息迷雾）下 DB 查看仅「与 user 相关」——
	// 原先直接读 reader 全量，会把尚未接触的 NPC 连同其特征/关系/记忆一并列出来。
	const view = createDbView(reader, MODE_PRESETS[runtime.mode].dbViewFilter);
	const clock = view.getClock();
	const events = view.listEvents();
	const turns = view.getTurnLog();
	const snaps = runtime.storyState.snapshotsDb.listSnapshots();
	const dataStatus = view.listDataStatus();
	const playerLoc = view.getPlayerLocation();
	const locById = new Map<number, LocationRow>(view.listLocations().map((l) => [l.id, l]));
	const npcs = view.listNpcs();
	const npcNameById = new Map<number, string>(npcs.map((n) => [n.id, n.name]));

	const time = clock ? `${clock.current_time} (${clock.calendar}/${clock.granularity})` : EN.unset;
	const pos = locationChain(playerLoc, locById);

	console.log(EN.statusTitle);
	console.log(EN.statusLine(time, pos, MODE_LABEL[runtime.mode]));
	if (npcs.length === 0) {
		console.log(EN.statusNoNpc);
	} else {
		for (const npc of npcs) {
			console.log(EN.statusNpc(npc.name, npc.id, npc.status, npc.current_location_name ?? EN.unlocated));
			printNpcDetails(view, npc, npcNameById);
		}
	}
	console.log("");
	console.log(EN.statusCounts(turns.length, events.length, snaps.length, dataStatus.length));
	const dirs = ctx.packDirs.length > 0 ? ctx.packDirs.join(", ") : EN.none;
	const pinned = ctx.pinned.length > 0 ? EN.statusPinnedSuffix(ctx.pinned.join(", ")) : "";
	console.log(EN.statusPacks(dirs, pinned));
	console.log(EN.statusIds(runtime.sessionManager.getSessionId(), runtime.sessionManager.getLeafId() ?? ""));
}

function printHelp(): void {
	console.log(
		[
			EN.helpTitle,
			...EN.helpGroups,
			"",
			EN.helpKeys,
			"",
			EN.helpModeNote,
			EN.helpForceNote,
			EN.helpAgentNote,
		].join("\n"),
	);
}

function printTurn(report: TurnResult): void {
	console.log(EN.turnHeader(report.turnSeq));
	if (report.narrativeText.trim().length > 0) {
		console.log(report.narrativeText.trim());
		console.log("");
	} else {
		console.log(EN.turnEmptyNarrative);
	}
	// 系统信息行：`· ` 前缀；警告/错误用 `! ` 前缀。
	if (report.collection) {
		const c = report.collection;
		console.log(
			EN.turnCollection(
				c.injected.length > 0 ? c.injected.join(", ") : EN.turnCollectionNone,
				c.warnings.length > 0 ? EN.turnCollectionWarnings(c.warnings.join("; ")) : "",
			),
		);
	}
	if (report.npc) {
		const onstage = report.npc.onstageNpcIds;
		console.log(
			EN.turnNpc(
				onstage.length > 0 ? `${onstage.length} (${onstage.join(", ")})` : `${onstage.length}`,
				report.npc.offscreenTriggeredIds.length,
			),
		);
	}
	if (report.story) {
		const s = report.story;
		console.log(
			EN.turnReview(
				s.sceneFallback ? EN.turnSceneFallback : EN.turnSceneOk,
				s.hardConflicts.length,
				s.suspicions.length,
				s.revisions,
			),
		);
		// 冲突详情原先只写进 turn_log，终端只有计数——看不到「到底哪里冲突」。
		for (const c of s.hardConflicts) console.log(`    ! ${c}`);
		for (const w of s.suspicions) console.log(`    ? ${w}`);
		if (s.releasedWithWarnings) console.log(EN.turnReleasedNote);
	}
	if (report.stylize) {
		console.log(
			EN.turnStylize(
				report.stylize.applied ? EN.turnStylized : EN.turnStylizeKept,
				report.stylize.drift && report.stylize.drift.length > 0
					? EN.turnDrift(report.stylize.drift.join("; "))
					: "",
			),
		);
	}
	if (report.data.ok) {
		const a = report.data.applied;
		console.log(
			EN.turnDataOk(
				a.events,
				a.newNpcs,
				a.timeAdvanced ? EN.turnTimeAdvanced : EN.turnTimeUnchanged,
				report.data.dropped && report.data.dropped.length > 0 ? EN.turnDropped(report.data.dropped.length) : "",
			),
		);
	} else {
		console.log(EN.turnDataFailed(report.data.attempts, truncate(report.data.error, 300)));
	}
	console.log(EN.turnSnapshot(report.snapshotTaken));
}

async function cmdFork(arg: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime> {
	const { session, sessionManager, storyState } = runtime;
	const target = resolveTreeTarget(sessionManager, arg);
	const truncateId = target.message.role === "user" ? (target.parentId ?? target.id) : target.id;
	const chain = buildAncestorChain(sessionManager.getEntries(), target.id);
	const oldSessionId = sessionManager.getSessionId();
	const oldStoryState = storyState;

	const newFile = sessionManager.createBranchedSession(truncateId);
	const newSessionId = sessionManager.getSessionId();
	const newStoryDir = join(ctx.storiesRoot, newSessionId);
	console.log(`> createBranchedSession → 新 sessionId=${newSessionId}（文件 ${newFile}）`);

	const forkResult = forkStoryDb(oldStoryState.snapshotsDb, chain, newStoryDir);
	console.log(
		`> forkStoryDb → 新故事目录 ${newStoryDir}（events=${forkResult.storyDb.reader.listEvents().length}，snapshots=${forkResult.snapshotsDb.listSnapshots().length} 份）`,
	);

	runtime.dispose(); // 级联释放 assist 会话与 broker 注册（不只 session）
	oldStoryState.storyDb.close();
	oldStoryState.snapshotsDb.close();

	// fork 产物继承元数据：复制 story.meta.json——模式与锁定（adventure）随 mode 继承。
	inheritStoryMeta(oldStoryState.storyDir, newStoryDir);
	// fork 重建 cache（注入热更按当前磁盘包内容）。
	if (ctx.packDirs.length > 0) ctx.packs = { cache: new PackCache(ctx.packDirs), pinned: () => ctx.pinned };

	const newStoryState = {
		storyDir: newStoryDir,
		storyDb: forkResult.storyDb,
		snapshotsDb: forkResult.snapshotsDb,
	};
	const newRuntime = await createStoryRuntime({
		cwd: ctx.cwd,
		sessionManager,
		storyState: newStoryState,
		settings: ctx.settings,
		modelRuntime: ctx.modelRuntime,
		prompts: ctx.prompts,
		eventLog: createPipelineEventLog(join(newStoryDir, "pipeline-events.jsonl")),
		onWarning: (m) => console.warn(`[warn] ${m}`),
		...runtimeExtras(ctx, newStoryDir),
	});
	attachInteraction(newRuntime, ctx.queue);
	console.log(`> 已切换故事: ${oldSessionId} → ${newSessionId}`);
	return newRuntime;
}

/** 轮中交互 handler：把 broker 的请求落到 readline 上（内置 confirm/choice/text 三种 kind）。
 *  卡包代码工具经 getInteractionBroker() 发起请求时走到这里；未挂 handler 时 broker 抛
 *  InteractionUnavailableError，由工具自行降级（不崩、不挂死）。 */
async function readlineInteractionHandler(req: InteractionRequest, queue: LineQueue): Promise<unknown> {
	switch (req.kind) {
		case "confirm": {
			const answer = (await queue.nextLine(`${req.prompt}（y/n）> `)).trim().toLowerCase();
			if (answer === "y" || answer === "yes") return { confirmed: true };
			if (answer === "n" || answer === "no") return { confirmed: false };
			throw new Error(`非法确认输入: ${JSON.stringify(answer)}（应为 y/n）`);
		}
		case "choice": {
			const options = ((req.payload ?? {}) as { options?: unknown }).options;
			if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
				throw new Error("choice 交互缺合法 payload.options（string[]）");
			}
			console.log(req.prompt);
			options.forEach((opt: string, i: number) => console.log(`  [${i + 1}] ${opt}`));
			const line = (await queue.nextLine("> ")).trim();
			const idx = Number(line) - 1;
			if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
				throw new Error(`非法选项序号: ${JSON.stringify(line)}（应为 1-${options.length}）`);
			}
			return { option: idx };
		}
		case "text":
			return { text: (await queue.nextLine(`${req.prompt}> `)).trim() };
		default:
			throw new Error(`未知交互 kind: ${req.kind}（内置 confirm/choice/text；卡包自定义 包名:kind）`);
	}
}

/** 给 runtime 的轮中交互 broker 挂 handler。每次重建 runtime 都要重挂——broker 是实例级的。 */
function attachInteraction(runtime: StoryRuntime, queue: LineQueue): void {
	runtime.interaction.registerHandler((req) => readlineInteractionHandler(req, queue));
}

/** 以当前 ctx 重建 runtime：subagent 开关在创建时固化，改开关必须重建。
 *  dispose 旧实例（级联释放 assist 会话与 broker 注册），复用同一个 sessionManager 与 storyState。 */
async function rebuildRuntime(runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime> {
	const { sessionManager, storyState } = runtime;
	runtime.dispose();
	const rebuilt = await createStoryRuntime({
		cwd: ctx.cwd,
		sessionManager,
		storyState,
		settings: ctx.settings,
		modelRuntime: ctx.modelRuntime,
		prompts: ctx.prompts,
		eventLog: createPipelineEventLog(join(storyState.storyDir, "pipeline-events.jsonl")),
		onWarning: (m) => console.warn(`[warn] ${m}`),
		...runtimeExtras(ctx, storyState.storyDir),
	});
	attachInteraction(rebuilt, ctx.queue);
	return rebuilt;
}

async function runCommand(line: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime | undefined> {
	const [cmd, ...rest] = line.slice(1).split(/\s+/);
	const arg = rest.join(" ").trim();
	switch (cmd) {
		case "tree": {
			if (arg === "") {
				printTree(runtime.sessionManager);
				return undefined;
			}
			const target = resolveTreeTarget(runtime.sessionManager, arg);
			console.log(`> navigateTree(${target.id})（${target.message.role} 消息）`);
			const { session } = runtime;
			if (session.isStreaming) {
				console.log("> 正在生成中，此时不能跳转条目（请等这一轮结束）");
				return undefined;
			}
			await session.navigateTree(target.id);
			printRestoreResult(runtime.hooks.state.lastRestoreResult, runtime);
			return undefined;
		}
		case "fork": {
			if (arg === "") {
				console.log("用法: /fork <序号|entryId>");
				return undefined;
			}
			return cmdFork(arg, runtime, ctx);
		}
		case "status":
			printStatus(runtime, ctx);
			return undefined;
		case "packs": {
			if (ctx.packs === undefined) {
				printPacks([]);
			} else {
				const { packs, warnings } = ctx.packs.cache.getPacks();
				printPacks(packs);
				for (const w of warnings) console.warn(`[warn] ${w}`);
			}
			return undefined;
		}
		case "pin": {
			if (arg === "") {
				console.log("用法: /pin <包名:type:id>");
				return undefined;
			}
			if (!ctx.pinned.includes(arg)) ctx.pinned.push(arg);
			console.log(`> pinned: [${ctx.pinned.join(", ")}]`);
			return undefined;
		}
		case "unpin": {
			const idx = ctx.pinned.indexOf(arg);
			if (idx >= 0) ctx.pinned.splice(idx, 1);
			console.log(`> pinned: [${ctx.pinned.join(", ")}]`);
			return undefined;
		}
		case "reload": {
			if (ctx.packs === undefined) {
				console.log("> 无卡包");
				return undefined;
			}
			const { packs, warnings } = ctx.packs.cache.getPacks();
			console.log(`> 已重载: ${packs.map((p) => `${p.name}(${p.entries.length} 条目)`).join(", ")}`);
			for (const w of warnings) console.warn(`[warn] ${w}`);
			return undefined;
		}
		case "prompt": {
			// /prompt                     列出各角色的生效层
			// /prompt <角色>               查看该角色的四层覆盖链（story > pack > global > builtin）
			// /prompt <角色> load <文件>    用文件内容设置 story 层覆盖
			// /prompt <角色> clear         清除 story 层覆盖
			const parts = arg.split(/\s+/).filter((s) => s !== "");
			const storyDir = runtime.storyState.storyDir;
			const dirs: PromptLayerDirs = { ...ctx.prompts, storyDir };
			if (parts.length === 0) {
				console.log("提示词生效层（优先级 story > pack > global > builtin）：");
				for (const role of PROMPT_ROLES) {
					try {
						console.log(`  ${role}: ${resolvePromptChain(dirs, role).effectiveLayer}`);
					} catch (err) {
						console.log(`  ${role}: 查询失败（${err instanceof Error ? err.message : String(err)}）`);
					}
				}
				return undefined;
			}
			const [role, op, file] = parts as [string, string?, string?];
			try {
				assertValidRole(role);
			} catch (err) {
				console.log(`! ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			}
			if (op === undefined) {
				const chain = resolvePromptChain(dirs, role);
				console.log(`${role}（生效层：${chain.effectiveLayer}）`);
				for (const l of chain.layers) {
					const mark = l.effective ? " ←生效" : "";
					console.log(`  ${l.layer.padEnd(8)}${l.exists ? `${l.contentLength} 字符` : "无"}${mark}`);
					for (const p of l.paths) console.log(`      ${p}`);
				}
				return undefined;
			}
			if (op === "clear") {
				clearStoryPromptOverride(storyDir, role);
				console.log(`> 已清除 ${role} 的 story 层覆盖`);
				return undefined;
			}
			if (op === "load") {
				if (file === undefined) {
					console.log("用法: /prompt <角色> load <文件路径>");
					return undefined;
				}
				const abs = resolve(file);
				const content = readFileSync(abs, "utf-8");
				setStoryPromptOverride(storyDir, role, content);
				console.log(`> 已设置 ${role} 的 story 层覆盖（${content.length} 字符，来源 ${abs}）`);
				console.log("  提示：story 层优先于 pack/global/builtin；下一轮生效。");
				return undefined;
			}
			console.log("用法: /prompt | /prompt <角色> | /prompt <角色> load <文件> | /prompt <角色> clear");
			return undefined;
		}
		case "write": {
			// /write <json 文件> —— 受信任写入：按 Changeset 契约直写 story.db。
			// 校验失败由 trustedWrite 抛中文错并保证零落库；此处只负责读文件与呈现结果。
			if (arg === "") {
				console.log("用法: /write <changeset.json>");
				console.log("  受信任写入：按变更集格式直接写入故事库（跳过模型，校验不通过则完全不写入）。");
				return undefined;
			}
			try {
				const abs = resolve(arg);
				const raw = JSON.parse(readFileSync(abs, "utf-8")) as unknown;
				const res = await runtime.trustedWrite(raw as Parameters<StoryRuntime["trustedWrite"]>[0]);
				console.log(
					`> 受信任写入完成：第 ${res.turnSeq} 轮 · 快照：${res.snapshotTaken ? "已保存" : "未保存"}`,
				);
				console.log(`  ${JSON.stringify(res.summary)}`);
			} catch (err) {
				console.log(`! 写入失败: ${err instanceof Error ? err.message : String(err)}`);
			}
			return undefined;
		}
		case "agents": {
			// /agents 查看；/agents <story|npc|stylize> <on|off> 设置（会话级，不持久化）。
			// 改开关必须重建 runtime——subagent 选项在创建时固化。
			if (arg === "") {
				const on = (b: boolean): string => (b ? "开" : "关");
				console.log(
					`子代理：story ${on(ctx.agents.story)} · npc ${on(ctx.agents.npc)} · stylize ${on(stylizeEnabled(ctx, runtime.storyState.storyDir))}（${MODE_LABEL[runtime.mode]}模式）`,
				);
				console.log("  用法：/agents <story|npc|stylize> <on|off>");
				return undefined;
			}
			const [name, value] = arg.split(/\s+/);
			if ((name !== "story" && name !== "npc" && name !== "stylize") || (value !== "on" && value !== "off")) {
				console.log("用法: /agents <story|npc|stylize> <on|off>");
				return undefined;
			}
			const next: CliCtx["agents"] = { ...ctx.agents, [name]: value === "on" };
			const stylizeOn = name === "stylize" ? value === "on" : stylizeEnabled(ctx, runtime.storyState.storyDir);
			const problems = validateSubagentSwitches(runtime.mode, {
				story: next.story,
				npc: next.npc,
				stylize: stylizeOn,
			});
			if (problems.length > 0) {
				console.log("! 该开关组合不符合当前模式预设：");
				for (const p of problems) console.log(`    - ${p}`);
				return undefined;
			}
			ctx.agents = next;
			const rebuilt = await rebuildRuntime(runtime, ctx);
			const onOff = (b: boolean): string => (b ? "开" : "关");
			console.log(
				`子代理：story ${onOff(ctx.agents.story)} · npc ${onOff(ctx.agents.npc)} · stylize ${onOff(stylizeEnabled(ctx, runtime.storyState.storyDir))}（已生效）`,
			);
			return rebuilt;
		}
		case "models": {
			// 角色清单与 core settings.ts 的 MODEL_ROLES 对应（那是未导出的内部常量，此处同步维护）。
			const roles = ["narrator", "data", "story", "npc", "stylize", "chapter_summary", "assist"] as const;
			console.log("各角色模型（配置：~/.tavernpi/settings.json 的 models）");
			for (const role of roles) {
				const ref = ctx.settings.models[role];
				console.log(`  ${role.padEnd(16)}${ref ? `${ref.provider}/${ref.id}` : "未配置 · 用 pi 默认"}`);
			}
			return undefined;
		}
		case "mode": {
			if (arg === "") {
				console.log(`> 当前模式: ${MODE_LABEL[runtime.mode]}（${runtime.mode}）`);
				return undefined;
			}
			if (!MODE_SET.includes(arg as StoryMode)) {
				console.log(`> 非法模式: ${arg}（可选: ${MODE_SET.map((m) => MODE_LABEL[m]).join(" / ")}）`);
				return undefined;
			}
			try {
				runtime.setMode(arg as StoryMode);
				console.log(`> 已切换到 ${MODE_LABEL[arg as StoryMode]}（story.meta.json 已持久化）`);
			} catch (err) {
				console.log(`> 切换失败: ${err instanceof Error ? err.message : String(err)}`);
			}
			return undefined;
		}
		case "plot": {
			if (arg === "") {
				console.log("用法: /plot <剧情大纲>");
				return undefined;
			}
			if (runtime.mode !== "creation") {
				console.log(`! 该模式不可用：/plot 仅创造模式合法（剧情大纲指令；生存/冒险拒绝非 user 角色输入）。`);
				return undefined;
			}
			const turnSeq = computeNextTurnSeq(runtime.storyState.storyDb);
			const directive = runtime.storyState.storyDb.writer.insertDirective({ turnSeq, content: arg });
			console.log(`> 已写入剧情指令 #${directive.id}: ${arg}`);
			return undefined;
		}
		case "swipe": {
			// /swipe（重骰）：基于分支重生成最后一个 user 轮次，旧稿留树。
			if (arg !== "") {
				console.log("用法: /swipe（无参数，重生成最后一个 user 轮次）");
				return undefined;
			}
			try {
				const report = await runtime.swipe();
				printTurn(report);
			} catch (err) {
				console.log(`> swipe 失败: ${err instanceof Error ? err.message : String(err)}`);
			}
			return undefined;
		}
		case "compact": {
			// /compact：章节摘要 compaction。
			if (arg !== "") {
				console.log("用法: /compact（无参数，触发章节摘要 compaction）");
				return undefined;
			}
			try {
				const result = await runtime.session.compact();
				console.log(`> compaction 完成: ${result.summary.slice(0, 120)}${result.summary.length > 120 ? "…" : ""}`);
				console.log(`> 摘要替换 ${result.tokensBefore} tokens（压缩条目已写入会话）`);
			} catch (err) {
				const m = err instanceof Error ? err.message : String(err);
				if (/Nothing to compact|Already compacted/i.test(m)) {
					console.log(`> compaction 跳过（友好提示）: ${m}`);
				} else {
					throw err;
				}
			}
			return undefined;
		}
		case "assist": {
			// /assist：带外顾问，只读、草稿制、不进叙事流。输出为草稿，由用户决定是否作为输入发出。
			if (arg === "") {
				console.log("用法: /assist <问题/求助>");
				return undefined;
			}
			try {
				const reply = await runtime.assist.chat(arg);
				console.log("\n── 旁路顾问 ──");
				console.log("只读/草稿制，不进叙事流；以下为草稿，可自行决定是否作为输入发出。");
				console.log(reply);
				console.log("──────────────");
			} catch (err) {
				console.log(`> assist 失败: ${err instanceof Error ? err.message : String(err)}`);
			}
			return undefined;
		}
		case "help":
			printHelp();
			return undefined;
		default:
			console.log(`未知命令 /${cmd}（/help 查看）`);
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// 行队列（沿 m5-cli）
// ---------------------------------------------------------------------------

class LineQueue {
	private readonly lines: string[] = [];
	private readonly waiters: Array<(line: string) => void> = [];
	private eof = false;

	constructor(rl: Interface) {
		rl.on("line", (line) => {
			const waiter = this.waiters.shift();
			if (waiter) waiter(line);
			else this.lines.push(line);
		});
		rl.on("close", () => {
			this.eof = true;
			const waiter = this.waiters.shift();
			if (waiter) waiter("");
		});
	}

	async nextLine(prompt: string): Promise<string> {
		process.stdout.write(prompt);
		if (this.lines.length > 0) return this.lines.shift()!;
		if (this.eof) return "";
		return new Promise<string>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

// ---------------------------------------------------------------------------
// 启动与参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = { pack: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--root") {
			i++;
			args.root = argv[i];
		} else if (a === "--resume") {
			i++;
			args.resume = argv[i];
		} else if (a === "--pack") {
			i++;
			args.pack.push(argv[i]!);
		} else if (a === "--mode") {
			i++;
			const v = argv[i];
			if (!MODE_SET.includes(v as StoryMode)) throw new Error(`--mode 只允许 ${MODE_SET.join(" / ")}`);
			args.mode = v as StoryMode;
		} else if (a === "--style") {
			i++;
			args.style = argv[i];
		} else {
			throw new Error(`未知参数: ${a}`);
		}
	}
	return args;
}

export async function main(argv: readonly string[]): Promise<void> {
	const args = parseArgs(argv);
	const storiesRoot = args.root ?? defaultStoriesRoot();
	const cwd = repoRoot;

	let sessionManager: SessionManager;
	let storyState: StoryState;
	let packDirs = args.pack.map((d) => resolve(d));

	if (args.resume !== undefined) {
		// 续写：session 文件恢复；mode 从 story.meta.json 恢复（runtime 解析）；subagent 开关全开满足各模式预设。
		sessionManager = SessionManager.open(args.resume);
		const sessionId = sessionManager.getSessionId();
		const dbPath = coreStoryDbPath(storiesRoot, sessionId);
		storyState = {
			storyDir: join(storiesRoot, sessionId),
			storyDb: openStoryDb(dbPath),
			snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
		};
		const meta = readStoryMeta(storyState.storyDir);
		if (meta?.mode !== undefined) {
			console.log(`> 恢复模式：${meta.mode}（来自 story.meta.json）`);
		}
		if (packDirs.length === 0 && meta !== undefined) {
			packDirs = meta.packs.map((p) => p.dir);
		}
	} else {
		// 新故事：--mode 仅在创建时有效（createStory 写入 meta；adventure 创建时锁定）。
		const created = await createStory({ storiesRoot, packDirs, cwd, ...(args.mode !== undefined ? { mode: args.mode } : {}) });
		sessionManager = created.sessionManager;
		storyState = created.storyState;
		const clock = storyState.storyDb.reader.getClock();
		console.log(`> clock 初值: ${clock?.current_time}（${clock?.calendar}/${clock?.granularity}）`);
		if (created.packs.length > 0) {
			console.log(`> 已加载卡包: ${created.packs.map((p) => p.name).join("、")}`);
		}
	}
	const sessionId = sessionManager.getSessionId();

	const { settings, warnings: settingsWarnings } = loadSettings();
	const prompts: PromptLayerDirs = {
		globalDir: defaultGlobalPromptsDir(),
		// 多包提示词合并：传全部包 prompts/ 目录（后包覆盖先包；存在的才被探测）。
		...(packDirs.length > 0 ? { packDirs } : {}),
	};
	const modelRuntime = await ModelRuntime.create();
	const eventLog = createPipelineEventLog(join(storyState.storyDir, "pipeline-events.jsonl"));

	console.log(`> sessionId: ${sessionId}`);
	console.log(`> storyDir: ${storyState.storyDir}`);
	for (const w of settingsWarnings) console.warn(`[warn] ${w}`);

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		// Tab 补全：斜杠命令名；/mode 补模式；/prompt 与 /agents 补各自的名字。
		// 注：Ctrl+P 在 readline 里已是「上一条历史」，与「打开菜单」冲突，故菜单仍走 /help。
		completer: (line: string): [string[], string] => {
			if (!line.startsWith("/")) return [[], line];
			const parts = line.split(/\s+/);
			const cur = parts[parts.length - 1] ?? "";
			if (parts.length === 1) {
				const hits = COMMANDS.filter((c) => c.startsWith(cur));
				return [hits.length > 0 ? [...hits] : [], cur];
			}
			if (parts.length === 2) {
				const table: Record<string, readonly string[]> = {
					"/mode": MODE_SET,
					"/prompt": PROMPT_ROLES,
					"/agents": ["story", "npc", "stylize"],
				};
				const candidates = table[parts[0] ?? ""];
				if (candidates !== undefined) {
					const hits = candidates.filter((c) => c.startsWith(cur));
					return [hits.length > 0 ? [...hits] : [], cur];
				}
			}
			return [[], cur];
		},
	});
	const queue = new LineQueue(rl);

	const pinned: string[] = [];
	const ctx: CliCtx = {
		storiesRoot,
		cwd,
		settings,
		modelRuntime,
		prompts,
		...(args.style !== undefined ? { style: args.style } : {}),
		agents: { story: true, npc: true },
		queue,
		pinned,
		packDirs,
	};
	if (packDirs.length > 0) {
		ctx.packs = { cache: new PackCache(packDirs), pinned: () => ctx.pinned };
	}

	let runtime: StoryRuntime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		settings,
		modelRuntime,
		prompts,
		eventLog,
		onWarning: (m) => console.warn(`[warn] ${m}`),
		...runtimeExtras(ctx, storyState.storyDir),
	});
	attachInteraction(runtime, queue);
	// Ctrl+C：第一次请求退出（若当前轮正在生成，等它结束再退），第二次强制退出。
	// 不接管的话 readline 只会把接口关掉——若此刻卡在几百秒的主叙事里，用户按了 Ctrl+C
	// 既没有提示也不会退出，会以为进程挂了。
	let sigintCount = 0;
	rl.on("SIGINT", () => {
		sigintCount++;
		if (sigintCount >= 2) {
			console.log("\n> 强制退出（未等当前操作完成）");
			process.exit(130);
		}
		console.log(
			runtime.session.isStreaming
				? "\n> 已收到 Ctrl+C：当前轮仍在生成，会在它结束后退出；再按一次立即强制退出。"
				: "\n> 已收到 Ctrl+C：正在退出（再按一次可强制立即退出）。",
		);
		rl.close();
	});
	console.log(
		`> 工具白名单: [${runtime.session.getActiveToolNames().join(", ")}]（应为空：主叙事零 DB 工具）`,
	);
	// 启动横幅：故事标题 + 模式中文名（adventure 追加「已锁定」徽章）。
	const bannerMeta = readStoryMeta(storyState.storyDir);
	const storyTitle = bannerMeta?.title ?? sessionManager.getSessionName() ?? "未命名故事";
	const modeLabel = MODE_LABEL[runtime.mode];
	const lockedBadge = runtime.mode === "adventure" ? " · 已锁定" : "";
	console.log(`═══ 《${storyTitle}》 · ${modeLabel}模式${lockedBadge} ═══`);
	if (runtime.mode !== "creation") {
		const modeInfo = runtime.mode === "adventure" ? "锁定，不可切换" : "story/输入校验生效";
		console.log(`模式说明: ${modeLabel}（${modeInfo}）`);
	}

	console.log("\n直接输入行动或对话开始。命令见 /help，空行退出。");
	try {
		for (;;) {
			const line = (await queue.nextLine(`[${MODE_LABEL[runtime.mode]}]> `)).trim();
			if (line === "") break;
			// /! 前缀：输入渠道校验强制提交（去前缀 + force:true）
			if (line.startsWith("/! ")) {
				const forcedInput = line.slice(2).trim();
				const report = await runtime.runTurn(forcedInput, { force: true });
				printTurn(report);
				continue;
			}
			if (line.startsWith("/")) {
				const next = await runCommand(line, runtime, ctx);
				if (next !== undefined) runtime = next;
			} else {
				try {
					const report = await runtime.runTurn(line);
					printTurn(report);
				} catch (err) {
					if (err instanceof InputRejectedError) {
						console.log(`! 输入被拒绝（输入渠道校验）：${err.reason}`);
						console.log(`! 建议改写：${err.suggestion}`);
						console.log(`! 如确需原样提交，以 /! 开头强制提交（将留痕 warning）。`);
					} else {
						throw err;
					}
				}
			}
		}
	} finally {
		rl.close();
		runtime.dispose();
		runtime.storyState.storyDb.close();
		runtime.storyState.snapshotsDb.close();
		console.log(
			`> 故事目录保留（未删）: ${runtime.storyState.storyDir}\n> 可续写: node packages/app/src/m6-cli.ts --resume ${runtime.sessionManager.getSessionFile()}`,
		);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	});
}
