// 传输层抽象：renderer 与 main 之间只有这一个接口。
//
// 为什么要抽象：「开发期用浏览器 + 系统 Node 跑内核、交付形态是 Electron」这条路线要成立，
// 传输层必须**从第一天就是可替换的适配器**——若等到收尾再把 WebSocket 换成 IPC，那不叫切换，叫重写。
// 两侧实现都实现本接口，共用 contract/channels.ts 的 channel 名与载荷类型：
//   生产：renderer 经 preload 的 contextBridge 走 IPC；main 侧 createIpcHost 注册处理器。
//   开发：renderer 直连 dev server（S1 接）；main 侧同进程起 HTTP/WS 服务。
//
// 纪律：adapter 只做「搬运」——不解释载荷、不做业务判断、不缓存内核状态。

import type { ChannelName, ChannelRequest, ChannelResponse } from "./channels.ts";

/** 推送订阅的载荷（channel 名 → 载荷类型由 PushMap 决定，见 channels.ts）。 */
export interface Transport {
	/** 请求-响应。失败以异常形式抛出（内核的中文错原样带到 UI，不要包一层看不懂的错）。 */
	request<C extends ChannelName>(channel: C, payload: ChannelRequest<C>): Promise<ChannelResponse<C>>;
	/** 订阅 main 侧推送；返回解绑函数（必须真的解绑——组件销毁后仍接推送是泄漏与错乱的源头）。 */
	subscribe(channel: string, listener: (payload: unknown) => void): () => void;
}

/** main 侧的 IPC 原语（Electron 的 ipcMain/webContents 的窄投影）。
 *  做成窄接口的理由：主进程代码不直接依赖 electron 就能被类型检查与单测覆盖
 *  （真实 electron 只在 S0 收尾接线时注入）。 */
export interface IpcLike {
	/** 注册请求-响应处理器；同一 channel 重复注册由实现方决定（Electron 会抛错，这里要求幂等语义）。 */
	handle(channel: string, handler: (payload: unknown) => Promise<unknown>): void;
	/** 向渲染进程推送。 */
	send(channel: string, payload: unknown): void;
}
