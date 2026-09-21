// 渲染进程的通道实现（生产 = preload/IPC；开发 = 本地 HTTP/SSE，S1 剩余项）。
//
// 与 main 侧共用同一份 channel 契约（src/contract/channels.ts）——本文件**不重定义任何 channel 名**。
// channel 名与载荷类型由编译器保证，这是从 S0 的经典脚本换成 TS 版本的唯一实质收益。
//
// 边界纪律（test/boundary.test.ts 扫描钉住）：本目录不得**值导入** @tavernpi/core，只允许 `import type`。

import type { ChannelName, ChannelRequest, ChannelResponse, Transport } from "../contract/index.ts";

/** preload 经 contextBridge 暴露的出口（见 src/preload.cjs）——刻意不含 ipcRenderer 本体。 */
interface TavernBridge {
	request: (channel: string, payload: unknown) => Promise<unknown>;
	subscribe: (channel: string, listener: (payload: unknown) => void) => () => void;
}

declare global {
	// eslint-disable-next-line no-var
	var tavern: TavernBridge | undefined;
}

/**
 * 生产传输：preload 注入的 window.tavern。
 *
 * 唯一失败模式是「preload 没加载」（例如直接用浏览器打开 dist/index.html 调试）——
 * 那种情况要大声说清该怎么走，而不是抛一句 undefined 的 TypeError。
 */
export function createIpcTransport(): Transport {
	const bridge = globalThis.tavern;
	if (bridge === undefined) {
		throw new Error(
			"tavern bridge 未注入：preload 未加载。" +
				"Electron 里请用 npm start；浏览器里调试请改用开发通道（S1 剩余项，见 src/dev/transport-ws.ts）。",
		);
	}
	return {
		request<C extends ChannelName>(channel: C, payload: ChannelRequest<C>): Promise<ChannelResponse<C>> {
			return bridge.request(channel, payload) as Promise<ChannelResponse<C>>;
		},
		subscribe(channel: string, listener: (payload: unknown) => void): () => void {
			return bridge.subscribe(channel, listener);
		},
	};
}
