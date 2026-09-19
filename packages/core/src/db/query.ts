// 通用只读查询（受限）。补 studio 的 DB 浏览器与卡包表查看所需的「翻任意表」能力，
// 同时不给调用方任何绕过内核纪律的通道。
//
// 四条硬约束（本层的全部安全面，勿在此层之外另开口子）：
//   1. **只生成 SELECT**：没有可写入口，不接受 SQL 片段——表名/列名一律对照真实 metadata
//      校验后加引号插值（SQLite 不支持参数化标识符），值一律参数化。
//   2. **表名必须精确命中库里真实存在的表**（清单来自 sqlite_master）。不做前缀/通配匹配——
//      前缀匹配正是「包名 event 覆盖内核表 event_npcs」那条旁路的成因（见 db/kernel-tables.ts）。
//   3. **列名必须命中该表的真实列**（PRAGMA table_info）。equals / orderBy 都过这道闸。
//   4. **分页有硬上限**，且扫描行数也有上限（见 TABLE_QUERY_MAX_SCAN）：超限只截断并标记，
//      不静默返回「看起来完整」的一页。
//
// 本层**不做可见性过滤**：过滤是视图层的职责（DbView 按 user-related 规则净化），
// 本层只回答「这张表里有什么」。经 DbView 暴露才带上冒险视图语义。

import type { DatabaseSync } from "node:sqlite";
import { KERNEL_TABLE_WHITELIST } from "./kernel-tables.ts";

/** 单页最多返回行数（调用方传更大值会被夹到上限，并反映在返回的 limit 上）。 */
export const TABLE_QUERY_MAX_LIMIT = 500;
/** 默认页大小。 */
export const TABLE_QUERY_DEFAULT_LIMIT = 50;
/**
 * 单次扫描的行数上限。可见性过滤发生在读行之后、分页之前（过滤规则是 JS 函数，
 * 下推 SQL 等于把规则抄第二遍），故此上限同时保护「视图过滤」路径的内存。
 * 超限时 truncated=true——调用方据此知道「还有没扫到的行」，而不是误以为这就是全表。
 */
export const TABLE_QUERY_MAX_SCAN = 10_000;

/** 表清单条目。kind 由内核保留表清单判定（见 kernel-tables.ts）。 */
export interface TableInfo {
	name: string;
	kernel: boolean;
	/** 表内行数（真实 COUNT，故事库规模下开销可接受）。 */
	rows: number;
}

/** 通用查询入参。未给的字段即不过滤/不排序（保持库内自然顺序）。 */
export interface TableQuery {
	table: string;
	limit?: number;
	offset?: number;
	/** 等值过滤（列名 → 值）；null 表示 IS NULL。 */
	equals?: Record<string, string | number | null>;
	/** 排序列（须是该表真实列）。不指定则按库内自然顺序。 */
	orderBy?: string;
	descending?: boolean;
}

/** 一页数据。truncated=true 表示「扫描上限内并非全表」，total 只覆盖已扫描部分。 */
export interface TablePage {
	table: string;
	columns: string[];
	rows: Array<Record<string, unknown>>;
	total: number;
	limit: number;
	offset: number;
	truncated: boolean;
}

/** 读行结果（未分页、未过滤）。供视图层过滤后再分页用。 */
export interface TableRows {
	table: string;
	columns: string[];
	rows: Array<Record<string, unknown>>;
	/** 是否因扫描上限截断。 */
	truncated: boolean;
}

/** 标识符加引号（双引号内再转义双引号）。表名/列名均已过清单校验，这是第二道防御。 */
function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** 库里真实存在的表名（排除 sqlite_ 内部表与视图）。 */
function tableNames(db: DatabaseSync): string[] {
	const rows = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all() as Array<{ name: string }>;
	return rows.map((r) => r.name);
}

/** 表名校验：必须精确命中真实表名（精确相等，不做前缀/通配）。 */
function assertKnownTable(db: DatabaseSync, table: string): void {
	const known = tableNames(db);
	if (!known.includes(table)) {
		throw new Error(`未知表 ${JSON.stringify(table)}（库内实际存在的表：${known.join(", ")}）`);
	}
}

/** 表的真实列名（PRAGMA table_info；表名已过 assertKnownTable）。 */
export function tableColumns(db: DatabaseSync, table: string): string[] {
	assertKnownTable(db, table);
	const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
	return rows.map((r) => r.name);
}

/** 表清单（含行数）。kernel=是否内核保留表。 */
export function listTableInfos(db: DatabaseSync): TableInfo[] {
	return tableNames(db).map((name) => {
		const count = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).get() as { c: number };
		return { name, kernel: KERNEL_TABLE_WHITELIST.includes(name), rows: count.c };
	});
}

/** 行内取列值（行来自 SELECT *，列名即表列名）。缺列按 undefined（不抛——视图形状可能不同）。 */
type Row = Record<string, unknown>;

/**
 * 读表（未分页、未过滤）：生成 `SELECT * FROM "t" [WHERE ...] [ORDER BY "c" ...] LIMIT <scan+1>`。
 * 值全参数化；表名/列名全过清单校验。返回 truncated 标记而非自行截断成「完整页」。
 */
export function readTableRows(db: DatabaseSync, query: Pick<TableQuery, "table" | "equals" | "orderBy" | "descending">): TableRows {
	assertKnownTable(db, query.table);
	const columns = tableColumns(db, query.table);

	const conditions: string[] = [];
	const params: Array<string | number | null> = [];
	for (const [column, value] of Object.entries(query.equals ?? {})) {
		if (!columns.includes(column)) {
			throw new Error(`表 ${query.table} 无此列: ${JSON.stringify(column)}（实际列：${columns.join(", ")}）`);
		}
		if (value === null) {
			conditions.push(`${quoteIdent(column)} IS NULL`);
		} else {
			conditions.push(`${quoteIdent(column)} = ?`);
			params.push(value);
		}
	}

	let order = "";
	if (query.orderBy !== undefined) {
		if (!columns.includes(query.orderBy)) {
			throw new Error(`表 ${query.table} 无排序列: ${JSON.stringify(query.orderBy)}（实际列：${columns.join(", ")}）`);
		}
		order = ` ORDER BY ${quoteIdent(query.orderBy)} ${query.descending === true ? "DESC" : "ASC"}`;
	}

	const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
	// 多读一行用于判定「还有没有更多」，随后丢弃。
	const sql = `SELECT * FROM ${quoteIdent(query.table)}${where}${order} LIMIT ?`;
	const scanned = db.prepare(sql).all(...params, TABLE_QUERY_MAX_SCAN + 1) as Row[];
	const truncated = scanned.length > TABLE_QUERY_MAX_SCAN;
	return { table: query.table, columns, rows: truncated ? scanned.slice(0, TABLE_QUERY_MAX_SCAN) : scanned, truncated };
}

/** 分页切片（在给定行集上）。limit 夹到 [1, TABLE_QUERY_MAX_LIMIT]。 */
export function paginateRows(
	rows: readonly Row[],
	options: { limit?: number; offset?: number } = {},
): { rows: Row[]; total: number; limit: number; offset: number } {
	const rawLimit = options.limit ?? TABLE_QUERY_DEFAULT_LIMIT;
	const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), TABLE_QUERY_MAX_LIMIT);
	const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
	return { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

/** 通用只读查询（未过滤）：读行 + 分页一步到位。 */
export function readTablePage(db: DatabaseSync, query: TableQuery): TablePage {
	const read = readTableRows(db, query);
	const page = paginateRows(read.rows, query);
	return { table: read.table, columns: read.columns, rows: page.rows, total: page.total, limit: page.limit, offset: page.offset, truncated: read.truncated };
}
