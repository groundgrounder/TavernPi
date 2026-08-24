// 受信任写入（§6.1 写者例外）+ 轮中交互 broker accessor（§6.7）+ runtime 提示词分层管理（§10.2）单测。
// 离线（stub session，无真实 LLM）：valid 写入落库+快照；invalid 拒绝零落库；broker 注册/清除；prompts 覆盖链绑定。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openSnapshotsDb, openStoryDb, snapshotsDbPath, storyDbPath, writeStoryMeta } from "../src/index.ts";
import { createStoryRuntime, getInteractionBroker, type StoryRuntime, type StoryState } from "../src/pipeline/runtime.ts";
import { loadPrompt } from "../src/prompts/loader.ts";
import type { SubagentResult, SubagentRunOptions, SubagentUsage } from "../src/subagent/runtime.ts";

const ZERO: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO, durationMs: 1 };
}

async function newRuntime(root: string): Promise<{ runtime: StoryRuntime; storyState: StoryState; sm: SessionManager }> {
	const sm = SessionManager.create(root, join(root, "sessions"));
	const sessionId = sm.getSessionId();
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
	const runtime = await createStoryRuntime({
		cwd: root,
		sessionManager: sm,
		storyState,
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
		npc: { enabled: false },
		story: { enabled: false },
		stylize: { enabled: false },
	});
	// 造一个 leaf（opening assistant 消息）——受信任写入的 takeSnapshot 需绑定 leaf。
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "开场白。" }],
		api: "pi-messages",
		provider: "tavernpi",
		model: "narrator",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	return { runtime, storyState, sm };
}

test("trustedWrite：合法变更集落库 + 快照立拍（bind 当前 leaf）+ turnSeq 取当前轮", async () => {
	const root = makeTempDir();
	try {
		const { runtime, storyState } = await newRuntime(root);
		try {
			const clocksBefore = storyState.storyDb.reader.getClock()?.current_time;
			const res = await runtime.trustedWrite({
				events: [{ summary: "受信任事件" }],
				time_advance: { to_time: "0000-01-02", span_note: "受信任推进" },
				new_locations: [],
				location_moves: [],
				new_npcs: [],
				npc_updates: [],
				world_state: [],
			});
			assert.equal(res.summary.events, 1);
			assert.equal(res.turnSeq, 0, "无 turn_log 时取 0");
			assert.equal(res.snapshotTaken, true, "有 leaf → 拍快照");
			// 落库校验
			assert.ok(storyState.storyDb.reader.listEvents().some((e) => e.summary === "受信任事件"));
			assert.equal(storyState.storyDb.reader.getClock()?.current_time, "0000-01-02");
			assert.ok(clocksBefore === "0000-01-01");
			// 快照绑定当前 leaf（同轮末语义）
			const snaps = storyState.snapshotsDb.listSnapshots();
			assert.equal(snaps.length, 1);
		} finally {
			runtime.dispose();
			storyState.storyDb.close();
			storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("trustedWrite：非法变更集（未登记地点）→ 抛中文错列全部问题、零落库", async () => {
	const root = makeTempDir();
	try {
		const { runtime, storyState } = await newRuntime(root);
		try {
			const eventsBefore = storyState.storyDb.reader.listEvents().length;
			await assert.rejects(
				runtime.trustedWrite({
					events: [{ summary: "x", location_name: "不存在之地" }],
					time_advance: undefined,
					new_locations: [],
					location_moves: [],
					new_npcs: [],
					npc_updates: [],
					world_state: [],
				}),
				(err: unknown) => {
					const m = err instanceof Error ? err.message : String(err);
					assert.ok(m.includes("未登记"), `提及未登记地点: ${m}`);
					assert.ok(m.includes("events[0]"), "逐条列出问题 item");
					return true;
				},
			);
			assert.equal(storyState.storyDb.reader.listEvents().length, eventsBefore, "零落库");
		} finally {
			runtime.dispose();
			storyState.storyDb.close();
			storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("interaction broker accessor：runtime 创建时注册、dispose 时清除；runtime.interaction === getInteractionBroker()", async () => {
	const root = makeTempDir();
	try {
		const { runtime } = await newRuntime(root);
		try {
			assert.equal(getInteractionBroker(), runtime.interaction, "注册当前 runtime broker");
			// broker.request 无 handler → InteractionUnavailableError（降级契约）
			const { InteractionUnavailableError } = await import("../src/interaction/broker.ts");
			await assert.rejects(
				runtime.interaction.request({ kind: "choice", prompt: "p", responseSchema: { type: "string" } } as never),
				InteractionUnavailableError,
			);
		} finally {
			runtime.dispose();
		}
		// dispose 后清除
		assert.equal(getInteractionBroker(), undefined);
	} finally {
		cleanupTempDir(root);
	}
});

test("runtime.prompts：resolveChain / setStoryOverride / clearStoryOverride 绑定当前 storyDir", async () => {
	const root = makeTempDir();
	try {
		const { runtime } = await newRuntime(root);
		try {
			assert.equal(runtime.prompts.resolveChain("narrator").effectiveLayer, "builtin");
			runtime.prompts.setStoryOverride("narrator", "故事层覆盖");
			const loaded = loadPrompt("narrator", { storyDir: runtime.storyState.storyDir });
			assert.equal(loaded.layer, "story");
			assert.equal(loaded.content, "故事层覆盖");
			assert.equal(runtime.prompts.resolveChain("narrator").effectiveLayer, "story");
			runtime.prompts.clearStoryOverride("narrator");
			assert.equal(runtime.prompts.resolveChain("narrator").effectiveLayer, "builtin");
		} finally {
			runtime.dispose();
			runtime.storyState.storyDb.close();
			runtime.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});
