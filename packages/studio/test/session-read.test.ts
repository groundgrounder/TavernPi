// studio 侧「阅读流 + DB 查询」两条 channel 的单测（S1 纵切）。
//
// 为什么在 studio 侧另测一遍内核已经测过的东西：studio 的 handler 有**自己的**边界形状检查
// （optionalCount / optionalScalarMap / optionalEnum）与**自己的**装配选择（哪份 filter、何时 refresh）。
// 这两处在内核测试里覆盖不到，而它们正是「载荷从 IPC 进来」时才会走到的路径。
//
// 判据全部落在真实盘上：故事由内核 createStory 真建，turn_log 行由 writer 真写，
// 断言读的是 studio session 的返回，而不是「我期望它调了哪个方法」。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStoryDb, TABLE_QUERY_MAX_LIMIT } from "@tavernpi/core";
import { StudioSession } from "../src/main/session.ts";
import { buildHostHandlers } from "../src/main/handlers.ts";

function makeTempDir(prefix = "tavernpi-studio-read-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** 收集推送的 sink（本测试不关心推送，但 StudioSession 需要它）。 */
function collectorSink(): { pushed: Array<[string, unknown]>; push: (c: string, p: unknown) => void } {
	const pushed: Array<[string, unknown]> = [];
	return { pushed, push: (channel, payload) => void pushed.push([channel, payload]) };
}

/**
 * 造一个「已打开」的故事：不用 openStory（那要 pi session 与模型配置），
 * 而是直接建库写行，再把 session 的内部打开态塞进去——本测试的对象是**读取路径**，
 * 不是装配路径（装配另有 S0 验收端到端覆盖）。
 *
 * 刻意经 `dbQuery` 之外的公开面注入：用一次真实的 openStory 代价太高且依赖 ~/.pi 认证，
 * 故这里只填 StudioSession 读取所需的最小字段。
 */
function injectOpened(session: StudioSession, dbPath: string): void {
	const db = openStoryDb(dbPath);
	// StudioSession.turns / dbQuery 只读 storyState.storyDb，故最小装配态即可。
	(session as unknown as { opened: unknown }).opened = { storyState: { storyDb: db, storyDir: join(dbPath, "..") } };
}

function seedTurns(dbPath: string, turns: Array<{ turnSeq: number; input: string; text: string }>): void {
	const db = openStoryDb(dbPath);
	try {
		for (const t of turns) {
			db.writer.recordTurnLog({
				turnSeq: t.turnSeq,
				sessionEntryId: `e${t.turnSeq}`,
				userInput: t.input,
				narrativeText: t.text,
			});
		}
	} finally {
		db.close();
	}
}

test("story:turns：未打开故事 → 空页而不抛错（空态不是错误）", async () => {
	const dir = makeTempDir();
	try {
		const session = new StudioSession(collectorSink(), { cwd: dir });
		const handlers = buildHostHandlers(session);
		const res = await handlers["story:turns"]({} as never);
		assert.deepEqual(res.turns, []);
		assert.equal(res.total, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("story:turns：默认倒序（最新在前），且分页切片落在真实行上", async () => {
	const dir = makeTempDir();
	try {
		const dbPath = join(dir, "story.db");
		seedTurns(dbPath, [
			{ turnSeq: 1, input: "推门", text: "第一轮正文" },
			{ turnSeq: 2, input: "环顾", text: "第二轮正文" },
			{ turnSeq: 3, input: "前行", text: "第三轮正文" },
		]);
		const session = new StudioSession(collectorSink(), { cwd: dir });
		injectOpened(session, dbPath);
		const handlers = buildHostHandlers(session);

		const page = await handlers["story:turns"]({ limit: 2 } as never);
		assert.equal(page.total, 3, "total 是全部轮次，不是本页行数");
		assert.deepEqual(
			page.turns.map((t) => t.turn_seq),
			[3, 2],
			"默认倒序：最新一轮在前",
		);

		const next = await handlers["story:turns"]({ limit: 2, offset: 2 } as never);
		assert.deepEqual(next.turns.map((t) => t.turn_seq), [1]);

		const asc = await handlers["story:turns"]({ order: "asc" } as never);
		assert.deepEqual(asc.turns.map((t) => t.turn_seq), [1, 2, 3]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("story:turns：正文取自 turn_log（事实源），不是流式草稿", async () => {
	const dir = makeTempDir();
	try {
		const dbPath = join(dir, "story.db");
		seedTurns(dbPath, [{ turnSeq: 1, input: "推门", text: "润色后的终稿" }]);
		const session = new StudioSession(collectorSink(), { cwd: dir });
		injectOpened(session, dbPath);
		const handlers = buildHostHandlers(session);

		const page = await handlers["story:turns"]({} as never);
		assert.equal(page.turns[0]?.narrative_text, "润色后的终稿");
		assert.equal(page.turns[0]?.user_input, "推门");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("story:turns：非法 order 被边界挡下（不静默当成 asc）", async () => {
	const dir = makeTempDir();
	try {
		const session = new StudioSession(collectorSink(), { cwd: dir });
		const handlers = buildHostHandlers(session);
		await assert.rejects(handlers["story:turns"]({ order: "descending" } as never), /order 应为 asc\|desc/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("db:query：未打开故事 → 空表清单（不抛错）", async () => {
	const dir = makeTempDir();
	try {
		const session = new StudioSession(collectorSink(), { cwd: dir });
		const handlers = buildHostHandlers(session);
		const res = await handlers["db:query"]({} as never);
		assert.deepEqual(res.tables, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("db:query：列内核表 + 翻页读真实行（作者视图 filter=none）", async () => {
	const dir = makeTempDir();
	try {
		const dbPath = join(dir, "story.db");
		seedTurns(dbPath, [
			{ turnSeq: 1, input: "推门", text: "第一轮" },
			{ turnSeq: 2, input: "环顾", text: "第二轮" },
		]);
		const session = new StudioSession(collectorSink(), { cwd: dir });
		injectOpened(session, dbPath);
		const handlers = buildHostHandlers(session);

		const tables = await handlers["db:query"]({} as never);
		const names = (tables.tables ?? []).map((t) => t.name);
		assert.ok(names.includes("turn_log"), `表清单应含 turn_log：${names.join(", ")}`);
		assert.ok(names.includes("events"));

		const page = await handlers["db:query"]({ table: "turn_log", orderBy: "turn_seq", descending: true, limit: 1 } as never);
		assert.equal(page.page?.total, 2);
		assert.equal(page.page?.rows.length, 1);
		assert.equal(page.page?.rows[0]?.["turn_seq"], 2, "倒序首行是 turn_seq=2");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("db:query：limit 请求超内核上限 → 夹到上限（不报错、不静默给超大页）", async () => {
	const dir = makeTempDir();
	try {
		const dbPath = join(dir, "story.db");
		seedTurns(dbPath, [{ turnSeq: 1, input: "推门", text: "第一轮" }]);
		const session = new StudioSession(collectorSink(), { cwd: dir });
		injectOpened(session, dbPath);
		const handlers = buildHostHandlers(session);

		const page = await handlers["db:query"]({ table: "turn_log", limit: 10_000 } as never);
		assert.equal(page.page?.limit, TABLE_QUERY_MAX_LIMIT);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("db:query：内核未知表 → 内核的中文错原样透传（不被包装成看不懂的错）", async () => {
	const dir = makeTempDir();
	try {
		const dbPath = join(dir, "story.db");
		seedTurns(dbPath, [{ turnSeq: 1, input: "推门", text: "第一轮" }]);
		const session = new StudioSession(collectorSink(), { cwd: dir });
		injectOpened(session, dbPath);
		const handlers = buildHostHandlers(session);

		await assert.rejects(handlers["db:query"]({ table: "no_such_table" } as never), /未知表/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("db:query：filter=user 时包自定义表被拒（冒险视图不给后门）", async () => {
	const dir = makeTempDir();
	try {
		const dbPath = join(dir, "story.db");
		const db = openStoryDb(dbPath);
		// 造一张非内核表（包自定义表的形态）。
		db.rawDb.exec("CREATE TABLE pack_secrets (id INTEGER PRIMARY KEY, secret TEXT)");
		db.close();

		const session = new StudioSession(collectorSink(), { cwd: dir });
		injectOpened(session, dbPath);
		const handlers = buildHostHandlers(session);

		// 作者视图能看
		const asAuthor = await handlers["db:query"]({ table: "pack_secrets", filter: "none" } as never);
		assert.equal(asAuthor.page?.total, 0, "作者视图可读该表（空表 total=0）");

		// 冒险视图拒绝
		await assert.rejects(
			handlers["db:query"]({ table: "pack_secrets", filter: "user" } as never),
			/冒险视图|不可读/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("边界形状：limit 传浮点/负数/字符串一律挡下（不静默取到意外行数）", async () => {
	const dir = makeTempDir();
	try {
		const session = new StudioSession(collectorSink(), { cwd: dir });
		const handlers = buildHostHandlers(session);
		await assert.rejects(handlers["db:query"]({ limit: 1.5 } as never), /limit 应为非负整数/);
		await assert.rejects(handlers["db:query"]({ limit: -1 } as never), /limit 应为非负整数/);
		await assert.rejects(handlers["db:query"]({ limit: "10" } as never), /limit 应为非负整数/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("边界形状：equals 里塞对象/数组 → 挡在边界（不穿到 SQLite 绑定处）", async () => {
	const dir = makeTempDir();
	try {
		const session = new StudioSession(collectorSink(), { cwd: dir });
		const handlers = buildHostHandlers(session);
		await assert.rejects(
			handlers["db:query"]({ table: "turn_log", equals: { turn_seq: { $gt: 1 } } } as never),
			/equals\.turn_seq 应为字符串\/数字\/null/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * 不变量：**任何** handler 的载荷错误都以 rejection 形式出现，绝不同步抛。
 *
 * 这条为什么值得单独钉：`HostHandlers` 声明的返回类型是 Promise，而校验函数是同步 throw。
 * 一旦某个 handler 忘了包 `asPromise`，它的错误就会在**调用点**炸开——Electron 里恰好无害
 * （ipcMain.handle 两者都接），但调用方再也不能写 `await`/`.catch()` 来统一处理；
 * 更阴的是测试端：`assert.rejects(handler(...))` 会在表达式求值阶段就抛，
 * 断言根本没跑到，用例却「失败得莫名其妙」——或者更糟，被写成 try/catch 后变成永久绿灯。
 *
 * 判据取「调用不抛、返回是 Promise、rejection 里有边界文案」三件套，逐个 channel 过一遍。
 */
test("不变量：全 channel 的非法载荷一律 rejection，不同步抛", async () => {
	const dir = makeTempDir();
	try {
		const session = new StudioSession(collectorSink(), { cwd: dir });
		const handlers = buildHostHandlers(session) as unknown as Record<string, (p: unknown) => unknown>;

		for (const channel of ["story:list", "story:open", "story:turns", "db:query", "turn:run", "turn:abort", "turn:swipe", "tree:navigate", "tree:fork", "prompts:read"]) {
			let returned: unknown;
			assert.doesNotThrow(() => {
				// 传一个形状非法的载荷：数字当对象用，所有 required*/optional* 校验都会炸。
				returned = handlers[channel]?.(42);
			}, `${channel} 的载荷错误不得同步抛出`);
			assert.ok(returned instanceof Promise, `${channel} 必须返回 Promise，实际 ${typeof returned}`);
			await assert.rejects(returned as Promise<unknown>, (err: unknown) => {
				assert.ok(err instanceof Error, `${channel} 应以 Error 形式 reject`);
				return true;
			}, `${channel} 的载荷错误应以 rejection 形式到达调用方`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
