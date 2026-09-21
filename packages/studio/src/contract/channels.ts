// studio 的唯一契约面（renderer ↔ main）。channel 名与载荷类型**只在这里定义一次**，
// main 侧与 renderer 侧都从这里 import——否则两条通道（生产 IPC / 开发 WS）与两侧实现必然漂移。
//
// 三条纪律：
//   1. 载荷类型引用 @tavernpi/core 的导出类型。`import type` 在类型剥离时被抹掉，**不会**把内核
//      打渲染进程的包里，所以类型可以放心共用；值导入不行（见第 2 条）。
//   2. renderer **不得值导入** @tavernpi/core：模式过滤（DbView）、唯一写路径（trustedWrite）、
//      快照恢复全在 main 侧的内核实例里。绕过它等于绕开内核信任边界。
//      test/boundary.test.ts 扫源码钉住这条，别只写在文档里。
//   3. 只登记「内核已有 API 支撑」的 channel。内核还缺的能力不在这里预先设计——接口等实现，不等想象。
//      缺口 1–12 已全部补齐，故 `story:turns`（turn_log 阅读流）与 `db:query`（缺口 3 的通用只读查询）
//      现在可以登记了；`interaction:respond` 仍刻意留在 ChannelMap 之外，理由见文件末尾。

import type { StoryMode, StorySummary, TableInfo, TablePage, TurnLogRow, TurnResult } from "@tavernpi/core";

/** 请求-响应（renderer → main）。 */
export interface ChannelMap {
	/** 故事枚举（内核 listStories：只扫盘、不打开库）。 */
	"story:list": { req: { storiesRoot?: string }; res: StorySummary[] };
	/**
	 * 阅读流：从**当前已打开故事**的 `story.db.turn_log` 分页取正文。
	 * 正文的事实源是 turn_log，不是 pi session 转录——两者在 stylize 润色/打回重写后可以不同。
	 * 从末尾倒序读：`offset:0` = 最新一轮，正好对上「打开故事先看结尾」的阅读习惯。
	 */
	"story:turns": {
		req: { limit?: number; offset?: number; order?: "asc" | "desc" };
		res: { turns: TurnLogRow[]; total: number; limit: number; offset: number };
	};
	/**
	 * 通用只读表查询（内核缺口 3：listTableInfos / DbView.queryTable）。
	 * `filter:"user"` 走冒险视图过滤（非内核表按 related 集合净化），`filter:"none"` 全量透传。
	 * 未打开故事时**不抛错**，回一个空页 —— 浏览器的空态由 UI 表达，不该走错误通道。
	 */
	"db:query": {
		req: {
			/** 不传则回表清单（内核 listTableInfos），传了则回该表一页。 */
			table?: string;
			limit?: number;
			offset?: number;
			orderBy?: string;
			descending?: boolean;
			equals?: Record<string, string | number | null>;
			filter?: "none" | "user";
		};
		res: { tables?: TableInfo[]; page?: TablePage };
	};
	/** 新建故事（内核 openStory）。返回选中故事的 sessionId 与生效模式。 */
	"story:create": {
		req: { storiesRoot?: string; packDirs?: string[]; mode?: StoryMode; title?: string };
		res: { sessionId: string; mode: StoryMode };
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
