// 开发通道（壳）：S1 的浏览器迭代脚手架。
//
// 目标形态（S1 接）：main 侧同进程起一个极小的本地 HTTP 服务，把**同一份 HostHandlers** 挂上去——
//   请求-响应：POST /rpc {channel, payload}
//   单向推送：GET /events（SSE）
// 于是 renderer 代码 100% 复用（只换 Transport 实现），改一行刷新即可，不必反复重启 Electron、
// 也不必吃那 200MB 二进制的加载时间。交付形态仍是 Electron，浏览器形态只是脚手架。
//
// 为什么现在只是壳：本文件的价值依赖于「main 侧 handler（openStory/runTurn/…）」与 renderer 应用，
// 两者都还没接（本刀刻意不接 UI）。现在把 HTTP/SSE 服务写成真代码＝先写一份只有我自己用的协议层，
// 届时还得跟着 handler 形状改一遍。故此处的实现**大声抛错**：谁误把它当可用通道，立刻知道。
//
// 红线：开发服务只监听 127.0.0.1，绝不绑 0.0.0.0。

import type { ChannelName, ChannelRequest, ChannelResponse, Transport } from "../contract/index.ts";

const NOT_WIRED = "开发通道（WebSocket/SSE）尚未接线：见 src/dev/transport-ws.ts 文件头说明";

export function createDevTransport(_endpoint: string): Transport {
	return {
		request<C extends ChannelName>(_channel: C, _payload: ChannelRequest<C>): Promise<ChannelResponse<C>> {
			return Promise.reject(new Error(NOT_WIRED));
		},
		subscribe(_channel: string, _listener: (payload: unknown) => void): () => void {
			throw new Error(NOT_WIRED);
		},
	};
}
