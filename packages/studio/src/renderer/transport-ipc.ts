// 生产通道（renderer 侧）：经 preload 的 contextBridge 说话。
//
// preload 只白名单少量方法（绝不把 ipcRenderer 本体挂到 window 上——那等于把任意 channel 的发送权
// 交给页面），故此模块是渲染进程访问 main 的唯一出口。形状与 Transport 一致，刻意不留扩展位。

import type { ChannelName, ChannelRequest, ChannelResponse, Transport } from "../contract/index.ts";

/** preload 经 contextBridge 暴露到全局的窄接口（main 侧见 main/transport-ipc.ts）。 */
export interface StudioBridge {
	request(channel: string, payload: unknown): Promise<unknown>;
	subscribe(channel: string, listener: (payload: unknown) => void): () => void;
}

/** 取全局注入的 bridge（非浏览器/未挂 preload 时抛错，而不是静默空实现）。 */
export function defaultBridge(): StudioBridge {
	const bridge = (globalThis as { tavern?: StudioBridge }).tavern;
	if (bridge === undefined) {
		throw new Error("studio bridge 未注入：preload 未加载（浏览器里调试请改用开发通道 transport-ws）");
	}
	return bridge;
}

export function createIpcTransport(bridge: StudioBridge = defaultBridge()): Transport {
	return {
		request<C extends ChannelName>(channel: C, payload: ChannelRequest<C>): Promise<ChannelResponse<C>> {
			return bridge.request(channel, payload) as Promise<ChannelResponse<C>>;
		},
		subscribe(channel: string, listener: (payload: unknown) => void): () => void {
			return bridge.subscribe(channel, listener);
		},
	};
}
