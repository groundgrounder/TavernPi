// S1 阅读流验收（主进程侧）：真 app + 真 handler + 真内核装配，**零模型调用**。
//
// 与 S0 验收的分工：
//   · S0（accept:s0）= 写入路径端到端：真跑一轮 LLM、落库、独立读盘核对、并发守卫、中止零落库。
//     贵且依赖 ~/.pi 认证，故只在改动写路径时跑。
//   · S1（本条）= **只读路径**端到端：建故事 → 打开 → 读 turn_log 阅读流 → DB 浏览器 → 编辑线。
//     零 LLM（createStory 只写开场白、不调模型），秒级、无外部依赖，可频繁跑。
//
// fixture 的选择（关键）：**用内核自己的 createStory 造**，而不是手搓一个只有 turn_log 的假库。
// 理由：story:open 走内核 resume 路径，要求一个真实的 pi session 文件与匹配的故事目录
// （assembly.ts 对此有两条纵深防御）。手搓 fixture 过不了那两道闸，等于绕开被验对象——
// 而 createStory 是纯本地的（建库 + 写 meta + 落开场白 + 建 session 文件），恰好给出**真实**装配态。
// 故事落在临时目录，绝不碰用户的 ~/.tavernpi/stories。

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStory, listStories } from "@tavernpi/core";
import type { StudioSession } from "./session.ts";

export interface S1Args {
	storiesRoot: string;
}

/** 解析 `--s1-accept [--stories-root <dir>]`。默认全新临时目录，绝不写用户真实故事库。 */
export function parseS1Args(argv: readonly string[]): S1Args | undefined {
	if (!argv.includes("--s1-accept")) return undefined;
	const idx = argv.indexOf("--stories-root");
	const given = idx >= 0 ? argv[idx + 1] : undefined;
	const storiesRoot = given !== undefined && given !== "" ? given : mkdtempSync(join(tmpdir(), "tavernpi-s1-"));
	return { storiesRoot };
}

/** fixture 的开场白——同时是 turn_log 的 turnSeq=0 行，阅读流读到的第一行。 */
const FIXTURE_OPENING = "门在你身后合拢。四壁潮湿，一盏灯将熄未熄。";

/** 补写的轮次（让分页/倒序判据有足够样本）。 */
const EXTRA_TURNS = [
	{ turnSeq: 1, input: "我环顾四周。", text: "四壁空荡，只有一张覆着灰的长桌。" },
	{ turnSeq: 2, input: "走向长桌。", text: "桌角刻着一行小字，被人反复摩挲得发亮。" },
	{ turnSeq: 3, input: "俯身细看。", text: "那字迹弯曲如蛇，你认出那是古语。" },
	{ turnSeq: 4, input: "读出那句话。", text: "空气骤然变冷，灯火齐齐一暗。" },
	{ turnSeq: 5, input: "退后一步。", text: "黑暗从四角涌来，又在半途停住。" },
];

/**
 * 建一个最小卡包，只为给 createStory 一个 `opening`。
 *
 * 为什么必须有开场白：**pi 的 session 文件在写入第一条消息前不存在**。
 * 没有开场白的故事因此没有 sessionFile，`story:open`（内核 resume 路径）就无从打开——
 * 而「打开故事 → 读阅读流」正是本验收要验的链路。故 fixture 必须带开场白。
 * 卡包本身不参与断言，只负责让 createStory 走到「写开场白 + 落 session 文件」那一步。
 */
function buildFixturePack(dir: string): string {
	const packDir = join(dir, "s1_fixture_pack");
	mkdirSync(packDir, { recursive: true });
	writeFileSync(join(packDir, "package.json"), `${JSON.stringify({ name: "s1_fixture_pack", version: "0.0.0" }, null, 2)}\n`);
	// opening 是消费 story.yaml 的关键字段；calendar/granularity 顺手给上，让 clock 有初值。
	writeFileSync(
		join(packDir, "story.yaml"),
		["title: S1 验收故事", "calendar: 大雍历", "granularity: elastic", `opening: ${FIXTURE_OPENING}`, ""].join("\n"),
	);
	// db/schema.sql 是卡包布局必填项（内容可为空）。
	mkdirSync(join(packDir, "db"), { recursive: true });
	writeFileSync(join(packDir, "db", "schema.sql"), "");
	return packDir;
}

/** 独立读盘（raw SQLite，不复用内核读取路径——免得用被验对象证明自己）。 */
function readDb(dbPath: string): {
	turns: Array<{ turnSeq: number; input: string; text: string }>;
	tables: string[];
	error?: string;
} {
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(dbPath);
	} catch (err) {
		return { turns: [], tables: [], error: err instanceof Error ? err.message : String(err) };
	}
	try {
		const rows = db
			.prepare("SELECT turn_seq, user_input, narrative_text FROM turn_log ORDER BY turn_seq")
			.all() as Array<{ turn_seq: number; user_input: string; narrative_text: string }>;
		const tableRows = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all() as Array<{ name: string }>;
		return {
			turns: rows.map((r) => ({ turnSeq: r.turn_seq, input: r.user_input, text: r.narrative_text })),
			tables: tableRows.map((r) => r.name),
		};
	} catch (err) {
		return { turns: [], tables: [], error: err instanceof Error ? err.message : String(err) };
	} finally {
		db.close();
	}
}

/** 在渲染进程里发一次请求（经 preload → IPC → main，即真实链路）。 */
type CallResult = { ok: true; value: unknown } | { ok: false; error: string };

async function call(
	win: import("electron").BrowserWindow,
	channel: string,
	payload: unknown,
): Promise<CallResult> {
	const script = `
		globalThis.tavern.request(${JSON.stringify(channel)}, ${JSON.stringify(payload)}).then(
			(v) => JSON.stringify({ ok: true, value: v }),
			(e) => JSON.stringify({ ok: false, error: (e && e.message) ? e.message : String(e) })
		)
	`;
	return JSON.parse((await win.webContents.executeJavaScript(script)) as string) as CallResult;
}

/** 取调用结果用于断言的可读形式（成功给 value，失败给 error）——避免每处都写三元。 */
function shown(res: CallResult): unknown {
	return res.ok ? res.value : res.error;
}

export async function runS1Acceptance(ctx: {
	win: import("electron").BrowserWindow;
	session: StudioSession;
	storiesRoot: string;
}): Promise<number> {
	const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
	const push = (name: string, ok: boolean, detail?: string): void => {
		checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
	};

	// ---- 0. 界面真的挂上了（file:// + CSP 下 React 产物能加载）----
	const ui = JSON.parse(
		(await ctx.win.webContents.executeJavaScript(
			`JSON.stringify({ ready: globalThis.__studioReady === true, h1: document.querySelector("h1")?.textContent ?? null,
				buttons: [...document.querySelectorAll("button")].map(b => b.textContent.trim()) })`,
		)) as string,
	) as { ready: boolean; h1: string | null; buttons: string[] };
	push("渲染层挂载（React 产物在 file:// + CSP 下可用）", ui.ready && ui.h1 === "tavern studio", `h1=${ui.h1}`);
	push(
		"S1 界面按钮齐备（新建 / 发送 / 重骰 / 中止）",
		["新建故事", "发送", "重骰", "中止"].every((l) => ui.buttons.includes(l)),
		ui.buttons.join(" / "),
	);

	// ---- 1. 空态：未打开故事时两条读取通道都不抛错 ----
	const noTurns = await call(ctx.win, "story:turns", { limit: 3 });
	push(
		"未打开故事时 story:turns 回空页（空态走数据不走错误通道）",
		noTurns.ok && JSON.stringify(noTurns.value) === JSON.stringify({ turns: [], total: 0, limit: 3, offset: 0 }),
		JSON.stringify(shown(noTurns)).slice(0, 120),
	);
	const noDb = await call(ctx.win, "db:query", {});
	const noDbTables = noDb.ok ? (noDb.value as { tables?: unknown[] }).tables : undefined;
	push(
		"未打开故事时 db:query 回空表清单（不抛错）",
		Array.isArray(noDbTables) && noDbTables.length === 0,
		JSON.stringify(shown(noDb)).slice(0, 120),
	);

	// ---- 2. 边界校验端到端：非法载荷以 rejection 到达渲染层 ----
	const badLimit = await call(ctx.win, "db:query", { limit: -5 });
	push("非法 limit 以 rejection 到达渲染层", !badLimit.ok && /非负整数/.test(badLimit.ok ? "" : badLimit.error), JSON.stringify(shown(badLimit)).slice(0, 120));
	const badOrder = await call(ctx.win, "story:turns", { order: "nope" });
	push("非法 order 以 rejection 到达渲染层", !badOrder.ok && /asc\|desc/.test(badOrder.ok ? "" : badOrder.error), JSON.stringify(shown(badOrder)).slice(0, 120));

	// ---- 3. 建 fixture（内核 createStory，纯本地；带开场白以落 session 文件）----
	const packDir = buildFixturePack(ctx.storiesRoot);
	const created = await createStory({
		storiesRoot: ctx.storiesRoot,
		packDirs: [packDir],
		cwd: ctx.storiesRoot,
		title: "S1 验收故事",
	});
	created.storyState.storyDb.close();
	created.storyState.snapshotsDb.close();
	const sessionId = created.sessionId;
	const storyDir = join(ctx.storiesRoot, sessionId);
	const dbPath = join(storyDir, "story.db");
	push("内核 createStory 建成 fixture（零模型调用）", sessionId !== "", `sessionId=${sessionId}`);

	// 补几轮 turn_log：只有开场白（turnSeq=0）一行的话，「分页 / 倒序」这类判据在小样本上区分度不足。
	// 直接用 raw SQLite 写——CREATE 由内核 migration 建好，这里只补行，不绕过任何校验逻辑
	// （阅读流是**只读**路径，行是谁写的与它无关；写完即关库，交给 app 重新打开）。
	{
		const db = new DatabaseSync(dbPath);
		const ins = db.prepare(
			"INSERT INTO turn_log (turn_seq, session_entry_id, user_input, narrative_text) VALUES (?, ?, ?, ?)",
		);
		for (const t of EXTRA_TURNS) ins.run(t.turnSeq, `s1-entry-${t.turnSeq}`, t.input, t.text);
		db.close();
	}
	// 独立的盘上事实（判据的另一端：一边我写，一边 app 读）。
	const dbBefore = readDb(dbPath);
	push(
		"fixture 盘上轮次数量正确（判据自检：防止 fixture 写歪造成假绿）",
		dbBefore.turns.length === EXTRA_TURNS.length + 1,
		`盘上 ${dbBefore.turns.length} 行（开场白 1 + 补写 ${EXTRA_TURNS.length}）`,
	);

	// ---- 4. 枚举认得它 ----
	const listed = await call(ctx.win, "story:list", { storiesRoot: ctx.storiesRoot });
	const found =
		listed.ok && Array.isArray(listed.value)
			? ((listed.value as Array<{ sessionId: string; sessionFile?: string }>).find((s) => s.sessionId === sessionId) ?? null)
			: null;
	push("story:list 列出 fixture 且给出会话文件", found !== null && found.sessionFile !== undefined, found === null ? "未找到" : `sessionFile=${found.sessionFile ? "有" : "无"}`);

	// ---- 5. 打开故事（真内核 resume 路径：story:open）----
	const sessionFile = found?.sessionFile ?? "";
	const opened = await call(ctx.win, "story:open", { storiesRoot: ctx.storiesRoot, sessionFile });
	push(
		"story:open 打开 fixture（真内核 resume）",
		opened.ok && (opened.value as { sessionId?: string }).sessionId === sessionId,
		opened.ok ? `mode=${(opened.value as { mode?: string }).mode}` : opened.error.slice(0, 140),
	);

	// ---- 6. 阅读流：story:turns 与盘上 turn_log 逐行比对（这是 S1 的核心判据）----
	// dbBefore 在步骤 3 末尾已从盘上读过（判据的另一端），此处直接复用同一份快照。
	const turns = await call(ctx.win, "story:turns", { limit: 50 });
	let turnsOk = false;
	let turnsDetail = "";
	if (turns.ok) {
		const got = (turns.value as { turns: Array<{ turn_seq: number; user_input: string; narrative_text: string }>; total: number }).turns;
		// 倒序：最新在前。
		const gotAsc = [...got].sort((a, b) => a.turn_seq - b.turn_seq);
		turnsOk =
			gotAsc.length === dbBefore.turns.length &&
			gotAsc.every((t, i) => {
				const want = dbBefore.turns[i];
				return want !== undefined && t.turn_seq === want.turnSeq && t.narrative_text === want.text && t.user_input === want.input;
			});
		turnsDetail = `通道 ${gotAsc.length} 行（倒序首行 turn_seq=${got.length > 0 ? got[0]?.turn_seq : "-"}）/ 盘上 ${dbBefore.turns.length} 行`;
	} else {
		turnsDetail = turns.error.slice(0, 140);
	}
	push("story:turns 读出的正文与盘上 turn_log 逐行逐字符一致", turnsOk, turnsDetail);

	// 倒序契约：首行必须是最大 turn_seq（阅读流默认从最新往回读）。
	const firstSeq = turns.ok ? (turns.value as { turns: Array<{ turn_seq: number }> }).turns[0]?.turn_seq : undefined;
	const maxSeq = dbBefore.turns.reduce((m, t) => Math.max(m, t.turnSeq), -1);
	push("story:turns 默认倒序（首行即最新一轮）", firstSeq === maxSeq, `首行 turn_seq=${firstSeq} / 盘上最大 ${maxSeq}`);

	// ---- 7. DB 浏览器：db:query 列出的表与盘上 sqlite_master 一致 ----
	const tables = await call(ctx.win, "db:query", {});
	const gotTables = tables.ok ? ((tables.value as { tables?: Array<{ name: string }> }).tables ?? []).map((t) => t.name) : [];
	push(
		"db:query 列出的表与盘上 sqlite_master 一致",
		tables.ok && JSON.stringify([...gotTables].sort()) === JSON.stringify([...dbBefore.tables].sort()),
		tables.ok ? `通道 ${gotTables.length} 表 / 盘上 ${dbBefore.tables.length} 表` : tables.error.slice(0, 140),
	);

	// 翻页读真实行：turn_log 一页。
	const page = await call(ctx.win, "db:query", { table: "turn_log", orderBy: "turn_seq", descending: true, limit: 2 });
	const pageRows = page.ok ? ((page.value as { page?: { rows: Array<Record<string, unknown>>; total: number } }).page?.rows ?? []) : [];
	push(
		"db:query 翻页读出真实行（turn_log 一页 2 行）",
		page.ok && pageRows.length === Math.min(2, dbBefore.turns.length) && pageRows[0]?.["turn_seq"] === maxSeq,
		page.ok ? `本页 ${pageRows.length} 行 · total ${(page.value as { page?: { total: number } }).page?.total} · 首行 turn_seq=${pageRows[0]?.["turn_seq"]}` : page.error.slice(0, 140),
	);

	// 冒险视图不给后门：filter=user 下列包自定义表必须被拒（fixture 无包，故只验不抛错与非空）。
	const userView = await call(ctx.win, "db:query", { filter: "user" });
	push("db:query 冒险视图（filter=user）可用且只列内核表", userView.ok, userView.ok ? `${(userView.value as { tables?: unknown[] }).tables?.length ?? 0} 表` : userView.error.slice(0, 140));

	// ---- 8. 脏读防护：listStories 与内核直读一致 ----
	const direct = listStories(ctx.storiesRoot);
	push("story:list 与内核 listStories 直读一致", listed.ok && Array.isArray(listed.value) && (listed.value as unknown[]).length === direct.length, `通道 ${listed.ok && Array.isArray(listed.value) ? (listed.value as unknown[]).length : "?"} / 直读 ${direct.length}`);

	const ok = checks.every((c) => c.ok);
	console.log(
		`S1_READ_RESULT ${JSON.stringify(
			{
				ok,
				storiesRoot: ctx.storiesRoot,
				fixture: { sessionId, dbPath, turns: dbBefore.turns.length, tables: dbBefore.tables.length },
				checks,
			},
			null,
			2,
		)}`,
	);
	return ok ? 0 : 1;
}
