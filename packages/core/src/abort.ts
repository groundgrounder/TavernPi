// 中止桥（缺口 1）：把调用侧的 AbortSignal 接到一个「启动后自己没有取消口」的异步操作上。
//
// 存在的理由：pi 的 `session.prompt()` 没有 signal 选项，只能侧向调 `session.abort()`
// （其内部 agent.abort() + 等空闲）。本模块把这段胶水收成单一实现，好让「中止语义」能脱离
// 真实模型被断言（层 1），而不是散在回合循环里只靠肉眼看。
//
// 语义（四条，测试逐条钉住）：
//   1. 入场即已中止 → 直接抛 TurnAbortedError，**不启动操作**；
//   2. 操作在飞期间信号触发 → 调 onAbort()（每轮至多一次）；
//   3. 操作返回后仍处中止态（signal.aborted 或 aborted() 自判）→ 抛 TurnAbortedError；
//   4. 监听器只覆盖「操作在飞」这段窗口，结束即解绑——长寿 signal 上不留监听器，
//      否则上一轮的中止信号会打到下一轮（挂一次解一次的纪律）。

/** 本轮被中止（未完成轮）：零落库——不写 turn_log、不拍快照、不跑后续阶段、不消耗 turn_seq。 */
export class TurnAbortedError extends Error {
	constructor(message = "本轮已中止（调用侧 AbortSignal），本轮未落库") {
		super(message);
		this.name = "TurnAbortedError";
	}
}

export interface AbortBridge {
	/** 调用侧的中止信号；缺省 = 不接中止（行为与从前完全一致）。 */
	signal?: AbortSignal;
	/** 真正跑的操作（如 session.prompt）。 */
	run: () => Promise<void>;
	/** 信号触发时的侧向中止调用（如 session.abort）；抛错由本模块吞掉，不影响操作本身收敛。 */
	onAbort: () => void;
	/** 操作返回后自行判定「这轮是否已被中止」（如 pi 标记的 stopReason === "aborted"）。 */
	aborted?: () => boolean;
}

/**
 * 跑操作并把中止信号接上。中止时抛 TurnAbortedError（调用侧据此呈现「已中止」并零落库）。
 * 非中止的故障照原样上抛——别把真故障混进「用户按了停止」里被咽掉。
 */
export async function runWithAbort(bridge: AbortBridge): Promise<void> {
	const { signal, run, onAbort, aborted } = bridge;
	// 包成函数读取：await 之后 signal.aborted 可能已经变了，而 TS 会把跨 await 的窄化沿用下来
	// （早退那处的 === true 判定会让末尾的比较变成「无交集」）。语义上这里每次都要现取。
	const isAborted = (): boolean => signal?.aborted === true;
	if (isAborted()) {
		throw new TurnAbortedError();
	}
	const handler = (): void => {
		onAbort();
	};
	signal?.addEventListener("abort", handler, { once: true });
	try {
		await run();
	} finally {
		signal?.removeEventListener("abort", handler);
	}
	if (isAborted() || aborted?.() === true) {
		throw new TurnAbortedError();
	}
}
