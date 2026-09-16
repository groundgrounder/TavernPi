// CLI 的各个「屏」：把 core/app 的数据排成一组行。
//
// 设计口径：
// - **视图是纯函数**——输入数据、返回 `string[]`，不写终端（写由调用方经 ui 收口）。
//   好处是排版可被断言（不需要真跑一轮叙事就能验证布局），也不会与活动行抢行。
// - 信息量只增不减：既有控制台每条信息都还在，只是换了层级与措辞。
// - 措辞出自 cli-text-en.ts / cli-text-zh.ts，本模块只负责摆。

import type { SessionEntry, SessionManager, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { DbView, LocationRow, NpcRow, NpcTraitRow, SnapshotRestoreResult, StoryMode, TurnResult, WorldPack } from "@tavernpi/core";
import { EN, EN_LABELS } from "./cli-text-en.ts";
import { displayWidth, formatElapsed, GLYPH, padToWidth, truncateByWidth, type Tone, type Ui } from "./ui.ts";

/** 每轮报告里的阶段耗时（键与阶段名一致；缺省表示该阶段没跑或没事件）。 */
export interface StageTimings {
	story?: number;
	npc?: number;
	stylize?: number;
	data?: number;
}

/** 会话条目 → 文本（取 text 块拼接；其余类型给空串）。 */
function messageText(message: { role: string; content?: unknown }): string {
	if (Array.isArray(message.content)) {
		return (message.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

/** 模式展示：显示名与标识符不同（中文版）才并列括号，英文版不写一遍重复的 "creation (creation)"。 */
export function modeLabel(mode: StoryMode): string {
	const name = EN_LABELS.mode[mode];
	return name === mode ? mode : `${name} (${mode})`;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export interface StartupInput {
	story: string;
	mode: string;
	locked: boolean;
	/** 非创造模式才有：模式补充说明（创造模式不占行）。 */
	modeNote?: string;
	sessionId?: string;
	storyDir?: string;
	clock?: string;
	/** 工具白名单（恒有；零工具时是 `[]`）。 */
	tools: string;
	packs?: string;
}

/** 启动头部：标题行 + 事实块。提示语（hint）由调用方在主循环前单独打。 */
export function renderStartup(ui: Ui, input: StartupInput): string[] {
	const out: string[] = [
		`${ui.paint("bold", input.story)} ${ui.paint("dim", `· ${input.mode}`)}${input.locked ? ui.paint("warn", EN.lockedBadge) : ""}`,
	];
	if (input.modeNote !== undefined) out.push(`  ${ui.paint("dim", input.modeNote)}`);
	out.push("");
	const rows: Array<readonly [string, string]> = [];
	if (input.sessionId !== undefined) rows.push([EN.labelSession, input.sessionId]);
	if (input.storyDir !== undefined) rows.push([EN.labelStoryDir, ui.paint("dim", input.storyDir)]);
	if (input.clock !== undefined) rows.push([EN.labelClock, input.clock]);
	if (input.packs !== undefined) rows.push([EN.labelPacks, input.packs]);
	rows.push([
		EN.labelTools,
		`${input.tools === EN.toolsEmpty ? ui.paint("dim", input.tools) : input.tools}  ${ui.paint("dim", `(${EN.toolsEmptyNote})`)}`,
	]);
	out.push(...ui.fields(rows));
	return out;
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

export function renderHelp(ui: Ui): string[] {
	const out: string[] = [ui.heading(EN.helpTitle)];
	// 说明列按全局最宽命令对齐——分组之间也不跳动。
	const cmdWidth = EN.helpGroups
		.flatMap((g) => g.items.map(([cmd]) => displayWidth(cmd)))
		.reduce((max, w) => Math.max(max, w), 0);
	for (const group of EN.helpGroups) {
		out.push(`  ${ui.paint("bold", group.title)}`);
		for (const [cmd, desc] of group.items) {
			out.push(`    ${padToWidth(cmd, cmdWidth)}  ${ui.paint("dim", desc)}`);
		}
	}
	out.push("");
	out.push(`  ${ui.paint("dim", EN.helpKeys)}`);
	out.push("");
	for (const note of [EN.helpModeNote, EN.helpForceNote, EN.helpAgentNote]) {
		out.push(`  ${ui.paint("dim", note)}`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// /tree
// ---------------------------------------------------------------------------

/** 故事树可见条目类型（其余如模型/思考变更等簿记条目透视隐藏，不破坏缩进）。 */
const STORY_TREE_TYPES = new Set<string>(["message", "compaction", "branch_summary", "custom", "custom_message"]);

/** 会话条目 → 树行文本。 */
function treeEntryText(ui: Ui, entry: SessionEntry, msgIndex: Map<string, number>): string {
	if (entry.type === "message") {
		const idx = msgIndex.get(entry.id) ?? "?";
		const role = entry.message.role;
		return `${ui.paint("dim", `#${idx}`)} ${ui.paint("dim", role.padEnd(9))} ${truncateByWidth(messageText(entry.message), 44)}`;
	}
	if (entry.type === "compaction") {
		return `${ui.paint("accent", GLYPH.info)} ${ui.paint("dim", EN.treeSummary)} ${truncateByWidth(entry.summary, 44)}`;
	}
	if (entry.type === "branch_summary") {
		return `${ui.paint("accent", GLYPH.info)} ${ui.paint("dim", EN.treeBranchSummary)} ${truncateByWidth(entry.summary, 44)}`;
	}
	const role = EN_LABELS.entryRole[entry.type] ?? entry.type;
	return ui.paint("dim", `[${role}]`);
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
	ui: Ui,
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
		const isCurrent = node.entry.id === currentId;
		const marker = isCurrent ? `${ui.paint("accent", GLYPH.mark)} ` : "";
		const tail = isCurrent ? ` ${ui.paint("accent", `(${EN.treeCurrent})`)}` : "";
		out.push(`${ui.paint("dim", prefix + connector)}${marker}${treeEntryText(ui, node.entry, msgIndex)}${tail}`);
		const childPrefix = isTop && visible.length === 1 ? "" : prefix + (isLast ? "   " : "│  ");
		renderTreeNodes(ui, node.children, childPrefix, false, out, currentId, msgIndex);
	}
}

export function renderTree(ui: Ui, sessionManager: SessionManager): string[] {
	const out: string[] = [ui.heading(EN.treeTitle)];
	const tree = sessionManager.getTree();
	const leafId = sessionManager.getLeafId();
	// #轮号 与 /tree <序号> 导航对齐：按 message 条目过滤顺序编号。
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
	const rootNodes = collectTreeNodes(tree);
	if (rootNodes.length === 0) {
		out.push(ui.bullet(ui.paint("dim", EN.treeEmpty)));
		return out;
	}
	renderTreeNodes(ui, rootNodes, "", true, out, currentId, msgIndex);
	return out;
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

/** 从地点沿 parent_id 上溯解析父链（如「王城 > 庭院」）；未登记父名断链；无地点给 unlocated。 */
function locationChain(loc: LocationRow | undefined, byId: Map<number, LocationRow>): string {
	if (!loc) return EN.unlocated;
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

/** 权重（0–1）映射为 5 格度量徽章，如 0.6 → ▰▰▰▱▱。 */
function weightGauge(weight: number): string {
	const clamped = Math.max(0, Math.min(1, weight));
	const filled = Math.round(clamped * 5);
	return "▰".repeat(filled) + "▱".repeat(5 - filled);
}

export interface StatusInput {
	view: DbView;
	/** 快照数：来自 snapshotsDb，不在 DbView 的面上。 */
	snapshotCount: number;
	mode: StoryMode;
	sessionId: string;
	entryId: string;
	packDirs: readonly string[];
	pinned: readonly string[];
}

export function renderStatus(ui: Ui, input: StatusInput): string[] {
	const { view } = input;
	const clock = view.getClock();
	const events = view.listEvents();
	const turns = view.getTurnLog();
	const snaps = input.snapshotCount;
	const dataStatus = view.listDataStatus();
	const playerLoc = view.getPlayerLocation();
	const locById = new Map<number, LocationRow>(view.listLocations().map((l) => [l.id, l]));
	const npcs = view.listNpcs();
	const npcNameById = new Map<number, string>(npcs.map((n) => [n.id, n.name]));

	const time = clock ? `${clock.current_time} (${clock.calendar}/${clock.granularity})` : EN.unset;
	const out: string[] = [ui.heading(EN.statusTitle)];
	out.push(
		...ui.fields([
			[EN.labelTime, time],
			[EN.labelLocation, locationChain(playerLoc, locById)],
			[EN.labelMode, modeLabel(input.mode)],
			[EN.labelCounts, EN.statusCounts(turns.length, events.length, snaps, dataStatus.length)],
			[
				EN.labelPacks,
				EN.statusPacks(
					input.packDirs.length > 0 ? input.packDirs.join(EN.listSep) : EN.none,
					input.pinned.length > 0 ? EN.statusPinnedSuffix(input.pinned.join(EN.listSep)) : "",
				),
			],
			[EN.labelSession, EN.statusIds(input.sessionId, input.entryId)],
		]),
	);

	out.push("");
	out.push(`  ${ui.paint("bold", EN.labelCharacters)}`);
	if (npcs.length === 0) {
		out.push(ui.bullet(ui.paint("dim", EN.statusNoNpc)));
		return out;
	}
	for (const npc of npcs) {
		out.push(
			`    ${npc.name} ${ui.paint("dim", `#${npc.id}`)} ${ui.paint("dim", `(${npc.status})`)} ${ui.paint("dim", "@")} ${npc.current_location_name ?? EN.unlocated}`,
		);
		renderNpcDetails(ui, view, npc, npcNameById, out);
	}
	return out;
}

/** NPC 分卡：特征（同名单取最新一次演化）/ 关系（对房姓名 + 好感符号）/ 记忆（条数 + 最近一条）。 */
function renderNpcDetails(
	ui: Ui,
	view: DbView,
	npc: NpcRow,
	npcNameById: Map<number, string>,
	out: string[],
): void {
	const comp = view.getNpc(npc.id);
	// 越集防御：DbView 在 user-related 模式下对集合外 NPC 返回 undefined。
	if (comp === undefined) return;
	const traitByLatest = new Map<string, NpcTraitRow>();
	for (const t of comp.traits) {
		const cur = traitByLatest.get(t.trait);
		if (!cur || t.turn_seq > cur.turn_seq) traitByLatest.set(t.trait, t);
	}
	for (const t of traitByLatest.values()) {
		out.push(ui.sub(ui.paint("dim", `  ${EN.npcTrait(t.trait, weightGauge(t.weight), t.weight.toFixed(1))}`)));
	}
	for (const rel of comp.relations) {
		const other = rel.npc_a === npc.id ? rel.npc_b : rel.npc_a;
		const otherName = npcNameById.get(other) ?? `#${other}`;
		out.push(ui.sub(ui.paint("dim", `  ${EN.npcRelation(otherName, rel.disposition >= 0 ? "+" : "", rel.disposition)}`)));
	}
	if (comp.memories.length > 0) {
		const recent = comp.memories.reduce((a, b) => (b.turn_seq > a.turn_seq ? b : a));
		out.push(ui.sub(ui.paint("dim", `  ${EN.npcMemory(comp.memories.length, truncateByWidth(recent.content, 30))}`)));
	}
}

// ---------------------------------------------------------------------------
// /packs
// ---------------------------------------------------------------------------

export function renderPacks(ui: Ui, packs: readonly WorldPack[]): string[] {
	const out: string[] = [ui.heading(EN.packsTitle)];
	if (packs.length === 0) {
		out.push(ui.bullet(ui.paint("dim", EN.packsEmpty)));
		return out;
	}
	for (const p of packs) {
		const byType = new Map<string, number>();
		for (const e of p.entries) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
		const typeSummary = [...byType.entries()]
			.map(([t, n]) => `${EN_LABELS.entryType[t] ?? t} ${n}`)
			.join(EN.listSep);
		out.push(ui.bullet(`${ui.paint("bold", p.name)}  ${ui.paint("dim", p.dir)}`));
		out.push(
			ui.sub(
				ui.paint(
					"dim",
					EN.packsEntryLine(p.entries.length, typeSummary, p.hasCode ? EN.packsHasCode : EN.packsContentOnly),
				),
			),
		);
		if (p.story.title) {
			out.push(
				ui.sub(
					ui.paint(
						"dim",
						EN.packsStoryLine(
							p.story.title,
							p.story.calendar ?? "default calendar",
							p.story.granularity ?? "default granularity",
						),
					),
				),
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 每轮报告
// ---------------------------------------------------------------------------

export interface TurnInput {
	report: TurnResult;
	/** 本轮墙钟耗时（CLI 侧计时；TurnResult 本身不带）。 */
	durationMs?: number;
	/** 各 subagent 阶段耗时（来自 pipeline 事件流；缺省则该列不显示）。 */
	stageMs?: StageTimings;
}

/** 阶段行 + 其下的细节行。`facts` 为空的阶段（如快照）也能成一格，读起来整齐。 */
interface StageRow {
	glyph: string;
	tone: Tone;
	label: string;
	time?: string;
	facts: string;
}

function stageRow(
	glyph: string,
	tone: Tone,
	label: string,
	ms: number | undefined,
	facts: string,
): StageRow {
	return {
		glyph,
		tone,
		label,
		// 未跑/无事件的阶段不给时长：不给数字比给假数字诚实。
		...(ms !== undefined ? { time: formatElapsed(ms) } : {}),
		facts,
	};
}

export function renderTurn(ui: Ui, input: TurnInput): string[] {
	const { report } = input;
	const ms = input.stageMs ?? {};
	const head = `${ui.paint("bold", EN.turnTitle(report.turnSeq))}`;
	const elapsed =
		input.durationMs !== undefined ? `  ${ui.paint("dim", formatElapsed(input.durationMs))}` : "";
	const out: string[] = [head + elapsed, ""];

	// 正文：只从 TurnResult.narrativeText 打一次（活动行上的流式预览是临时的，不在此重复）。
	if (report.narrativeText.trim().length > 0) {
		out.push(report.narrativeText.trim());
	} else {
		out.push(ui.paint("dim", EN.turnEmptyNarrative));
	}

	const rows: StageRow[] = [];
	const details: string[] = [];

	if (report.story) {
		const s = report.story;
		const bad = s.hardConflicts.length > 0 || s.releasedWithWarnings;
		rows.push(
			stageRow(
				bad ? GLYPH.warn : GLYPH.ok,
				bad ? "warn" : "ok",
				EN.stageStory,
				ms.story,
				EN.turnReview(
					s.sceneFallback ? EN.turnSceneFallback : EN.turnSceneOk,
					s.hardConflicts.length,
					s.suspicions.length,
					s.revisions,
				),
			),
		);
		for (const c of s.hardConflicts) details.push(ui.detail(c, "warn"));
		for (const w of s.suspicions) details.push(ui.detail(w, "ask"));
		if (s.releasedWithWarnings) details.push(ui.detail(EN.turnReleasedNote, "warn"));
	}

	if (report.npc) {
		const onstage = report.npc.onstageNpcIds.length;
		rows.push(
			stageRow(
				GLYPH.ok,
				"ok",
				EN.stageNpc,
				ms.npc,
				`${EN.turnNpc(onstage, report.npc.offscreenTriggeredIds.length)}${onstage > 0 ? ui.paint("dim", ` · ${report.npc.onstageNpcIds.join(", ")}`) : ""}`,
			),
		);
	}

	if (report.stylize) {
		const drift = report.stylize.drift ?? [];
		rows.push(
			stageRow(
				report.stylize.applied ? GLYPH.ok : GLYPH.dot,
				report.stylize.applied ? "ok" : "dim",
				EN.stageStylize,
				ms.stylize,
				EN.turnStylize(
					report.stylize.applied ? EN.turnStylized : EN.turnStylizeKept,
					drift.length > 0 ? EN.turnDrift(drift.join("; ")) : "",
				),
			),
		);
	}

	if (report.data.ok) {
		const a = report.data.applied;
		const dropped = report.data.dropped && report.data.dropped.length > 0 ? EN.turnDropped(report.data.dropped.length) : "";
		rows.push(
			stageRow(
				GLYPH.ok,
				"ok",
				EN.stageData,
				ms.data,
				EN.turnDataOk(a.events, a.newNpcs, a.timeAdvanced ? EN.turnTimeAdvanced : EN.turnTimeUnchanged, dropped),
			),
		);
	} else {
		rows.push(
			stageRow(
				GLYPH.err,
				"err",
				EN.stageData,
				ms.data,
				EN.turnDataFailed(report.data.attempts, truncateByWidth(report.data.error, 200)),
			),
		);
	}

	if (report.collection) {
		const c = report.collection;
		const warned = c.warnings.length > 0;
		rows.push(
			stageRow(
				warned ? GLYPH.warn : GLYPH.ok,
				warned ? "warn" : "ok",
				EN.stagePacks,
				undefined,
				EN.turnCollection(
					c.injected.length > 0 ? c.injected.join(", ") : EN.turnCollectionNone,
					warned ? EN.turnCollectionWarnings(c.warnings.join("; ")) : "",
				),
			),
		);
	}

	rows.push(
		stageRow(
			report.snapshotTaken ? GLYPH.ok : GLYPH.info,
			report.snapshotTaken ? "ok" : "dim",
			EN.stageSnapshot,
			undefined,
			EN.turnSnapshot(report.snapshotTaken),
		),
	);

	out.push("");
	out.push(...ui.stages(rows));
	out.push(...details);
	return out;
}

// ---------------------------------------------------------------------------
// 快照恢复
// ---------------------------------------------------------------------------

export function renderRestore(
	ui: Ui,
	result: SnapshotRestoreResult | undefined,
	clockTime: string,
	eventCount: number,
): string[] {
	let verdict: string;
	let tone: Tone;
	if (result === undefined) {
		verdict = EN.restoreSkipped;
		tone = "dim";
	} else if (!result.ok) {
		verdict = EN.restoreFailed(result.error ?? EN.restoreUnknown);
		tone = "err";
	} else if (result.restoredTurnSeq !== undefined) {
		verdict = EN.restoreOk(result.restoredTurnSeq, result.restoredEntryId ?? "");
		tone = "ok";
	} else {
		verdict = EN.restoreEmptyFallback;
		tone = "ok";
	}
	return [
		ui.heading(EN.restoreTitle),
		...ui.fields([
			[EN.labelEntry, ui.paint(tone, verdict)],
			[EN.labelClock, EN.restoreClock(clockTime, eventCount)],
		]),
	];
}

// ---------------------------------------------------------------------------
// 输入被拒
// ---------------------------------------------------------------------------

/** 输入渠道校验把这一轮挡下时打的三行：原因（红）、建议（暗）、强制提交提示（暗）。 */
export function renderInputRejected(ui: Ui, reason: string, suggestion: string): string[] {
	return [
		ui.note(EN.inputRejected(reason), "err"),
		ui.note(EN.inputSuggestion(suggestion), "info"),
		ui.note(EN.inputForceHint, "info"),
	];
}

// ---------------------------------------------------------------------------
// /prompt、/models（窄视图：标签列 + 值列）
// ---------------------------------------------------------------------------

/** 覆盖链里的一层（结构取自 core 的 PromptChainInfo.layers，此处只取排版要用的字段）。 */
export interface PromptChainRow {
	layer: string;
	exists: boolean;
	contentLength: number;
	effective: boolean;
	paths: readonly string[];
}

/** `/prompt`：12 个角色的生效层一览（查询失败的角色单独标黄，不让一个错吞掉整屏）。 */
export function renderPromptLayerList(
	ui: Ui,
	rows: ReadonlyArray<{ role: string; layer?: string; error?: string }>,
): string[] {
	const out: string[] = [ui.heading(EN.promptTitle), ui.bullet(ui.paint("dim", EN.promptLayersNote))];
	const width = rows.reduce((max, r) => Math.max(max, displayWidth(r.role)), 0);
	for (const r of rows) {
		if (r.error !== undefined) {
			out.push(`    ${ui.paint("warn", GLYPH.warn)} ${ui.paint("warn", EN.promptQueryFailed(r.role, r.error))}`);
			continue;
		}
		out.push(`    ${ui.paint("dim", padToWidth(r.role, width))}  ${r.layer ?? ""}`);
	}
	return out;
}

/** `/prompt <角色>`：四层覆盖链（story > pack > global > builtin）+ 生效层标记 + 各层路径。 */
export function renderPromptChain(
	ui: Ui,
	role: string,
	effectiveLayer: string,
	layers: readonly PromptChainRow[],
): string[] {
	const out: string[] = [ui.heading(EN.promptTitle), `  ${EN.promptChain(role, ui.paint("accent", effectiveLayer))}`];
	const width = layers.reduce((max, l) => Math.max(max, displayWidth(l.layer)), 0);
	for (const l of layers) {
		const mark = l.effective ? `  ${ui.paint("accent", EN.promptEffectiveMark)}` : "";
		out.push(
			`    ${padToWidth(ui.paint(l.effective ? "bold" : "dim", l.layer), width)}  ${
				l.exists ? EN.promptChars(l.contentLength) : ui.paint("dim", EN.promptMissing)
			}${mark}`,
		);
		for (const path of l.paths) out.push(`      ${ui.paint("dim", path)}`);
	}
	return out;
}

/** `/models`：各角色解析到的模型。 */
export function renderModels(ui: Ui, rows: ReadonlyArray<readonly [string, string]>): string[] {
	return [ui.heading(EN.modelsTitle), ...ui.fields(rows), "", ui.bullet(ui.paint("dim", EN.modelsNote))];
}
