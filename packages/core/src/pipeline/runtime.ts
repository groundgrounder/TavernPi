// StoryRuntime 编排器（创作规划 §10.2 对外 API 面；§7 M3/M4 验收的运行时核心）。
// 接线（app/CLI 只消费 core API）：
//   SessionManager ↔ StoryDb ↔ SnapshotsDb ↔ createSnapshotHooks（导航原子恢复）
//   ↔ 主叙事 AgentSession（零工具 + before_agent_start 每轮注入 DB 摘要 + 预演/场景卡/统筹/打回批注
//      + 卡包检索注入 {{collection_injection}}，§4.1 M5）
//   ↔ npc 阶段（§6.2：场景规划 → 在场预演 ×N 并行 + 离线批量推演 → 主叙事 → data）
//   ↔ story 阶段（§6.3：场景分析最前 → 轻检/打回循环 → 全统筹）
//   ↔ stylize（§6.4：可选，审查通过后、data 前；只改文风不动事实）
//   ↔ runDataStage（data subagent：抽取落库，唯一写者，§6.1）
//     预演产物注入主叙事隐藏批注，离线 delta 交 data 转写落库——npc 层永不直接写库，
//     只由编排器在 data.ok 后直写 sys_ 簿记键（同 clock 例外精神）。
//
// M5 卡包接线（§4.1）：StoryRuntimeOptions.packs 缺省 undefined = M2–M4 形态（无注入）；
// 提供时每轮 before_agent_start 经 renderNarratorPrompt 注入检索式命中条目（system 前部 / recent 后部），
// cache 回退/预算裁减/未知钉警告走 onWarning + 事件流，TurnResult.collection 留痕本轮注入。
//
// 关键接线决策（与 M1 一致，文件头复述）：
// 1. 快照绑定本轮 leaf（最终 assistant entry），与 turn_log 同一 id。pi navigateTree 语义：
//    导航 u_N → newLeaf = a_{N-1} → 命中 a_{N-1} 快照（第 N-1 轮末）；导航 a_N → 命中自身快照。
//    user-entry 绑定会恢复出「第 N 轮结束后」，重做时事件会双重落库 —— 故绑定 assistant leaf。
// 2. 主叙事零 DB 工具：customTools=[] + tools=[]（严格白名单空数组）；上下文全由编排器注入
//    （§6.0），DB 摘要在 before_agent_start 每轮现算（getter 读当前 storyDb 实例，恢复/回溯后
//    自然准确）。构建后断言 getActiveToolNames() 为空；非空则回退 noTools:"builtin" 重建。
// 3. data 阶段（§6.1）：成功 → recordDataStatus(ok) + markFailedTurnsCompensated + 拍快照；
//    失败 → recordDataStatus(failed)、**不拍快照**（拍摄前提 = 落库成功），未落库内容下轮补齐；
//    连续失败 ≥ threshold 时 onWarning 明确提示用户。
// 4. turnSeq 从 turn_log 最大 +1（core 内 computeNextTurnSeq，与 m1-cli 同源）。
// 5. 打回重写（§6.3 轻检）：navigateTree(userEntryId) 会触发快照钩子恢复到第 N-1 轮末快照——
//    本轮 data 尚未运行（语义无害）；恢复替换 storyDb 实例，故重写循环内所有 DB 读取都必须
//    经 storyState.storyDb 属性在调用时现取（story-stage 的 options.storyDb 逐调用注入当前实例）。
// 6. userEntryId 从最终 leaf 沿 parentId 上溯取第一个 user entry（findUserEntryOnBranch）——
//    打回重写后旧稿 u_N 与新稿 u_N' 同 parentId，find-first 会误中旧稿。
//
// 坑：
// - session.prompt 必须 await 完（isStreaming=false）才能 navigateTree（spike/05 实证）。
// - 恢复（restore）用新 StoryDb 实例替换，旧连接被关闭；任何长期持有 storyDb 的闭包
//   （除 getter）都会在恢复后读到已关闭连接。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SettingsManager,
	type AgentSession,
	type CompactionResult,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type ModelRuntime,
	type SessionEntry,
	type SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { StoryDb } from "../db/story-db.ts";
import type { SnapshotsDb } from "../snapshot/snapshots-db.ts";
import { buildAncestorChain } from "../snapshot/ancestors.ts";
import { createSnapshotHooks, type SnapshotHooks } from "../snapshot/hooks.ts";
import { takeSnapshot } from "../snapshot/snapshots-db.ts";
import type { TavernModels, TavernSettings } from "../settings.ts";
import { loadPrompt, renderPlaceholders, type PromptLayerDirs } from "../prompts/loader.ts";
import type { SubagentResult, SubagentRunOptions } from "../subagent/runtime.ts";
import { buildCollectionInjection } from "../pack/matcher.ts";
import type { PackCache } from "../pack/cache.ts";
import { runDataStage, type DataStageOptions, type DataStageOutcome } from "./data-stage.ts";
import {
	computeScenePlan,
	offscreenLastTurnKey,
	renderRehearsals,
	runOffscreenBatch,
	runOnstageRehearsals,
	type NpcRehearsal,
	type NpcStageOptions,
	type OffscreenDelta,
} from "./npc-stage.ts";
import type { NpcRow } from "../db/types.ts";
import {
	renderOverseeNote,
	renderRevisionRequest,
	renderSceneCardForNarrator,
	runOversee,
	runReview,
	runRuleChecks,
	runSceneAnalysis,
	type OverseeNote,
	type ReviewFinding,
	type SceneCard,
	type StoryStageOptions,
} from "./story-stage.ts";
import { runChapterSummary } from "./chapter-summary.ts";
import { runStylize, type StylizeOptions } from "./stylize-stage.ts";
import type { PipelineEventLog } from "./events.ts";
import { renderDbSummary } from "./db-summary.ts";
import {
	assertCanSwitchMode,
	isStoryMode,
	MODE_PRESETS,
	validateSubagentSwitches,
	type StoryMode,
	type SubagentSwitchFlags,
} from "../mode.ts";
import { readStoryMeta, writeStoryMeta } from "../story.ts";

/** 当前最大 turn_seq 的下一轮（turn_log 每轮一行，PK 保证完整性；新库为 1）。与 m1-cli 同源。 */
export function computeNextTurnSeq(storyDb: StoryDb): number {
	const logs = storyDb.reader.getTurnLog();
	const last = logs.at(-1);
	return last ? last.turn_seq + 1 : 1;
}

// ---------------------------------------------------------------------------
// 主叙事系统提示渲染（before_agent_start 处理函数体；独立导出便于单测确定性断言，无需模型/网络）
// ---------------------------------------------------------------------------

/** 主叙事系统提示渲染依赖（§4.1 检索式注入 + §6.0 上下文全注入）。 */
export interface NarratorPromptDeps {
	/** narrator 模板（含 {{db_summary}}/{{collection_injection}} 等占位符）。 */
	template: string;
	/** 当前故事 DB（getter：恢复/回溯替换实例后读取始终命中最新连接）。 */
	storyDb: () => StoryDb;
	/** 卡包检索注入选项（缺省 = 无注入，占位符渲染「（无世界包注入）」）。 */
	packs?: StoryRuntimeOptions["packs"];
	/** 本轮玩家输入（runTurn 置入；打回重写循环保持同一输入，注入扫描文本不变）。 */
	currentInput: () => string;
	/** 当前 turnSeq（卡包警告事件流留痕用）。 */
	currentTurnSeq: () => number;
	pendingRehearsals: () => string | undefined;
	pendingSceneCard: () => SceneCard | undefined;
	pendingOverseeNote: () => string | undefined;
	pendingRevision: () => string | undefined;
	onWarning?: (m: string) => void;
	eventLog?: PipelineEventLog;
}

export interface NarratorPromptResult {
	/** 渲染完成的当轮系统提示全文。 */
	rendered: string;
	/** 命中注入条目标识（包名:type:id；含截断注入的条目）。 */
	collectionInjected: string[];
	/** 注入警告（缓存回退 / 预算裁减 / 未知钉）。 */
	collectionWarnings: string[];
}

/**
 * 渲染当轮主叙事系统提示。before_agent_start 钩子体——独立函数便于单测确定性断言
 * （packs 注入/警告上抛无需真实模型与网络）。
 * 卡包注入（§4.1）：cache.getPacks() 取当前 packs → buildCollectionInjection
 * （input + 上一轮 turn_log narrativeText 作为扫描文本；pinned 经 getter 每轮现取）→
 * systemText 在前、recentText 在后拼入 {{collection_injection}}；cache 回退 / 预算裁减 /
 * 未知钉警告走 onWarning + pipeline 事件流（role="pack"）。
 */
export function renderNarratorPrompt(deps: NarratorPromptDeps): NarratorPromptResult {
	const injected: string[] = [];
	const warnings: string[] = [];
	let collectionText = "（无世界包注入）";

	if (deps.packs !== undefined) {
		const { packs, warnings: cacheWarnings } = deps.packs.cache.getPacks();
		warnings.push(...cacheWarnings);
		const lastTurn = deps.storyDb().reader.getTurnLog().at(-1);
		const result = buildCollectionInjection(packs, {
			input: deps.currentInput(),
			recentNarrative: lastTurn?.narrative_text,
			pinned: deps.packs.pinned?.(),
			budgetTokens: deps.packs.budgetTokens,
		});
		injected.push(...result.injected);
		warnings.push(...result.warnings);
		const parts: string[] = [];
		if (result.systemText !== "") parts.push(result.systemText);
		if (result.recentText !== "") parts.push(result.recentText);
		collectionText = parts.length > 0 ? parts.join("\n\n") : "（本轮无注入条目）";
	}

	// 注入警告（缓存回退 / 预算裁减 / 未知钉）走 onWarning + pipeline 事件流（§4.1）
	for (const warning of warnings) {
		deps.onWarning?.(`[卡包] ${warning}`);
		deps.eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: deps.currentTurnSeq(),
			role: "pack",
			ok: false,
			durationMs: 0,
			error: warning,
		});
	}

	const rendered = renderPlaceholders(deps.template, {
		db_summary: renderDbSummary(deps.storyDb()),
		npc_rehearsals: deps.pendingRehearsals() ?? "（本轮无在场 NPC 预演）",
		scene_card: deps.pendingSceneCard()
			? renderSceneCardForNarrator(deps.pendingSceneCard()!, deps.storyDb())
			: "（无）",
		oversee_note: deps.pendingOverseeNote() ?? "（无）",
		revision_request: deps.pendingRevision() ?? "（无）",
		collection_injection: collectionText,
	}).text;

	return { rendered, collectionInjected: injected, collectionWarnings: warnings };
}

/** story.meta.json 的 defaultStyle（世界包文风，§6.4 stylize 缺省 hint）；读不到返回 undefined。 */
function readStoryMetaDefaultStyle(storyDir: string): string | undefined {
	try {
		const meta = JSON.parse(readFileSync(join(storyDir, "story.meta.json"), "utf8")) as { defaultStyle?: unknown };
		return typeof meta.defaultStyle === "string" ? meta.defaultStyle : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 从最终 leaf 沿 parentId 上溯找第一个 user entry（§6.3 打回重写后原 u_N 与新 u_N' 同 parentId，
 * find-first 会误中旧稿；本函数从最终 leaf 出发，命中新稿所在分支的 user entry）。找不到返回 null。
 */
export function findUserEntryOnBranch(
	entries: ReadonlyArray<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
	leafId: string,
): string | null {
	const byId = new Map(entries.map((e) => [e.id, e]));
	let cur = byId.get(leafId) ?? null;
	while (cur !== null) {
		if (cur.type === "message" && cur.message?.role === "user") return cur.id;
		cur = cur.parentId !== null ? byId.get(cur.parentId) ?? null : null;
	}
	return null;
}

/** 从 leaf 上溯取 user entry，缺失即抛（正常 prompt 流恒成立；供快照绑定/navigateTree 定位）。 */
function assertUserEntryOnBranch(
	entries: ReadonlyArray<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
	leafId: string,
): string {
	const id = findUserEntryOnBranch(entries, leafId);
	if (id === null) {
		throw new Error(`从 leaf ${leafId} 上溯未找到 user entry——快照绑定失败`);
	}
	return id;
}

/** 最后一个非空 assistant 文本回复（本轮叙事正文）。 */
function extractLastAssistantReply(messages: ReadonlyArray<{ role: string; content?: unknown }>): string | undefined {
	for (const msg of [...messages].reverse()) {
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		const text = (msg.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		if (text.trim() !== "") return text;
	}
	return undefined;
}

/** message 条目的文本（content 数组或纯字符串）。 */
function messageTextOfEntry(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const content = (entry.message as { content?: unknown }).content;
	if (Array.isArray(content)) {
		return (content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof content === "string" ? content : "";
}

/** data_status 中 status='failed' 的轮次，join turn_log 取 user_input/narrative_text（待补齐轮）。 */
function computePendingTurns(storyDb: StoryDb): DataStageOptions["input"]["pendingTurns"] {
	const failedTurns = storyDb.reader.listDataStatus().filter((r) => r.status === "failed").map((r) => r.turn_seq);
	if (failedTurns.length === 0) return [];
	const turnLogs = new Map(storyDb.reader.getTurnLog().map((t) => [t.turn_seq, t]));
	return failedTurns.map((turnSeq) => {
		const row = turnLogs.get(turnSeq);
		return row
			? { turnSeq, userInput: row.user_input, narrativeText: row.narrative_text }
			: { turnSeq, userInput: "", narrativeText: "" };
	});
}

/** 从最新往前连续 'failed' 计数（'ok'/'compensated' 断串）——连续失败提示阈值依据。 */
function countConsecutiveFailures(storyDb: StoryDb): number {
	let count = 0;
	for (const row of [...storyDb.reader.listDataStatus()].reverse()) {
		if (row.status === "failed") count++;
		else break;
	}
	return count;
}

/** 近期叙事窗口（turn_log 后 N 条）——场景分析/全统筹的输入（§6.3）。 */
function recentNarratives(storyDb: StoryDb, n: number): Array<{ turnSeq: number; userInput: string; narrativeText: string }> {
	return storyDb.reader.getTurnLog().slice(-n).map((t) => ({
		turnSeq: t.turn_seq,
		userInput: t.user_input,
		narrativeText: t.narrative_text,
	}));
}

/** 解析角色模型（settings.models.<role> → modelRuntime.getModel）；解析失败/无配置 → undefined + onWarning。 */
function resolveRoleModel(
	settings: TavernSettings | undefined,
	role: keyof TavernModels,
	modelRuntime: ModelRuntime | undefined,
	onWarning: ((m: string) => void) | undefined,
): SubagentRunOptions["model"] {
	if (modelRuntime === undefined) return undefined;
	const ref = settings?.models[role];
	if (!ref) return undefined;
	const model = modelRuntime.getModel(ref.provider, ref.id);
	if (!model) {
		onWarning?.(`模型解析失败: ${role}=${ref.provider}/${ref.id}（modelRuntime.getModel 返回空，使用 pi 默认模型）`);
	}
	return model ?? undefined;
}

export interface StoryState {
	storyDir: string;
	storyDb: StoryDb;
	snapshotsDb: SnapshotsDb;
}

/** npc subagent 阶段运行时选项（§6.2）。enabled 缺省 false——M2/M3 路径（npc 关闭）零改动。 */
export interface NpcStageRuntimeOptions {
	enabled: boolean;
	/** 离线推演触发阈值：距上次推演 ≥ N 轮触发（默认 5）。 */
	offscreenAfterTurns?: number;
	/** 每 NPC / 每批重试上限（默认 2）。 */
	maxAttempts?: number;
	/** npc 执行器注入（验收故障注入，npc 专用）。 */
	executor?: NpcStageOptions["executor"];
}

/** story subagent 阶段运行时选项（§6.3）。enabled 缺省 false——M2/M3 路径（story 关闭）零改动。 */
export interface StoryStageRuntimeOptions {
	enabled: boolean;
	/** 打回重写上限（默认 1 = 最多 2 稿，§6.3「上限 1–2 次」）；超限放行（strictDrop）。 */
	maxRevisions?: number;
	/** 全统筹轮期间隔（默认 10；sceneCard.major_event 也触发）。 */
	overseeEveryTurns?: number;
	/** 场景分析/全统筹的近期叙事窗口（默认 5，从 turn_log 取）。 */
	recentNarratives?: number;
	/** story 执行器注入（验收故障注入，story 专用）。 */
	executor?: StoryStageOptions["executor"];
}

/** stylize 阶段运行时选项（§6.4）。enabled 缺省 false（默认关闭）。 */
export interface StylizeRuntimeOptions {
	enabled: boolean;
	/** 文风目标（世界包文风字段 M5 接入；现为故事级覆盖）。 */
	styleHint?: string;
	/** 重试上限（默认 2）。 */
	maxAttempts?: number;
	/** stylize 执行器注入（验收故障注入）。 */
	executor?: StylizeOptions["executor"];
}

export interface StoryRuntimeOptions {
	cwd: string;
	sessionManager: SessionManager;
	storyState: StoryState;
	/** 内核级模式预设（§10.1 ★信任边界）。解析顺序：显式 option → story.meta.json（storyDir 内）→ "creation"。
	 *  若 meta 记录 adventure 而 option 传了别的值 → 抛错（锁不可绕）。 */
	mode?: StoryMode;
	settings?: TavernSettings;
	modelRuntime?: ModelRuntime;
	prompts?: PromptLayerDirs;
	eventLog?: PipelineEventLog;
	onWarning?: (m: string) => void;
	/** data 重试上限（默认 3）。 */
	maxDataAttempts?: number;
	/** 连续失败提示阈值（默认 3）。 */
	failureWarningThreshold?: number;
	/** data 执行器注入（验收故障注入）。 */
	dataExecutor?: DataStageOptions["executor"];
	/** npc subagent 阶段（§6.2）。缺省关闭（M2 形态不变）。 */
	npc?: NpcStageRuntimeOptions;
	/** story subagent 阶段（§6.3）。缺省关闭（M3 形态不变）。 */
	story?: StoryStageRuntimeOptions;
	/** stylize 阶段（§6.4）。缺省关闭。 */
	stylize?: StylizeRuntimeOptions;
	/** 卡包检索注入（§4.1 M5；缺省 = M2–M4 形态，无注入，占位符渲染「（无世界包注入）」）。 */
	packs?: {
		/** 设定集热更新缓存（getPacks：mtime 变化重载，失败回退上次成功快照 + warning）。 */
		cache: PackCache;
		/** 手动钉（getter：CLI 会话级动态改）。写法 `包名:type:id`。 */
		pinned?: () => string[];
		/** token 预算（默认 1500，可按故事覆盖）。 */
		budgetTokens?: number;
	};
	/** 系统提示渲染完成回调（§10.2 pipeline 可观测性）：before_agent_start 每次注入后调用，
	 *  参数为渲染好的当轮系统提示全文（含 db_summary 与当轮预演/场景卡/统筹/打回批注）。观测钩子，不影响渲染语义。 */
	onSystemPromptRender?: (rendered: string) => void;
	/** 主叙事 session 的 pi SettingsManager（§3.0/§3.1 compaction 触发参数：keepRecentTokens 等）。
	 *  缺省走 createAgentSession 默认（~/.pi/agent 全局设置）；测试/验收可传 SettingsManager.inMemory 注入小 keepRecentTokens。 */
	settingsManager?: SettingsManager;
	/** 章节摘要 compaction subagent 选项（§3.0/§3.1）：缺省走真实 runSubagent。executor 供测试故障注入。 */
	chapterSummary?: {
		executor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
		/** 重试上限（默认 2）。 */
		maxAttempts?: number;
	};
}

export interface TurnResult {
	turnSeq: number;
	userEntryId: string;
	leafId: string;
	narrativeText: string;
	data: DataStageOutcome;
	snapshotTaken: boolean;
	consecutiveDataFailures: number;
	/** npc 阶段报告（§6.2；npc 关闭时缺省）。 */
	npc?: {
		onstageNpcIds: number[];
		rehearsals: NpcRehearsal[];
		offscreenTriggeredIds: number[];
		offscreenDeltas: OffscreenDelta[];
	};
	/** story 阶段报告（§6.3；story 关闭时缺省）。 */
	story?: {
		sceneCard: SceneCard;
		sceneFallback: boolean;
		hardConflicts: string[];
		suspicions: string[];
		reviewFindings: ReviewFinding[];
		/** 实际重写次数。 */
		revisions: number;
		/** 超限放行（重写仍冲突 → 放行，冲突留 turn_log.warnings + data strictDrop）。 */
		releasedWithWarnings: boolean;
	};
	/** stylize 报告（§6.4；stylize 关闭时缺省）。 */
	stylize?: { applied: boolean; drift?: string[] };
	/** 全统筹批注（§6.3；本轮触发则为 note，未触发字段缺省，触发但失败为 null）。 */
	oversee?: OverseeNote | null;
	/** 卡包检索注入报告（§4.1；packs 缺省时无此字段）。 */
	collection?: { injected: string[]; warnings: string[] };
}

export interface StoryRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	storyState: StoryState;
	hooks: SnapshotHooks;
	/** 当前内核级模式（§10.1）。 */
	readonly mode: StoryMode;
	/** 切换模式（§10.1）：断言可切换、校验当前 subagent 开关符合目标预设、写回 story.meta.json、更新内部状态。
	 *  adventure 锁定不可切换（含切出）；违规抛中文 Error（列需先重开项，不自动改）。 */
	setMode(next: StoryMode): void;
	/** 跑一轮叙事。opts.force = /! 前缀（输入渠道校验强制提交，留痕 warning；§10.1 + §8 决策记录）。
	 *  skipInputValidation 为内部选项（swipe 重放历史已接受输入时跳过校验），不经公开签名。 */
	runTurn(input: string, opts?: { force?: boolean }): Promise<TurnResult>;
	/** /swipe（§3.0 重骰）：基于分支重生成最后一个 user 轮次的响应，旧稿留树。 */
	swipe(): Promise<TurnResult>;
	dispose(): void;
}

/**
 * 解析运行时生效模式（§10.1 ★信任边界）。优先级：显式 option → story.meta.json（storyDir 内）→ "creation"。
 * 【adventure 锁】meta 记录 adventure 而 option 传了别的值 → 抛错（锁不可绕；中途不进出的契约）。
 * 【升级守卫】meta 存在且非 adventure、option = adventure → 抛错（冒险只能在故事创建时选定，§10.1；不可把已存在的故事升级为冒险）。
 * 【无 meta 升级拒】meta 缺失（非 createStory 产物）+ option = adventure → 抛错（无法确认曾以冒险创建）。
 * 【合法性】非法模式值（option 或 meta.mode，如 "Survival"）→ 抛错（不回落；避免首次 runTurn 在 MODE_PRESETS[mode] 抛 TypeError）。
 */
export function resolveStoryMode(optsMode: StoryMode | undefined, storyDir: string): StoryMode {
	if (optsMode !== undefined && !isStoryMode(optsMode)) {
		throw new Error(`非法模式值: ${JSON.stringify(optsMode)}（应为 creation|survival|adventure）`);
	}
	const meta = readStoryMeta(storyDir);
	const metaMode = meta?.mode;
	if (metaMode !== undefined && !isStoryMode(metaMode)) {
		throw new Error(`故事 meta 记录非法模式值: ${JSON.stringify(metaMode)}（应为 creation|survival|adventure）`);
	}
	if (metaMode === "adventure" && optsMode !== undefined && optsMode !== "adventure") {
		throw new Error(`故事模式已锁定为 adventure（冒险），不能以 ${optsMode} 打开（锁不可绕，中途不进不出）。`);
	}
	if (meta !== undefined && metaMode !== "adventure" && optsMode === "adventure") {
		throw new Error(
			`不能以 adventure（冒险）打开已存在的故事（当前模式 ${metaMode ?? "（未记录，缺省 creation）"}）——冒险只能在创建故事时选定。`,
		);
	}
	if (meta === undefined && optsMode === "adventure") {
		throw new Error("冒险模式只能在创建故事时选定；该故事无模式元数据（story.meta.json 缺失）。");
	}
	return optsMode ?? metaMode ?? "creation";
}

/**
 * 输入渠道校验错误（§10.1 + §8 决策记录「输入渠道校验判定」）：生存/冒险拒绝非 user 角色行为的输入
 * （命令 NPC、指定剧情结果、上帝视角陈述）。携带 reason（非法原因）与 suggestion（改写建议）字段；
 * 用户可改写成合法输入，或经 `/!` 前缀强制提交（留痕 warning，见 runTurn force 路径）。
 */
export class InputRejectedError extends Error {
	readonly reason: string;
	readonly suggestion: string;
	constructor(reason: string, suggestion: string) {
		super(`输入被拒绝：${reason}`);
		this.name = "InputRejectedError";
		this.reason = reason;
		this.suggestion = suggestion;
	}
}

/**
 * 输入渠道校验判定（§10.1 + §8 决策记录；纯函数无副作用）：返回是否拒绝 + 原因/建议。
 * 规则：只对模式预设 inputValidation=true（生存/冒险）且场景卡存在生效；creation（inputValidation=false）
 * 或场景卡缺席（story 关闭）不校验。场景卡 input_validity 缺席或 valid=true → 放行。
 * force=true（/! 前缀）→ 不拒绝（放行留痕）。驳回时返回 reason/suggestion 供 InputRejectedError 消费。
 */
export function computeInputValidityAction(
	mode: StoryMode,
	sceneCard: SceneCard | undefined,
	force: boolean,
): { reject: boolean; reason: string; suggestion: string } {
	if (!MODE_PRESETS[mode].inputValidation || sceneCard === undefined) {
		return { reject: false, reason: "", suggestion: "" };
	}
	const iv = sceneCard.input_validity;
	if (iv === undefined || iv.valid === true) {
		return { reject: false, reason: "", suggestion: "" };
	}
	const reason = iv.reason ?? "输入越权";
	const suggestion = iv.suggestion ?? "";
	return { reject: !force, reason, suggestion };
}

/**
 * 切换模式（§10.1）：断言可切换、校验当前 subagent 开关符合目标模式预设、写回 story.meta.json、返回新模式。
 * 不自动改 subagent 开关——违规抛中文 Error 列出需先重开的项。adventure 锁定（含切出）一律拒绝。
 */
export function applyModeSwitch(
	currentMode: StoryMode,
	nextMode: StoryMode,
	flags: SubagentSwitchFlags,
	storyDir: string,
): StoryMode {
	assertCanSwitchMode(currentMode, nextMode);
	const problems = validateSubagentSwitches(nextMode, flags);
	if (problems.length > 0) {
		throw new Error(
			`无法从 ${currentMode} 切换到 ${nextMode}：当前 subagent 开关不符合目标模式预设，需先重置：\n- ${problems.join("\n- ")}`,
		);
	}
	const meta = readStoryMeta(storyDir) ?? { packs: [], createdAt: new Date().toISOString() };
	writeStoryMeta(storyDir, { ...meta, mode: nextMode });
	return nextMode;
}

/** 构建一次完整接线运行态（fork 后以新故事目录重建新实例）。 */
export async function createStoryRuntime(opts: StoryRuntimeOptions): Promise<StoryRuntime> {
	const { cwd, sessionManager, storyState, settings, modelRuntime, prompts, eventLog, onWarning } = opts;

	// ---- 模式解析（§10.1 ★信任边界）：显式 option → story.meta.json → "creation"；adventure 锁不可绕 ----
	let mode: StoryMode = resolveStoryMode(opts.mode, storyState.storyDir);
	const maxDataAttempts = opts.maxDataAttempts ?? 3;
	const failureWarningThreshold = opts.failureWarningThreshold ?? 3;
	// 阶段选项：缺省全部关闭（enabled=false，M2/M3 形态不变）。
	const npcOpts: NpcStageRuntimeOptions = { enabled: false, ...opts.npc };
	const storyOpts: StoryStageRuntimeOptions = { enabled: false, ...opts.story };
	const stylizeOpts: StylizeRuntimeOptions = { enabled: false, ...opts.stylize };
	// 构建时以最终 mode 校验 subagent 开关组合（flags 取各阶段 enabled 解析结果），有问题则 throw（中文列出全部问题）。
	const subagentFlags: SubagentSwitchFlags = {
		story: storyOpts.enabled,
		npc: npcOpts.enabled,
		stylize: stylizeOpts.enabled,
	};
	const modeProblems = validateSubagentSwitches(mode, subagentFlags);
	if (modeProblems.length > 0) {
		throw new Error(`subagent 开关与故事模式（${mode}）冲突：\n- ${modeProblems.join("\n- ")}`);
	}
	// stylize.styleHint 缺省值：未显式传入时读 story.meta.json 的 defaultStyle（§6.4 世界包文风）。
	if (stylizeOpts.styleHint === undefined) {
		stylizeOpts.styleHint = readStoryMetaDefaultStyle(storyState.storyDir);
	}

	const hooks = createSnapshotHooks({
		snapshotsDb: storyState.snapshotsDb,
		getStoryDb: () => storyState.storyDb,
		setStoryDb: (db) => {
			storyState.storyDb = db;
		},
		getEntryAncestors: (entryId) => buildAncestorChain(sessionManager.getEntries(), entryId),
		onWarning,
	});

	// 主叙事提示词模板（占位符 before_agent_start 每轮现算注入）。
	const narratorTemplate = loadPrompt("narrator", prompts).content;
	const narratorModel = resolveRoleModel(settings, "narrator", modelRuntime, onWarning);
	const dataModel = resolveRoleModel(settings, "data", modelRuntime, onWarning);
	const npcModel = resolveRoleModel(settings, "npc", modelRuntime, onWarning);
	const storyModel = resolveRoleModel(settings, "story", modelRuntime, onWarning);
	const stylizeModel = resolveRoleModel(settings, "stylize", modelRuntime, onWarning);
	// 章节摘要 compaction subagent（§3.0/§3.1）：模型配置 settings.models.chapter_summary；缺省走 pi 默认模型。
	// 提示词由 runChapterSummary 内部 loadPrompt("chapter_summary") 加载，此处只解析模型。
	const chapterSummaryModel = resolveRoleModel(settings, "chapter_summary", modelRuntime, onWarning);

	// story 阶段 runner 公共选项（storyDb 逐调用注入当前实例——重写循环经快照恢复替换实例后不能持有旧连接）。
	const storyStageOptsBase: Omit<StoryStageOptions, "storyDb"> = {
		cwd,
		model: storyModel,
		modelRuntime,
		prompts,
		eventLog,
		executor: storyOpts.executor,
	};

	// 主叙事注入闭包：每轮现算；turn 结束后复位（预演/场景卡/打回只属当轮，统筹产物给下一轮）。
	let pendingRehearsals: string | undefined;
	let pendingSceneCard: SceneCard | undefined;
	let pendingOverseeNote: string | undefined;
	let pendingRevision: string | undefined;
	// 输入渠道校验 /! 强制留痕（§8）：内存记录「最近一次拒绝」（输入文本 + reason），不落库（零痕迹语义不破）。
	// force=true 且输入匹配该记录时无条件留痕，即使第二次场景分析判合法（审计痕迹不丢）。
	let lastRejectedInput: { input: string; reason: string } | undefined;
	// 卡包检索注入输入/报告（§4.1）：输入由 runTurn 置入（重写循环保持同一输入）；报告在
	// before_agent_start 每次渲染后暂存，供 TurnResult.collection（最后一次 prompt 的注入结果）。
	let pendingCollectionInput: string | undefined;
	let pendingCollectionTurnSeq = 0;
	let pendingCollectionReport: TurnResult["collection"];

	const extensionFactories: Array<(pi: ExtensionAPI) => void> = [
		(pi) => {
			pi.on("session_before_tree", (event, ctx) => {
				hooks.sessionBeforeTree(event, ctx);
			});
			pi.on("session_tree", (event, ctx) => {
				hooks.sessionTree(event, ctx);
			});
			// 章节摘要 compaction（§3.0/§3.1）：session_before_compact 触发时用 chapter_summary subagent
			// 生成章节摘要（完全替换 pi 默认摘要）。返回 undefined（失败回退默认摘要）绝不阻塞 compaction。
			pi.on("session_before_compact", async (event) => {
				const prep = event.preparation;
				const summary = await runChapterSummary(
					{
						branchEntries: event.branchEntries,
						firstKeptEntryId: prep.firstKeptEntryId,
						// 迭代 compaction（§3.1）：把上次章节摘要（previousSummary）与 SDK 精确吞并集
						// （messagesToSummarize + turnPrefixMessages）一并交给 chapter_summary——新摘要吸收前情要点，
						// 避免前置章节摘要 S1 从活上下文消失导致伏笔丢失。
						previousSummary: prep.previousSummary,
						messagesToSummarize: prep.messagesToSummarize,
						turnPrefixMessages: prep.turnPrefixMessages,
					},
					{
						storyDb: storyState.storyDb,
						cwd,
						model: chapterSummaryModel,
						modelRuntime,
						prompts,
						eventLog,
						executor: opts.chapterSummary?.executor,
						maxAttempts: opts.chapterSummary?.maxAttempts,
					},
				);
				if (summary === undefined) {
					onWarning?.(`章节摘要生成失败（回退 pi 默认摘要）：被吞并区段 ${prep.tokensBefore} tokens`);
					return undefined;
				}
				return {
					compaction: {
						summary,
						firstKeptEntryId: prep.firstKeptEntryId,
						tokensBefore: prep.tokensBefore,
					} satisfies CompactionResult,
				};
			});
			// 每轮注入通道：before_agent_start 每次 prompt 触发一次，整串替换当轮系统提示。
			// 渲染逻辑收敛在 renderNarratorPrompt（独立导出，单测确定性覆盖）：
			// renderPlaceholders 只替换已知占位符，其余模板原样保留。
			// onSystemPromptRender：渲染完成回调（§10.2 可观测性），供验收/观测钩子读取注入内容。
			// 卡包检索注入（§4.1）：packs 提供时每轮 cache.getPacks() + buildCollectionInjection，
			// 注入报告暂存 pendingCollectionReport，供 TurnResult.collection（最后一次 prompt 的结果）。
			pi.on("before_agent_start", () => {
				const result = renderNarratorPrompt({
					template: narratorTemplate,
					storyDb: () => storyState.storyDb,
					packs: opts.packs,
					currentInput: () => pendingCollectionInput ?? "",
					currentTurnSeq: () => pendingCollectionTurnSeq,
					pendingRehearsals: () => pendingRehearsals,
					pendingSceneCard: () => pendingSceneCard,
					pendingOverseeNote: () => pendingOverseeNote,
					pendingRevision: () => pendingRevision,
					onWarning,
					eventLog,
				});
				if (opts.packs !== undefined) {
					pendingCollectionReport = {
						injected: result.collectionInjected,
						warnings: result.collectionWarnings,
					};
				}
				opts.onSystemPromptRender?.(result.rendered);
				return { systemPrompt: result.rendered };
			});
		},
	];

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPromptOverride: () => narratorTemplate,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: () => ({ prompts: [], diagnostics: [] }),
		extensionFactories,
	});
	await loader.reload();

	// 零工具会话：tools 是严格白名单，空数组 = 零工具（§6.0 主叙事不持有 DB 工具）。
	// 构建后断言；若非空（SDK 行为异常）则回退 noTools:"builtin" 重建（customTools 为空，
	// noTools 只会关闭内置工具，最终仍为零工具）。
	const sessionOptions: CreateAgentSessionOptions = {
		cwd,
		sessionManager,
		resourceLoader: loader,
		customTools: [],
		tools: [],
		model: narratorModel,
		modelRuntime,
		...(opts.settingsManager !== undefined ? { settingsManager: opts.settingsManager } : {}),
	};
	let created = await createAgentSession(sessionOptions);
	let session = created.session;
	if (session.getActiveToolNames().length > 0) {
		session.dispose();
		created = await createAgentSession({ ...sessionOptions, tools: undefined, noTools: "builtin" });
		session = created.session;
	}
	if (created.modelFallbackMessage) {
		console.warn(`[warn] ${created.modelFallbackMessage}`);
	}

	// 私有 runTurn 主体（§10.2 API 面收口）：skipInputValidation 是内部选项（swipe 重放历史已接受输入故跳过校验），
	// 不进公开签名（对比 force 有留痕；skipInputValidation 是无痕旁路，不对外暴露）。
	const runTurnInternal = async (input: string, turnOpts?: { force?: boolean; skipInputValidation?: boolean }): Promise<TurnResult> => {
		if (session.isStreaming) {
			throw new Error("isStreaming 期间不能 prompt（应等待上一轮完成）");
		}
		const turnSeq = computeNextTurnSeq(storyState.storyDb);
		const startedAt = Date.now();

		// 卡包检索注入输入（§4.1）：runTurn 置入，before_agent_start 经 renderNarratorPrompt 消费；
		// 打回重写循环保持同一输入（注入扫描文本不变）。
		pendingCollectionInput = input;
		pendingCollectionTurnSeq = turnSeq;
		pendingCollectionReport = undefined;

		// ---- story 阶段①：场景分析在最前，产出场景卡（npc 调度 / data 时间建议 / 轻检依据 / 输入校验）----
		let sceneCard: SceneCard | undefined;
		let sceneFallback = false;
		if (storyOpts.enabled) {
			const analysis = await runSceneAnalysis(
				{
					turnSeq,
					userInput: input,
					recentNarratives: recentNarratives(storyState.storyDb, storyOpts.recentNarratives ?? 5),
					validateInput: MODE_PRESETS[mode].inputValidation,
					directivesAllowed: MODE_PRESETS[mode].directivesAllowed,
				},
				{ ...storyStageOptsBase, storyDb: storyState.storyDb },
			);
			sceneCard = analysis.card;
			sceneFallback = analysis.fallback;
			pendingSceneCard = analysis.card;
		}

		// ---- 输入渠道校验（§10.1 + §8 决策记录「输入渠道校验判定」）----
		// 只在模式预设 inputValidation=true（生存/冒险）且 story 开启时生效（story 关闭无场景分析 → 无校验；
		// inputValidation 模式强制 story 开，故 story 关闭必然是中立的创造降级形态，自洽）。创造模式只看字段不拦截。
		let forcedInputWarning: string | undefined;
		if (storyOpts.enabled && sceneCard && turnOpts?.skipInputValidation !== true) {
			const validity = computeInputValidityAction(mode, sceneCard, turnOpts?.force ?? false);
			if (validity.reject) {
				// 拒绝轮零痕迹：不 prompt 主叙事（输入不进 session 树）、不消耗 turn_seq（未写 turn_log，
				// 下轮 reapend 同号）、不写 turn_log、不拍快照、npc/data 不跑。场景分析只读 + eventLog 诊断留痕，
				// 不落故事库状态。清当轮注入闭包，防泄漏到后续 prompt。
				pendingSceneCard = undefined;
				pendingRevision = undefined;
				// 内存记最近一次拒绝（供 /! 强制留痕兜底；仅内存，零痕迹语义不破）。
				lastRejectedInput = { input, reason: validity.reason };
				throw new InputRejectedError(validity.reason, validity.suggestion);
			}
			// force=/! 前缀：放行继续 pipeline，留痕 warning（与 M4 超限放行 warning 并存时合并，见下方 setTurnLogWarnings）。
			if (turnOpts?.force === true && MODE_PRESETS[mode].inputValidation) {
				// 优先用「最近一次拒绝」的 reason 无条件留痕（即使本次场景分析判合法）；否则按本次判定。
				const forceReason =
					lastRejectedInput !== undefined && lastRejectedInput.input === input
						? lastRejectedInput.reason
						: sceneCard.input_validity?.valid === false
							? validity.reason
							: undefined;
				if (forceReason !== undefined) {
					forcedInputWarning = `输入经 /! 强制提交：${forceReason}`;
				}
			}
		}

		// ---- npc 阶段（§6.2）：场景卡驱动在场/离线名单；story 关闭时维持 M3 确定性判定 ----
		let npcReport: TurnResult["npc"];
		if (npcOpts.enabled) {
			const allNpcs = storyState.storyDb.reader.listNpcs();
			const npcById = new Map(allNpcs.map((n) => [n.id, n]));
			let onstageNpcs: NpcRow[] = [];
			let offscreenTriggered: NpcRow[] = [];
			if (storyOpts.enabled && sceneCard) {
				// 在场 = onstage_npc_ids（场景卡校验已保证合法）；离线 = offscreen_npc_ids ∪ K 轮确定性
				// 兜底（computeScenePlan，防场景卡漏列久未推演者），去重并排除在场。
				onstageNpcs = sceneCard.onstage_npc_ids
					.map((id) => npcById.get(id))
					.filter((n): n is NpcRow => n !== undefined);
				const union = new Map<number, NpcRow>();
				for (const off of sceneCard.offscreen_npc_ids) {
					const n = npcById.get(off.npc_id);
					if (n) union.set(n.id, n);
				}
				for (const n of computeScenePlan(storyState.storyDb, turnSeq, {
					offscreenAfterTurns: npcOpts.offscreenAfterTurns,
				}).offscreenTriggered) {
					union.set(n.id, n);
				}
				const onstageSet = new Set(onstageNpcs.map((n) => n.id));
				offscreenTriggered = [...union.values()].filter((n) => !onstageSet.has(n.id));
			} else {
				const scenePlan = computeScenePlan(storyState.storyDb, turnSeq, {
					offscreenAfterTurns: npcOpts.offscreenAfterTurns,
				});
				onstageNpcs = scenePlan.onstage;
				offscreenTriggered = scenePlan.offscreenTriggered;
			}
			const npcStageOpts: NpcStageOptions = {
				storyDb: storyState.storyDb,
				cwd,
				model: npcModel,
				modelRuntime,
				prompts,
				eventLog,
				maxAttempts: npcOpts.maxAttempts,
				executor: npcOpts.executor,
				directives: storyOpts.enabled && MODE_PRESETS[mode].directivesAllowed
					? storyState.storyDb.reader.listDirectives("active").map((d) => d.content)
					: undefined,
			};
			const [rehearsals, deltas] = await Promise.all([
				onstageNpcs.length > 0
					? runOnstageRehearsals(onstageNpcs, turnSeq, input, npcStageOpts)
					: Promise.resolve<NpcRehearsal[]>([]),
				offscreenTriggered.length > 0
					? runOffscreenBatch(offscreenTriggered, turnSeq, npcStageOpts)
					: Promise.resolve<OffscreenDelta[]>([]),
			]);
			// 预演产物注入主叙事（before_agent_start 一并渲染）；无在场预演 → 占位文本。
			pendingRehearsals =
				rehearsals.length === 0 ? "（本轮无在场 NPC 预演）" : renderRehearsals(rehearsals, storyState.storyDb);
			npcReport = {
				onstageNpcIds: onstageNpcs.map((n) => n.id),
				rehearsals,
				offscreenTriggeredIds: offscreenTriggered.map((n) => n.id),
				offscreenDeltas: deltas,
			};
		}

		// story 阶段报告累积量（重写循环内更新）
		let hardConflicts: string[] = [];
		let suspicions: string[] = [];
		let reviewFindings: ReviewFinding[] = [];
		let revisions = 0;
		let releasedWithWarnings = false;

		try {
			// ---- 主叙事（§6.3 轻检/打回循环；story 关闭时保持 M3 单 prompt 形态）----
			let promptStart = session.state.messages.length;
			await session.prompt(input);
			let leafId = sessionManager.getLeafId();
			if (leafId === null) {
				throw new Error("prompt 后无 leaf entry（会话树异常）");
			}
			let userEntryId = assertUserEntryOnBranch(sessionManager.getEntries(), leafId);
			let narrativeText = extractLastAssistantReply(session.state.messages.slice(promptStart)) ?? "";

			if (storyOpts.enabled && sceneCard) {
				const maxRevisions = storyOpts.maxRevisions ?? 1;
				for (;;) {
					// 规则层确定性断言（零 LLM，每轮必跑）
					const rule = runRuleChecks({ sceneCard, storyDb: storyState.storyDb, narrativeText, turnSeq });
					hardConflicts = rule.hardConflicts;
					suspicions = rule.suspicions;
					const revisionBasis: string[] = [...rule.hardConflicts];
					let rewriteFindings: ReviewFinding[] = [];
					if (rule.hardConflicts.length > 0) {
						// 规则层硬冲突：直接打回（无需 LLM 审查）
					} else if (rule.suspicions.length > 0) {
						// 报疑 → LLM 审查层核验；severity=hard 并入打回依据
						reviewFindings = await runReview(
							{ turnSeq, narrativeText, suspicions: rule.suspicions, sceneCard },
							{ ...storyStageOptsBase, storyDb: storyState.storyDb },
						);
						rewriteFindings = reviewFindings.filter((f) => f.severity === "hard");
						revisionBasis.push(...rewriteFindings.map((f) => `[${f.kind}] ${f.description}`));
					}
					if (revisionBasis.length === 0) break; // 轻检通过
					if (revisions >= maxRevisions) {
						// 超限放行：冲突留 turn_log.warnings + data strictDrop（§6.3）
						releasedWithWarnings = true;
						break;
					}
					// 打回：navigateTree 到当轮 user entry（钩子恢复到第 N-1 轮末快照——本轮 data 未跑，
					// 语义无害；DB 实例被替换，后续读取一律经 storyState.storyDb 现取）。
					// 防御（首轮/目标链无快照）：此时 navigateTree 会触发「空库兜底」（resetToEmptyStoryDb），
					// 清空 seed 与已落库事实——跳过导航、从当前 leaf 直接重写（旧稿留在上下文，语义偏差可接受，
					// 绝不误清库）；有快照时走标准导航重写路径。
					const rewriteHasSnapshot =
						storyState.snapshotsDb.findNearestSnapshot(buildAncestorChain(sessionManager.getEntries(), userEntryId)) !== undefined;
					if (rewriteHasSnapshot) {
						await session.navigateTree(userEntryId);
					}
					pendingRevision = renderRevisionRequest(rule.hardConflicts, rewriteFindings);
					promptStart = session.state.messages.length;
					await session.prompt(input);
					leafId = sessionManager.getLeafId();
					if (leafId === null) {
						throw new Error("重写后无 leaf entry（会话树异常）");
					}
					narrativeText = extractLastAssistantReply(session.state.messages.slice(promptStart)) ?? "";
					userEntryId = assertUserEntryOnBranch(sessionManager.getEntries(), leafId);
					revisions++;
				}
			}

			// 当轮注入闭包消费完毕复位（统筹产物给下一轮，由下一轮叙事阶段消费后复位）
			pendingRevision = undefined;
			pendingOverseeNote = undefined;

			// ---- stylize（§6.4，默认关闭；轻检通过/放行后、data 前）----
			let finalText = narrativeText;
			let stylizeReport: TurnResult["stylize"];
			if (stylizeOpts.enabled) {
				const res = await runStylize(
					{ turnSeq, narrativeText, styleHint: stylizeOpts.styleHint },
					{
						storyDb: storyState.storyDb,
						cwd,
						model: stylizeModel,
						modelRuntime,
						prompts,
						eventLog,
						maxAttempts: stylizeOpts.maxAttempts,
						executor: stylizeOpts.executor,
					},
				);
				finalText = res.text;
				stylizeReport = { applied: res.applied, drift: res.drift };
			}

			// ---- turn_log：narrativeText = 最终文本（stylize 后）；rawText = stylize 前原文；warnings = 超限放行冲突 ----
			const releasedWarningsText = releasedWithWarnings
				? `本轮轻检未通过但超限放行: ${[
						...hardConflicts,
						...reviewFindings.filter((f) => f.severity === "hard").map((f) => `[${f.kind}] ${f.description}`),
					].join("; ")}`
				: undefined;
			storyState.storyDb.writer.recordTurnLog({
				turnSeq,
				sessionEntryId: leafId,
				userInput: input,
				narrativeText: finalText,
				...(stylizeOpts.enabled ? { rawText: narrativeText } : {}),
				warnings: releasedWarningsText,
			});

			// 输入强制提交留痕（§8 决策记录）：与 M4 超限放行 warning 并存时合并追加。
			if (forcedInputWarning !== undefined) {
				const existingWarnings = storyState.storyDb.reader.getTurnLog(turnSeq)[0]?.warnings;
				const mergedWarnings = existingWarnings
					? `${existingWarnings}；${forcedInputWarning}`
					: forcedInputWarning;
				storyState.storyDb.writer.setTurnLogWarnings(turnSeq, mergedWarnings);
			}

			// ---- data 阶段：抽取落库（唯一写者，§6.1）。narrativeText = 最终文本；
			//      timeSuggestion = 场景卡时间建议（§6.3 → §5.3）；strictDrop = 超限放行轮 ----
			const data = await runDataStage({
				storyDb: storyState.storyDb,
				input: {
					turnSeq,
					userInput: input,
					narrativeText: finalText,
					createdEntryId: leafId,
					pendingTurns: computePendingTurns(storyState.storyDb),
					offscreenDeltas: npcReport?.offscreenDeltas,
					...(storyOpts.enabled && sceneCard
						? { timeSuggestion: { estimate: sceneCard.time_span_estimate, toTime: sceneCard.to_time_suggestion } }
						: {}),
				},
				cwd,
				model: dataModel,
				modelRuntime,
				prompts,
				eventLog,
				maxAttempts: maxDataAttempts,
				executor: opts.dataExecutor,
				strictDrop: releasedWithWarnings,
			});

			let snapshotTaken = false;
			if (data.ok) {
				storyState.storyDb.writer.recordDataStatus({ turnSeq, status: "ok", attempts: data.attempts });
				// 本轮落库成功 → 此前失败的待补轮一并视作已补齐（§6.1 下轮补齐语义）。
				storyState.storyDb.writer.markFailedTurnsCompensated();
				// sys 键簿记（§6.2 内核簿记，编排器直写，同 clock 例外精神）：data 成功才对每个
				// offscreenTriggered NPC 更新离线推演 last-turn 键（快照前写入，随快照持久化）；
				// data 失败不更新 → 下轮自然重触发、delta 重算。
				for (const npcId of npcReport?.offscreenTriggeredIds ?? []) {
					storyState.storyDb.writer.upsertWorldState({
						key: offscreenLastTurnKey(npcId),
						value: String(turnSeq),
						turnSeq,
					});
				}
				await takeSnapshot(storyState.storyDb, { turnSeq, sessionEntryId: leafId });
				snapshotTaken = true;
			} else {
				// §6.1：data 失败不拍快照（拍摄前提 = 落库成功），叙事照常呈现。
				storyState.storyDb.writer.recordDataStatus({
					turnSeq,
					status: "failed",
					attempts: data.attempts,
					error: data.error,
				});
			}

			const consecutiveDataFailures = countConsecutiveFailures(storyState.storyDb);
			if (consecutiveDataFailures >= failureWarningThreshold) {
				onWarning?.(
					`data 落库已连续失败 ${consecutiveDataFailures} 轮（阈值 ${failureWarningThreshold}）——本轮及此前失败的叙事事实尚未入库，请留意；下轮将继续尝试补齐（§6.1）`,
				);
			}

			// ---- 全统筹（§6.3 步骤 8：data+快照之后，不阻塞落库；data 失败照跑，统筹不依赖落库成功）----
			let overseeNote: OverseeNote | null | undefined;
			if (storyOpts.enabled && sceneCard) {
				const shouldOversee =
					turnSeq % (storyOpts.overseeEveryTurns ?? 10) === 0 || sceneCard.major_event === true;
				if (shouldOversee) {
					overseeNote = await runOversee(
						{ turnSeq, recentNarratives: recentNarratives(storyState.storyDb, storyOpts.recentNarratives ?? 5), sceneCard },
						{ ...storyStageOptsBase, storyDb: storyState.storyDb },
					);
					pendingOverseeNote = overseeNote ? renderOverseeNote(overseeNote) : undefined;
				}
			}

			eventLog?.record({
				ts: new Date().toISOString(),
				turnSeq,
				role: "narrator",
				ok: true,
				durationMs: Date.now() - startedAt,
				outputChars: finalText.length,
			});

			return {
				turnSeq,
				userEntryId,
				leafId,
				narrativeText: finalText,
				data,
				snapshotTaken,
				consecutiveDataFailures,
				npc: npcReport,
				...(storyOpts.enabled && sceneCard
					? {
							story: {
								sceneCard,
								sceneFallback,
								hardConflicts,
								suspicions,
								reviewFindings,
								revisions,
								releasedWithWarnings,
							},
						}
					: {}),
				stylize: stylizeReport,
				oversee: overseeNote,
				collection: pendingCollectionReport,
			};
		} finally {
			// turn 结束后复位：预演/场景卡/打回只属当轮，不泄漏到后续 prompt（下轮重新填充）。
			// pendingOverseeNote 有跨轮语义（本轮统筹产物下一轮注入），不在 finally 复位。
			pendingRehearsals = undefined;
			pendingSceneCard = undefined;
			pendingRevision = undefined;
		}
	};

	// 公开 runTurn（§10.2）：只暴露 force（/! 留痕）；skipInputValidation 为内部选项，不进公开签名。
	const runTurn = async (input: string, opts?: { force?: boolean }): Promise<TurnResult> => runTurnInternal(input, opts);

	return {
		session,
		sessionManager,
		storyState,
		hooks,
		get mode() {
			return mode;
		},
		setMode(next: StoryMode): void {
			// 入口拒绝非法模式值（避免 MODE_PRESETS[next] 首次切换才 TypeError）
			if (!isStoryMode(next)) {
				throw new Error(`非法模式值: ${JSON.stringify(next)}（应为 creation|survival|adventure）`);
			}
			mode = applyModeSwitch(mode, next, subagentFlags, storyState.storyDir);
		},
		runTurn,
		// /swipe（§3.0 重骰）：基于分支重生成最后一个 user 轮次的响应，旧稿留树。
		// 找到当前分支最后一个 user message（getBranch）；取其输入文本；navigateTree(u_N) 前查
		// rewriteHasSnapshot 同款守卫（§3.1：有快照走导航恢复、无快照跳过导航直接重写——首轮/无快照不误清库）；
		// 然后以同一输入重放完整 pipeline（runTurn，skipInputValidation=true：重放的是历史已接受输入，不再过输入校验）。
		async swipe(): Promise<TurnResult> {
			if (session.isStreaming) {
				throw new Error("isStreaming 期间不能 swipe（应等待上一轮完成）");
			}
			const branch = sessionManager.getBranch();
			const userEntries = branch.filter(
				(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
			);
			const lastUser = userEntries[userEntries.length - 1];
			if (!lastUser) {
				throw new Error("没有可重新生成的轮次（当前分支无 user 消息）");
			}
			const input = messageTextOfEntry(lastUser);
			if (input.trim() === "") {
				throw new Error("最后一个 user 轮次输入为空，无法重新生成");
			}
			// 快照守卫（§3.1）：target 是 user 消息 u_N → newLeaf = parentId（N-1 轮末），快照钩子恢复 DB 到 N-1 末；
			// 无快照（如首轮 u1）跳过导航直接重写（旧稿留在上下文，语义偏差可接受，绝不误清库）。
			const rewriteHasSnapshot =
				storyState.snapshotsDb.findNearestSnapshot(buildAncestorChain(sessionManager.getEntries(), lastUser.id)) !== undefined;
			if (rewriteHasSnapshot) {
				await session.navigateTree(lastUser.id);
			}
			// swipe 走内部路径（skipInputValidation: 重放的是历史已接受输入，不再过输入校验）。
			return runTurnInternal(input, { skipInputValidation: true });
		},
		dispose: () => {
			session.dispose();
		},
	};
}
