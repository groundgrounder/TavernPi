// studio 契约面出口：main 侧与 renderer 侧都从这里 import（单一事实来源）。

export {
	INTERACTION_RESPOND,
	type ChannelMap,
	type ChannelName,
	type ChannelRequest,
	type ChannelResponse,
	type InteractionRespondRequest,
	type PushChannelName,
	type PushMap,
	type PushPayload,
} from "./channels.ts";
export type { IpcLike, Transport } from "./transport.ts";
