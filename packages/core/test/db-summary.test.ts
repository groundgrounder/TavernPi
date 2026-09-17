// db-summary 渲染单测：玩家位置切片（路径带 id + 同层 + 下级）、NPC 位置走路径与相对空间关系、
// 未定位时的世界概览。覆盖「agent 按叙事粒度选择地图层级」的注入面（不再全量铺地点树）。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb } from "../src/db/story-db.ts";
import { PLAYER_NPC_ID_KEY } from "../src/db/view.ts";
import { renderDbSummary } from "../src/pipeline/db-summary.ts";

test("renderDbSummary：玩家位置走焦点切片（路径带 id + 同层标记 + 下级），NPC 位置走路径与相对关系", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const realm = story.writer.insertLocation({ name: "大雍", kind: "国" });
		const city = story.writer.insertLocation({ name: "王城", parentId: realm.id, kind: "城" });
		const east = story.writer.insertLocation({ name: "东市", parentId: city.id, kind: "片" });
		// 茶棚/布庄带坐标：柳先生（布庄）应获得「相距约 100 步 · 南方」的坐标距离后缀
		const teahouse = story.writer.insertLocation({ name: "茶棚", parentId: east.id, kind: "点", x: 0, y: 100 });
		const clothShop = story.writer.insertLocation({ name: "布庄", parentId: east.id, kind: "点", x: 0, y: 0 });
		story.writer.insertLocation({ name: "灶前", parentId: teahouse.id });
		const npc = story.writer.insertNpc({ name: "老渡" });
		const cousinNpc = story.writer.insertNpc({ name: "柳先生" });
		const hero = story.writer.insertNpc({ name: "无名客" });
		story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: teahouse.id });
		story.writer.moveSubject({ turnSeq: 1, subject: `npc:${npc.id}`, toLocationId: city.id });
		story.writer.moveSubject({ turnSeq: 1, subject: `npc:${cousinNpc.id}`, toLocationId: clothShop.id });
		// 玩家锚定行（player_npc_id）：与玩家同处，但自身不给关系描述
		story.writer.moveSubject({ turnSeq: 1, subject: `npc:${hero.id}`, toLocationId: teahouse.id });
		story.writer.upsertWorldState({ key: PLAYER_NPC_ID_KEY, value: String(hero.id), turnSeq: 1 });

		const text = renderDbSummary(story);
		const lines = text.split("\n");

		// 玩家位置：完整路径（每节带 id）
		assert.ok(lines.includes("玩家位置: #1 大雍（国） > #2 王城（城） > #3 东市（片） > #4 茶棚（点）"), text);
		// 同层行：东市的全部孩子，焦点带标记（坐标随行显示）
		assert.ok(lines.includes("东市（片）: #4 茶棚（点） (0,100) ← 你在这里 · #5 布庄（点） (0,0)"), text);
		// 下级行：茶棚内部
		assert.ok(lines.includes("茶棚（点）: #6 灶前"), text);
		// NPC 位置：完整路径（不带 id，可读优先）
		assert.ok(text.includes("位置 大雍（国） > 王城（城）"), text);
		// 相对空间关系：嵌套上下位（老渡在王城=玩家路径的祖先）不重复、同源分叉（柳先生在布庄）给显式短语
		const laoDuLine = lines.find((l) => l.includes("老渡"));
		assert.ok(laoDuLine, text);
		assert.ok(!laoDuLine.includes("与你"), "嵌套上下位不给关系后缀（路径已表达）");
		const liuLine = lines.find((l) => l.includes("柳先生"));
		assert.ok(liuLine?.includes("（与你同在「东市（片）」，相距约 100 步 · 南方）"), text);
		// 玩家锚定行自身不给关系描述
		const heroLine = lines.find((l) => l.includes("无名客"));
		assert.ok(heroLine, text);
		assert.ok(!heroLine.includes("与你"), "玩家角色自身行不给关系描述");
		// 全量地点树不再注入（切片取代）
		assert.ok(!text.includes("地点树:"), "不应再出现全量地点树");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("renderDbSummary：玩家未定位时给世界概览（根 + 一层），并提示未定位（不推导相对关系）", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const realm = story.writer.insertLocation({ name: "大雍", kind: "国" });
		story.writer.insertLocation({ name: "王城", parentId: realm.id, kind: "城" });
		story.writer.insertLocation({ name: "临江城", parentId: realm.id, kind: "城" });
		const npc = story.writer.insertNpc({ name: "路人" });
		story.writer.moveSubject({ turnSeq: 1, subject: `npc:${npc.id}`, toLocationId: realm.id });

		const text = renderDbSummary(story);
		assert.ok(text.includes("玩家位置: (玩家尚未定位)"), text);
		assert.ok(text.includes("世界地图:"), text);
		assert.ok(text.includes("#1 大雍（国）: #2 王城（城） · #3 临江城（城）"), text);
		assert.ok(!text.includes("与你"), "玩家未定位时不给相对空间关系");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("renderDbSummary：事件带故事时间（时间线锚点）；NPC 记忆按时间精度衰减（重大记忆作节点不衰减）", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		// 时间线：turn1 +10 天、turn2 +40 天、turn3 +0.5 天（记忆记于 turn1，距今 40.5 天 → 月级）
		story.writer.advanceClock({ turnSeq: 1, toTime: "0000-01-10", spanNote: "十日", spanDays: 10 });
		story.writer.advanceClock({ turnSeq: 2, toTime: "0000-02-20", spanNote: "四十日", spanDays: 40 });
		story.writer.advanceClock({ turnSeq: 3, toTime: "0000-02-20", spanNote: "半日", spanDays: 0.5 });
		story.writer.insertEvent({ turnSeq: 1, summary: "城门洞开", storyTime: "0000-01-05" });

		const npc = story.writer.insertNpc({ name: "艾琳" });
		story.writer.insertNpcMemory({ npcId: npc.id, turnSeq: 1, kind: "event", content: "普通往事", salience: 0.3 });
		story.writer.insertNpcMemory({ npcId: npc.id, turnSeq: 1, kind: "event", content: "重大往事", salience: 0.9 });

		const text = renderDbSummary(story);
		// 事件与时间耦合：story_time 显式给出
		assert.ok(text.includes("- [0000-01-05] turn1 城门洞开"), text);
		// 普通记忆：距今 40.5 天 → 月级（当前年 0000 → 「今年一月」）
		assert.ok(text.includes("普通往事（今年一月）"), text);
		// 重大记忆：salience 0.9 ≥ 阈值 → 节点，保留完整时间（turn1 结束时钟值 0000-01-10）
		assert.ok(text.includes("重大往事（0000-01-10）"), text);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("renderDbSummary：无地点时不给地点段（不报错）", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const text = renderDbSummary(story);
		assert.ok(text.includes("玩家位置: (玩家尚未定位)"), text);
		assert.ok(!text.includes("世界地图:"), "无地点不给世界地图行");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
