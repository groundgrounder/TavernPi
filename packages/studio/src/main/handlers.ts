// channel → 业务处理的唯一映射处。main 侧的「handler」就是这一张表：每个 channel 一行，
// 全部转发给 StudioSession（内核装配态的持有者）。
//
// 纪律：这里不做**业务**判断（校验在内核与会话层）。但要做**边界形状**检查——IPC 载荷在类型上
// 是 unknown，缺字段/类型错会一路穿到内核深处变成难懂的 TypeError，而调用方只看到「远程方法失败」。
// 只查「不查就会静默出事」的字段，不造校验框架。

import type { StoryMode } from "@tavernpi/core";
import type { HostHandlers } from "./transport-ipc.ts";
import type { StudioSession } from "./session.ts";

function readPayload(payload: unknown): Record<string, unknown> {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error(`IPC 载荷不是对象: ${JSON.stringify(payload)}`);
	}
	return payload as Record<string, unknown>;
}

/** 必填字符串（缺了会让内核抛出难以定位的错，在此挡掉并说明是哪个 channel 的哪个字段）。 */
function requiredString(payload: unknown, field: string): string {
	const value = readPayload(payload)[field];
	if (typeof value !== "string" || value === "") {
		throw new Error(`IPC 载荷字段非法: ${field} 应为非空字符串，收到 ${JSON.stringify(value)}`);
	}
	return value;
}

/** 可选布尔。**必须严格判类型**：`force` 用真值判断的话，字符串 "no" 会被当成「强制提交」。 */
function optionalBoolean(payload: unknown, field: string): boolean | undefined {
	const value = readPayload(payload)[field];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`IPC 载荷字段非法: ${field} 应为布尔，收到 ${JSON.stringify(value)}`);
	}
	return value;
}

/** 可选字符串（给了就必须是字符串，不接受数字/对象被静默透传进内核）。 */
function optionalString(payload: unknown, field: string): string | undefined {
	const value = readPayload(payload)[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`IPC 载荷字段非法: ${field} 应为字符串，收到 ${JSON.stringify(value)}`);
	}
	return value;
}

/** 可选字符串数组（如 packDirs）。 */
function optionalStringArray(payload: unknown, field: string): string[] | undefined {
	const value = readPayload(payload)[field];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new Error(`IPC 载荷字段非法: ${field} 应为字符串数组，收到 ${JSON.stringify(value)}`);
	}
	return value as string[];
}

/** 可选模式值（★信任边界上的第一个口：非法值在这里就挡掉，别等内核抛）。 */
function optionalMode(payload: unknown): StoryMode | undefined {
	const value = readPayload(payload)["mode"];
	if (value === undefined) return undefined;
	if (value !== "creation" && value !== "survival" && value !== "adventure") {
		throw new Error(`IPC 载荷字段非法: mode 应为 creation|survival|adventure，收到 ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * 可选正整数（分页 limit/offset）。**必须拒绝 NaN/浮点/负数**：这些值不会让内核抛错，
 * 而会让 SQLite 的 LIMIT 静默取到意外行数——「不报错但结果不对」是最难查的一类。
 */
function optionalCount(payload: unknown, field: string): number | undefined {
	const value = readPayload(payload)[field];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`IPC 载荷字段非法: ${field} 应为非负整数，收到 ${JSON.stringify(value)}`);
	}
	return value;
}

/** 可选枚举（限定在给定取值集合内）。 */
function optionalEnum<T extends string>(payload: unknown, field: string, allowed: readonly T[]): T | undefined {
	const value = readPayload(payload)[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new Error(`IPC 载荷字段非法: ${field} 应为 ${allowed.join("|")}，收到 ${JSON.stringify(value)}`);
	}
	return value as T;
}

/**
 * 可选等值过滤表（列名 → 标量）。**只允许 string|number|null**：
 * 对象/数组当作过滤值会一路穿到 SQLite 绑定处崩成看不懂的错，且 null 有 IS NULL 的特殊语义，
 * 必须在边界上把形状钉死。
 */
function optionalScalarMap(payload: unknown, field: string): Record<string, string | number | null> | undefined {
	const value = readPayload(payload)[field];
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`IPC 载荷字段非法: ${field} 应为对象，收到 ${JSON.stringify(value)}`);
	}
	const out: Record<string, string | number | null> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry !== null && typeof entry !== "string" && typeof entry !== "number") {
			throw new Error(`IPC 载荷字段非法: ${field}.${key} 应为字符串/数字/null，收到 ${JSON.stringify(entry)}`);
		}
		out[key] = entry as string | number | null;
	}
	return out;
}

/**
 * 载荷校验一律**经此包装**再返回。
 *
 * 为什么必须包：`HostHandlers` 声明的是 `(payload) => Promise<...>`，而边界校验是**同步**抛错
 * （`requiredString` 等直接 throw）。同步抛错发生在调用点，即调用方拿不到 Promise 就被炸了——
 * 在 Electron 里这恰好不会出问题（`ipcMain.handle` 两者都接），但契约因此变得**表里不一**：
 * 「全部 handler 都返回 Promise」这条不变量只有部分成立，调用方无法依赖。
 * 更糟的是它让测试写成 `assert.rejects(handlers.x(...))` 时**在表达式求值阶段**就崩，
 * 断言根本没被执行——一个绿得发亮的假阳性陷阱。
 *
 * 包装后不变量恢复：任何入参问题都以 rejection 形式出现，与业务错误走同一条通道。
 */
function asPromise<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(run());
	} catch (err) {
		return Promise.reject(err);
	}
}

export function buildHostHandlers(session: StudioSession): HostHandlers {
	return {
		"story:list": (req) => asPromise(() => session.list(optionalString(req, "storiesRoot"))),

		"story:create": (req) =>
			asPromise(() => {
				const storiesRoot = optionalString(req, "storiesRoot");
				const packDirs = optionalStringArray(req, "packDirs");
				const mode = optionalMode(req);
				const title = optionalString(req, "title");
				return session.create({
					...(storiesRoot !== undefined ? { storiesRoot } : {}),
					...(packDirs !== undefined ? { packDirs } : {}),
					...(mode !== undefined ? { mode } : {}),
					...(title !== undefined ? { title } : {}),
				});
			}),

		"story:open": (req) =>
			asPromise(() => {
				const storiesRoot = optionalString(req, "storiesRoot");
				return session.open({
					sessionFile: requiredString(req, "sessionFile"),
					...(storiesRoot !== undefined ? { storiesRoot } : {}),
				});
			}),

		"turn:run": (req) =>
			asPromise(() => {
				const force = optionalBoolean(req, "force");
				return session.runTurn({
					turnId: requiredString(req, "turnId"),
					input: requiredString(req, "input"),
					...(force !== undefined ? { force } : {}),
				});
			}),

		"turn:abort": (req) =>
			asPromise(() => {
				session.abort({ turnId: requiredString(req, "turnId") });
				return undefined;
			}),

		"story:turns": (req) =>
			asPromise(() => {
				const limit = optionalCount(req, "limit");
				const offset = optionalCount(req, "offset");
				const order = optionalEnum(req, "order", ["asc", "desc"] as const);
				return session.turns({
					...(limit !== undefined ? { limit } : {}),
					...(offset !== undefined ? { offset } : {}),
					...(order !== undefined ? { order } : {}),
				});
			}),

		"db:query": (req) =>
			asPromise(() => {
				const table = optionalString(req, "table");
				const limit = optionalCount(req, "limit");
				const offset = optionalCount(req, "offset");
				const orderBy = optionalString(req, "orderBy");
				const descending = optionalBoolean(req, "descending");
				const equals = optionalScalarMap(req, "equals");
				const filter = optionalEnum(req, "filter", ["none", "user"] as const);
				return session.dbQuery({
					...(table !== undefined ? { table } : {}),
					...(limit !== undefined ? { limit } : {}),
					...(offset !== undefined ? { offset } : {}),
					...(orderBy !== undefined ? { orderBy } : {}),
					...(descending !== undefined ? { descending } : {}),
					...(equals !== undefined ? { equals } : {}),
					...(filter !== undefined ? { filter } : {}),
				});
			}),

		"turn:swipe": (req) => asPromise(() => session.swipe({ turnId: requiredString(req, "turnId") })),

		"tree:navigate": (req) => asPromise(() => session.navigate({ entryId: requiredString(req, "entryId") })),

		"tree:fork": (req) => asPromise(() => session.fork({ entryId: requiredString(req, "entryId") })),

		"settings:read": () => Promise.resolve(session.settings()),

		"settings:write": (req) => asPromise(() => session.writeSettings(readPayload(req)["settings"])),

		"prompts:read": (req) => asPromise(() => session.promptChain(requiredString(req, "role"))),
	};
}
