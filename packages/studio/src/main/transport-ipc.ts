// 生产通道（IPC）：main 侧把契约里的每个 channel 注册到 IpcLike（Electron 的 ipcMain 窄投影）。
//
// 两侧职责切分：
//   · 本模块只做「注册 + 搬运」——不解释载荷、不缓存内核状态、不吞异常（内核的中文错原样回给 UI）。
//   · 真正的业务处理（openStory / runTurn / forkFrom …）由 S1 的 main 侧 handler 目录实现，
//     在这里注入：channel 未接处理器 → 启动即抛错，不留半挂的通道（坏在启动比坏在用户点下去好）。
//
// 依赖 electron 的只有 IpcLike 的构造（S0 收尾接线时写 3 行适配），本文件因此可被单测覆盖。

import type {
	ChannelName,
	ChannelRequest,
	ChannelResponse,
	IpcLike,
	PushChannelName,
	PushPayload,
} from "../contract/index.ts";

/** 每个 channel 的处理器（类型逐 channel 收窄：写错载荷形状编译期就红）。 */
export type HostHandlers = {
	[C in ChannelName]: (payload: ChannelRequest<C>) => Promise<ChannelResponse<C>>;
};

export interface IpcHost {
	/** 向 renderer 推送（main → renderer 单向）。 */
	push<C extends PushChannelName>(channel: C, payload: PushPayload<C>): void;
	/** 已注册的 channel（自检/诊断）。 */
	readonly channels: readonly ChannelName[];
}

/**
 * 全部请求-响应 channel 的运行时清单（导出供自检/测试比对）。
 * `satisfies Record<ChannelName, 0>` 让「漏登记」变成编译错误——加 channel 时忘进清单是必然会发生的事。
 */
export const CHANNEL_NAMES: readonly ChannelName[] = Object.keys({
	"story:list": 0,
	"story:create": 0,
	"story:open": 0,
	"turn:run": 0,
	"turn:abort": 0,
	"turn:swipe": 0,
	"tree:navigate": 0,
	"tree:fork": 0,
	"settings:read": 0,
	"settings:write": 0,
	"prompts:read": 0,
} satisfies Record<ChannelName, 0>) as ChannelName[];

/**
 * 把处理器注册到 IPC 通道上并返回推送把手。
 * 缺处理器 → 抛错（附全部缺失项）；重复注册的语义由 IpcLike 实现方保证幂等（Electron 自身会抛错）。
 */
export function createIpcHost(ipc: IpcLike, handlers: HostHandlers): IpcHost {
	const missing = CHANNEL_NAMES.filter((name) => typeof handlers[name] !== "function");
	if (missing.length > 0) {
		throw new Error(`IPC 通道未接处理器: ${missing.join(" / ")}`);
	}
	for (const name of CHANNEL_NAMES) {
		const handler = handlers[name] as (payload: unknown) => Promise<unknown>;
		ipc.handle(name, (payload) => handler(payload));
	}
	return {
		channels: CHANNEL_NAMES,
		push<C extends PushChannelName>(channel: C, payload: PushPayload<C>): void {
			ipc.send(channel, payload);
		},
	};
}
