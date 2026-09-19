// 章节摘要 compaction + /swipe（重骰）单测。
// 覆盖：extractSwallowedMessages / buildChapterSummaryUserPrompt / runChapterSummary（成功 + 失败回退 undefined）；
// compact 钩子接线（session.compact() + 桩 executor：捕获输入含被吞并区段 + DB 摘要；返回 CompactionResult 形状正确；
// 失败回退 undefined + warning）；swipe 边界（无 user 消息抛错））。
// 说明：session.compact() 触发用 SettingsManager.inMemory 注入极小 keepRecentTokens（spike/07 同款），离线无需真实 LLM
//（钩子返回自有摘要完全跳过默认摘要调用）。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openSnapshotsDb, openStoryDb, snapshotsDbPath, storyDbPath, writeStoryMeta } from "../src/index.ts";
import {
	buildChapterSummaryUserPrompt,
	extractSwallowedMessages,
	runChapterSummary,
	type ChapterSummaryInput,
} from "../src/pipeline/chapter-summary.ts";
import { createStoryRuntime, type StoryRuntime, type StoryState } from "../src/pipeline/runtime.ts";
import type { SubagentResult, SubagentRunOptions, SubagentUsage } from "../src/subagent/runtime.ts";
import { createPipelineEventLog, type PipelineEvent } from "../src/pipeline/events.ts";

const ZERO: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO, durationMs: 1 };
}

interface EntryLike {
	id: string;
	type?: string;
	message?: { role?: string; content?: unknown };
}

function userMsg(id: string, text: string): EntryLike {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantMsg(id: string, text: string): EntryLike {
	return { type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function compaction(id: string): EntryLike {
	return { type: "compaction", id, message: undefined };
}

// ---------------------------------------------------------------------------
// extractSwallowedMessages / buildChapterSummaryUserPrompt
// ---------------------------------------------------------------------------

test("extractSwallowedMessages：firstKeptEntryId 之前的 message 条目 user/assistant 文本；非 message 跳过", () => {
	const entries: EntryLike[] = [
		userMsg("u1", "主角走进王城"),
		assistantMsg("a1", "城门缓缓打开"),
		compaction("c1"), // 非 message → 跳过
		userMsg("u2", "主角看见紫晶王座"),
		assistantMsg("a2", "王座发出微光"),
	];
	// firstKeptEntryId = a2 → 吞并 u1/a1/c1/u2（a2 是首个保留条目）
	const swallowed = extractSwallowedMessages(entries, "a2");
	assert.deepEqual(
		swallowed,
		[
			{ role: "user", text: "主角走进王城" },
			{ role: "assistant", text: "城门缓缓打开" },
			{ role: "user", text: "主角看见紫晶王座" },
		],
	);
	// firstKeptEntryId 不存在 → 吞并全部 message
	const all = extractSwallowedMessages(entries, "nonexistent");
	assert.equal(all.length, 4);
	// firstKeptEntryId = u1 → 无吞并
	const none = extractSwallowedMessages(entries, "u1");
	assert.deepEqual(none, []);
});

test("buildChapterSummaryUserPrompt：含被吞并区段文本 + DB 摘要（当前故事时间）+ 指令", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertLocation({ name: "王城" });
		story.writer.insertNpc({ name: "卫兵" });
		const input: ChapterSummaryInput = {
			branchEntries: [userMsg("u1", "我走进王城，看见紫晶王座")],
			firstKeptEntryId: "kept-1",
		};
		const prompt = buildChapterSummaryUserPrompt(story, input);
		assert.ok(prompt.includes("我走进王城，看见紫晶王座"), "含被吞并区段文本");
		assert.ok(prompt.includes("当前故事时间"), "含 DB 摘要（当前故事时间）");
		assert.ok(prompt.includes("未解决的伏笔"), "含章节摘要结构指令（保留未解决伏笔）");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("buildChapterSummaryUserPrompt：迭代 compaction——含「前情章节摘要」小节且优先用 messagesToSummarize", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertLocation({ name: "王城" });
		// 有 previousSummary + messagesToSummarize：注入前情小节、优先用 SDK 吞并文本
		const prevSummary = "前情摘要：青铜钥匙与暗纹伏笔（尚未解决）。";
		const input: ChapterSummaryInput = {
			branchEntries: [userMsg("u1", "旧对话（不应出现，因 messagesToSummarize 优先）")],
			firstKeptEntryId: "kept-1",
			previousSummary: prevSummary,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "我来到王陵查证。" }] }],
		};
		const prompt = buildChapterSummaryUserPrompt(story, input);
		assert.ok(prompt.includes("## 前情章节摘要"), "含前情章节摘要小节");
		assert.ok(prompt.includes("前情摘要：青铜钥匙与暗纹伏笔"), "前情摘要内容出现");
		assert.ok(prompt.includes("我来到王陵查证。"), "优先用 messagesToSummarize 的吞并文本");
		assert.ok(!prompt.includes("旧对话"), "不再用 branchEntries 自行重导区间（messagesToSummarize 存在时）");
		// 无 previousSummary → 省略前情小节
		const noPrev = buildChapterSummaryUserPrompt(story, {
			branchEntries: [userMsg("u1", "x")],
			firstKeptEntryId: "kept-1",
		});
		assert.ok(!noPrev.includes("## 前情章节摘要"), "无 previousSummary 时省略前情小节");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// runChapterSummary
// ---------------------------------------------------------------------------

test("runChapterSummary：成功（stub 返回合法 summary）→ 返回 summary + eventLog ok", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertLocation({ name: "王城" });
		const events: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => events.push(e));
		const summary = await runChapterSummary(
			{ branchEntries: [userMsg("u1", "x")], firstKeptEntryId: "k" },
			{ storyDb: story, cwd: dir, eventLog: log, executor: async () => stubResult({ summary: "章节摘要正文" }) },
		);
		assert.equal(summary, "章节摘要正文");
		assert.ok(events.some((e) => e.role === "chapter_summary" && e.ok === true));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runChapterSummary：executor 恒抛/恒垃圾 → 返回 undefined（回退默认摘要）+ eventLog ok:false", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertLocation({ name: "王城" });
		const events: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => events.push(e));
		// 恒垃圾（缺 summary 字段）→ schema 拒 → 重试耗尽 → undefined
		const res = await runChapterSummary(
			{ branchEntries: [userMsg("u1", "x")], firstKeptEntryId: "k" },
			{ storyDb: story, cwd: dir, eventLog: log, executor: async () => stubResult({ bad: true }) },
		);
		assert.equal(res, undefined, "重试耗尽返回 undefined");
		const csRecords = events.filter((e) => e.role === "chapter_summary");
		// 缺口 6：一个 stage = start + end；生成不出来由 end.ok=false 显形。
		assert.equal(csRecords.length, 2);
		assert.equal(csRecords[0]!.phase, "start");
		assert.equal(csRecords[1]!.phase, "end");
		assert.equal(csRecords[1]!.ok, false);
		// 恒抛异常 → undefined
		const res2 = await runChapterSummary(
			{ branchEntries: [userMsg("u1", "x")], firstKeptEntryId: "k" },
			{ storyDb: story, cwd: dir, executor: async () => { throw new Error("boom"); } },
		);
		assert.equal(res2, undefined);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// compact 钩子接线（session.compact() 离线 + 桩 executor）
// ---------------------------------------------------------------------------

interface MessageLike {
	role: string;
	content: Array<{ type: string; text: string }>;
	api: string;
	provider: string;
	model: string;
	usage: Record<string, number>;
	stopReason: string;
	timestamp: number;
}

function msg(role: string, text: string): MessageLike {
	return {
		role,
		content: [{ type: "text", text }],
		api: "pi-messages",
		provider: "tavernpi",
		model: "narrator",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function newCompactRuntime(
	root: string,
	chapterSummaryExecutor: (o: SubagentRunOptions) => Promise<SubagentResult<unknown>>,
	warnings: string[],
): Promise<{ runtime: StoryRuntime; storyState: StoryState; sessionManager: SessionManager }> {
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const storyDir = join(root, sessionId);
	const dbPath = storyDbPath(root, sessionId);
	const storyState: StoryState = {
		storyDir,
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};
	writeStoryMeta(storyDir, { packs: [], mode: "creation", createdAt: new Date().toISOString() });
	const w = storyState.storyDb.writer;
	w.insertLocation({ name: "王城" });
	w.insertNpc({ name: "卫兵" });
	const runtime = await createStoryRuntime({
		cwd: root,
		sessionManager,
		storyState,
		// 极小 keepRecentTokens 触发 cut point（spike/07 同款）；defaultProvider/model 供 findInitialModel 解析出 session.model。
		settingsManager: SettingsManager.inMemory({
			defaultProvider: "deepseek",
			defaultModel: "deepseek-v4-flash",
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		}),
		chapterSummary: { executor: chapterSummaryExecutor },
		dataExecutor: async () =>
			stubResult({
				events: [],
				time_advance: { to_time: "0000-01-01", span_note: "" },
				new_locations: [],
				location_moves: [],
				new_npcs: [],
				npc_updates: [],
				world_state: [],
			}),
		onWarning: (m) => warnings.push(m),
	});
	return { runtime, storyState, sessionManager };
}

test("compact 钩子接线：session.compact() 用桩 executor 生成章节摘要（捕获含吞并区段+DB 摘要；形状正确）", async () => {
	const root = makeTempDir();
	try {
		const warnings: string[] = [];
		const captured: string[] = [];
		const stubChapter = async (o: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
			captured.push(o.userPrompt);
			return stubResult({ summary: "章节摘要：主角走进王城，看见紫晶王座。" });
		};
		const { runtime, storyState, sessionManager } = await newCompactRuntime(root, stubChapter, warnings);
		try {
			// 注入一条吞并区段（user 消息带独特标记）。keepRecentTokens=1 → 首条 user 被吞并。
			sessionManager.appendMessage(msg("user", "我是主角，走进王城见到紫晶王座。") as never);
			sessionManager.appendMessage(msg("assistant", "城门缓缓打开，紫晶王座的光照着你。") as never);

			const res = await runtime.session.compact();
			// 钩子捕获的输入：含被吞并区段文本 + DB 摘要
			assert.ok(captured.length >= 1, "钩子触发且有 userPrompt");
			assert.ok(captured[0]!.includes("紫晶王座"), "含被吞并区段文本");
			assert.ok(captured[0]!.includes("当前故事时间"), "含 DB 摘要（当前故事时间）");
			// CompactionResult 形状正确
			assert.equal(res.summary, "章节摘要：主角走进王城，看见紫晶王座。");
			assert.equal(typeof res.firstKeptEntryId, "string");
			assert.equal(typeof res.tokensBefore, "number");
			// compaction 条目落进 branch
			const branch = sessionManager.getBranch();
			const lastEntry = branch[branch.length - 1];
			assert.equal(lastEntry?.type, "compaction");
			assert.ok((lastEntry as { summary?: string }).summary?.includes("紫晶王座"), "compaction 条目 summary 为自定义摘要");
			assert.equal((lastEntry as { fromHook?: boolean }).fromHook, true, "compaction 条目 fromHook=true（扩展生成）");
			assert.equal(warnings.length, 0, "成功路径无 warning");
		} finally {
			runtime.dispose();
			storyState.storyDb.close();
			storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("compact 钩子失败回退：桩 executor 返回 none → 钩子返回 undefined（回退默认摘要）+ warning", async () => {
	const root = makeTempDir();
	try {
		const warnings: string[] = [];
		// 桩恒垃圾 → runChapterSummary 重试耗尽返回 undefined → 钩子返回 undefined → compact() 走默认摘要（真实 LLM）。
		const { runtime, storyState, sessionManager } = await newCompactRuntime(
			root,
			async () => stubResult({ bad: true }),
			warnings,
		);
		try {
			sessionManager.appendMessage(msg("user", "我是主角。") as never);
			sessionManager.appendMessage(msg("assistant", "好的。") as never);
			try {
				await runtime.session.compact();
				// 回退默认摘要成功（本环境网络可达）——不 assert 返回自定义摘要（钩子已返回 undefined）。
			} catch {
				// 回退默认摘要失败（离线/无网络）——compact 抛错，钩子 warning 已记录（下面统一断言）。
			}
			// 钩子在 summary===undefined 时记录 warning；无论默认摘要成功与否都成立。
			assert.ok(warnings.some((w) => w.includes("章节摘要生成失败")), "钩子 onWarning 记录失败");
		} finally {
			runtime.dispose();
			storyState.storyDb.close();
			storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

// ---------------------------------------------------------------------------
// swipe 边界
// ---------------------------------------------------------------------------

test("swipe：无 user 消息 → 抛中文错「没有可重新生成的轮次」", async () => {
	const root = makeTempDir();
	try {
		const warnings: string[] = [];
		const { runtime, storyState } = await newCompactRuntime(root, async () => stubResult({ summary: "x" }), warnings);
		try {
			await assert.rejects(runtime.swipe(), /没有可重新生成的轮次/);
		} finally {
			runtime.dispose();
			storyState.storyDb.close();
			storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});
