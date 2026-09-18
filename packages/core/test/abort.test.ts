// 中止桥单测（缺口 1：runTurn 的 AbortSignal）。
// 层 1（纯 JVM，无需模型）：runWithAbort 四条语义逐条钉住 + 监听器生命周期。
// 层 1.5（真实运行时，无模型）：runTurn 接已中止信号 → TurnAbortedError + DB/session 零痕迹。
// 「中止发生在模型在飞期间」的端到端叙事收敛属 m6 acceptance（需真实 LLM），不在本文件。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openSnapshotsDb, openStoryDb, snapshotsDbPath, storyDbPath } from "../src/index.ts";
import { runWithAbort, TurnAbortedError } from "../src/abort.ts";
import { computeNextTurnSeq, createStoryRuntime, type StoryState } from "../src/pipeline/runtime.ts";
import type { SubagentResult, SubagentUsage } from "../src/subagent/runtime.ts";

const ZERO: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO, durationMs: 1 };
}

// ---------------------------------------------------------------------------
// runWithAbort（纯语义，假操作桩）
// ---------------------------------------------------------------------------

test("runWithAbort：无 signal → 操作正常跑完，不抛", async () => {
	let ran = 0;
	await runWithAbort({ run: async () => void ran++, onAbort: () => assert.fail("无 signal 不该触发 onAbort") });
	assert.equal(ran, 1);
});

test("runWithAbort：入场即已中止 → 抛 TurnAbortedError 且**操作根本没启动**（onAbort 也不触发）", async () => {
	const controller = new AbortController();
	controller.abort();
	let ran = 0;
	await assert.rejects(
		runWithAbort({
			signal: controller.signal,
			run: async () => void ran++,
			onAbort: () => assert.fail("操作未启动，不该调 onAbort"),
		}),
		(err: unknown) => {
			assert.ok(err instanceof TurnAbortedError, "应为 TurnAbortedError");
			assert.equal((err as Error).name, "TurnAbortedError");
			assert.match((err as Error).message, /未落库/);
			return true;
		},
	);
	assert.equal(ran, 0, "已中止的入场不得启动操作");
});

test("runWithAbort：在飞期间中止 → 调 onAbort，且操作返回后抛 TurnAbortedError", async () => {
	const controller = new AbortController();
	let aborted = 0;
	let release: (() => void) | undefined;
	const inflight = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = runWithAbort({
		signal: controller.signal,
		run: () => inflight,
		onAbort: () => void aborted++,
	});
	// 操作在飞：此时中止
	controller.abort();
	assert.equal(aborted, 1, "在飞期间中止应触发侧向 onAbort");
	release?.();
	await assert.rejects(pending, TurnAbortedError);
});

test("runWithAbort：侧向 onAbort 的语义 = 中止信号已到但操作仍返回（如慢模型恰好在信号后收尾）", async () => {
	const controller = new AbortController();
	let aborted = 0;
	const pending = runWithAbort({
		signal: controller.signal,
		run: async () => {
			controller.abort();
		},
		onAbort: () => void aborted++,
	});
	await assert.rejects(pending, TurnAbortedError);
	assert.equal(aborted, 1);
});

test("runWithAbort：signal 未中止但 aborted() 自判为真（pi 的 stopReason=aborted）→ 同样抛中止错", async () => {
	await assert.rejects(
		runWithAbort({ run: async () => undefined, onAbort: () => undefined, aborted: () => true }),
		TurnAbortedError,
	);
});

test("runWithAbort：非中止故障原样上抛（不被吞成「用户按了停止」）", async () => {
	const boom = new Error("模型鉴权失败");
	await assert.rejects(runWithAbort({ run: async () => Promise.reject(boom), onAbort: () => undefined }), (err: unknown) => {
		assert.equal(err, boom, "原始错误对象必须原样透出");
		return true;
	});
});

test("runWithAbort：onAbort 同步抛错必须被吞掉——否则监听器里的异常会变成未捕获异常崩掉进程", async () => {
	const controller = new AbortController();
	let ran = 0;
	const pending = runWithAbort({
		signal: controller.signal,
		run: async () => {
			ran++;
			await new Promise((resolve) => setTimeout(resolve, 10));
		},
		onAbort: () => {
			throw new Error("onAbort 同步炸了");
		},
	});
	// 关键判据：abort() 本身不得把监听器的异常抛给调用点（Node 会 process.nextTick 重抛 → 进程 exit 1）
	assert.doesNotThrow(() => controller.abort(), "controller.abort() 不该把 onAbort 的异常抛出来");
	await assert.rejects(pending, TurnAbortedError, "中止语义照旧：操作作废");
	assert.equal(ran, 1);
});

test("runWithAbort：操作结束后解绑监听器——事后 abort 不再打到 onAbort（长寿 signal 不串轮）", async () => {
	const controller = new AbortController();
	let aborted = 0;
	await runWithAbort({ signal: controller.signal, run: async () => undefined, onAbort: () => void aborted++ });
	controller.abort(); // 本轮已结束，事后触发
	assert.equal(aborted, 0, "结束后必须已解绑（否则上一轮的中止信号会打到下一轮）");
});

test("runWithAbort：操作自身抛错也要解绑（finally 保证）", async () => {
	const controller = new AbortController();
	let aborted = 0;
	await assert.rejects(
		runWithAbort({
			signal: controller.signal,
			run: async () => Promise.reject(new Error("boom")),
			onAbort: () => void aborted++,
		}),
		/boom/,
	);
	controller.abort();
	assert.equal(aborted, 0, "抛错路径同样要解绑");
});

// ---------------------------------------------------------------------------
// runTurn + 已中止信号：真实运行时、零模型调用、零落库
// ---------------------------------------------------------------------------

test("runTurn：已中止的 signal → TurnAbortedError，且 turn_log/快照/session 树/turn_seq 全部零痕迹", async () => {
	const root = makeTempDir();
	try {
		const sessionManager = SessionManager.create(root, join(root, "sessions"));
		const sessionId = sessionManager.getSessionId();
		const dbPath = storyDbPath(root, sessionId);
		const storyState: StoryState = {
			storyDir: join(root, sessionId),
			storyDb: openStoryDb(dbPath),
			snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
		};
		// 三阶段全关（data 也只给桩）——本轮不该跑到任何阶段落库。
		const runtime = await createStoryRuntime({
			cwd: root,
			sessionManager,
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
		});
		try {
			const entriesBefore = sessionManager.getEntries().length;
			const controller = new AbortController();
			controller.abort();

			await assert.rejects(runtime.runTurn("我推门而入。", { signal: controller.signal }), TurnAbortedError);

			assert.equal(storyState.storyDb.reader.getTurnLog().length, 0, "未写 turn_log");
			assert.equal(storyState.snapshotsDb.listSnapshots().length, 0, "未拍快照");
			assert.equal(sessionManager.getEntries().length, entriesBefore, "输入未进 session 树");
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

// 「不传 signal 时行为不变」由上面第一条 runWithAbort 用例覆盖（无 signal → 不挂监听器、不抛中止错）。
// 刻意不再写「真跑一轮 runTurn」的用例：本机配了 auth.json，runTurn 会打真实模型（实测 9 秒 + 花钱），
// 单测必须离线——真实一轮属 m6 acceptance 的职责。

