// S0 验收（渲染进程侧）：从 shell.js 原样移植，驱动方式与判据字段**保持不变**。
//
// 为什么移植而不是重写：s0-acceptance.ts（主进程侧）按字段名读这份报告，且已实测 14 项全绿。
// 换渲染层时改判据字段 = 把「回归」变成「重新设计一套测试」，S0 的既有覆盖就白丢了。
// 故这里的每个字段、每条流程（含两处刻意的探针）都与 shell.js 对齐，只把 DOM 操作换成纯 transport 调用。
//
// 刻意不走 React：验收测的是「渲染进程 → preload → IPC → main → 内核 → SQLite」这条链路，
// 而不是 React 的状态流转。混进 hook 会让判据依赖渲染时机，那是在测 UI 不是测契约。

import type { Transport } from "../contract/index.ts";

/** 与 s0-acceptance.ts 的 RendererReport 逐字段对应——改这里必须同步改那边。 */
interface S0Report {
	ok: boolean;
	error?: string;
	storiesBefore: number;
	sessionId: string;
	mode: string;
	turnSeq: number;
	narrativeChars: number;
	narrativeText: string;
	snapshotTaken: boolean;
	deltas: number;
	deltaChars: number;
	doneEvents: number;
	pipelineRoles: string[];
	listedSessionFile: boolean;
	reopenedSessionId: string;
	reopenedMode: string;
	switchWhileStreaming: string;
	abortRequest: string;
	abortOutcome: string;
	warnings: string[];
	elapsedMs: number;
}

const query = new URLSearchParams(location.search);
const storiesRoot = query.get("storiesRoot") ?? undefined;

/** 带上 storiesRoot（验收跑在临时目录，绝不写进用户真实故事库）。 */
function withRoot<T extends Record<string, unknown>>(payload: T): T & { storiesRoot?: string } {
	return storiesRoot !== undefined ? { ...payload, storiesRoot } : payload;
}

export async function runS0Acceptance(transport: Transport): Promise<void> {
	const started = Date.now();
	const deltas = { n: 0, chars: 0 };
	const pipelineRoles = new Set<string>();
	const warnings: string[] = [];
	let doneEvents = 0;
	let currentTurnId: string | undefined;

	transport.subscribe("turn:delta", (payload) => {
		const p = payload as { turnId: string; text: string };
		// 只统计当前轮的（与 shell.js 一致：流式增量按 turnId 认轮）。
		if (currentTurnId !== undefined && p.turnId !== currentTurnId) return;
		deltas.n++;
		deltas.chars += p.text.length;
	});
	transport.subscribe("event:pipeline", (payload) => pipelineRoles.add((payload as { role: string }).role));
	transport.subscribe("turn:done", () => {
		doneEvents++;
	});
	transport.subscribe("warning", (payload) => warnings.push((payload as { message: string }).message));

	const fail = (err: unknown): S0Report => ({
		ok: false,
		error: err instanceof Error ? err.message : String(err),
		storiesBefore: 0,
		sessionId: "",
		mode: "",
		turnSeq: -1,
		narrativeChars: 0,
		narrativeText: "",
		snapshotTaken: false,
		deltas: deltas.n,
		deltaChars: deltas.chars,
		doneEvents,
		pipelineRoles: [...pipelineRoles],
		listedSessionFile: false,
		reopenedSessionId: "",
		reopenedMode: "",
		switchWhileStreaming: "",
		abortRequest: "",
		abortOutcome: "",
		warnings,
		elapsedMs: Date.now() - started,
	});

	try {
		const storiesBefore = (await transport.request("story:list", withRoot({}))).length;
		const created = await transport.request("story:create", withRoot({}));

		const turnId = `s0-${Date.now()}`;
		currentTurnId = turnId;
		const result = await transport.request("turn:run", withRoot({ turnId, input: "我推门而入，环顾四周。" }));
		currentTurnId = undefined;

		// 续写路径也过一遍（不花模型调用）：list 给出的会话文件必须能直接喂给 story:open。
		const after = await transport.request("story:list", withRoot({}));
		const listed = after.find((s) => s.sessionId === created.sessionId);
		const reopened =
			listed !== undefined && listed.sessionFile !== undefined
				? await transport.request("story:open", withRoot({ sessionFile: listed.sessionFile }))
				: undefined;

		// ---- 阶段 2：并发守卫 + 中止（缺口 1「零落库」的唯一端到端覆盖）----
		// 开一轮不 await，趁生成中做两件事：① 试切故事（必须被拒）；② 中止它。
		const turnId2 = `s0-abort-${Date.now()}`;
		currentTurnId = turnId2;
		const pending2 = transport.request("turn:run", withRoot({ turnId: turnId2, input: "我继续往里走。" }));
		const switchWhileStreaming = await transport
			.request("story:create", withRoot({}))
			.then(() => "allowed（缺陷：生成中竟允许切故事，在飞 runtime 会被 dispose）")
			.catch((e: unknown) => String(e instanceof Error ? e.message : e));
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const abortRequest = await transport
			.request("turn:abort", { turnId: turnId2 })
			.then(() => "accepted")
			.catch((e: unknown) => `failed: ${e instanceof Error ? e.message : e}`);
		const abortOutcome = await pending2
			.then(() => "resolved（缺陷：中止后仍按成功返回）")
			.catch((e: unknown) => String(e instanceof Error ? e.message : e));
		currentTurnId = undefined;

		const report: S0Report = {
			ok: true,
			storiesBefore,
			sessionId: created.sessionId,
			mode: created.mode,
			turnSeq: result.turnSeq,
			narrativeChars: result.narrativeText.length,
			narrativeText: result.narrativeText,
			snapshotTaken: result.snapshotTaken,
			deltas: deltas.n,
			deltaChars: deltas.chars,
			doneEvents,
			pipelineRoles: [...pipelineRoles],
			listedSessionFile: listed !== undefined && listed.sessionFile !== undefined,
			reopenedSessionId: reopened !== undefined ? reopened.sessionId : "",
			reopenedMode: reopened !== undefined ? reopened.mode : "",
			switchWhileStreaming,
			abortRequest,
			abortOutcome,
			warnings,
			elapsedMs: Date.now() - started,
		};
		globalThis.__s0Result = report;
	} catch (err) {
		globalThis.__s0Result = fail(err);
	}
}

declare global {
	// eslint-disable-next-line no-var
	var __studioReady: boolean;
	// eslint-disable-next-line no-var
	var __s0Result: S0Report | undefined;
}
