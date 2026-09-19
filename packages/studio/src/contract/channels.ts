// studio 的唯一契约面（renderer ↔ main）。channel 名与载荷类型**只在这里定义一次**，
// main 侧与 renderer 侧都从这里 import——否则两条通道（生产 IPC / 开发 WS）与两侧实现必然漂移。
//
// 三条纪律：
//   1. 载荷类型引用 @tavernpi/core 的导出类型。`import type` 在类型剥离时被抹掉，**不会**把内核
//      打渲染进程的包里，所以类型可以放心共用；值导入不行（见第 2 条）。
//   2. renderer **不得值导入** @tavernpi/core：模式过滤（DbView）、唯一写路径（trustedWrite）、
//      快照恢复全在 main 侧的内核实例里。绕过它等于绕开内核信任边界。
//      test/boundary.test.ts 扫源码钉住这条，别只写在文档里。
//   3. 只登记「内核已有 API 支撑」的 channel。内核还缺的能力（如通用只读表查询，见技术考察 §3.2 缺口 3）
//      不在这里预先设计——接口等实现，不等想象。

import type { StoryMode, StorySummary, TurnResult } from "@tavernpi/core";

/** 请求-响应（renderer → main）。 */
export interface ChannelMap {
	/** 故事枚举（内核 listStories：只扫盘、不打开库）。 */
	"story:list": { req: { storiesRoot?: string }; res: StorySummary[] };
	/** 新建故事（内核 openStory）。返回选中故事的 sessionId。 */
	"story:create": {
		req: { storiesRoot?: string; packDirs?: string[]; mode?: StoryMode; title?: string };
		res: { sessionId: string };
	};
	/** 续写：打开已有 session 文件（内核 openStory 的 resume 路径）。 */
	"story:open": {
		req: { storiesRoot?: string; sessionFile: string };
		res: { sessionId: string; mode: StoryMode };
	};
	/** 跑一轮叙事。turnId 由 renderer 生成，是 turn:abort 的把手。 */
	"turn:run": { req: { turnId: string; input: string; force?: boolean }; res: TurnResult };
	/** 中止在飞的一轮（内核 runTurn 的 AbortSignal：中止 = 未完成轮、零落库）。 */
	"turn:abort": { req: { turnId: string }; res: void };
	/** 重骰最后一轮（旧稿留树）。 */
	"turn:swipe": { req: { turnId: string }; res: TurnResult };
	/** 回溯到指定会话条目（内核 session.navigateTree + 快照钩子）。 */
	"tree:navigate": { req: { entryId: string }; res: { clock: string; eventCount: number } };
	/** 从指定条目分叉出新故事（内核 forkFrom）。 */
	"tree:fork": { req: { entryId: string }; res: { sessionId: string } };
	/** 读模型配置（内核 loadSettings；警告随 res 一起回，让 UI 能显示「配置坏了」）。 */
	"settings:read": { req: Record<string, never>; res: { settings: unknown; warnings: string[] } };
	/** 写模型配置（内核 saveSettings：校验先行、绝不覆盖读不懂的文件）。 */
	"settings:write": { req: { settings: unknown }; res: void };
	/** 提示词分层读取（内核 resolvePromptChain：显示「当前生效层」用）。 */
	"prompts:read": { req: { role: string }; res: unknown };
}

export type ChannelName = keyof ChannelMap;
export type ChannelRequest<C extends ChannelName> = ChannelMap[C]["req"];
export type ChannelResponse<C extends ChannelName> = ChannelMap[C]["res"];

/** 单向推送（main → renderer）。 */
export interface PushMap {
	/** 当轮流式增量。**只作「生成中」临时展示**：轮末必须用 turn:done 的终稿覆写
	 *  （stylize 会润色、story 可能打回重写，草稿与终稿可以不同）。 */
	"turn:delta": { turnId: string; text: string };
	/**
	 * pipeline 阶段事件（缺口 6）。
	 * `phase:"start"` 只有 turnSeq/role（那时还不知道成败与耗时）；`phase:"end"` 才带 ok/durationMs。
	 * 渲染进程据此把「阶段进度」显示为进行中/已结束，不必干等整轮结束。
	 */
	"event:pipeline": {
		turnSeq: number;
		role: string;
		phase: "start" | "end";
		ok?: boolean;
		durationMs?: number;
		error?: string;
	};
	/** 轮次收束：带终稿与阶段耗时。 */
	"turn:done": { turnId: string; narrativeText: string; ok: boolean };
	/** 内核告警（onWarning 出口）。 */
	warning: { message: string };
	/** 卡包代码工具发起的轮中交互请求（renderer 呈现后经 interaction:respond 回）。 */
	"interaction:request": { requestId: string; kind: string; prompt: string; payload?: unknown };
	/** 回溯/分叉完成后故事库已换（UI 需重取状态）。 */
	"story:changed": { sessionId: string };
}

export type PushChannelName = keyof PushMap;
export type PushPayload<C extends PushChannelName> = PushMap[C];

/**
 * 轮中交互的回应（renderer → main，兑现内核 broker 的 pending Promise）。
 * **尚未并入 ChannelMap**：并进去就必须有一个真 handler（否则 createIpcHost 启动即失败），
 * 而 studio 目前刻意不挂 broker handler——没挂时卡包工具会按内核既有语义降级（不崩、不挂死）。
 * S1 接通轮中交互时把它作为 channel 加进 ChannelMap 并配 handler。
 */
export const INTERACTION_RESPOND = "interaction:respond" as const;
export type InteractionRespondRequest = { requestId: string; payload: unknown };
