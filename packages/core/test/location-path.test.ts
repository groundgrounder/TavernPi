// location-path 单测：位置路径构建/渲染 + 焦点切片渲染（纯函数，不碰 DB）。
// 覆盖「地理层级嵌套 + 按叙事粒度取视图」的核心语义：路径带层级标签、切片 = 路径 + 同层 + 下级。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildLocationPath,
	describeSpatialRelation,
	renderLocationLevels,
	renderLocationNode,
	renderLocationOverview,
	renderLocationPath,
	renderLocationPoint,
	renderLocationSlice,
	type LocationPath,
} from "../src/db/location-path.ts";
import type { LocationRow } from "../src/db/types.ts";

/** 构造地点行（parent_name 由调用方按需给；本文件只关心结构与渲染）。 */
function loc(
	id: number,
	name: string,
	parentId: number | null,
	kind: string | null = null,
	point: { x: number; y: number; z?: number } | null = null,
): LocationRow {
	return {
		id,
		name,
		parent_id: parentId,
		detail: null,
		kind,
		x: point?.x ?? null,
		y: point?.y ?? null,
		z: point?.z ?? null,
		parent_name: null,
	};
}

/**
 * 测试用森林（模拟「国家 ⊃ 城市 ⊃ 片区 ⊃ 地点 ⊃ 位点」五级嵌套）：
 *   大雍（国）#1
 *   ├─ 王城（城）#2
 *   │  ├─ 东市（片）#4
 *   │  │  ├─ 茶棚（点）#6
 *   │  │  │  ├─ 灶前 #9（无层级标签）
 *   │  │  │  └─ 靠窗的桌 #10
 *   │  │  └─ 布庄（点）#7
 *   │  └─ 西市（片）#5
 *   └─ 临江城（城）#3
 *   大漠（地域）#11（第二个根）
 */
const WORLD: LocationRow[] = [
	loc(1, "大雍", null, "国"),
	loc(2, "王城", 1, "城"),
	loc(3, "临江城", 1, "城"),
	loc(4, "东市", 2, "片"),
	loc(5, "西市", 2, "片"),
	loc(6, "茶棚", 4, "点"),
	loc(7, "布庄", 4, "点"),
	loc(9, "灶前", 6),
	loc(10, "靠窗的桌", 6),
	loc(11, "大漠", null, "地域"),
];

// ---------------------------------------------------------------------------
// buildLocationPath
// ---------------------------------------------------------------------------

test("buildLocationPath：从叶回溯到根，每节带 id/名/层级标签", () => {
	const path = buildLocationPath(WORLD, 9);
	assert.deepEqual(
		path?.map((n) => [n.id, n.name, n.kind]),
		[
			[1, "大雍", "国"],
			[2, "王城", "城"],
			[4, "东市", "片"],
			[6, "茶棚", "点"],
			[9, "灶前", null],
		],
	);
});

test("buildLocationPath：叶不存在 / 链断裂 / 环 → undefined", () => {
	assert.equal(buildLocationPath(WORLD, 999), undefined, "叶不存在");
	assert.equal(buildLocationPath([loc(1, "孤儿", 42)], 1), undefined, "链断裂（父行不存在）");
	const cyclic = [loc(1, "A", 2), loc(2, "B", 1)];
	assert.equal(buildLocationPath(cyclic, 1), undefined, "环");
});

// ---------------------------------------------------------------------------
// renderLocationPath / renderLocationNode
// ---------------------------------------------------------------------------

test("renderLocationPath：默认纯名路径（带层级标签），withIds 时每节带 id", () => {
	const path = buildLocationPath(WORLD, 6);
	assert.ok(path);
	assert.equal(renderLocationPath(path), "大雍（国） > 王城（城） > 东市（片） > 茶棚（点）");
	assert.equal(renderLocationPath(path, { withIds: true }), "#1 大雍（国） > #2 王城（城） > #4 东市（片） > #6 茶棚（点）");
});

test("renderLocationNode：无层级标签时省略括号", () => {
	assert.equal(renderLocationNode({ name: "灶前", kind: null }), "灶前");
	assert.equal(renderLocationNode({ name: "灶前", kind: "" }), "灶前");
	assert.equal(renderLocationNode({ name: "茶棚", kind: "点" }), "茶棚（点）");
});

// ---------------------------------------------------------------------------
// renderLocationSlice（焦点切片）
// ---------------------------------------------------------------------------

test("renderLocationSlice：焦点在茶棚 → 路径 + 同层（东市的孩子）+ 下级（茶棚的孩子）", () => {
	const lines = renderLocationSlice(WORLD, 6, { mark: "← 你在这里" });
	assert.deepEqual(lines, [
		"地图: #1 大雍（国） · #11 大漠（地域）",
		"位置: #1 大雍（国） > #2 王城（城） > #4 东市（片） > #6 茶棚（点）",
		"东市（片）: #6 茶棚（点） ← 你在这里 · #7 布庄（点）",
		"茶棚（点）: #9 灶前 · #10 靠窗的桌",
	]);
});

test("renderLocationSlice：多根时首行给地图根清单（单根不给）", () => {
	const lines = renderLocationSlice(WORLD, 6);
	assert.equal(lines[0], "地图: #1 大雍（国） · #11 大漠（地域）");

	const singleRoot = WORLD.filter((l) => l.id !== 11);
	const lines2 = renderLocationSlice(singleRoot, 6);
	assert.ok(!lines2[0]?.startsWith("地图:"), "单根世界不给地图行");
});

test("renderLocationSlice：depth=0 只看同层（不给下级）", () => {
	const lines = renderLocationSlice(WORLD, 6, { depth: 0 });
	assert.deepEqual(lines, [
		"地图: #1 大雍（国） · #11 大漠（地域）",
		"位置: #1 大雍（国） > #2 王城（城） > #4 东市（片） > #6 茶棚（点）",
		"东市（片）: #6 茶棚（点） · #7 布庄（点）",
	]);
});

test("renderLocationSlice：depth=2 逐层展开孩子的孩子", () => {
	const lines = renderLocationSlice(WORLD, 2, { depth: 2 });
	// 焦点=王城：同层 = 大雍的孩子（王城/临江城）；下级两层 = 东西市 + 茶棚/布庄
	assert.deepEqual(lines, [
		"地图: #1 大雍（国） · #11 大漠（地域）",
		"位置: #1 大雍（国） > #2 王城（城）",
		"大雍（国）: #2 王城（城） · #3 临江城（城）",
		"王城（城）: #4 东市（片） · #5 西市（片）",
		"东市（片）: #6 茶棚（点） · #7 布庄（点）",
	]);
});

test("renderLocationSlice：焦点是根 → 无同层行；焦点不存在 → 空数组", () => {
	const lines = renderLocationSlice(WORLD, 1);
	assert.deepEqual(lines, [
		"地图: #1 大雍（国） · #11 大漠（地域）",
		"位置: #1 大雍（国）",
		"大雍（国）: #2 王城（城） · #3 临江城（城）",
	]);
	assert.deepEqual(renderLocationSlice(WORLD, 999), []);
});

test("renderLocationSlice：叶节点无子 → 无下级行", () => {
	const lines = renderLocationSlice(WORLD, 9);
	assert.deepEqual(lines, [
		"地图: #1 大雍（国） · #11 大漠（地域）",
		"位置: #1 大雍（国） > #2 王城（城） > #4 东市（片） > #6 茶棚（点） > #9 灶前",
		"茶棚（点）: #9 灶前 · #10 靠窗的桌",
	]);
});

// ---------------------------------------------------------------------------
// renderLocationOverview / renderLocationLevels
// ---------------------------------------------------------------------------

test("renderLocationOverview：每个根一行（根 + 一层孩子）", () => {
	assert.deepEqual(renderLocationOverview(WORLD), [
		"#1 大雍（国）: #2 王城（城） · #3 临江城（城）",
		"#11 大漠（地域）",
	]);
});

test("renderLocationLevels：逐层全展开（根行 + 每层「父: 孩子」行）", () => {
	assert.deepEqual(renderLocationLevels(WORLD), [
		"#1 大雍（国） · #11 大漠（地域）",
		"大雍（国）: #2 王城（城） · #3 临江城（城）",
		"王城（城）: #4 东市（片） · #5 西市（片）",
		"东市（片）: #6 茶棚（点） · #7 布庄（点）",
		"茶棚（点）: #9 灶前 · #10 靠窗的桌",
	]);
});

test("renderLocationLevels：空表 → 空数组", () => {
	assert.deepEqual(renderLocationLevels([]), []);
	assert.deepEqual(renderLocationOverview([]), []);
});

// ---------------------------------------------------------------------------
// describeSpatialRelation（LCA 推导相对空间关系 + 坐标距离方位）
// ---------------------------------------------------------------------------

/**
 * 带坐标的森林（结构同 WORLD；坐标用于距离/方位与坐标渲染断言）。
 * 数字设计成可手算：茶棚(100,200) → 布庄(100,100) 正南 100 步；→ 灶前(140,240) 东北 √3200≈57；
 * → 西市(-100,300) 西北 √50000≈224；临江城/靠窗的桌不标坐标（缺坐标 → distance=null）。
 */
const GEO_WORLD: LocationRow[] = [
	loc(1, "大雍", null, "国", { x: 0, y: 0 }),
	loc(2, "王城", 1, "城", { x: 0, y: 300 }),
	loc(3, "临江城", 1, "城"),
	loc(4, "东市", 2, "片", { x: 100, y: 300 }),
	loc(5, "西市", 2, "片", { x: -100, y: 300 }),
	loc(6, "茶棚", 4, "点", { x: 100, y: 200 }),
	loc(7, "布庄", 4, "点", { x: 100, y: 100 }),
	loc(9, "灶前", 6, null, { x: 140, y: 240 }),
	loc(10, "靠窗的桌", 6),
	loc(11, "大漠", null, "地域", { x: 5000, y: -3000 }),
];

/** 取路径（测试便捷；断言存在）。 */
function pathOf(id: number, world: LocationRow[] = WORLD): LocationPath {
	const path = buildLocationPath(world, id);
	assert.ok(path, `路径 #${id} 应存在`);
	return path;
}

test("describeSpatialRelation：同地点 / 兄弟 / 表亲 / 跨国四档（共同祖先越深越近）", () => {
	// 同一地点
	const same = describeSpatialRelation(pathOf(6), pathOf(6));
	assert.equal(same.kind, "same");
	assert.equal(same.treeSteps, 0);
	assert.equal(same.text, "在一起");

	// 兄弟（同父东市）
	const sibling = describeSpatialRelation(pathOf(6), pathOf(7));
	assert.equal(sibling.kind, "cousin");
	assert.equal(sibling.lca?.id, 4);
	assert.equal(sibling.treeSteps, 2);
	assert.equal(sibling.text, "同在「东市（片）」");

	// 表亲（同祖父王城，跨片区）
	const cousin = describeSpatialRelation(pathOf(6), pathOf(5));
	assert.equal(cousin.kind, "cousin");
	assert.equal(cousin.lca?.id, 2);
	assert.equal(cousin.treeSteps, 3);

	// 跨国（同根大雍，跨城市）
	const crossCity = describeSpatialRelation(pathOf(6), pathOf(3));
	assert.equal(crossCity.kind, "cousin");
	assert.equal(crossCity.lca?.id, 1);
	assert.equal(crossCity.treeSteps, 4);
	assert.equal(crossCity.text, "同在「大雍（国）」");
});

test("describeSpatialRelation：嵌套上下位（一方是另一方的真前缀）与异地", () => {
	// 对方在上（王城是茶棚的祖先）
	const up = describeSpatialRelation(pathOf(6), pathOf(2));
	assert.equal(up.kind, "ancestor");
	assert.equal(up.treeSteps, 2);
	assert.equal(up.text, "同在「王城（城）」");

	// 对方在下（灶前是茶棚的子）
	const down = describeSpatialRelation(pathOf(6), pathOf(9));
	assert.equal(down.kind, "descendant");
	assert.equal(down.treeSteps, 1);
	assert.equal(down.text, "同在「茶棚（点）」");

	// 不同根（异地）
	const other = describeSpatialRelation(pathOf(6), pathOf(11));
	assert.equal(other.kind, "unrelated");
	assert.equal(other.lca, null);
	assert.equal(other.treeSteps, null);
	assert.equal(other.text, "不同地图");

	// 空路径视为无位置（防御）
	assert.equal(describeSpatialRelation([], pathOf(6)).kind, "unrelated");
});

test("describeSpatialRelation：双方都有坐标时给距离（步）与八方位；缺坐标/同地点则 null", () => {
	// 轴对齐：茶棚 → 布庄 正南 100 步
	const south = describeSpatialRelation(pathOf(6, GEO_WORLD), pathOf(7, GEO_WORLD));
	assert.equal(south.distance?.steps, 100);
	assert.equal(south.distance?.bearing, "南");

	// 3-4-5 三角：茶棚 → 灶前 东北 √3200 ≈ 57 步
	const ne = describeSpatialRelation(pathOf(6, GEO_WORLD), pathOf(9, GEO_WORLD));
	assert.equal(ne.distance?.steps, 57);
	assert.equal(ne.distance?.bearing, "东北");

	// 跨片区：茶棚 → 西市 西北 √50000 ≈ 224 步
	const nw = describeSpatialRelation(pathOf(6, GEO_WORLD), pathOf(5, GEO_WORLD));
	assert.equal(nw.distance?.steps, 224);
	assert.equal(nw.distance?.bearing, "西北");

	// 跨地图：方向仍可算（距离应远超城内量级）
	const far = describeSpatialRelation(pathOf(6, GEO_WORLD), pathOf(11, GEO_WORLD));
	assert.equal(far.kind, "unrelated");
	assert.equal(far.distance?.bearing, "东南");
	assert.ok((far.distance?.steps ?? 0) > 5000, `跨地图距离应远超城内：${far.distance?.steps}`);

	// 缺坐标（临江城未标注）→ distance = null，层级关系照给
	const noCoord = describeSpatialRelation(pathOf(6, GEO_WORLD), pathOf(3, GEO_WORLD));
	assert.equal(noCoord.kind, "cousin");
	assert.equal(noCoord.distance, null);

	// 同一地点不给距离（0 步无意义）
	const same = describeSpatialRelation(pathOf(6, GEO_WORLD), pathOf(6, GEO_WORLD));
	assert.equal(same.distance, null);
});

test("renderLocationPoint：z=0 省略、z≠0 显示；垂直分量计入距离", () => {
	assert.equal(renderLocationPoint({ x: 200, y: -150, z: 0 }), "(200,-150)");
	assert.equal(renderLocationPoint({ x: 200, y: -150, z: 3 }), "(200,-150,3)");

	// 水平 30、垂直 40 → 50 步（3-4-5）
	const shaft = [loc(20, "井口", null, null, { x: 0, y: 0 })];
	const bottom = [loc(21, "井底", null, null, { x: 30, y: 0, z: 40 })];
	const relation = describeSpatialRelation(buildLocationPath(shaft, 20)!, buildLocationPath(bottom, 21)!);
	assert.equal(relation.distance?.steps, 50);
});

test("坐标渲染：切片/概览行带坐标（未标注则省略），路径节点带坐标", () => {
	// 路径节点带坐标（原始列值）
	const path = buildLocationPath(GEO_WORLD, 6);
	assert.deepEqual(
		path?.map((n) => [n.name, n.x, n.y, n.z]),
		[
			["大雍", 0, 0, null],
			["王城", 0, 300, null],
			["东市", 100, 300, null],
			["茶棚", 100, 200, null],
		],
	);

	const lines = renderLocationSlice(GEO_WORLD, 6, { mark: "← 你在这里" });
	assert.deepEqual(lines, [
		"地图: #1 大雍（国） (0,0) · #11 大漠（地域） (5000,-3000)",
		"位置: #1 大雍（国） > #2 王城（城） > #4 东市（片） > #6 茶棚（点）",
		"东市（片）: #6 茶棚（点） (100,200) ← 你在这里 · #7 布庄（点） (100,100)",
		"茶棚（点）: #9 灶前 (140,240) · #10 靠窗的桌",
	]);
	assert.deepEqual(renderLocationOverview(GEO_WORLD), [
		"#1 大雍（国） (0,0): #2 王城（城） (0,300) · #3 临江城（城）",
		"#11 大漠（地域） (5000,-3000)",
	]);
});
