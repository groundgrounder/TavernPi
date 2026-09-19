// pipeline 事件流单测：JSONL 落盘、纯内存模式、listener 通知/退订/异常隔离、写失败容错。

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import {
	createPipelineEventLog,
	summarizePipeline,
	type PipelineEvent,
} from "../src/pipeline/events.ts";

const eventFixture: PipelineEvent = {
	ts: "2026-08-20T00:00:00.000Z",
	turnSeq: 1,
	role: "narrator",
	ok: true,
	durationMs: 123,
	attempt: 1,
	inputChars: 50,
	outputChars: 200,
	usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 38, costTotal: 0.5 },
};

test("record 写 JSONL：每行一个事件，字段往返一致（含可选字段）", () => {
	const dir = makeTempDir();
	try {
		const filePath = join(dir, "events", "pipeline.jsonl");
		const log = createPipelineEventLog(filePath);
		log.record(eventFixture);
		log.record({ ...eventFixture, turnSeq: 2, role: "data", ok: false, error: "boom" });

		const lines = readFileSync(filePath, "utf-8").trimEnd().split("\n");
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]!) as PipelineEvent;
		assert.deepEqual(first, eventFixture);
		const second = JSON.parse(lines[1]!) as PipelineEvent;
		assert.equal(second.turnSeq, 2);
		assert.equal(second.ok, false);
		assert.equal(second.error, "boom");
		assert.equal(second.attempt, 1, "可选字段透传");
		assert.equal(log.filePath, filePath);
	} finally {
		cleanupTempDir(dir);
	}
});

test("无 filePath：纯内存模式，record 不落盘也不抛错", () => {
	const log = createPipelineEventLog();
	assert.equal(log.filePath, undefined);
	const notified: PipelineEvent[] = [];
	log.on((e) => notified.push(e));
	assert.doesNotThrow(() => log.record(eventFixture));
	assert.equal(notified.length, 1);
});

test("listener 通知与退订：on 返回退订函数", () => {
	const log = createPipelineEventLog();
	const received: string[] = [];
	const off = log.on((e) => received.push(e.role));
	log.record(eventFixture);
	assert.deepEqual(received, ["narrator"]);
	off();
	log.record({ ...eventFixture, role: "data" });
	assert.deepEqual(received, ["narrator"], "退订后不再通知");
});

test("listener 抛错不影响 record：其他 listener 照常、落盘照常", () => {
	const dir = makeTempDir();
	try {
		const filePath = join(dir, "events.jsonl");
		const log = createPipelineEventLog(filePath);
		const good: string[] = [];
		log.on(() => {
			throw new Error("listener 炸了");
		});
		log.on((e) => good.push(e.role));
		assert.doesNotThrow(() => log.record(eventFixture));
		assert.deepEqual(good, ["narrator"], "抛错的 listener 不连累其他 listener");
		assert.ok(readFileSync(filePath, "utf-8").includes(eventFixture.role), "落盘不受 listener 异常影响");
	} finally {
		cleanupTempDir(dir);
	}
});

test("写失败路径：目标位置非法（父级是普通文件）→ 不抛，仅首次 console.warn", () => {
	const dir = makeTempDir();
	const originalWarn = console.warn;
	let warnCount = 0;
	console.warn = () => {
		warnCount++;
	};
	try {
		// 用普通文件占住父路径：mkdirSync(dirname) 必然失败
		writeFileSync(join(dir, "blocker"), "占用");
		const filePath = join(dir, "blocker", "events.jsonl");
		const log = createPipelineEventLog(filePath);
		assert.doesNotThrow(() => log.record(eventFixture));
		assert.doesNotThrow(() => log.record({ ...eventFixture, turnSeq: 2 }));
		assert.equal(warnCount, 1, "写失败仅首次告警（去重）");
	} finally {
		console.warn = originalWarn;
		cleanupTempDir(dir);
	}
});

test("写失败告警：传 onWarning 时不再裸写 stderr（轮中 stderr 写会撕裂 CLI 活动行）", () => {
	const dir = makeTempDir();
	const originalWarn = console.warn;
	let stderrWrites = 0;
	const warnings: string[] = [];
	console.warn = () => {
		stderrWrites++;
	};
	try {
		writeFileSync(join(dir, "blocker"), "占用");
		const filePath = join(dir, "blocker", "events.jsonl");
		const log = createPipelineEventLog(filePath, (m) => warnings.push(m));
		assert.doesNotThrow(() => log.record(eventFixture));
		assert.doesNotThrow(() => log.record({ ...eventFixture, turnSeq: 2 }));
		assert.equal(warnings.length, 1, "写失败仅首次告警（去重）");
		assert.match(warnings[0]!, /\[pipeline-events\] 写入事件日志失败/);
		assert.equal(stderrWrites, 0, "有 onWarning 时不得再写 console.warn");
	} finally {
		console.warn = originalWarn;
		cleanupTempDir(dir);
	}
});

// ==== 缺口 6：stage() 成对事件 ====

test("stage 成功：先 start 后 end，end 带 ok/durationMs，fn 返回值原样透传", async () => {
	const dir = makeTempDir();
	try {
		const filePath = join(dir, "events.jsonl");
		const log = createPipelineEventLog(filePath);
		const live: PipelineEvent[] = [];
		log.on((e) => live.push(e));

		const returned = await log.stage("narrator", 3, () => "正文");
		assert.equal(returned, "正文", "fn 的返回值原样返回，stage 不吞不改");

		assert.equal(live.length, 2, "恰好两条事件");
		assert.equal(live[0]!.phase, "start");
		assert.equal(live[0]!.turnSeq, 3);
		assert.equal(live[0]!.role, "narrator");
		assert.equal(live[0]!.ok, undefined, "start 不谎报成败——那时还不知道");
		assert.equal(live[0]!.durationMs, undefined, "start 没有耗时");

		assert.equal(live[1]!.phase, "end");
		assert.equal(live[1]!.ok, true);
		assert.equal(typeof live[1]!.durationMs, "number");
		assert.ok(live[1]!.durationMs! >= 0);

		assert.equal(readFileSync(filePath, "utf-8").trimEnd().split("\n").length, 2, "两条都落盘");
	} finally {
		cleanupTempDir(dir);
	}
});

test("stage 抛错：end 照样落（ok:false + error），异常原样透传不吞", async () => {
	const log = createPipelineEventLog();
	const live: PipelineEvent[] = [];
	log.on((e) => live.push(e));

	await assert.rejects(
		() =>
			log.stage("story", 1, () => {
				throw new Error("subagent 炸了");
			}),
		/subagent 炸了/,
		"异常必须原样抛出——stage 是观测设施，不是错误处理层",
	);

	assert.equal(live.length, 2, "抛错路径也必须成对：否则 start 永远挂着，界面一直显示「进行中」");
	assert.equal(live[1]!.phase, "end");
	assert.equal(live[1]!.ok, false);
	assert.equal(live[1]!.error, "subagent 炸了");
});

test("stage 异步 fn：await 后再落 end（耗时覆盖真实异步区间）", async () => {
	const log = createPipelineEventLog();
	const live: PipelineEvent[] = [];
	log.on((e) => live.push(e));

	await log.stage("data", 2, async () => {
		await new Promise((r) => setTimeout(r, 20));
		return 42;
	});

	assert.equal(live.length, 2);
	assert.equal(live[0]!.phase, "start");
	assert.equal(live[1]!.phase, "end");
	assert.ok(live[1]!.durationMs! >= 15, `end 的耗时应覆盖异步区间，实测 ${live[1]!.durationMs}ms`);
});

test("stage 非 Error 抛出物：error 字段是字符串化结果，不落成 [object Object]", async () => {
	const log = createPipelineEventLog();
	const live: PipelineEvent[] = [];
	log.on((e) => live.push(e));

	await assert.rejects(() => log.stage("npc", 4, () => Promise.reject("裸字符串拒绝")));

	assert.equal(live[1]!.ok, false);
	assert.equal(live[1]!.error, "裸字符串拒绝");
});

test("stage endFields 回调：在阶段跑完后才求值，能读到结果与耗时（故必须是函数不是对象）", async () => {
	const log = createPipelineEventLog();
	const live: PipelineEvent[] = [];
	log.on((e) => live.push(e));

	await log.stage(
		"narrator",
		1,
		() => "x".repeat(120),
		(result) => ({ outputChars: result!.length, attempt: 2 }),
	);

	assert.equal(live[1]!.outputChars, 120, "endFields 拿到了 fn 的返回值");
	assert.equal(live[1]!.attempt, 2);
	assert.equal(live[1]!.ok, true, "endFields 不能把 stage 自己的 ok 覆盖掉……除非它故意写 ok");
});

test("stage endFields 抛错：不炸掉阶段本身（观测设施不得成为故障源）", async () => {
	const log = createPipelineEventLog();
	const live: PipelineEvent[] = [];
	log.on((e) => live.push(e));

	const returned = await log.stage("data", 1, () => "ok", () => {
		throw new Error("endFields 炸了");
	});
	assert.equal(returned, "ok");
});

// ==== 缺口 6：summarizePipeline() ====

const ev = (over: Partial<PipelineEvent>): PipelineEvent => ({
	ts: "2026-09-19T00:00:00.000Z",
	turnSeq: 1,
	role: "narrator",
	...over,
});

test("summarize：start 无 end → running，时间从 start 起算", () => {
	const states = summarizePipeline([
		ev({ phase: "start", ts: new Date(Date.now() - 5000).toISOString() }),
	]);
	assert.equal(states.length, 1);
	assert.equal(states[0]!.status, "running");
	assert.equal(states[0]!.role, "narrator");
	assert.ok(states[0]!.elapsedMs >= 4000, `running 的 elapsed 应≈至今，实测 ${states[0]!.elapsedMs}ms`);
	assert.equal(states[0]!.ok, undefined, "还在跑就没有成败可言");
});

test("summarize：start + 同轮 end → done，用 end 自报的 durationMs", () => {
	const states = summarizePipeline([
		ev({ phase: "start" }),
		ev({ phase: "end", ok: true, durationMs: 1234 }),
	]);
	assert.equal(states.length, 1);
	assert.equal(states[0]!.status, "done");
	assert.equal(states[0]!.ok, true);
	assert.equal(states[0]!.elapsedMs, 1234, "优先采信结束事件自报的耗时");
});

test("summarize：跨轮次的 end 不闭合上一轮的遗留 start（否则谎报完成）", () => {
	const states = summarizePipeline([
		ev({ phase: "start", turnSeq: 1 }),
		ev({ phase: "end", turnSeq: 2, ok: true, durationMs: 10 }),
	]);
	assert.equal(states[0]!.status, "running", "第 1 轮的 start 不该被第 2 轮的 end 收掉");
	assert.equal(states[0]!.turnSeq, 1);
});

test("summarize：新 start 覆盖未闭合的旧 start（重试/进程被杀场景不卡在陈旧 start）", () => {
	const states = summarizePipeline([
		ev({ phase: "start", turnSeq: 1, ts: "2026-09-19T00:00:00.000Z" }),
		ev({ phase: "start", turnSeq: 1, ts: "2026-09-19T00:01:00.000Z" }),
	]);
	assert.equal(states.length, 1, "同 role 归并成一条");
	assert.equal(states[0]!.status, "running");
	assert.equal(states[0]!.startedAt, "2026-09-19T00:01:00.000Z", "显示最新那次，不卡在陈旧的 start");
});

test("summarize：end 无对应 start → 忽略（不凭空造出 done 条目）", () => {
	const states = summarizePipeline([ev({ phase: "end", ok: true, durationMs: 5 })]);
	assert.equal(states.length, 0, "没见过的 start 不该凭空冒出来——否则旧日志会显示一堆假阶段");
});

test("summarize：历史事件（无 phase）按 end 处理，旧日志不凭空冒出「运行中」", () => {
	const states = summarizePipeline([ev({ ok: true, durationMs: 7 })]);
	assert.equal(states.length, 0);
	// 但历史事件也不该「闭合掉」一个真的 start——它压根不是配对候选：只闭合同轮次。
	const mixed = summarizePipeline([
		ev({ phase: "start", turnSeq: 5 }),
		{ ts: "2026-09-19T00:00:01.000Z", turnSeq: 5, role: "narrator", ok: true, durationMs: 3 },
	]);
	assert.equal(mixed[0]!.status, "done", "无 phase 的旧事件按 end，正好闭合上面的 start");
	assert.equal(mixed[0]!.elapsedMs, 3);
});

test("summarize：多角色各自独立归并", () => {
	const states = summarizePipeline([
		ev({ role: "story", phase: "start" }),
		ev({ role: "npc", phase: "start" }),
		ev({ role: "story", phase: "end", ok: true, durationMs: 100 }),
	]);
	const byRole = new Map(states.map((s) => [s.role, s]));
	assert.equal(byRole.get("story")!.status, "done");
	assert.equal(byRole.get("npc")!.status, "running", "npc 还在跑，不该被 story 的 end 影响");
	assert.equal(states.length, 2);
});
