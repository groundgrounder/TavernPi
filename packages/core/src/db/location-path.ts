// 位置路径（location-path）：位置读取侧的统一表示与渲染。
// 「位置的真身是路径，id 只是存储层的指针」——本模块把这条原则做成基础设施：
//   - LocationPath：从根到叶的完整链（id + 名 + 地理层级标签 kind）；
//   - buildLocationPath：由 locations 全量表构建路径（叶不存在 / 链断裂 / 环 → undefined）；
//   - renderLocationPath：路径渲染（`大雍（国）> 王城（城）> 茶棚`）；
//   - renderLocationSlice：焦点切片渲染（地图根 + 焦点路径 + 同层 + 下级逐层）——
//     「agent 按叙事粒度选择地图层级」的落点：叙事焦点在哪一层，地图就取哪一层。
// 本模块是 db 层纯函数（无 DB 依赖），供 db-summary / db 工具 / 其他消费点共用
// （此前 renderLocationPath 在 tools.ts 与 db-summary.ts 各复制一份——收口于此）。

import type { LocationRow } from "./types.ts";

/** 位置路径节点：id + 名 + 地理层级标签 + 世界坐标（原始列值，可空）。 */
export interface LocationPathNode {
	id: number;
	name: string;
	/** 地理层级标签（如 国/城/区/别墅/房间）；未标注为 null。 */
	kind: string | null;
	/** 世界坐标（单位步；x 东正 / y 北正 / z 上正）；未标注为 null（z null 视为 0）。 */
	x: number | null;
	y: number | null;
	z: number | null;
}

/** 位置路径：从根到叶的完整链。 */
export type LocationPath = LocationPathNode[];

/** 世界坐标点（单位：步，1 单位 = 成人一步；x 东正 / y 北正 / z 上正）。 */
export interface LocationPoint {
	x: number;
	y: number;
	z: number;
}

/** 从行/节点取坐标点；x/y 缺任一返回 undefined（z 缺视为 0）。 */
export function locationPointOf(node: { x: number | null; y: number | null; z: number | null }): LocationPoint | undefined {
	if (node.x === null || node.y === null) return undefined;
	return { x: node.x, y: node.y, z: node.z ?? 0 };
}

/** 坐标渲染：`(200,-150)`；z≠0 时 `(200,-150,3)`。 */
export function renderLocationPoint(point: LocationPoint): string {
	const x = Math.round(point.x);
	const y = Math.round(point.y);
	const z = Math.round(point.z);
	return z === 0 ? `(${x},${y})` : `(${x},${y},${z})`;
}

/** 节点行标签：`#4 茶棚（点） (200,-150)`（坐标未标注则省略）。 */
function nodeLabel(node: LocationRow): string {
	const point = locationPointOf(node);
	const base = `#${node.id} ${renderLocationNode(node)}`;
	return point === undefined ? base : `${base} ${renderLocationPoint(point)}`;
}

/**
 * 由 locations 全量表构建从根到叶的路径。
 * 叶不存在、链断裂（parent_id 指向不存在的行）或存在环时返回 undefined。
 */
export function buildLocationPath(locations: LocationRow[], leafId: number): LocationPath | undefined {
	const byId = new Map<number, LocationRow>();
	for (const loc of locations) byId.set(loc.id, loc);
	const leaf = byId.get(leafId);
	if (leaf === undefined) return undefined;

	const chain: LocationPath = [];
	const seen = new Set<number>();
	let cur: LocationRow = leaf;
	while (true) {
		if (seen.has(cur.id)) return undefined; // 环守卫（parent 链回卷）
		seen.add(cur.id);
		chain.unshift({ id: cur.id, name: cur.name, kind: cur.kind, x: cur.x, y: cur.y, z: cur.z });
		if (cur.parent_id === null) return chain;
		const parent = byId.get(cur.parent_id);
		if (parent === undefined) return undefined; // 链断裂
		cur = parent;
	}
}

/** 节点标签渲染：`茶棚（点）`；kind 为空时即 `茶棚`。 */
export function renderLocationNode(node: { name: string; kind: string | null }): string {
	return node.kind === null || node.kind === "" ? node.name : `${node.name}（${node.kind}）`;
}

export interface RenderLocationPathOptions {
	/** 每节前缀 `#id `（默认 false = 纯名路径）。切片里用 true（id 是可操作引用），展示用 false。 */
	withIds?: boolean;
}

/** 渲染位置路径：`大雍（国）> 王城（城）> 茶棚`；withIds 时 `#1 大雍（国）> #2 王城（城）> #3 茶棚`。 */
export function renderLocationPath(path: LocationPath, options: RenderLocationPathOptions = {}): string {
	return path
		.map((n) => (options.withIds ? `#${n.id} ${renderLocationNode(n)}` : renderLocationNode(n)))
		.join(" > ");
}

export interface LocationSliceOptions {
	/** 从焦点向下展开的层数（默认 1；0 = 只给同层）。 */
	depth?: number;
	/** 焦点标记文字（如 `← 你在这里`）；缺省不标。 */
	mark?: string;
	/** 路径行标签（默认 `位置`）。 */
	pathLabel?: string;
}

/** 节点行渲染：`#4 茶棚（点） (200,-150)`（可带标记；坐标未标注则省略）。 */
function sliceNodeLine(node: LocationRow, mark?: string): string {
	const label = nodeLabel(node);
	return mark === undefined ? label : `${label} ${mark}`;
}

/**
 * 世界概览（供玩家未定位 / 开局时建立世界感）：每个根一行
 * `#1 大雍（国）: #2 王城（城）· #3 临江城（城）`（根无子节点时只给根本身）。
 */
export function renderLocationOverview(locations: LocationRow[]): string[] {
	const children = new Map<number | null, LocationRow[]>();
	for (const loc of locations) {
		const list = children.get(loc.parent_id) ?? [];
		list.push(loc);
		children.set(loc.parent_id, list);
	}
	const roots = children.get(null) ?? [];
	return roots.map((root) => {
		const label = nodeLabel(root);
		const kids = children.get(root.id) ?? [];
		if (kids.length === 0) return label;
		return `${label}: ${kids.map((k) => nodeLabel(k)).join(" · ")}`;
	});
}

/**
 * 逐层渲染整棵树（全部根，含 id）：首行是根清单，此后每层每行 `父: 孩子 · 孩子`。
 * 用于「查看整个地图」的场合（assist 的 list_locations）；叙事注入走 renderLocationSlice（焦点切片）。
 */
export function renderLocationLevels(locations: LocationRow[]): string[] {
	const children = new Map<number | null, LocationRow[]>();
	for (const loc of locations) {
		const list = children.get(loc.parent_id) ?? [];
		list.push(loc);
		children.set(loc.parent_id, list);
	}
	const lines: string[] = [];
	let level = children.get(null) ?? [];
	if (level.length > 0) {
		lines.push(level.map((r) => nodeLabel(r)).join(" · "));
	}
	while (level.length > 0) {
		const next: LocationRow[] = [];
		const rows: string[] = [];
		for (const node of level) {
			const kids = children.get(node.id) ?? [];
			if (kids.length === 0) continue;
			rows.push(`${renderLocationNode(node)}: ${kids.map((k) => nodeLabel(k)).join(" · ")}`);
			next.push(...kids);
		}
		if (rows.length === 0) break;
		lines.push(...rows);
		level = next;
	}
	return lines;
}

// ---------------------------------------------------------------------------
// 相对空间关系（LCA 推导，零存储）
// ---------------------------------------------------------------------------

/**
 * 两地的相对空间关系（由层级路径推导——「距离」在叙事里折算为时间与层级，
 * 不存米制坐标；见「位置 = 路径」）。视点：以 pathA 为参照、pathB 为对方。
 * 判据是最近公共祖先（LCA）：共同祖先越深（离叶越近），两地越近；无共同祖先 = 不同地图。
 * 若两地都标注了坐标，附精确距离（步）与平面八方位。
 */
export interface SpatialRelation {
	/** same=同一地点；ancestor/descendant=一方路径是另一方的真前缀（嵌套上下位）；
	 *  cousin=互不包含但有共同祖先（兄弟/表亲）；unrelated=不同地图（无共同祖先）。 */
	kind: "same" | "ancestor" | "descendant" | "cousin" | "unrelated";
	/** 最近公共祖先（unrelated 时为 null）。 */
	lca: LocationPathNode | null;
	/** 树距离：层级树上要走的边数（same=0；unrelated=null）。 */
	treeSteps: number | null;
	/** 坐标距离（步，三维欧氏）+ 平面八方位；任一方未标注坐标、或同一地点时为 null。 */
	distance: { steps: number; bearing: string } | null;
	/** 可读短语（与「与你」拼接使用）：`在一起` / `同在「东市（片）」` / `不同地图`。 */
	text: string;
}

/** 平面八方位（从北顺时针；dx 东正、dy 北正）。 */
const BEARING_NAMES = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"] as const;

function bearingOf(dx: number, dy: number): string {
	const index = Math.round(Math.atan2(dx, dy) / (Math.PI / 4));
	return BEARING_NAMES[((index % 8) + 8) % 8]!;
}

/** 两路径末节的坐标距离（步）+ 八方位；任一方未标注坐标 → null。 */
function pathDistance(pathA: LocationPath, pathB: LocationPath): SpatialRelation["distance"] {
	const a = locationPointOf(pathA[pathA.length - 1]!);
	const b = locationPointOf(pathB[pathB.length - 1]!);
	if (a === undefined || b === undefined) return null;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	return { steps: Math.round(Math.hypot(dx, dy, b.z - a.z)), bearing: bearingOf(dx, dy) };
}

/**
 * 推导两地的相对空间关系。
 * 空路径视为「无位置」→ unrelated（调用方应先判未定位，不该传空）。
 */
export function describeSpatialRelation(pathA: LocationPath, pathB: LocationPath): SpatialRelation {
	if (pathA.length === 0 || pathB.length === 0) {
		return { kind: "unrelated", lca: null, treeSteps: null, distance: null, text: "不同地图" };
	}
	// 最长公共前缀（按 id 比较）
	let i = 0;
	while (i < pathA.length && i < pathB.length && pathA[i]!.id === pathB[i]!.id) i++;
	if (i === 0) {
		return { kind: "unrelated", lca: null, treeSteps: null, distance: pathDistance(pathA, pathB), text: "不同地图" };
	}
	const lca = pathA[i - 1]!;
	const treeSteps = pathA.length - i + (pathB.length - i);
	if (treeSteps === 0) {
		return { kind: "same", lca, treeSteps, distance: null, text: "在一起" };
	}
	const distance = pathDistance(pathA, pathB);
	const text = `同在「${renderLocationNode(lca)}」`;
	if (i === pathA.length) return { kind: "descendant", lca, treeSteps, distance, text }; // B 在 A 之下
	if (i === pathB.length) return { kind: "ancestor", lca, treeSteps, distance, text }; // B 在 A 之上
	return { kind: "cousin", lca, treeSteps, distance, text };
}

/**
 * 渲染焦点切片（行数组，供 db-summary 与 db 工具共用）。
 * 组成：
 *   1) 地图根清单行（仅当世界有多个根时给——单根世界的路径已含根）；
 *   2) 焦点路径行（`位置: 大雍（国）> 王城（城）> 茶棚（点）`）；
 *   3) 同层行（焦点父节点的全部子节点，焦点带标记）；
 *   4) 下级逐层行（从焦点向下 depth 层，每层按 `父: 孩子…` 分组）。
 * 焦点不存在 / 链断裂时返回空数组（调用方按「未定位」处理）。
 */
export function renderLocationSlice(
	locations: LocationRow[],
	focusId: number,
	options: LocationSliceOptions = {},
): string[] {
	const depth = options.depth ?? 1;
	const byId = new Map<number, LocationRow>();
	const children = new Map<number | null, LocationRow[]>();
	for (const loc of locations) {
		byId.set(loc.id, loc);
		const list = children.get(loc.parent_id) ?? [];
		list.push(loc);
		children.set(loc.parent_id, list);
	}

	const focus = byId.get(focusId);
	if (focus === undefined) return [];
	const path = buildLocationPath(locations, focusId);
	if (path === undefined) return [];

	const lines: string[] = [];

	// 1) 地图根清单（多根才给；单根世界路径已含根）
	const roots = children.get(null) ?? [];
	if (roots.length >= 2) {
		lines.push(`地图: ${roots.map((r) => nodeLabel(r)).join(" · ")}`);
	}

	// 2) 焦点路径（带 id：路径上的每一节都是可操作引用）
	lines.push(`${options.pathLabel ?? "位置"}: ${renderLocationPath(path, { withIds: true })}`);

	// 3) 同层（焦点父节点的全部子节点）
	if (focus.parent_id !== null) {
		const parent = byId.get(focus.parent_id);
		const siblings = children.get(focus.parent_id) ?? [];
		if (parent !== undefined && siblings.length > 0) {
			const items = siblings.map((s) => sliceNodeLine(s, s.id === focusId ? options.mark : undefined));
			lines.push(`${renderLocationNode(parent)}: ${items.join(" · ")}`);
		}
	}

	// 4) 下级逐层（从焦点向下 depth 层）
	let currentLevel: LocationRow[] = [focus];
	for (let d = 0; d < depth; d++) {
		const nextLevel: LocationRow[] = [];
		const rows: string[] = [];
		for (const node of currentLevel) {
			const kids = children.get(node.id) ?? [];
			if (kids.length === 0) continue;
			rows.push(`${renderLocationNode(node)}: ${kids.map((k) => sliceNodeLine(k)).join(" · ")}`);
			nextLevel.push(...kids);
		}
		if (rows.length === 0) break;
		lines.push(...rows);
		currentLevel = nextLevel;
	}

	return lines;
}
