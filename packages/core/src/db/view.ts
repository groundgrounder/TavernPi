// 冒险模式 DB 视图过滤查询层。只读包装 DbReader，提供两种过滤面：
// - none：全量透传（含 sys_ 前缀内核簿记键），供需要完整数据的调用方；
// - user-related：玩家相关 NPC 域过滤 + world_state 隐藏 sys_ 内核簿记键，供冒险视图 UI/assist。
// 本层不写库，只读；NpcComposite 内 traits/memories/relations 随 NPC 可见性整体过滤。
// 净化规则见 resolveRelatedNpcSet；world_state 隐藏规则见 isSysBookkeepingKey。

import { KERNEL_TABLE_WHITELIST } from "./kernel-tables.ts";
import { paginateRows, type TableInfo, type TablePage, type TableQuery } from "./query.ts";
import type { DbReader, NpcComposite } from "./reader.ts";
import type { LocationPath } from "./location-path.ts";
import type {
	DataStatusRow,
	DirectiveRow,
	EventRow,
	LocationLogRow,
	LocationRow,
	NpcRow,
	PhaseRow,
	StoryClock,
	TimeLogRow,
	TurnLogRow,
	WorldStateRow,
} from "./types.ts";

/** world_state 约定键：玩家 NPC 锚定键。值 = npcs.id 的十进制字符串（内核保留键）。 */
export const PLAYER_NPC_ID_KEY = "player_npc_id";

/**
 * 玩家相关 NPC 集合。
 * playerNpcId：锚定的玩家 npcs 行 id（未设/无效/不存在行为 null）。
 * npcIds：与 user 相关集合 = 玩家自身 ∪ npc_relations 任一侧为 player_npc_id 的对端 ∪
 *         与玩家同地点（npcs.current_location = world_state player_location 解析出的 location_id）的 NPC ∪
 *         叙事文本里被提起过的 NPC（「知道」的近似）。
 * degraded：未设 player_npc_id（或值无效/指向不存在行）。退化为仅同地点 NPC。
 * warning：degraded 且因「值无效/指向不存在行」触发时的说明；正常未设不携带。
 */
export interface RelatedNpcSet {
	playerNpcId: number | null;
	npcIds: ReadonlySet<number>;
	degraded: boolean;
	warning?: string;
}

/**
 * 解析「与 user 相关」NPC 集合（净化规则见 RelatedNpcSet 注释）。
 * player_npc_id 指向不存在的 npcs 行时按未设置处理（degraded=true）并附 warning。
 */
export function resolveRelatedNpcSet(reader: DbReader): RelatedNpcSet {
	let playerNpcId: number | null = null;
	let playerComposite: NpcComposite | undefined;
	let degraded = false;
	let warning: string | undefined;

	const anchor = reader.listWorldState().find((row) => row.key === PLAYER_NPC_ID_KEY);
	if (anchor === undefined) {
		// 未设 player_npc_id → 正常退化（新故事/未锚定玩家）。
		degraded = true;
	} else {
		const id = parseNpcAnchorValue(anchor.value);
		if (id === null) {
			degraded = true;
			// 空串 = 值未设置（按未设置处理，不附误导性「指向不存在行」）；非空但非法（1e2/0x10 等）→ 明确报非法值。
			if (anchor.value !== "") {
				warning = `player_npc_id 值非法（应为非负十进制整数，收到 ${JSON.stringify(anchor.value)}），按未设置处理`;
			}
		} else {
			const composite = reader.getNpc(id);
			if (composite.npc === undefined) {
				degraded = true;
				warning = `player_npc_id=${anchor.value} 指向不存在的 npcs 行，按未设置处理`;
			} else {
				playerNpcId = id;
				playerComposite = composite;
			}
		}
	}

	const npcIds = new Set<number>();
	if (playerNpcId !== null && playerComposite !== undefined) {
		npcIds.add(playerNpcId);
		// npc_relations 任一侧为 player_npc_id → 对端（getNpc 已按 npc_a/id OR npc_b/id 双侧过滤）。
		for (const rel of playerComposite.relations) {
			npcIds.add(rel.npc_a === playerNpcId ? rel.npc_b : rel.npc_a);
		}
	}

	// 与玩家同地点的 NPC（player_location → location_id → npcs.current_location 相等）。
	const playerLoc = reader.getPlayerLocation();
	if (playerLoc !== undefined) {
		for (const npc of reader.listNpcs()) {
			if (npc.current_location === playerLoc.id) {
				npcIds.add(npc.id);
			}
		}
	}

	// 叙事里被提起过的（「知道」的近似，见 resolveMentionedNpcIds）。
	for (const id of resolveMentionedNpcIds(reader)) npcIds.add(id);

	return { playerNpcId, npcIds, degraded, ...(warning === undefined ? {} : { warning }) };
}

/** 解析 player_npc_id 值文本为非负十进制整数字符串（/^\d+$/ 精确匹配）；非法返回 null。
 *  Number() 会宽容解析 "1e2"(→100)/"0x10"(→16)/""(→0)，故须严格匹配；空串按未设置处理（resolveRelatedNpcSet 特判）。 */
function parseNpcAnchorValue(value: string): number | null {
	return /^\d+$/.test(value) ? Number(value) : null;
}

/** world_state 内核簿记键（sys_ 前缀）；约定键 player_location / player_npc_id 保持可见。 */
function isSysBookkeepingKey(key: string): boolean {
	return key.startsWith("sys_");
}

/**
 * 「user 经历过」的地点集合：location_log 中 subject=player 的起点/终点 ∪ 玩家当前所在地
 * ∪ 这些地点的祖先链。
 * 祖先链必须有：地点是包含关系（王城 > 庭院），到过「庭院」的人自然知道「王城」。
 */
function resolveVisitedLocationIds(reader: DbReader): Set<number> {
	const ids = new Set<number>();
	for (const row of reader.listLocationLog(Number.MAX_SAFE_INTEGER)) {
		if (row.subject !== "player") continue;
		if (row.from_location !== null) ids.add(row.from_location);
		if (row.to_location !== null) ids.add(row.to_location);
	}
	const current = reader.getPlayerLocation();
	if (current !== undefined) ids.add(current.id);

	const byId = new Map(reader.listLocations().map((l) => [l.id, l]));
	for (const id of [...ids]) {
		let parent = byId.get(id)?.parent_id ?? null;
		while (parent !== null && !ids.has(parent)) {
			ids.add(parent);
			parent = byId.get(parent)?.parent_id ?? null;
		}
	}
	return ids;
}

/**
 * 「user 知道」的 NPC 追加集：叙事文本（turn_log.narrative_text）里出现过名字的 NPC。
 * 这是「知道」的近似——故事里被提起过的人，玩家就认识；真正的「见过面」没有可靠落库记录。
 * 名字匹配为子串匹配，可能误判（同名/子串），故只用于**放宽**可见性，不用于收紧。
 */
function resolveMentionedNpcIds(reader: DbReader): Set<number> {
	const names = new Map<number, string>();
	for (const npc of reader.listNpcs()) {
		if (npc.name.trim() !== "") names.set(npc.id, npc.name);
	}
	const hit = new Set<number>();
	if (names.size === 0) return hit;
	for (const turn of reader.getTurnLog()) {
		for (const [id, name] of names) {
			if (!hit.has(id) && turn.narrative_text.includes(name)) hit.add(id);
		}
	}
	return hit;
}

/**
 * 冒险视图：与 DbReader 同形的只读方法子集。
 * filter="none" 全量透传（sys_ 键也可见）；filter="user-related" 的总原则是
 * **只有 user 经历过或知道的数据才可见**：
 * - NPC 域（listNpcs / findNpcByCardRef / getNpc）只返回集合内的行（自身 ∪ 有关系 ∪ 同地点 ∪ 叙事提起过）；
 *   越集 id 调 getNpc 返回 undefined（UI 友好）；可见 NPC 的 composite 内 relations 再按「对端也在集合内」过滤。
 * - 地点（listLocations / getLocation）只给 user 到过的（含祖先链）；越集 getLocation 返回 undefined。
 * - 事件（listEvents）只给发生在 user 到过地点的事件。
 * - 位移记录（listLocationLog）只给玩家自己的。
 * - 幕/阶段（listPhases）、剧情大纲指令（listDirectives）、落库状态（listDataStatus）一律不可见
 *   （分别是叙事结构元数据、作者意图、内核运维面）。
 * - world_state 隐藏 sys_ 前缀内核簿记键（player_location / player_npc_id 保持可见）。
 * - clock / time_log / turn_log 全量：时间可感知，叙事与玩家输入本就是 user 自己的经历。
 *
 * 注意：相关集合与到访地点集都是**惰性解析 + 缓存**的（首次访问时算一次，之后复用）。
 * 可见性不会随移动/新叙事自动刷新——需要新鲜可见性的调用方调 `refresh()`，
 * 或（等价地）**每次查询新建视图**。旧版是构造时立即解析并冻结，两者对外行为一致，
 * 但惰性版让「构造了但没查」零开销，也让 `refresh()` 有明确的语义落点。
 */
export class DbView {
	private readonly reader: DbReader;
	private readonly filter: "none" | "user-related";
	/** 惰性缓存：undefined = 尚未解析（或已被 refresh 作废）。 */
	private relatedCache: RelatedNpcSet | undefined;
	/** 「user 经历过」的地点集合（user-related 下用于地点/事件过滤，见 resolveVisitedLocationIds）。 */
	private visitedCache: Set<number> | undefined;

	constructor(reader: DbReader, filter: "none" | "user-related") {
		this.reader = reader;
		this.filter = filter;
	}

	/**
	 * 丢弃已解析的可见性集合，下次访问时重算（缺口 12）。
	 *
	 * 用途：同一个视图实例跨轮复用时（例如 UI 面板持有一个长期视图、或一次会话里连查多张表），
	 * 世界已经变了（玩家移动、新 NPC 落库、新叙事提到新名字），可见性该跟着变。
	 * 旧设计下唯一办法是丢掉整个实例另建一个——能用，但「什么时候该重建」这条规则
	 * 只存在于调用方脑子里，迟早有人漏掉。有 refresh() 之后，规则是「查之前想要新鲜的，就刷一下」。
	 *
	 * 不需要它也能正确：**每次查询新建视图**是等价做法（既有调用方就是这么做的）。
	 * refresh() 是给「想留着实例」的场景省掉重复构造。
	 */
	refresh(): void {
		this.relatedCache = undefined;
		this.visitedCache = undefined;
		this.eventIdCache = undefined;
	}

	/** 相关 NPC 集合（供 UI/assist 消费；"none" 模式下仅信息性）。惰性解析，见类注释。 */
	get relatedSet(): RelatedNpcSet {
		if (this.relatedCache === undefined) this.relatedCache = resolveRelatedNpcSet(this.reader);
		return this.relatedCache;
	}

	/** 「user 到过」的地点集合（惰性解析）。 */
	private get visitedLocationIds(): Set<number> {
		if (this.visitedCache === undefined) this.visitedCache = resolveVisitedLocationIds(this.reader);
		return this.visitedCache;
	}

	private inSet(npcId: number): boolean {
		return this.relatedSet.npcIds.has(npcId);
	}

	// ------------------------------------------------------------------
	// 时间
	// ------------------------------------------------------------------

	getClock(): StoryClock | undefined {
		return this.reader.getClock();
	}

	listTimeLog(options: { fromTurn?: number; toTurn?: number } = {}): TimeLogRow[] {
		return this.reader.listTimeLog(options);
	}

	// ------------------------------------------------------------------
	// 叙事世界
	// ------------------------------------------------------------------

	/** 事件：user-related 下只给「发生在 user 到过的地点」的事件——没去过的地方出什么事，玩家无从得知。 */
	listEvents(options: { fromTurn?: number; toTurn?: number; type?: string } = {}): EventRow[] {
		const rows = this.reader.listEvents(options);
		if (this.filter === "none") return rows;
		return rows.filter((e) => e.location_id !== null && this.visitedLocationIds.has(e.location_id));
	}

	/** 幕/阶段：冒险（user-related）下不暴露叙事结构元数据（含创作目标 goals）。 */
	listPhases(): PhaseRow[] {
		if (this.filter === "user-related") return [];
		return this.reader.listPhases();
	}

	/** world_state：user-related 下隐藏 sys_ 前缀内核簿记键；none 全量。 */
	listWorldState(): WorldStateRow[] {
		if (this.filter === "user-related") {
			return this.reader.listWorldState().filter((row) => !isSysBookkeepingKey(row.key));
		}
		return this.reader.listWorldState();
	}

	// ------------------------------------------------------------------
	// 空间基元
	// ------------------------------------------------------------------

	/** 地点：user-related 下只给「user 到过的」地点（含祖先链）——没去过的地方连名字都不该知道。 */
	listLocations(): LocationRow[] {
		const rows = this.reader.listLocations();
		if (this.filter === "none") return rows;
		return rows.filter((l) => this.visitedLocationIds.has(l.id));
	}

	/** 单地点读：越集（未到过）返回 undefined，与 getNpc 的越集语义一致。 */
	getLocation(id: number): LocationRow | undefined {
		if (this.filter === "user-related" && !this.visitedLocationIds.has(id)) return undefined;
		return this.reader.getLocation(id);
	}

	/** 单地点路径（从根到叶）：越集（未到过）返回 undefined（到过地点的祖先链必在集内，见 resolveVisitedLocationIds）。 */
	getLocationPath(id: number): LocationPath | undefined {
		if (this.filter === "user-related" && !this.visitedLocationIds.has(id)) return undefined;
		return this.reader.getLocationPath(id);
	}

	getPlayerLocation(): LocationRow | undefined {
		return this.reader.getPlayerLocation();
	}

	/** 玩家当前位置的路径（玩家自身位置始终可见，直接透传）。 */
	getPlayerLocationPath(): LocationPath | undefined {
		return this.reader.getPlayerLocationPath();
	}

	/** 位移记录：user-related 下只给玩家自己的——别人的行程是别人的事。 */
	listLocationLog(limit = 20): LocationLogRow[] {
		const rows = this.reader.listLocationLog(limit);
		if (this.filter === "none") return rows;
		return rows.filter((r) => r.subject === "player");
	}

	// ------------------------------------------------------------------
	// NPC 域（user-related 下按集合过滤）
	// ------------------------------------------------------------------

	listNpcs(): NpcRow[] {
		if (this.filter === "user-related") {
			return this.reader.listNpcs().filter((npc) => this.inSet(npc.id));
		}
		return this.reader.listNpcs();
	}

	findNpcByCardRef(cardRef: string): NpcRow | undefined {
		const row = this.reader.findNpcByCardRef(cardRef);
		if (row === undefined) return undefined;
		if (this.filter === "user-related" && !this.inSet(row.id)) return undefined;
		return row;
	}

	/** NPC 复合读：越集 id 返回 undefined（filter="none" 时始终返回 composite）；可见 NPC 的 relations 再按对端过滤。 */
	getNpc(npcId: number): NpcComposite | undefined {
		if (this.filter === "user-related" && !this.inSet(npcId)) return undefined;
		const comp = this.reader.getNpc(npcId);
		if (this.filter === "user-related") {
			// 防御：集合成员均来自既有行，理论上 npc 必存在；仍防行为分叉。
			if (comp.npc === undefined) return undefined;
			return { ...comp, relations: comp.relations.filter((rel) => this.inSet(rel.npc_a) && this.inSet(rel.npc_b)) };
		}
		return comp;
	}

	// ------------------------------------------------------------------
	// 一致性 & 指令
	// ------------------------------------------------------------------

	getTurnLog(turnSeq?: number): TurnLogRow[] {
		return this.reader.getTurnLog(turnSeq);
	}

	/** 剧情大纲指令：作者意图（非世界事实），冒险（user-related）下完全不可见。 */
	listDirectives(status?: "active" | "done" | "revoked"): DirectiveRow[] {
		if (this.filter === "user-related") return [];
		return this.reader.listDirectives(status);
	}

	/** data 落库状态：内核运维面（失败/补齐/重试记录），玩家侧不可见。 */
	listDataStatus(): DataStatusRow[] {
		if (this.filter === "user-related") return [];
		return this.reader.listDataStatus();
	}

	// ------------------------------------------------------------------
	// 通用只读查询（DB 浏览器/包表查看用；形态约束见 query.ts，可见性在本类）
	// ------------------------------------------------------------------

	/**
	 * 表清单。user-related 下**只列内核表**：包自定义表若不可读（见 queryTable），
	 * 列出它们只会让 UI 出现一堆点了报错的项，且表名本身就可能带剧情（如 `xx_secrets`）。
	 * 行数本身不含内容，故随清单给出。
	 */
	listTables(): TableInfo[] {
		const infos = this.reader.listTableInfos();
		if (this.filter === "none") return infos;
		return infos.filter((info) => info.kernel);
	}

	/**
	 * 通用只读查询（分页）。只生成 SELECT，表名/列名须命中真实 metadata（query.ts 的三道闸）。
	 *
	 * 可见性：
	 * - filter="none"（作者视图）：全量透传。
	 * - filter="user-related"（冒险视图）：内核表按**与本类既有方法同一套规则**逐表净化
	 *   （rules 见 visibleRowPredicate；两者一致性由 view-query 测试比对钉住，防规则漂移）；
	 *   **包自定义表一律拒绝**（抛 TableNotVisibleError）——内核无从判断包表的可见性语义
	 *   （表里很可能存着玩家不该知道的事实），默认放行等于给冒险视图开一个后门。
	 *
	 * 过滤发生在分页**之前**（过滤规则是 JS 函数，下推 SQL 等于把规则抄第二遍），
	 * 故 total 是「可见行数」而非表内行数；扫描上限见 query.ts 的 TABLE_QUERY_MAX_SCAN。
	 */
	queryTable(query: TableQuery): TablePage {
		if (this.filter === "none") return this.reader.readTablePage(query);
		if (!KERNEL_TABLE_WHITELIST.includes(query.table)) {
			throw new TableNotVisibleError(query.table);
		}
		// 读全量（equals/orderBy 已在 SQL 层生效），再按可见性过滤，最后分页。
		const read = this.reader.readTable({ table: query.table, ...(query.equals !== undefined ? { equals: query.equals } : {}), ...(query.orderBy !== undefined ? { orderBy: query.orderBy } : {}), ...(query.descending !== undefined ? { descending: query.descending } : {}) });
		const visible = read.rows.filter((row) => this.isRowVisible(query.table, row));
		const page = paginateRows(visible, query);
		return {
			table: query.table,
			columns: read.columns,
			rows: page.rows,
			total: page.total,
			limit: page.limit,
			offset: page.offset,
			truncated: read.truncated,
		};
	}

	/** 冒险视图下某表内的可见事件 id 集（events 的可见性规则见 isRowVisible）。 */
	private visibleEventIds(): Set<number> {
		const ids = new Set<number>();
		for (const row of this.reader.readTable({ table: "events" }).rows) {
			if (this.isRowVisible("events", row)) ids.add(Number(row.id));
		}
		return ids;
	}

	/**
	 * 行可见性谓词（user-related）。与 listNpcs / listEvents / listWorldState 等既有方法同规则：
	 * - npcs 及其从属表（npc_traits / npc_memories / npc_relations / event_npcs）：按相关集合过滤；
	 *   relations 与 event_npcs 要求**两端**都在集合内（与 getNpc 的 relations 过滤一致）。
	 * - events：只给发生在 user 到过地点的事件；event_npcs 再按可见事件收窄。
	 * - locations：只给到过的（含祖先链，由 resolveVisitedLocationIds 展开）。
	 * - location_log：只给 player 自己的。
	 * - world_state：隐藏 sys_ 前缀内核簿记键。
	 * - phases / directives / data_status：叙事结构、作者意图、内核运维面 → 全不可见（空）。
	 * - clock / time_log / turn_log / schema_migrations：时间与自己的经历、以及无内容的迁移簿记 → 全量。
	 */
	private isRowVisible(table: string, row: Record<string, unknown>): boolean {
		switch (table) {
			case "npcs":
				return this.inSet(Number(row.id));
			case "npc_traits":
			case "npc_memories":
				return this.inSet(Number(row.npc_id));
			case "npc_relations":
				return this.inSet(Number(row.npc_a)) && this.inSet(Number(row.npc_b));
			case "events":
				return row.location_id !== null && row.location_id !== undefined && this.visitedLocationIds.has(Number(row.location_id));
			case "event_npcs":
				return this.inSet(Number(row.npc_id)) && this.cachedVisibleEventIds().has(Number(row.event_id));
			case "locations":
				return this.visitedLocationIds.has(Number(row.id));
			case "location_log":
				return row.subject === "player";
			case "world_state":
				return !isSysBookkeepingKey(String(row.key));
			case "phases":
			case "directives":
			case "data_status":
				return false;
			default:
				return true; // clock / time_log / turn_log / schema_migrations
		}
	}

	/** 可见事件 id 集按需算一次（一次查询内多行 event_npcs 共用，避免逐行重算）。 */
	private eventIdCache: Set<number> | undefined;

	private cachedVisibleEventIds(): Set<number> {
		if (this.eventIdCache === undefined) this.eventIdCache = this.visibleEventIds();
		return this.eventIdCache;
	}
}

/** 冒险视图下读包自定义表被拒（内核无从判断其可见性语义，见 DbView.queryTable）。 */
export class TableNotVisibleError extends Error {
	constructor(table: string) {
		super(
			`包自定义表 ${JSON.stringify(table)} 在冒险视图（user-related）下不可读：` +
				"内核无从判断包表的可见性语义（表里可能存着玩家不该知道的事实），默认拒绝。" +
				"作者视图（filter=\"none\"）可读。",
		);
		this.name = "TableNotVisibleError";
	}
}

/** 创建冒险视图。filter="none" 全量透传；filter="user-related" 按规则净化。 */
export function createDbView(reader: DbReader, filter: "none" | "user-related"): DbView {
	return new DbView(reader, filter);
}

/**
 * 依据 npcs 行构建 card_ref → NpcRow 索引（card_ref = 包名:条目id，唯一）。供 isNpcCardVisible 快速查询。
 * 用 listNpcs（或 DbView.listNpcs 等）返回的行集构建；行无 card_ref 则忽略。
 */
export function buildNpcCardRefIndex(npcs: NpcRow[]): ReadonlyMap<string, NpcRow> {
	const index = new Map<string, NpcRow>();
	for (const row of npcs) {
		if (row.card_ref !== null) index.set(row.card_ref, row);
	}
	return index;
}

/**
 * 判定某 character 条目（card_ref = 包名:条目id）是否属于相关 NPC 集合（冒险视图可见）。
 * 规则：cardRef 对应的 npcs 行 id 在 set.npcIds 内即可见；card_ref 未 seed（无对应 npcs 行）
 * 或对应行 id 不在集合内 → 不可见。使用示例：
 *   const set = dbView.relatedSet;
 *   const index = buildNpcCardRefIndex(dbView.listNpcs());
 *   isNpcCardVisible(set, index, "pack:entry-1"); // true/false
 */
export function isNpcCardVisible(
	set: RelatedNpcSet,
	cardRefIndex: ReadonlyMap<string, NpcRow>,
	cardRef: string,
): boolean {
	const row = cardRefIndex.get(cardRef);
	return row !== undefined && set.npcIds.has(row.id);
}
