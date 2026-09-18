// 告警出口（叶子模块，零依赖；pipeline 各 stage 与 subagent/runtime 共用）。
//
// 存在的理由：降级告警（重试耗尽 → 兜底、模型回退）原先散在 core 各处直接 console.warn 写
// stderr。CLI 的活动行靠 stdout 的 `\r` 原地重绘（app/src/ui.ts 是唯一 stdout 出口），
// stderr 上的一次裸写会插进重绘行中间，把提示行撕成两半——偏偏这些告警都发生在轮中。
// 收到 onWarning 就走它（CLI 侧落 ui.warn，先 clearLine 再写，不撕裂）；
// 没有则退回 console.warn——core 各模块可独立用于工具/测试，不强制注入告警口。
//
// 信息不丢：这些降级事实本身已进 eventLog（ok:false + error），本模块只管「怎么让用户看见」。

/** 告警接收方；undefined = 无人接收，退回 console.warn。 */
export type WarnSink = ((message: string) => void) | undefined;

/** 发一条告警。 */
export function emitWarning(onWarning: WarnSink, message: string): void {
	if (onWarning !== undefined) {
		onWarning(message);
		return;
	}
	console.warn(message);
}
