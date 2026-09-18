// 章节摘要 compaction。把被吞并的对话区段 + DB 权威摘要交给 chapter_summary subagent
// 生成章节摘要，完全替换 pi 默认摘要（经 session_before_compact 钩子 return {compaction}）。
// 摘要须保留未解决伏笔 / 在场 NPC 状态与关系变化 / 当前阶段目标——这些 DB 摘要（renderDbSummary）是权威面。
//
// 失败路径：重试耗尽 / 异常 → 返回 undefined（runtime 回退 pi 默认摘要）+ onWarning + eventLog，绝不阻塞 compaction。
// 输出 schema：单输出工具 submit_chapter_summary {summary}，summary 上限 6000 字符（M3 预算 .max() 风格）。

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { TSchema } from "typebox";
import type { StoryDb } from "../db/story-db.ts";
import { loadPrompt, type PromptLayerDirs } from "../prompts/loader.ts";
import {
	runSubagent,
	type SubagentOutputTool,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
} from "../subagent/runtime.ts";
import type { PipelineEventLog } from "./events.ts";
import { renderDbSummary } from "./db-summary.ts";

// ---------------------------------------------------------------------------
// 输出 schema（预算上限仿 M3 .max() 风格）
// ---------------------------------------------------------------------------

const chapterSummarySchema = z.object({
	// 章节摘要正文（唯一输出）；约束最小 token，不虚构、不复述全文。
	summary: z.string().max(6000),
});

export const chapterSummaryZodSchema = chapterSummarySchema;
export type ChapterSummaryOutput = z.infer<typeof chapterSummarySchema>;
export const CHAPTER_SUMMARY_JSON_SCHEMA = chapterSummarySchema.toJSONSchema() as unknown as TSchema;
export const CHAPTER_SUMMARY_OUTPUT_TOOL_NAME = "submit_chapter_summary";

const CHAPTER_SUMMARY_TOOL: SubagentOutputTool = {
	name: CHAPTER_SUMMARY_OUTPUT_TOOL_NAME,
	description: "提交本章节摘要（唯一输出通道），替换被吞并的对话区段。",
	schema: CHAPTER_SUMMARY_JSON_SCHEMA,
};

const CHAPTER_SUMMARY_INSTRUCTIONS = [
	"把被吞并的对话区段压缩成一段章节摘要，替换这些对话；摘要作为后续叙事的长期记忆。",
	"必须保留：未解决的伏笔/线索、在场 NPC 的状态与关系变化、当前阶段（幕）的目标。",
	"若提供了「前情章节摘要」（上次 compaction 产物），新摘要必须先吸收其要点（未解决伏笔/在场 NPC/阶段目标），不得丢失前情——这是迭代 compaction 的核心。",
	"结构建议：故事时间与地点线 → 事件脉络 → 未解决伏笔 → 在场 NPC 状态与关系变化 → 当前阶段目标。",
	"以当前世界状态摘要（DB 权威事实）为准，不虚构新事实、不扩充细节、不要复述对话全文。",
	"只输出章节摘要正文（submit_chapter_summary.summary），不解释、不过程描述。",
].join("\n");

export const CHAPTER_SUMMARY_INSTRUCTIONS_TEXT = CHAPTER_SUMMARY_INSTRUCTIONS;

// ---------------------------------------------------------------------------
// 被吞并区段提取
// ---------------------------------------------------------------------------

const SWALLOWED_INPUT_BUDGET = 16000; // 被吞并对话文本的预算（字符），超出取最新（贴近 kept 区段）部分。

/** 从 branchEntries 提取 firstKeptEntryId 之前的 message 条目（user/assistant）文本。 */
export function extractSwallowedMessages(
	branchEntries: ReadonlyArray<{ id: string; type?: string; message?: { role?: string; content?: unknown } }>,
	firstKeptEntryId: string,
): Array<{ role: string; text: string }> {
	const keptIndex = branchEntries.findIndex((e) => e.id === firstKeptEntryId);
	const end = keptIndex === -1 ? branchEntries.length : keptIndex;
	const out: Array<{ role: string; text: string }> = [];
	for (let i = 0; i < end; i++) {
		const entry = branchEntries[i];
		if (!entry) continue;
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(entry.message);
		if (text.trim() !== "") out.push({ role, text });
	}
	return out;
}

/** 单条 message 条目文本（content 数组或纯字符串）。 */
function messageText(message: { role?: string; content?: unknown } | undefined): string {
	if (!message) return "";
	if (Array.isArray(message.content)) {
		return (message.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

/** 从 SDK messagesToSummarize（AgentMessage[]）结构化提取 user/assistant 文本（精确对齐吞并语义）。 */
function swallowedFromMessages(messages: ReadonlyArray<{ role?: string; content?: unknown }>): Array<{ role: string; text: string }> {
	const out: Array<{ role: string; text: string }> = [];
	for (const m of messages) {
		const role = m.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(m);
		if (text.trim() !== "") out.push({ role, text });
	}
	return out;
}

/** 渲染被吞并区段（预算裁剪：超预算保留末尾——最贴近保持区段的部分）。 */
function renderSwallowed(swallowed: Array<{ role: string; text: string }>): string {
	if (swallowed.length === 0) return "(无被吞并消息)";
	const lines = swallowed.map((m) => `[${m.role}] ${m.text}`);
	let text = lines.join("\n\n");
	if (text.length > SWALLOWED_INPUT_BUDGET) {
		const tail = SWALLOWED_INPUT_BUDGET;
		text = `……（前文过长，已截断）\n\n${text.slice(-tail)}`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// 用户提示词
// ---------------------------------------------------------------------------

export interface ChapterSummaryInput {
	branchEntries: ReadonlyArray<{ id: string; type?: string; message?: { role?: string; content?: unknown } }>;
	firstKeptEntryId: string;
	/** SDK prepareCompaction 的 previousSummary（上次 compaction 摘要，迭代更新用）；无则省略「前情章节摘要」节。 */
	previousSummary?: string;
	/** SDK prepareCompaction 的 messagesToSummarize（精确吞并语义）；提供时优先用它，否则回退 extractSwallowedMessages。 */
	messagesToSummarize?: ReadonlyArray<{ role?: string; content?: unknown }>;
	/** SDK prepareCompaction 的 turnPrefixMessages（切分轮次的前缀，同样被吞并）；与 messagesToSummarize 一并纳入。 */
	turnPrefixMessages?: ReadonlyArray<{ role?: string; content?: unknown }>;
}

export function buildChapterSummaryUserPrompt(storyDb: StoryDb, input: ChapterSummaryInput): string {
	// 优先用 SDK messagesToSummarize + turnPrefixMessages（精确对齐 pi 吞并语义：二者共同构成被吞并内容，
	// 前者为整轮、后者为切分轮的前缀）；缺席则回退自行从 branchEntries 重导区间（向后兼容直调方）。
	const swallowed =
		input.messagesToSummarize !== undefined
			? [
					...swallowedFromMessages(input.messagesToSummarize),
					...swallowedFromMessages(input.turnPrefixMessages ?? []),
				]
			: extractSwallowedMessages(input.branchEntries, input.firstKeptEntryId);
	const parts: string[] = [];
	parts.push(`## 被吞并对话区段（将被压缩为章节摘要）\n${renderSwallowed(swallowed)}`);
	// 前情章节摘要（迭代 compaction 不丢前情）：有 previousSummary 才注入，指令要求吸收其要点。
	if (input.previousSummary !== undefined && input.previousSummary.trim() !== "") {
		parts.push(`## 前情章节摘要（上次 compaction 产物，新摘要必须吸收其要点，不得丢失）\n${input.previousSummary}`);
	}
	parts.push(`## 当前世界状态摘要（DB 权威事实，伏笔/NPC/阶段以此为准）\n${renderDbSummary(storyDb)}`);
	parts.push(`## 指令\n${CHAPTER_SUMMARY_INSTRUCTIONS}`);
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// 运行器
// ---------------------------------------------------------------------------

export interface ChapterSummaryOptions {
	storyDb: StoryDb;
	cwd: string;
	model?: SubagentRunOptions["model"];
	modelRuntime?: ModelRuntime;
	prompts?: PromptLayerDirs;
	eventLog?: PipelineEventLog;
	/** 告警出口（缺省 console.warn；编排层传入以收口到 CLI 活动行）。 */
	onWarning?: (message: string) => void;
	/** 重试上限（默认 2）。 */
	maxAttempts?: number;
	/** 缺省 runSubagent；测试/验收故障注入通道。 */
	executor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
}

const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

/** 章节摘要事件流留痕用的 turn_seq（compaction 在轮间发生，取当前最后已落库轮；无轮为 0）。 */
function lastTurnSeq(storyDb: StoryDb): number {
	return storyDb.reader.getTurnLog().at(-1)?.turn_seq ?? 0;
}

/**
 * 生成章节摘要。重试耗尽 / 异常 → 返回 undefined（不阻塞 compaction）+ eventLog ok:false。
 * 成功返回 summary 字符串。
 */
export async function runChapterSummary(
	input: ChapterSummaryInput,
	opts: ChapterSummaryOptions,
): Promise<string | undefined> {
	const maxAttempts = opts.maxAttempts ?? 2;
	const executor = opts.executor ?? runSubagent;
	const systemPrompt = loadPrompt("chapter_summary", opts.prompts).content;
	let userPrompt = buildChapterSummaryUserPrompt(opts.storyDb, input);

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await executor({
				role: "chapter_summary",
				cwd: opts.cwd,
				systemPrompt,
				userPrompt,
				outputTool: CHAPTER_SUMMARY_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
				onWarning: opts.onWarning,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;
			const parsed = chapterSummaryZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else if (parsed.data.summary.trim() === "") {
				error = `第 ${attempt} 次提交摘要为空`;
			} else {
				opts.eventLog?.record({
					ts: new Date().toISOString(),
					turnSeq: lastTurnSeq(opts.storyDb),
					role: "chapter_summary",
					ok: true,
					attempt,
					durationMs: Date.now() - attemptStartedAt,
					usage,
					inputChars: userPrompt.length,
					outputChars,
				});
				return parsed.data.summary;
			}
		} catch (err) {
			error = `第 ${attempt} 次执行失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		opts.eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: lastTurnSeq(opts.storyDb),
			role: "chapter_summary",
			ok: false,
			attempt,
			durationMs: Date.now() - attemptStartedAt,
			usage,
			inputChars: userPrompt.length,
			outputChars,
			error,
		});
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	return undefined;
}
