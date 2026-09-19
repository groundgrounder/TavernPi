// 读取 API 最小集（DB 层职责）。只读，无写途径。
// 按后续 pipeline 需要：clock 读取、turn_seq 范围查询、全表读、NPC 复合读。

import { DatabaseSync } from "node:sqlite";
import { buildLocationPath, type LocationPath } from "./location-path.ts";
import {
	listTableInfos,
	readTablePage,
	readTableRows,
	type TableInfo,
	type TablePage,
	type TableQuery,
	type TableRows,
} from "./query.ts";
import { parseTimeYear } from "./time-fuzzy.ts";
import { PLAYER_LOCATION_KEY } from "./types.ts";
import type {
	DataStatusRow,
	DirectiveRow,
	EventRow,
	LocationLogRow,
	LocationRow,
	NpcMemoryRow,
	NpcRelationRow,
	NpcRow,
	NpcTraitRow,
	PhaseRow,
	StoryClock,
	TimeLogRow,
	TurnLogRow,
	WorldStateRow,
} from "./types.ts";

export interface NpcComposite {
	npc: NpcRow | undefined;
	traits: NpcTraitRow[];
	memories: NpcMemoryRow[];
	relations: NpcRelationRow[];
}

export class DbReader {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	// ------------------------------------------------------------------
	// 时间
	// ------------------------------------------------------------------

	/** clock 单例读取。未初始化时返回 undefined（openStoryDb 会默认种入，见 story-db.ts）。
	 *  注意：current_time 是 SQLite 关键字（CURRENT_TIME），列引用必须限定表名或加引号。 */
	getClock(): StoryClock | undefined {
		return (
			(this.db
				.prepare(
					'SELECT "current_time", calendar, granularity FROM clock WHERE id = 1',
				)
				.get() as StoryClock | undefined) ?? undefined
		);
	}

	/** time_log 按轮次范围（含端点）。 */
	listTimeLog(options: { fromTurn?: number; toTurn?: number } = {}): TimeLogRow[] {
		const { where, params } = buildRangeWhere(options, "turn_seq");
		return this.db
			.prepare(`SELECT turn_seq, from_time, to_time, span_note, span_days FROM time_log${where} ORDER BY turn_seq`)
			.all(...params) as unknown as TimeLogRow[];
	}

	/** 某轮结束时的故事时间（time_log.to_time）；无记录返回 undefined。 */
	turnEndTime(turnSeq: number): string | undefined {
		const row = this.db.prepare("SELECT to_time FROM time_log WHERE turn_seq = ?").get(turnSeq) as
			| { to_time: string }
			| undefined;
		return row?.to_time;
	}

	/** 自 fromTurnSeq（不含）至 toTurnSeq（含）累计推进的故事天数（time_log.span_days 求和）。
	 *  未标注 span_days 的轮按 0 计（保守：衰减不增长）；负值归零。 */
	daysSinceTurn(fromTurnSeq: number, toTurnSeq: number): number {
		const row = this.db
			.prepare("SELECT COALESCE(SUM(span_days), 0) AS d FROM time_log WHERE turn_seq > ? AND turn_seq <= ?")
			.get(fromTurnSeq, toTurnSeq) as { d: number | null };
		return Math.max(0, row.d ?? 0);
	}

	// ------------------------------------------------------------------
	// 叙事世界
	// ------------------------------------------------------------------

	/** events 全表/范围/类型查询（按 id 升序）。 */
	listEvents(options: { fromTurn?: number; toTurn?: number; type?: string } = {}): EventRow[] {
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (options.fromTurn !== undefined) {
			clauses.push("turn_seq >= ?");
			params.push(options.fromTurn);
		}
		if (options.toTurn !== undefined) {
			clauses.push("turn_seq <= ?");
			params.push(options.toTurn);
		}
		if (options.type !== undefined) {
			clauses.push("type = ?");
			params.push(options.type);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		return this.db
			.prepare(
				`SELECT id, turn_seq, story_time, type, summary, detail, participants, location, location_id, created_entry_id
				 FROM events${where} ORDER BY id`,
			)
			.all(...params) as unknown as EventRow[];
	}

	/** phases 全表读（按 started_turn 升序）。 */
	listPhases(): PhaseRow[] {
		return this.db
			.prepare("SELECT id, name, started_turn, ended_turn, goals, status FROM phases ORDER BY started_turn")
			.all() as unknown as PhaseRow[];
	}

	/** 某 NPC 亲历的事件（event_npcs 名册 JOIN events；返回按 id 升序 = 时间序）。
	 *  limit 取最近 N 条（内部倒序取再正序返回）。 */
	listNpcEvents(npcId: number, limit = 10): EventRow[] {
		const rows = this.db
			.prepare(
				`SELECT e.id, e.turn_seq, e.story_time, e.type, e.summary, e.detail, e.participants, e.location, e.location_id, e.created_entry_id
				 FROM event_npcs en JOIN events e ON e.id = en.event_id
				 WHERE en.npc_id = ? ORDER BY e.id DESC LIMIT ?`,
			)
			.all(npcId, limit) as unknown as EventRow[];
		return rows.reverse();
	}

	/** world_state 全表读（按 key 升序）。 */
	listWorldState(): WorldStateRow[] {
		return this.db.prepare("SELECT key, value, turn_seq FROM world_state ORDER BY key").all() as unknown as WorldStateRow[];
	}

	// ------------------------------------------------------------------
	// 空间基元（locations / location_log）
	// ------------------------------------------------------------------

	/** 地点注册表全表读（按 id 升序；parent 名已解析）。 */
	listLocations(): LocationRow[] {
		return this.db
			.prepare(
				`SELECT l.id, l.name, l.parent_id, l.detail, l.kind, l.x, l.y, l.z, p.name AS parent_name
				 FROM locations l LEFT JOIN locations p ON p.id = l.parent_id ORDER BY l.id`,
			)
			.all() as unknown as LocationRow[];
	}

	/** 单个地点（含 parent 名解析）；未登记返回 undefined。 */
	getLocation(id: number): LocationRow | undefined {
		return this.db
			.prepare(
				`SELECT l.id, l.name, l.parent_id, l.detail, l.kind, l.x, l.y, l.z, p.name AS parent_name
				 FROM locations l LEFT JOIN locations p ON p.id = l.parent_id WHERE l.id = ?`,
			)
			.get(id) as LocationRow | undefined;
	}

	/** 读取 world_state 约定键 player_location 解析出的地点 id；未定位/值非法返回 null。 */
	private readPlayerLocationId(): number | null {
		const ws = this.db.prepare("SELECT value FROM world_state WHERE key = ?").get(PLAYER_LOCATION_KEY) as
			| { value: string }
			| undefined;
		if (!ws) return null;
		const n = Number(ws.value);
		return Number.isInteger(n) && n >= 0 ? n : null;
	}

	/** 玩家当前位置（读 world_state 约定键 player_location 并解析为地点行）；未定位返回 undefined。 */
	getPlayerLocation(): LocationRow | undefined {
		const id = this.readPlayerLocationId();
		return id === null ? undefined : this.getLocation(id);
	}

	/** 单个地点的位置路径（从根到叶；位置读取侧的统一表示）；未登记返回 undefined。 */
	getLocationPath(id: number): LocationPath | undefined {
		return buildLocationPath(this.listLocations(), id);
	}

	/** 玩家当前位置的路径；未定位返回 undefined。 */
	getPlayerLocationPath(): LocationPath | undefined {
		const id = this.readPlayerLocationId();
		return id === null ? undefined : buildLocationPath(this.listLocations(), id);
	}

	/** 位置变更记录（按 turn_seq 倒序，最近在前；地点名已解析）。 */
	listLocationLog(limit = 20): LocationLogRow[] {
		return this.db
			.prepare(
				`SELECT ll.turn_seq, ll.subject, ll.from_location, ll.to_location, ll.note,
				        fl.name AS from_location_name, tl.name AS to_location_name
				 FROM location_log ll
				 LEFT JOIN locations fl ON fl.id = ll.from_location
				 LEFT JOIN locations tl ON tl.id = ll.to_location
				 ORDER BY ll.turn_seq DESC, ll.rowid DESC LIMIT ?`,
			)
			.all(limit) as unknown as LocationLogRow[];
	}

	// ------------------------------------------------------------------
	// NPC
	// ------------------------------------------------------------------

	/** 时间线上最新已推进的轮次（time_log 最大 turn_seq；空库为 0）。
	 *  记忆时间精度衰减的「当前」基准——与 span_days 同源（time_log）。 */
	latestTurnSeq(): number {
		const row = this.db.prepare("SELECT MAX(turn_seq) AS t FROM time_log").get() as { t: number | null };
		return row.t ?? 0;
	}

	/**
	 * 记忆的时间视图（供时间精度衰减渲染）：
	 * - timeText = 时间锚：优先所涉事件的 story_time（更精确，可能含时段如「傍晚」），
	 *   否则取记录轮结束时的时钟值（time_log.to_time）；
	 * - daysAgo = 距当前轮累计推进的故事天数（span_days 求和）；
	 * - currentYear = 当前故事年份（分层时间串首段；解析不出省略）。
	 * 时间锚无从获得（无事件 story_time 且该轮无 time_log）时返回 undefined。
	 */
	memoryTimeView(
		memory: { turn_seq: number; event_id: number | null },
		currentTurnSeq: number,
	): { timeText: string; daysAgo: number; currentYear?: number } | undefined {
		let timeText: string | undefined;
		if (memory.event_id !== null) {
			const ev = this.db.prepare("SELECT story_time FROM events WHERE id = ?").get(memory.event_id) as
				| { story_time: string | null }
				| undefined;
			if (ev?.story_time != null && ev.story_time.trim() !== "") timeText = ev.story_time;
		}
		timeText ??= this.turnEndTime(memory.turn_seq);
		if (timeText === undefined) return undefined;
		const clock = this.getClock();
		const currentYear = clock === undefined ? undefined : parseTimeYear(clock.current_time);
		return {
			timeText,
			daysAgo: this.daysSinceTurn(memory.turn_seq, currentTurnSeq),
			...(currentYear === undefined ? {} : { currentYear }),
		};
	}

	/** NPC 全表读（按 id 升序；current_location 名已解析）。 */
	listNpcs(): NpcRow[] {
		return this.db
			.prepare(
				`SELECT n.id, n.name, n.card_ref, n.status, n.current_location, loc.name AS current_location_name
				 FROM npcs n LEFT JOIN locations loc ON loc.id = n.current_location ORDER BY n.id`,
			)
			.all() as unknown as NpcRow[];
	}

	/** 按 card_ref 精确查 NPC（卡包条目 seed 幂等键：card_ref = 包名:条目id，已存在即跳过不覆盖）。 */
	findNpcByCardRef(cardRef: string): NpcRow | undefined {
		return this.db
			.prepare(
				`SELECT n.id, n.name, n.card_ref, n.status, n.current_location, loc.name AS current_location_name
				 FROM npcs n LEFT JOIN locations loc ON loc.id = n.current_location WHERE n.card_ref = ?`,
			)
			.get(cardRef) as NpcRow | undefined;
	}

	/** NPC 复合读：基本信息（含当前位置）+ 特征 + 记忆（按 salience 降序）+ 关系（双向）。 */
	getNpc(npcId: number): NpcComposite {
		const npc = this.db
			.prepare(
				`SELECT n.id, n.name, n.card_ref, n.status, n.current_location, loc.name AS current_location_name
				 FROM npcs n LEFT JOIN locations loc ON loc.id = n.current_location WHERE n.id = ?`,
			)
			.get(npcId) as NpcRow | undefined;
		const traits = this.db
			.prepare("SELECT npc_id, trait, weight, source, turn_seq FROM npc_traits WHERE npc_id = ? ORDER BY turn_seq")
			.all(npcId) as unknown as NpcTraitRow[];
		const memories = this.db
			.prepare(
				"SELECT id, npc_id, turn_seq, kind, content, salience, source, event_id FROM npc_memories WHERE npc_id = ? ORDER BY salience DESC, id",
			)
			.all(npcId) as unknown as NpcMemoryRow[];
		const relations = this.db
			.prepare(
				"SELECT npc_a, npc_b, disposition, turn_seq FROM npc_relations WHERE npc_a = ? OR npc_b = ? ORDER BY turn_seq",
			)
			.all(npcId, npcId) as unknown as NpcRelationRow[];
		return { npc, traits, memories, relations };
	}

	// ------------------------------------------------------------------
	// 一致性 & 指令
	// ------------------------------------------------------------------

	/** turn_log 读取；不带 turnSeq 时返回全表（按 turn_seq 升序）。 */
	getTurnLog(turnSeq?: number): TurnLogRow[] {
		if (turnSeq !== undefined) {
			return this.db
				.prepare(
					"SELECT turn_seq, session_entry_id, user_input, narrative_text, raw_text, warnings FROM turn_log WHERE turn_seq = ?",
				)
				.all(turnSeq) as unknown as TurnLogRow[];
		}
		return this.db
			.prepare(
				"SELECT turn_seq, session_entry_id, user_input, narrative_text, raw_text, warnings FROM turn_log ORDER BY turn_seq",
			)
			.all() as unknown as TurnLogRow[];
	}

	/** directives 读取；status 过滤可选（默认全部）。 */
	listDirectives(status?: "active" | "done" | "revoked"): DirectiveRow[] {
		if (status !== undefined) {
			return this.db
				.prepare("SELECT id, turn_seq, content, status FROM directives WHERE status = ? ORDER BY id")
				.all(status) as unknown as DirectiveRow[];
		}
		return this.db.prepare("SELECT id, turn_seq, content, status FROM directives ORDER BY id").all() as unknown as DirectiveRow[];
	}

	/** data subagent 落库状态全表读（按 turn_seq 升序）。 */
	listDataStatus(): DataStatusRow[] {
		return this.db
			.prepare("SELECT turn_seq, status, attempts, error FROM data_status ORDER BY turn_seq")
			.all() as unknown as DataStatusRow[];
	}

	// ------------------------------------------------------------------
	// 通用只读查询（受限；安全面见 query.ts 文件头）
	// ------------------------------------------------------------------

	/** 表清单（表名 + 是否内核表 + 行数）。 */
	listTableInfos(): TableInfo[] {
		return listTableInfos(this.db);
	}

	/**
	 * 读表（**未过滤**、未分页）：本层只回答「这张表里有什么」，可见性净化是 DbView 的职责。
	 * 要带冒险视图语义请走 `DbView.queryTable`。
	 */
	readTable(query: Omit<TableQuery, "limit" | "offset">): TableRows {
		return readTableRows(this.db, query);
	}

	/** 读表 + 分页（**未过滤**）。DbView 不用它——过滤必须在分页之前做，故那里走 readTable。 */
	readTablePage(query: TableQuery): TablePage {
		return readTablePage(this.db, query);
	}
}

/** 组装 turn_seq 范围 WHERE（含端点）。 */
function buildRangeWhere(options: { fromTurn?: number; toTurn?: number }, column: string): { where: string; params: Array<number> } {
	const clauses: string[] = [];
	const params: number[] = [];
	if (options.fromTurn !== undefined) {
		clauses.push(`${column} >= ?`);
		params.push(options.fromTurn);
	}
	if (options.toTurn !== undefined) {
		clauses.push(`${column} <= ?`);
		params.push(options.toTurn);
	}
	return { where: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}
