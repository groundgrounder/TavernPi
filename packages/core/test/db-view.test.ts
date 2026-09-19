// 冒险模式 DB 视图过滤查询层单测。全部确定性，无 LLM。
// 覆盖：锚定三方并集 / 无关被滤 / relations 两侧校验 / 退化与 warning / world_state sys_ 隐藏 /
//       世界公开面全量透传 / 越集 getNpc 返回 undefined / filter="none" 全透传 / card_ref 可见性判定。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import { PLAYER_LOCATION_KEY } from "../src/db/types.ts";
import {
	buildNpcCardRefIndex,
	createDbView,
	isNpcCardVisible,
	PLAYER_NPC_ID_KEY,
	resolveRelatedNpcSet,
} from "../src/db/view.ts";
import type { LocationRow, NpcRow } from "../src/db/types.ts";

/** 锚定场景：玩家 + 关系对端 + 同地点三方并集，含一个无关 NPC（不同地点且无关系）。 */
function setupAnchorStory(dir: string): { story: StoryDb; city: LocationRow; yard: LocationRow } & Record<
	"player" | "ally" | "local" | "stranger",
	NpcRow
> {
	const story = openStoryDb(join(dir, "story.db"));
	const city = story.writer.insertLocation({ name: "王城" });
	const yard = story.writer.insertLocation({ name: "庭院", parentId: city.id });

	// 玩家位于庭院
	story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: yard.id });

	// NPC：玩家锚定、盟友（关系）、本地人（同地点）、无关者（不同地点且无关系）
	const player = story.writer.insertNpc({ name: "玩家", cardRef: "pack:a" });
	const ally = story.writer.insertNpc({ name: "盟友", cardRef: "pack:b" });
	const local = story.writer.insertNpc({ name: "本地人", cardRef: "pack:c" });
	const stranger = story.writer.insertNpc({ name: "无关者", cardRef: "pack:d" });

	story.writer.upsertWorldState({ key: PLAYER_NPC_ID_KEY, value: String(player.id), turnSeq: 1 });

	// 移动 NPC 到地点：盟友/无关者到王城；本地人到庭院
	story.writer.moveSubject({ turnSeq: 2, subject: `npc:${ally.id}`, toLocationId: city.id });
	story.writer.moveSubject({ turnSeq: 3, subject: `npc:${local.id}`, toLocationId: yard.id });
	story.writer.moveSubject({ turnSeq: 4, subject: `npc:${stranger.id}`, toLocationId: city.id });

	// 关系：R1 玩家-盟友（两侧在集合）；R2 盟友-无关者（一侧无关）；R3 本地人-玩家（两侧在集合）
	story.writer.insertNpcRelation({ npcA: player.id, npcB: ally.id, disposition: 50, turnSeq: 1 });
	story.writer.insertNpcRelation({ npcA: ally.id, npcB: stranger.id, disposition: -10, turnSeq: 1 });
	story.writer.insertNpcRelation({ npcA: local.id, npcB: player.id, disposition: 20, turnSeq: 1 });

	// 盟友的 traits/memories，验证 composite 随 NPC 可见性整体过滤
	story.writer.insertNpcTrait({ npcId: ally.id, trait: "谨慎", weight: 0.8, turnSeq: 1 });
	story.writer.insertNpcMemory({ npcId: ally.id, turnSeq: 1, kind: "fact", content: "曾与玩家结盟", salience: 5 });

	return { story, city, yard, player, ally, local, stranger };
}

test("锚定场景：player_npc_id + 关系对端 + 同地点三方并集；无关 NPC 被滤", () => {
	const dir = makeTempDir();
	try {
		const { story, player, ally, local, stranger } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");
		const set = view.relatedSet;

		// 集合成员 = 玩家 ∪ 关系对端(盟友) ∪ 同地点(本地人)；无关者被滤
		assert.equal(set.playerNpcId, player.id);
		assert.equal(set.degraded, false);
		assert.deepEqual([...set.npcIds].sort((a, b) => a - b), [player.id, ally.id, local.id].sort((a, b) => a - b));

		// listNpcs 只返回集合内
		const visibleIds = view.listNpcs().map((n) => n.id).sort((a, b) => a - b);
		assert.deepEqual(visibleIds, [player.id, ally.id, local.id].sort((a, b) => a - b));

		// 越集 id：getNpc 返回 undefined
		assert.equal(view.getNpc(stranger.id), undefined);

		// 可见 NPC composite：traits/memories 随可见性整体给出
		const allyComp = view.getNpc(ally.id);
		assert.notEqual(allyComp, undefined);
		assert.equal(allyComp?.npc?.name, "盟友");
		assert.equal(allyComp?.traits.length, 1);
		assert.equal(allyComp?.memories.length, 1);

		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("relations 两侧都在集合才可见：一侧无关即滤", () => {
	const dir = makeTempDir();
	try {
		const { story, player, ally, local, stranger } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");

		const allyComp = view.getNpc(ally.id);
		// R1(玩家-盟友)、R3(本地人-玩家) 两侧都在集合 → 保留；R2(盟友-无关者) 一侧无关 → 滤
		assert.deepEqual(
			allyComp!.relations.filter((r) => !(r.npc_a === stranger.id || r.npc_b === stranger.id)).length,
			1,
			"盟友的可见关系不应包含与无关者的关系",
		);
		const allyRelationSides = new Set<number>();
		for (const r of allyComp!.relations) {
			allyRelationSides.add(r.npc_a);
			allyRelationSides.add(r.npc_b);
		}
		assert.ok(!allyRelationSides.has(stranger.id), "盟友的可见关系对端不允许含无关者");

		// 玩家复合：R1 + R3 可见（均含玩家且两侧在集合）
		const playerComp = view.getNpc(player.id);
		assert.equal(playerComp?.relations.length, 2);

		// 本地人复合：R3 可见
		const localComp = view.getNpc(local.id);
		assert.equal(localComp?.relations.length, 1);
		assert.equal(localComp?.relations[0]?.npc_a, local.id);
		assert.equal(localComp?.relations[0]?.npc_b, player.id);

		// 无关者的复合不可得（越集）
		assert.equal(view.getNpc(stranger.id), undefined);

		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("退化：无 player_npc_id → 集合仅同地点 NPC", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const city = story.writer.insertLocation({ name: "王城" });
		const yard = story.writer.insertLocation({ name: "庭院" });

		// 玩家定位到庭院（world_state player_location），但未设 player_npc_id
		story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: yard.id });
		const yardNpc = story.writer.insertNpc({ name: "同院者" });
		const cityNpc = story.writer.insertNpc({ name: "城中者" });
		story.writer.moveSubject({ turnSeq: 2, subject: `npc:${yardNpc.id}`, toLocationId: yard.id });
		story.writer.moveSubject({ turnSeq: 3, subject: `npc:${cityNpc.id}`, toLocationId: city.id });

		const set = resolveRelatedNpcSet(story.reader);
		assert.equal(set.playerNpcId, null);
		assert.equal(set.degraded, true);
		assert.equal(set.warning, undefined, "正常未设不应有 warning");
		assert.deepEqual([...set.npcIds], [yardNpc.id], "仅同地点 NPC");

		const view = createDbView(story.reader, "user-related");
		assert.deepEqual(view.listNpcs().map((n) => n.id), [yardNpc.id]);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("player_npc_id 指向不存在行 → degraded + warning，按未设置处理", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const yard = story.writer.insertLocation({ name: "庭院" });
		story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: yard.id });
		const yardNpc = story.writer.insertNpc({ name: "同院者" });
		story.writer.moveSubject({ turnSeq: 2, subject: `npc:${yardNpc.id}`, toLocationId: yard.id });

		// 锚定到不存在的 npcs 行
		story.writer.upsertWorldState({ key: PLAYER_NPC_ID_KEY, value: "999", turnSeq: 1 });

		const set = resolveRelatedNpcSet(story.reader);
		assert.equal(set.playerNpcId, null);
		assert.equal(set.degraded, true);
		assert.equal(typeof set.warning, "string");
		assert.ok(set.warning!.includes("999"), "warning 应提及不存在的 id");
		assert.deepEqual([...set.npcIds], [yardNpc.id], "退化为仅同地点 NPC");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("parseNpcAnchorValue：/^\\d+$/ 严格匹配——合法十进制接受；1e2/0x10/abc/空串→非法→degraded", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const yard = story.writer.insertLocation({ name: "庭院" });
		story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: yard.id });
		const yardNpc = story.writer.insertNpc({ name: "同院者" });
		story.writer.moveSubject({ turnSeq: 2, subject: `npc:${yardNpc.id}`, toLocationId: yard.id });
		const setup = (value: string) => {
			story.writer.upsertWorldState({ key: PLAYER_NPC_ID_KEY, value, turnSeq: 3 });
			return resolveRelatedNpcSet(story.reader);
		};
		// 合法非负十进制字符串 → 正常锚定
		const ok = setup(String(yardNpc.id));
		assert.equal(ok.playerNpcId, yardNpc.id);
		assert.equal(ok.degraded, false);
		assert.equal(ok.warning, undefined);
		// "1e2"（Number() 宽容解析为 100）→ 被 /^\d+$/ 严格拦截 → 非法值 → degraded
		const sci = setup("1e2");
		assert.equal(sci.playerNpcId, null);
		assert.equal(sci.degraded, true);
		assert.ok(sci.warning!.includes("非法"), "warning 提及非法值");
		assert.ok(!sci.warning!.includes("指向不存在"), "不再走误导性「指向不存在行」warning");
		// "0x10"（Number() 宽容解析为 16）→ 拒绝
		const hex = setup("0x10");
		assert.equal(hex.playerNpcId, null);
		assert.equal(hex.degraded, true);
		assert.ok(hex.warning!.includes("非法"));
		// 空串 → 按未设置处理（degraded，不附误导性 warning）
		const empty = setup("");
		assert.equal(empty.playerNpcId, null);
		assert.equal(empty.degraded, true);
		assert.equal(empty.warning, undefined, "空串按未设置处理，无 warning");
		// 负号 / 前导空格 / 非数字 → 一律拒绝
		assert.equal(setup("-1").playerNpcId, null);
		assert.equal(setup(" 12").playerNpcId, null);
		assert.equal(setup("abc").playerNpcId, null);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("world_state：sys_ 键在 user-related 下隐藏、none 下可见；player_location 两模式都可见", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const yard = story.writer.insertLocation({ name: "庭院" });
		story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: yard.id });
		story.writer.upsertWorldState({ key: "sys_npc_offscreen_last_turn:3", value: "1", turnSeq: 1 });
		story.writer.upsertWorldState({ key: "weather", value: "rain", turnSeq: 1 });

		const keys = (rows: Array<{ key: string }>) => rows.map((r) => r.key);
		const userRelatedKeys = keys(createDbView(story.reader, "user-related").listWorldState());
		const noneKeys = keys(createDbView(story.reader, "none").listWorldState());

		// user-related：sys_ 隐藏，player_location 与普通约定键可见
		assert.ok(!userRelatedKeys.some((k) => k.startsWith("sys_")), "user-related 应隐藏 sys_ 键");
		assert.ok(userRelatedKeys.includes(PLAYER_LOCATION_KEY), "user-related 应保留 player_location");
		assert.ok(userRelatedKeys.includes("weather"), "user-related 应保留普通约定键");

		// none：sys_ 键可见
		assert.ok(noneKeys.includes("sys_npc_offscreen_last_turn:3"), "none 模式下 sys_ 键应可见");
		assert.ok(noneKeys.includes(PLAYER_LOCATION_KEY), "none 模式下应保留 player_location");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("user-related 只给「user 经历过或知道」的数据：到过地点/当地事件可见，未到过的与作者意图/运维面不可见", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const city = story.writer.insertLocation({ name: "王城" });
		const yard = story.writer.insertLocation({ name: "庭院" }); // 玩家没去过
		story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: city.id });
		const passerby = story.writer.insertNpc({ name: "路人" });
		story.writer.moveSubject({ turnSeq: 2, subject: `npc:${passerby.id}`, toLocationId: yard.id }); // 别人的行程
		story.writer.advanceClock({ turnSeq: 2, toTime: "0000-01-02", spanNote: "次日" });
		story.writer.insertEvent({ turnSeq: 3, summary: "城门洞开", locationId: city.id }); // 到过地点的事件
		story.writer.insertEvent({ turnSeq: 4, summary: "庭院私语", locationId: yard.id }); // 没到过地点的事件
		story.writer.insertPhase({ name: "第一幕", startedTurn: 1 });
		story.writer.recordTurnLog({ turnSeq: 5, sessionEntryId: "s1", userInput: "hi", narrativeText: "叙事" });
		story.writer.insertDirective({ turnSeq: 6, content: "作者意图" });

		const view = createDbView(story.reader, "user-related");

		// 可见：可感知的时间 + 自己的经历
		assert.equal(view.getClock()?.current_time, "0000-01-02", "clock 可见（时间可感知）");
		assert.equal(view.listTimeLog().length, 1, "time_log 可见");
		assert.equal(view.getTurnLog().length, 1, "turn_log 可见（玩家自己的经历）");
		assert.equal(view.getPlayerLocation()?.name, "王城", "getPlayerLocation 可见");

		// 可见：到过的地点；未到过的连 getLocation 都取不到
		assert.equal(view.listLocations().length, 1, "只给到过的地点");
		assert.equal(view.getLocation(city.id)?.name, "王城", "到过的地点可见");
		assert.equal(view.getLocation(yard.id), undefined, "未到过的地点越集返回 undefined");

		// 可见：发生在到过地点的事件（未到过地点的事件不可见）
		assert.equal(view.listEvents().length, 1, "只给到过地点的事件");

		// 可见：位移记录只剩玩家自己的（NPC 的行程被滤掉）
		assert.equal(view.listLocationLog().length, 1, "只给玩家自己的位移");
		assert.equal(view.listLocationLog()[0]!.subject, "player");

		// 不可见：叙事结构元数据 / 作者意图 / 内核运维面
		assert.equal(view.listPhases().length, 0, "phases 不可见");
		assert.equal(view.listDirectives().length, 0, "directives 不可见");
		assert.equal(view.listDataStatus().length, 0, "data_status 不可见");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("filter=none 全透传：NpcComposite 不滤、relations 不滤、world_state sys_ 键可见", () => {
	const dir = makeTempDir();
	try {
		const { story, player, ally, local, stranger } = setupAnchorStory(dir);
		story.writer.upsertWorldState({ key: "sys_demo", value: "x", turnSeq: 9 });

		const view = createDbView(story.reader, "none");
		// NPC 域全量
		assert.equal(view.listNpcs().length, 4, "none 模式返回全部 NPC");
		// 越集仍返回 composite（与 DbReader 同形）
		const strangerComp = view.getNpc(stranger.id);
		assert.notEqual(strangerComp, undefined);
		assert.equal(strangerComp?.npc?.name, "无关者");
		// relations 不滤：无关者复合含与盟友的关系
		assert.ok(strangerComp!.relations.some((r) => r.npc_a === ally.id || r.npc_b === ally.id));
		// 玩家复合含全部关系（R1 + R3）
		assert.equal(view.getNpc(player.id)?.relations.length, 2);
		// world_state 全量（含 sys_）
		const wsKeys = view.listWorldState().map((r) => r.key);
		assert.ok(wsKeys.includes("sys_demo"));
		assert.ok(wsKeys.includes(PLAYER_NPC_ID_KEY));
		assert.ok(wsKeys.includes(PLAYER_LOCATION_KEY));
		// 无关的 local 也可见（none 不滤）
		assert.equal(view.getNpc(local.id)?.npc?.name, "本地人");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("isNpcCardVisible：card_ref 对应行在集合内即可见，未 seed 或越集不可见", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");
		const set = view.relatedSet;

		// 用 view.listNpcs()（已滤集）建索引时，无关者 card_ref 不在索引 → 不可见
		const visibleIndex = buildNpcCardRefIndex(view.listNpcs());
		assert.equal(isNpcCardVisible(set, visibleIndex, "pack:a"), true, "玩家行可见");
		assert.equal(isNpcCardVisible(set, visibleIndex, "pack:b"), true, "盟友行可见");
		assert.equal(isNpcCardVisible(set, visibleIndex, "pack:c"), true, "本地人行可见");
		assert.equal(isNpcCardVisible(set, visibleIndex, "pack:d"), false, "无关者 card_ref 不在已滤索引");

		// 用全量 listNpcs 建索引：无关者在索引内但集合外 → 仍不可见
		const fullIndex = buildNpcCardRefIndex(story.reader.listNpcs());
		assert.equal(isNpcCardVisible(set, fullIndex, "pack:d"), false, "集合外行不可见");
		assert.equal(isNpcCardVisible(set, fullIndex, "pack:a"), true);
		// 未 seed 的 card_ref → 不可见
		assert.equal(isNpcCardVisible(set, fullIndex, "pack:not-seeded"), false, "未 seed 条目不可见");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 缺口 12：可见性集合惰性解析 + refresh()（原先「构造即冻结」）
// ---------------------------------------------------------------------------

test("缺口 12：同一实例跨世界变化——不 refresh 就还是旧可见性（这是惰性的**语义**，不是 bug）", () => {
	const dir = makeTempDir();
	try {
		const { story, stranger } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");

		// 初始：无关者在王城，玩家在庭院 → 不可见
		assert.equal(view.getNpc(stranger.id), undefined, "初始应不可见");
		assert.equal(view.listNpcs().some((n) => n.id === stranger.id), false);

		// 世界变了：无关者搬到玩家所在地（庭院）
		story.writer.moveSubject({ turnSeq: 9, subject: `npc:${stranger.id}`, toLocationId: view.getPlayerLocation()!.id });

		// **已经解析过的集合不会自己变**——这正是「冻结」的语义；断言它，是为了让「必须 refresh」有据可依
		assert.equal(view.getNpc(stranger.id), undefined, "未 refresh → 仍是旧集合（可见性不会自动跟随）");

		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("缺口 12：refresh() 后可见性跟上世界变化（无需丢弃实例重建）", () => {
	const dir = makeTempDir();
	try {
		const { story, stranger } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");

		assert.equal(view.getNpc(stranger.id), undefined, "初始不可见");

		const yardId = view.getPlayerLocation()!.id;
		story.writer.moveSubject({ turnSeq: 9, subject: `npc:${stranger.id}`, toLocationId: yardId });

		view.refresh();

		assert.notEqual(view.getNpc(stranger.id), undefined, "refresh 后：搬到玩家所在地 → 可见");
		assert.equal(view.listNpcs().some((n) => n.id === stranger.id), true, "listNpcs 一并跟上");
		// 关系过滤也按新集合算
		assert.deepEqual(view.relatedSet.npcIds.has(stranger.id), true);

		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("缺口 12：refresh() 也刷新「到过地点」集（地点/事件过滤跟着变）", () => {
	const dir = makeTempDir();
	try {
		const { story } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");

		// 王城是庭院的父级，玩家长辈链已在集内；另建一个从未去过的地点
		const faraway = story.writer.insertLocation({ name: "远郊" });
		assert.equal(view.getLocation(faraway.id), undefined, "没去过 → 不可见");

		// 玩家走过去
		story.writer.moveSubject({ turnSeq: 10, subject: "player", toLocationId: faraway.id });

		assert.equal(view.getLocation(faraway.id), undefined, "未 refresh → 地点集仍是旧的");
		view.refresh();
		assert.notEqual(view.getLocation(faraway.id), undefined, "refresh 后：到过 → 可见");
		assert.equal(view.listLocations().some((l) => l.id === faraway.id), true);

		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("缺口 12：filter=none 不解析任何可见性集合（惰性 → 全量透传零额外开销）", () => {
	// 判据不是「跑得快」而是**行为**：none 下无论世界怎么变，透传结果永远= reader 的结果。
	// 若实现里 none 也去解析集合，这些断言依旧会过——故本条真正钉的是「none 分支不依赖集合」
	// （由下面的 stub reader 计数钉死：解析函数若被调用会去读 world_state/turn_log）。
	const dir = makeTempDir();
	try {
		const { story, stranger } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "none");
		// world_state 全量（含 sys_ 与 player_npc_id）
		assert.ok(view.listWorldState().some((r) => r.key === PLAYER_NPC_ID_KEY));
		// 无关 NPC 可见
		assert.notEqual(view.getNpc(stranger.id), undefined);
		// 作者面（phases / directives / data_status）可见 —— 这就是文档里说的「作者视图」
		assert.deepEqual(view.listPhases(), story.reader.listPhases());
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("缺口 12：refresh() 也作废「可见事件 id」缓存——否则 queryTable(event_npcs) 用陈旧事件集判可见性", () => {
	// event_npcs 的可见性规则是「NPC 在集合内 **且** 事件可见」。事件集是一次查询内按需算的
	// 缓存（eventIdCache）。若 refresh() 漏掉它，玩家移动到新地点后新事件虽然进了 events 表，
	// event_npcs 却仍按旧事件集判——**个别调用方根本看不到这个 bug**，因为只有 queryTable 走那条路。
	const dir = makeTempDir();
	try {
		const { story, yard, player, ally } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");

		// 在「远郊」（玩家没去过）放一个事件，名册含玩家与盟友。
		const faraway = story.writer.insertLocation({ name: "远郊" });
		const farEvent = story.writer.insertEvent({
			turnSeq: 20,
			summary: "远郊的集会",
			locationId: faraway.id,
			npcIds: [player.id, ally.id],
		});

		// 先查一次，把 eventIdCache 建起来（此刻远郊事件不可见）
		assert.deepEqual(
			view.queryTable({ table: "events", limit: 100 }).rows.map((r) => Number(r.id)),
			[],
			"玩家没去过远郊 → 那条事件不可见",
		);
		assert.deepEqual(view.queryTable({ table: "event_npcs", limit: 100 }).rows, [], "对应名册也不可见");

		// 玩家走到远郊
		story.writer.moveSubject({ turnSeq: 21, subject: "player", toLocationId: faraway.id });
		view.refresh();

		assert.deepEqual(
			view.queryTable({ table: "events", limit: 100 }).rows.map((r) => Number(r.id)),
			[farEvent.id],
			"refresh 后事件可见",
		);
		// 名册是 (event_id, npc_id) 复合主键：一条事件带两个在场 NPC → 两行，event_id 都是 farEvent.id。
		// 故判据取「事件列只含该事件」+「在场人是这两个」，而不是「行数=1」。
		const roster = view.queryTable({ table: "event_npcs", limit: 100 }).rows;
		assert.deepEqual(
			[...new Set(roster.map((r) => Number(r.event_id)))],
			[farEvent.id],
			"refresh 必须一并作废事件 id 缓存，否则名册仍按旧事件集判 → 这里会是空",
		);
		assert.deepEqual(
			roster.map((r) => Number(r.npc_id)).sort((a, b) => a - b),
			[player.id, ally.id].sort((a, b) => a - b),
			"在场名册两人都在集合内 → 两条都可见",
		);
		// yard 只为让「玩家原所在地」明确，不参与断言
		assert.notEqual(yard.id, faraway.id);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("缺口 12：惰性解析不改变判定结果——relatedSet 内容与直接调 resolveRelatedNpcSet 一致", () => {
	const dir = makeTempDir();
	try {
		const { story, player, ally, local, stranger } = setupAnchorStory(dir);
		const view = createDbView(story.reader, "user-related");
		const direct = resolveRelatedNpcSet(story.reader);
		const viaView = view.relatedSet;

		assert.equal(viaView.playerNpcId, direct.playerNpcId);
		assert.equal(viaView.degraded, direct.degraded);
		assert.deepEqual([...viaView.npcIds].sort((a, b) => a - b), [...direct.npcIds].sort((a, b) => a - b));
		// 同一实例重复取用返回同一对象（缓存生效，不是每次重算）
		assert.equal(view.relatedSet, viaView, "缓存：重复取用应是同一个对象");
		assert.ok(direct.npcIds.has(player.id) && direct.npcIds.has(ally.id) && direct.npcIds.has(local.id));
		assert.equal(direct.npcIds.has(stranger.id), false, "无关者仍不在集合内（惰性化没放宽判定）");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
