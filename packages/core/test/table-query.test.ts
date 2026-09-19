// 通用只读查询单测（缺口 3）：表清单 / 分页 / 只读闸门 / 视图净化 / 与既有视图方法一致性。
// 全部离线确定性，无 LLM。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import {
	TABLE_QUERY_MAX_LIMIT,
	TABLE_QUERY_MAX_SCAN,
	listTableInfos,
	readTablePage,
	tableColumns,
} from "../src/db/query.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import { PLAYER_NPC_ID_KEY, TableNotVisibleError, createDbView } from "../src/db/view.ts";
import type { EventRow, LocationRow, NpcRow } from "../src/db/types.ts";

interface Scenario {
	story: StoryDb;
	city: LocationRow;
	yard: LocationRow;
	faraway: LocationRow;
	player: NpcRow;
	ally: NpcRow;
	local: NpcRow;
	stranger: NpcRow;
	atYard: EventRow;
	atFaraway: EventRow;
}

/**
 * 场景：玩家锚定且人在庭院（庭院的父是王城）。
 * 相关 NPC 集合 = 玩家 ∪ 关系对端（盟友）∪ 玩家同地点（本地人）；无关者（在王城、无关系）不可见。
 *
 * 地点可见性取「到过的 + 祖先链」，故王城也可见（玩家从王城进庭院）；**远山玩家没去过**，
 * 放在那里的 `atFaraway` 事件是「玩家无从得知」的样本。另备 phases / directives / data_status /
 * turn_log 与一张包自定义表（`minipack_tokens`）。
 */
function setupStory(dir: string): Scenario {
	const story = openStoryDb(join(dir, "story.db"));
	const w = story.writer;

	const city = w.insertLocation({ name: "王城" });
	const yard = w.insertLocation({ name: "庭院", parentId: city.id });
	const faraway = w.insertLocation({ name: "远山" });
	w.moveSubject({ turnSeq: 1, subject: "player", toLocationId: yard.id });

	const player = w.insertNpc({ name: "玩家", cardRef: "pack:a" });
	const ally = w.insertNpc({ name: "盟友", cardRef: "pack:b" });
	const local = w.insertNpc({ name: "本地人", cardRef: "pack:c" });
	const stranger = w.insertNpc({ name: "无关者", cardRef: "pack:d" });

	w.upsertWorldState({ key: PLAYER_NPC_ID_KEY, value: String(player.id), turnSeq: 1 });
	w.upsertWorldState({ key: "sys_internal_cursor", value: "42", turnSeq: 1 });
	w.upsertWorldState({ key: "weather", value: "雨", turnSeq: 1 });

	// 移动：盟友与无关者去王城，本地人留在庭院
	w.moveSubject({ turnSeq: 2, subject: `npc:${ally.id}`, toLocationId: city.id });
	w.moveSubject({ turnSeq: 2, subject: `npc:${local.id}`, toLocationId: yard.id });
	w.moveSubject({ turnSeq: 2, subject: `npc:${stranger.id}`, toLocationId: city.id });

	// 关系：玩家-盟友（两端在集合）；盟友-无关者（一端不在，必须被滤）
	w.insertNpcRelation({ npcA: player.id, npcB: ally.id, disposition: 50, turnSeq: 1 });
	w.insertNpcRelation({ npcA: ally.id, npcB: stranger.id, disposition: -10, turnSeq: 1 });

	// 特征与记忆：可见者的要看得到，无关者的必须看不到
	w.insertNpcTrait({ npcId: ally.id, trait: "谨慎", weight: 0.8, turnSeq: 1 });
	w.insertNpcTrait({ npcId: stranger.id, trait: "阴鸷", weight: 0.9, turnSeq: 1 });
	w.insertNpcMemory({ npcId: ally.id, turnSeq: 1, kind: "fact", content: "曾与玩家结盟", salience: 5 });
	w.insertNpcMemory({ npcId: stranger.id, turnSeq: 1, kind: "fact", content: "密谋篡位", salience: 9 });

	// 事件：庭院那条玩家在场（名册含一位不可见者）；远山那条玩家无从得知
	const atYard = w.insertEvent({
		turnSeq: 3,
		summary: "庭院里的相遇",
		locationId: yard.id,
		npcIds: [player.id, ally.id, stranger.id],
	});
	const atFaraway = w.insertEvent({ turnSeq: 3, summary: "远山的异动", locationId: faraway.id, npcIds: [stranger.id] });

	// 叙事结构 / 作者意图 / 内核运维面（冒险视图下都该不可见）
	w.insertPhase({ name: "第一幕", startedTurn: 1 });
	w.insertDirective({ turnSeq: 2, content: "让玩家遇见盟友" });
	w.recordDataStatus({ turnSeq: 3, status: "ok", attempts: 1 });
	w.recordTurnLog({ turnSeq: 3, sessionEntryId: "e3", userInput: "我环顾四周", narrativeText: "庭院里有人。" });

	// 包自定义表：真实场景由卡包迁移建（内核 writer 不管包表），故此处直接建表。
	story.rawDb.exec("CREATE TABLE minipack_tokens (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
	story.rawDb.exec("INSERT INTO minipack_tokens (label) VALUES ('秘密令牌')");

	return { story, city, yard, faraway, player, ally, local, stranger, atYard, atFaraway };
}

// ---------------------------------------------------------------------------
// 形态：表清单 / 列清单 / 分页 / 过滤 / 排序
// ---------------------------------------------------------------------------

test("listTableInfos：列出内核表与包表，kernel 标记与行数正确（含 v7 的 event_npcs）", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		const byName = new Map(listTableInfos(story.rawDb).map((i) => [i.name, i]));

		assert.equal(byName.get("event_npcs")?.kernel, true, "v7 迁移建的 event_npcs 必须是内核表");
		assert.equal(byName.get("minipack_tokens")?.kernel, false, "非内核表即包表");
		assert.equal(byName.get("npcs")?.rows, 4);
		assert.equal(byName.get("minipack_tokens")?.rows, 1);
		assert.equal(byName.get("sqlite_sequence"), undefined, "sqlite_ 内部表不入清单");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("tableColumns：列清单来自真实 metadata（含迁移新增列），不是 schema 源码常量", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		assert.ok(tableColumns(story.rawDb, "npcs").includes("current_location"), "v2 ALTER 新增列必须出现");
		assert.ok(tableColumns(story.rawDb, "turn_log").includes("warnings"), "turn_log.warnings 是后续迁移加的列");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("分页：total 是过滤后行数，两页不重合，limit 夹到硬上限，越界给空页", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		const db = story.rawDb;
		const allIds = readTablePage(db, { table: "npcs" }).rows.map((r) => Number(r.id)).sort((a, b) => a - b);
		assert.equal(allIds.length, 4);

		const first = readTablePage(db, { table: "npcs", limit: 2, offset: 0 });
		const second = readTablePage(db, { table: "npcs", limit: 2, offset: 2 });
		assert.equal(first.total, 4);
		assert.equal(first.rows.length, 2);
		assert.deepEqual(
			[first.rows, second.rows].map((rows) => rows.map((r) => Number(r.id))).flat().sort((a, b) => a - b),
			allIds,
			"两页拼起来正好是全表（不重不漏）",
		);

		const clamped = readTablePage(db, { table: "npcs", limit: 99_999 });
		assert.equal(clamped.limit, TABLE_QUERY_MAX_LIMIT, "limit 超上限被夹住而不是照办");

		const beyond = readTablePage(db, { table: "npcs", offset: 999 });
		assert.deepEqual(beyond.rows, []);
		assert.equal(beyond.total, 4, "越界页的 total 仍是总行数");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("过滤与排序：equals 精确命中、orderBy 正反序", () => {
	const dir = makeTempDir();
	try {
		const { story, ally, stranger } = setupStory(dir);
		const db = story.rawDb;

		assert.deepEqual(readTablePage(db, { table: "npcs", equals: { name: "盟友" } }).rows.map((r) => r.id), [ally.id]);
		assert.deepEqual(readTablePage(db, { table: "npcs", equals: { name: "无此人" } }).rows, []);

		const byOwner = readTablePage(db, { table: "npc_traits", equals: { npc_id: stranger.id } });
		assert.deepEqual(byOwner.rows.map((r) => r.trait), ["阴鸷"]);

		const ascending = readTablePage(db, { table: "npcs", orderBy: "id" }).rows.map((r) => Number(r.id));
		const descending = readTablePage(db, { table: "npcs", orderBy: "id", descending: true }).rows.map((r) => Number(r.id));
		assert.deepEqual(descending, [...ascending].reverse(), "降序即升序反转");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("只读闸门：表名/列名不命中真实 metadata 一律拒绝（注入无门，且库未被动过）", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		const db = story.rawDb;

		for (const table of ["npcs; DROP TABLE npcs", 'npcs" ; DROP TABLE npcs; --', "npcs n", "sqlite_master", "npcs ", "NPCS"]) {
			assert.throws(() => readTablePage(db, { table }), /未知表/, `表名 ${JSON.stringify(table)} 必须被拒`);
		}
		assert.throws(() => readTablePage(db, { table: "npcs", orderBy: "id; DROP TABLE npcs" }), /无排序列/);
		assert.throws(() => readTablePage(db, { table: "npcs", equals: { "id) OR 1=1 --": 1 } }), /无此列/);
		assert.throws(() => tableColumns(db, "npcs; --"), /未知表/);

		// 库照样完好：表还在、行数没变
		assert.equal(readTablePage(db, { table: "npcs" }).total, 4);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("扫描上限：超限只截断并标记 truncated，不伪装成完整页", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		const db = story.rawDb;
		const bulk = TABLE_QUERY_MAX_SCAN + 3;
		db.exec(
			`INSERT INTO npcs (name) SELECT 'bulk-' || x FROM (
			   WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${bulk}) SELECT x FROM c
			 )`,
		);

		const page = readTablePage(db, { table: "npcs", limit: 5 });
		assert.equal(page.truncated, true, "超出扫描上限必须标记");
		assert.equal(page.total, TABLE_QUERY_MAX_SCAN, "total 只覆盖已扫描部分");
		assert.equal(page.rows.length, 5, "分页仍按 limit 生效");

		assert.equal(readTablePage(db, { table: "minipack_tokens" }).truncated, false, "小表不该被标记截断");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 视图净化：与既有视图方法同规则（一致性判据钉住，防两份规则漂移）
// ---------------------------------------------------------------------------

test("冒险视图：通用查询与既有视图方法逐表一致（含三类不可见表）", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		const view = createDbView(story.reader, "user-related");
		// 视图方法返回具名行类型（NpcRow 等），通用查询返回宽松行；比较时按 key 列取文本。
		const keyed = (rows: readonly object[], keys: string[]): string[] =>
			rows.map((row) => keys.map((k) => String((row as Record<string, unknown>)[k])).join("|")).sort();

		const cases: Array<{ table: string; keys: string[]; listed: () => readonly object[] }> = [
			{ table: "npcs", keys: ["id"], listed: () => view.listNpcs() },
			{ table: "locations", keys: ["id"], listed: () => view.listLocations() },
			{ table: "events", keys: ["id"], listed: () => view.listEvents() },
			{ table: "location_log", keys: ["turn_seq", "subject", "to_location"], listed: () => view.listLocationLog(10_000) },
			{ table: "world_state", keys: ["key"], listed: () => view.listWorldState() },
			{ table: "phases", keys: ["id"], listed: () => view.listPhases() },
			{ table: "directives", keys: ["id"], listed: () => view.listDirectives() },
			{ table: "data_status", keys: ["turn_seq"], listed: () => view.listDataStatus() },
		];
		for (const c of cases) {
			const queried = keyed(view.queryTable({ table: c.table, limit: TABLE_QUERY_MAX_LIMIT }).rows, c.keys);
			const listed = keyed(c.listed(), c.keys);
			assert.deepEqual(queried, listed, `${c.table}: 通用查询与视图方法结果不一致（两份规则漂移了）`);
		}
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("冒险视图：无关者的特征/记忆/关系与「没去过的地方的事」都读不到", () => {
	const dir = makeTempDir();
	try {
		const { story, ally, player, stranger, atYard, faraway } = setupStory(dir);
		const view = createDbView(story.reader, "user-related");

		const traits = view.queryTable({ table: "npc_traits", limit: 100 }).rows.map((r) => Number(r.npc_id));
		assert.ok(traits.includes(ally.id), "可见 NPC 的特征看得到");
		assert.ok(!traits.includes(stranger.id), "无关者的特征不可见");

		const memories = view.queryTable({ table: "npc_memories", limit: 100 }).rows.map((r) => r.content);
		assert.ok(memories.includes("曾与玩家结盟"));
		assert.ok(!memories.includes("密谋篡位"), "无关者的记忆不可见");

		const relations = view.queryTable({ table: "npc_relations", limit: 100 }).rows;
		assert.equal(relations.length, 1, "只有两端都在集合内的关系可见（盟友-无关者被滤）");

		// 地点：到过的（庭院 + 其祖先王城）可见，没去过的远山不可见
		const locationNames = view.queryTable({ table: "locations", limit: 100 }).rows.map((r) => r.name).sort();
		assert.deepEqual(locationNames, ["庭院", "王城"].sort());

		// 事件：远山那条不可见 → 名册里也不该出现它的人
		const eventIds = view.queryTable({ table: "events", limit: 100 }).rows.map((r) => Number(r.id));
		assert.deepEqual(eventIds, [atYard.id]);
		const roster = view.queryTable({ table: "event_npcs", limit: 100 }).rows;
		assert.ok(roster.every((r) => Number(r.event_id) === atYard.id), "未去过地点的事件名册整体不可见");
		assert.deepEqual(
			roster.map((r) => Number(r.npc_id)).sort((a, b) => a - b),
			[player.id, ally.id].sort((a, b) => a - b),
			"名册里只剩集合内的人（无关者被滤）",
		);

		// 远山本身在内核库里存在（作者视图可见），只是玩家侧看不见
		const authorView = createDbView(story.reader, "none");
		assert.equal(authorView.queryTable({ table: "locations", equals: { id: faraway.id } }).total, 1);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("冒险视图：包自定义表拒绝读（TableNotVisibleError），作者视图可读；表清单同样按视图收窄", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		const userView = createDbView(story.reader, "user-related");
		const authorView = createDbView(story.reader, "none");

		assert.throws(() => userView.queryTable({ table: "minipack_tokens" }), TableNotVisibleError);
		assert.equal(authorView.queryTable({ table: "minipack_tokens" }).rows.length, 1, "作者视图照读");

		const userTables = userView.listTables();
		assert.ok(!userTables.some((t) => t.name === "minipack_tokens"), "冒险视图不列包表（表名本身也可能带剧情）");
		assert.ok(userTables.every((t) => t.kernel));

		const authorTables = authorView.listTables();
		assert.ok(authorTables.some((t) => t.name === "minipack_tokens" && !t.kernel));
		assert.ok(authorTables.some((t) => t.name === "event_npcs" && t.kernel));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("作者视图全量透传：冒险视图滤掉的行，在 none 视图里都在", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupStory(dir);
		const userView = createDbView(story.reader, "user-related");
		const authorView = createDbView(story.reader, "none");
		const total = (view: ReturnType<typeof createDbView>, table: string): number =>
			view.queryTable({ table, limit: TABLE_QUERY_MAX_LIMIT }).total;

		assert.equal(total(authorView, "npcs"), 4);
		assert.equal(total(userView, "npcs"), 3, "玩家 + 盟友（关系）+ 本地人（同地点）；无关者在王城且无关系");
		assert.equal(total(authorView, "events"), 2);
		assert.equal(total(userView, "events"), 1, "远山那条玩家无从得知");
		assert.equal(total(authorView, "locations"), 3);
		assert.equal(total(userView, "locations"), 2, "庭院 + 祖先王城；远山没去过");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
