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

export function buildHostHandlers(session: StudioSession): HostHandlers {
	return {
		"story:list": (req) => session.list(optionalString(req, "storiesRoot")),

		"story:create": (req) => {
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
		},

		"story:open": (req) => {
			const storiesRoot = optionalString(req, "storiesRoot");
			return session.open({
				sessionFile: requiredString(req, "sessionFile"),
				...(storiesRoot !== undefined ? { storiesRoot } : {}),
			});
		},

		"turn:run": (req) => {
			const force = optionalBoolean(req, "force");
			return session.runTurn({
				turnId: requiredString(req, "turnId"),
				input: requiredString(req, "input"),
				...(force !== undefined ? { force } : {}),
			});
		},

		"turn:abort": (req) => {
			session.abort({ turnId: requiredString(req, "turnId") });
			return Promise.resolve(undefined);
		},

		"turn:swipe": (req) => session.swipe({ turnId: requiredString(req, "turnId") }),

		"tree:navigate": (req) => session.navigate({ entryId: requiredString(req, "entryId") }),

		"tree:fork": (req) => session.fork({ entryId: requiredString(req, "entryId") }),

		"settings:read": () => Promise.resolve(session.settings()),

		"settings:write": async (req) => {
			await session.writeSettings(readPayload(req)["settings"]);
		},

		"prompts:read": (req) => Promise.resolve(session.promptChain(requiredString(req, "role"))),
	};
}
