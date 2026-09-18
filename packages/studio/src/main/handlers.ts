// channel → 业务处理的唯一映射处。main 侧的「handler」就是这一张表：每个 channel 一行，
// 全部转发给 StudioSession（内核装配态的持有者）。
//
// 纪律：这里不做业务判断——校验在会话层与内核里，渲染进程要什么就搬什么。
// 新增 channel 时本文件会因 HostHandlers 的类型不完整而编译失败，不会静默漏接。

import type { HostHandlers } from "./transport-ipc.ts";
import type { StudioSession } from "./session.ts";

export function buildHostHandlers(session: StudioSession): HostHandlers {
	return {
		"story:list": (req) => session.list(req.storiesRoot),
		"story:create": (req) => session.create(req),
		"story:open": (req) => session.open(req),
		"turn:run": (req) => session.runTurn(req),
		"turn:abort": (req) => {
			session.abort(req);
			return Promise.resolve(undefined);
		},
		"turn:swipe": (req) => session.swipe(req),
		"tree:navigate": (req) => session.navigate(req),
		"tree:fork": (req) => session.fork(req),
		"settings:read": () => Promise.resolve(session.settings()),
		"settings:write": (req) => {
			session.writeSettings(req.settings);
			return Promise.resolve(undefined);
		},
		"prompts:read": (req) => Promise.resolve(session.promptChain(req.role)),
	};
}
