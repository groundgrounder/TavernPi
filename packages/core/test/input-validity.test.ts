// 输入渠道校验（「输入渠道校验判定」）单测。
// 覆盖：computeInputValidityAction 纯判定（reject/force/creation-ignore/缺席），
// runTurn 拒绝轮零痕迹（stub scene 卡 invalid → InputRejectedError、DB/session 零痕迹，拒绝发生在主叙事前）。
// 说明：force 放行叙事与 creation-ignore 全流程属 acceptance 脚本（真实 LLM 叙事）非本单元（需模型出正文）。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openSnapshotsDb, openStoryDb, snapshotsDbPath, storyDbPath, writeStoryMeta } from "../src/index.ts";
import {
	computeInputValidityAction,
	computeNextTurnSeq,
	createStoryRuntime,
	InputRejectedError,
	type StoryState,
} from "../src/pipeline/runtime.ts";
import type { SceneCard } from "../src/pipeline/story-stage.ts";
import type { SubagentResult, SubagentRunOptions, SubagentUsage } from "../src/subagent/runtime.ts";

const ZERO: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO, durationMs: 1 };
}

/** 合法场景卡（仅 input_validity 可控）；npc 在场/offline 依 computeScenePlan 由 runtime 兜底。 */
function sceneCard(validity: SceneCard["input_validity"]): SceneCard {
	return {
		onstage_npc_ids: [],
		offscreen_npc_ids: [],
		scene_location_name: "王城",
		current_story_time: "0000-01-01",
		time_span_estimate: "",
		to_time_suggestion: "0000-01-01",
		scene_goal: "",
		tone: "",
		major_event: false,
		...(validity !== undefined ? { input_validity: validity } : {}),
	};
}

// ---------------------------------------------------------------------------
// computeInputValidityAction（纯判定）
// ---------------------------------------------------------------------------

test("computeInputValidityAction：creation（inputValidation=false）忽略无效字段", () => {
	const invalid = { valid: false, reason: "命令 NPC", suggestion: "改写法" };
	assert.deepEqual(computeInputValidityAction("creation", sceneCard(invalid), false), {
		reject: false,
		reason: "",
		suggestion: "",
	});
});

test("computeInputValidityAction：survival + invalid + 非 force → 拒绝（reason/suggestion）", () => {
	const invalid = { valid: false, reason: "直接命令 NPC", suggestion: "改成第一人称" };
	assert.deepEqual(computeInputValidityAction("survival", sceneCard(invalid), false), {
		reject: true,
		reason: "直接命令 NPC",
		suggestion: "改成第一人称",
	});
});

test("computeInputValidityAction：survival + invalid + force=true → 放行（保留 reason 供留痕）", () => {
	const invalid = { valid: false, reason: "直接命令 NPC", suggestion: "改写" };
	assert.deepEqual(computeInputValidityAction("survival", sceneCard(invalid), true), {
		reject: false,
		reason: "直接命令 NPC",
		suggestion: "改写",
	});
});

test("computeInputValidityAction：survival + valid / 缺席 / 场景卡缺席 → 放行", () => {
	assert.deepEqual(computeInputValidityAction("survival", sceneCard({ valid: true }), false), {
		reject: false,
		reason: "",
		suggestion: "",
	});
	// input_validity 缺席（validateInput=false 或模型未产出）→ 放行
	assert.deepEqual(computeInputValidityAction("survival", sceneCard(undefined), false), {
		reject: false,
		reason: "",
		suggestion: "",
	});
	// 故事关闭（无场景卡）→ 无校验
	assert.deepEqual(computeInputValidityAction("survival", undefined, false), {
		reject: false,
		reason: "",
		suggestion: "",
	});
});

// ---------------------------------------------------------------------------
// runTurn 拒绝轮零痕迹（stub scene 卡 invalid；拒绝发生在主叙事前，无需模型）
// ---------------------------------------------------------------------------

/** 构造运行时：survival meta + story(stub 卡) + npc 开（survival 强制），data 桩。 */
async function newSurvivalRuntime(
	root: string,
	storyCard: SceneCard,
	opts: { mode?: "survival" | "creation" } = {},
): Promise<{ runtime: Awaited<ReturnType<typeof createStoryRuntime>>; storyState: StoryState; sessionManager: SessionManager }> {
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const storyDir = join(root, sessionId);
	const dbPath = storyDbPath(root, sessionId);
	const storyState: StoryState = {
		storyDir,
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};
	writeStoryMeta(storyDir, { packs: [], mode: opts.mode ?? "survival", createdAt: new Date().toISOString() });
	const w = storyState.storyDb.writer;
	const loc = w.insertLocation({ name: "王城" });
	w.moveSubject({ turnSeq: 0, subject: "player", toLocationId: loc.id, note: "seed" });
	const guard = w.insertNpc({ name: "卫兵" });
	w.moveSubject({ turnSeq: 0, subject: `npc:${guard.id}`, toLocationId: loc.id, note: "seed" });
	const storyExecutor = async (): Promise<SubagentResult<unknown>> => stubResult(storyCard);
	// npc 桩：schema 垃圾 → 在场/离线预演丢弃（非致命，避免真实模型调用；输入校验测试不依赖预演产物）。
	const npcExecutor = async (): Promise<SubagentResult<unknown>> => stubResult({});
	const runtime = await createStoryRuntime({
		cwd: root,
		sessionManager,
		storyState,
		npc: { enabled: true, executor: npcExecutor },
		story: { enabled: true, executor: storyExecutor },
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
	});
	return { runtime, storyState, sessionManager };
}

test("runTurn：survival + invalid 输入 → 抛 InputRejectedError 且 DB 零痕迹（turn_log 行数不变、无叙事落库）", async () => {
	const root = makeTempDir();
	try {
		const invalidCard = sceneCard({ valid: false, reason: "直接命令 NPC", suggestion: "改为我试着说服卫兵" });
		const { runtime, storyState, sessionManager } = await newSurvivalRuntime(root, invalidCard);
		try {
			const msgsBefore = sessionManager.getEntries().length;
			await assert.rejects(
				runtime.runTurn("我命令卫兵立刻打开城门放走囚犯"),
				(err: unknown) => {
					assert.ok(err instanceof InputRejectedError, "应为 InputRejectedError");
					assert.equal((err as InputRejectedError).reason, "直接命令 NPC");
					assert.equal((err as InputRejectedError).suggestion, "改为我试着说服卫兵");
					assert.ok((err as Error).message.includes("输入被拒绝"));
					return true;
				},
			);
			// 零痕迹：turn_log 无新增；session 树无新增（主叙事未 prompt，输入未入树）
			assert.equal(storyState.storyDb.reader.getTurnLog().length, 0, "未写 turn_log");
			assert.equal(sessionManager.getEntries().length, msgsBefore, "输入未进 session 树");
			// turn_seq 未消耗：下一轮从 1 起（无 turn_log → computeNextTurnSeq 返回 1）
			assert.equal(computeNextTurnSeq(storyState.storyDb), 1, "turn_seq 未消耗");
		} finally {
			runtime.dispose();
			storyState.storyDb.close();
			storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("runtime npc 预演不注入作者指令（剧本是作者视角；存量指令不撤销）", async () => {
	const root = makeTempDir();
	try {
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
		const loc = w.insertLocation({ name: "王城" });
		w.moveSubject({ turnSeq: 0, subject: "player", toLocationId: loc.id, note: "seed" });
		const guard = w.insertNpc({ name: "卫兵" });
		w.moveSubject({ turnSeq: 0, subject: `npc:${guard.id}`, toLocationId: loc.id, note: "seed" });
		w.insertDirective({ turnSeq: 0, content: "卫兵必须在黎明前交出兵符", status: "active" });
		// 场景卡：卫兵在场（npc 阶段才会预演）
		const card: SceneCard = { ...sceneCard({ valid: true }), onstage_npc_ids: [guard.id] };
		const captured: string[] = [];
		const npcExecutor = async (o: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
			captured.push(o.userPrompt);
			return stubResult({});
		};
		const runtime = await createStoryRuntime({
			cwd: root,
			sessionManager,
			storyState,
			npc: { enabled: true, executor: npcExecutor },
			story: { enabled: true, executor: async () => stubResult(card) },
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
		});
		let directivesLeft = 0;
		try {
			try {
				await runtime.runTurn("我向卫兵问好。");
			} catch (err) {
				// 叙事需模型可捕获（stub）；npc 阶段调用已在 captured 记录。
				void err;
			}
			directivesLeft = storyState.storyDb.reader.listDirectives("active").length;
		} finally {
			runtime.dispose();
			storyState.storyDb.close();
			storyState.snapshotsDb.close();
		}

		assert.ok(captured.length > 0, "有 npc 预演调用（场景卡驱动）");
		assert.ok(
			captured.every((p) => !p.includes("作者指令") && !p.includes("卫兵必须在黎明前交出兵符")),
			"npc 预演不注入作者指令（任何模式；角色不拿剧本）",
		);
		assert.equal(directivesLeft, 1, "存量指令未撤销");
	} finally {
		cleanupTempDir(root);
	}
});
