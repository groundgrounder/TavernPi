// 冒险模式 DB 视图过滤查询层（创作规划 §10.1）。只读包装 DbReader，提供两种过滤面：
// - none：全量透传（含 sys_ 前缀内核簿记键），供需要完整数据的调用方；
// - user-related：玩家相关 NPC 域过滤 + world_state 隐藏 sys_ 内核簿记键，供冒险视图 UI/assist。
// 本层不写库，只读；NpcComposite 内 traits/memories/relations 随 NPC 可见性整体过滤。
// 净化规则见 resolveRelatedNpcSet；world_state 隐藏规则见 isSysBookkeepingKey。

import type { DbReader, NpcComposite } from "./reader.ts";
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
 *         与玩家同地点（npcs.current_location = world_state player_location 解析出的 location_id）的 NPC。
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
 * 冒险视图：与 DbReader 同形的只读方法子集（NPC 域 + 世界公开面 + data_status）。
 * filter="none" 全量透传（sys_ 键也可见）；filter="user-related" 按 resolveRelatedNpcSet 规则过滤：
 * - NPC 域（listNpcs / findNpcByCardRef / getNpc）只返回集合内的行；越集 id 调 getNpc 返回 undefined（UI 友好）；
 * - 可见 NPC 的 composite 内 relations 再按「对端也在集合内」过滤；
 * - world_state 隐藏 sys_ 前缀内核簿记键（player_location / player_npc_id 保持可见）；
 * - 世界公开面（locations / events / phases / time_log / turn_log / location_log / directives / clock）全量透传。
 */
export class DbView {
	private readonly reader: DbReader;
	private readonly filter: "none" | "user-related";
	private readonly related: RelatedNpcSet;

	constructor(reader: DbReader, filter: "none" | "user-related") {
		this.reader = reader;
		this.filter = filter;
		this.related = resolveRelatedNpcSet(reader);
	}

	/** 相关 NPC 集合（供 UI/assist 消费；"none" 模式下仅信息性）。 */
	get relatedSet(): RelatedNpcSet {
		return this.related;
	}

	private inSet(npcId: number): boolean {
		return this.related.npcIds.has(npcId);
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

	listEvents(options: { fromTurn?: number; toTurn?: number; type?: string } = {}): EventRow[] {
		return this.reader.listEvents(options);
	}

	listPhases(): PhaseRow[] {
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

	listLocations(): LocationRow[] {
		return this.reader.listLocations();
	}

	getLocation(id: number): LocationRow | undefined {
		return this.reader.getLocation(id);
	}

	getPlayerLocation(): LocationRow | undefined {
		return this.reader.getPlayerLocation();
	}

	listLocationLog(limit = 20): LocationLogRow[] {
		return this.reader.listLocationLog(limit);
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

	listDirectives(status?: "active" | "done" | "revoked"): DirectiveRow[] {
		return this.reader.listDirectives(status);
	}

	listDataStatus(): DataStatusRow[] {
		return this.reader.listDataStatus();
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
