// 故事 DB 行类型与共享常量（schema 的结构化镜像）。

/** clock 单例（id=1）。不带 turn_seq ——的显式例外。 */
export interface StoryClock {
	current_time: string;
	calendar: string;
	granularity: string;
}

/** 默认时钟初值。历法/粒度由卡包 story.yaml 配置（createStory 消费），默认弹性时间。 */
export const DEFAULT_STORY_CLOCK: StoryClock = {
	current_time: "0000-01-01",
	calendar: "default",
	granularity: "elastic",
};

/**
 * 连接级忙等上限（毫秒）；story.db 与 snapshots.db 都在打开时设置。
 *
 * 为什么需要：本内核是可供同进程嵌入的库（studio 同宿主），而 takeSnapshot 会为
 * snapshots.db **另开一条连接**（用完即关），常开的 snapshotsDb 连接同时也在——同一库文件
 * 存在多个写者；SnapshotsDb 构造里还要跑 CREATE TABLE IF NOT EXISTS（写操作）。
 * 不设 busy_timeout 时第二个写者立即拿到 SQLITE_BUSY，而不是等待。
 *
 * 为什么写事务还得配 BEGIN IMMEDIATE：WAL 下 deferred BEGIN 先取读快照、到写语句才升级为写，
 * 此时若别人已提交写，SQLite 返回 SQLITE_BUSY_SNAPSHOT —— **busy_timeout 对它不生效**，
 * 只能整事务回滚重试。IMMEDIATE 在事务起点就取写锁，busy_timeout 才真正起作用。
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** 每轮时间推进记录。span_days = 本轮推进的故事天数（可空；一切时间运算以此为准）。 */
export interface TimeLogRow {
	turn_seq: number;
	from_time: string;
	to_time: string;
	span_note: string | null;
	span_days: number | null;
}

/** 叙事事件。story_time = 事件发生的故事时间（events.story_time 锚点）。
 *  location 自由文本留作叙事描述；location_id 引用 locations（登记校验）。 */
export interface EventRow {
	id: number;
	turn_seq: number;
	story_time: string | null;
	type: string;
	summary: string;
	detail: string | null;
	participants: string | null;
	location: string | null;
	location_id: number | null;
	created_entry_id: string | null;
}

/** 故事阶段/幕。ended_turn 为 NULL 表示未结束。status 是开放词汇（无枚举约束）。 */
export interface PhaseRow {
	id: number;
	name: string;
	started_turn: number;
	ended_turn: number | null;
	goals: string | null;
	status: string;
}

/** 世界状态键值（天气、经济等）。约定键 player_location = 玩家当前 location_id。 */
export interface WorldStateRow {
	key: string;
	value: string;
	turn_seq: number;
}

/** world_state 约定键：玩家当前所在地点 id（文本 = location_id）。 */
export const PLAYER_LOCATION_KEY = "player_location";

/** world_state 存的 location id 文本 → number | null（非法值返回 null）。 */
export function parseLocationId(value: string): number | null {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 地点注册表行。parent_id 表达包含关系（如 王城>庭院），不构成完整拓扑，内核不校验连通性。
 *  kind = 地理层级标签（如 国/城/区/别墅/房间；卡包自定义词汇，可空）。
 *  x/y/z = 世界坐标（单位：步，1 单位 = 成人一步；x 东正 / y 北正 / z 上正），可空；
 *  可空语义：x/y 成对（只给一半非法），z NULL 视为 0。 */
export interface LocationRow {
	id: number;
	name: string;
	parent_id: number | null;
	detail: string | null;
	/** 地理层级标签（可空；未标注为 null，渲染时省略）。 */
	kind: string | null;
	/** 世界坐标 x（东为正，单位步）；未标注为 null。 */
	x: number | null;
	/** 世界坐标 y（北为正，单位步）；未标注为 null。 */
	y: number | null;
	/** 世界坐标 z（上为正，单位步；楼层/地下）；未标注为 null（视为 0）。 */
	z: number | null;
	/** 父地点名（LEFT JOIN locations 解析；无父为 null）。 */
	parent_name: string | null;
}

/** 位置变更记录（镜像 time_log）。subject = 'player' 或 'npc:<id>'。 */
export interface LocationLogRow {
	turn_seq: number;
	subject: string;
	from_location: number | null;
	to_location: number | null;
	note: string | null;
	/** 起点/终点地点名（LEFT JOIN 解析；null 表示起点为空或未登记）。 */
	from_location_name: string | null;
	to_location_name: string | null;
}

/** NPC。status: 开放集合（alive/dead/absent...，无枚举约束）。current_location 引用 locations。 */
export interface NpcRow {
	id: number;
	name: string;
	card_ref: string | null;
	status: string;
	current_location: number | null;
	/** 当前所在地点名（LEFT JOIN locations 解析）。 */
	current_location_name: string | null;
}

/** 性格特征，可演化 —— (npc_id, trait, turn_seq) 保留每次演化。weight 由 data subagent 按提示词判断（schema 不约束数值域）。 */
export interface NpcTraitRow {
	npc_id: number;
	trait: string;
	weight: number;
	source: string | null;
	turn_seq: number;
}

/** 知识来源（记忆的主观维度）：witness=亲历 / hearsay=耳闻 / inference=推断。 */
export const MEMORY_SOURCES = ["witness", "hearsay", "inference"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** 知识来源的中文标签（渲染用）。 */
export const MEMORY_SOURCE_LABELS: Record<MemorySource, string> = {
	witness: "亲历",
	hearsay: "耳闻",
	inference: "推断",
};

/** 记忆渲染：`内容（来源 · 时间）`；来源/时间缺省则相应省略（时间标签由 time-fuzzy 产出）。 */
export function renderMemoryText(
	memory: { content: string; source: MemorySource | null },
	timeLabel?: string,
): string {
	const tags: string[] = [];
	if (memory.source !== null) tags.push(MEMORY_SOURCE_LABELS[memory.source]);
	if (timeLabel !== undefined && timeLabel !== "") tags.push(timeLabel);
	return tags.length === 0 ? memory.content : `${memory.content}（${tags.join(" · ")}）`;
}

/** 记忆；salience 供检索排序（默认 0；衰减由 data subagent 判断，非内核计算）。
 *  source = 知识来源（可空 = 未标注）；event_id = 所涉事件引用（可空；耳闻版本允许与事件不符）。 */
export interface NpcMemoryRow {
	id: number;
	npc_id: number;
	turn_seq: number;
	kind: string;
	content: string;
	salience: number;
	source: MemorySource | null;
	event_id: number | null;
}

/** 关系/好感。disposition 参考 favor 示例（-100~100，INTEGER）。 */
export interface NpcRelationRow {
	npc_a: number;
	npc_b: number;
	disposition: number;
	turn_seq: number;
}

/** 每轮一致性记录。raw_text = stylize 前原文（未启用则同 narrative_text）。
 *  warnings = 轻检/审查留痕（规则层硬冲突或 LLM 审查 findings 的文本摘要；可空，后补写）。 */
export interface TurnLogRow {
	turn_seq: number;
	session_entry_id: string;
	user_input: string;
	narrative_text: string;
	raw_text: string | null;
	warnings: string | null;
}

/** 创造模式剧情大纲指令（作者意图，非世界事实）。status 封闭枚举。 */
export interface DirectiveRow {
	id: number;
	turn_seq: number;
	content: string;
	status: "active" | "done" | "revoked";
}

/** data subagent 落库状态（失败路径持久化；PK turn_seq）。
 *  status：ok = 落库成功；failed = 本轮失败待补；compensated = 后续轮补齐（含本轮事实）。 */
export interface DataStatusRow {
	turn_seq: number;
	status: "ok" | "failed" | "compensated";
	attempts: number;
	error: string | null;
}
