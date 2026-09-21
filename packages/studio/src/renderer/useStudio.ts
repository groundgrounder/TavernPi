// 渲染进程的会话状态（React hook）：把 transport 的两条数据流收敛成一个可渲染的状态对象。
//
// 两条数据纪律在此处兑现（这是本文件存在的理由，不是「随便包一层 state」）：
//
//   1. **流式增量只作「生成中」临时展示**。stylize 会润色、story 阶段可能打回重写，草稿 ≠ 终稿。
//      故 delta 写进 `draft`（一个明确标着「还在生成」的字段），轮末由 `turn:done` 的终稿覆写，
//      覆写后 draft 清空、正文改从 turns（turn_log）读。绝不让 draft 冒充正文。
//
//   2. **阅读流的正文事实源是 story.db 的 turn_log**，不是流式草稿、也不是 pi session 转录
//      （转录里留着被弃的稿）。故「打开故事」后主动 `story:turns` 拉取，轮末再次拉取刷新。
//
// 状态的形状刻意保持扁平：UI 只做展示，所有判断（能不能发、要不要禁用按钮）都在这里算完。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StorySummary, TurnLogRow } from "@tavernpi/core";
import type { Transport } from "../contract/index.ts";

/** 一次 pipeline 阶段的状态（start 置为进行中，end 补齐耗时/成败）。 */
export interface PhaseState {
	role: string;
	phase: "start" | "end";
	ok?: boolean;
	durationMs?: number;
	error?: string;
}

export interface StudioState {
	stories: StorySummary[];
	/** 当前打开的故事（sessionId）；未打开为空串。 */
	sessionId: string;
	mode: string;
	/** turn_log 读出的轮次（倒序：最新在前）。这是正文的事实源。 */
	turns: TurnLogRow[];
	turnsTotal: number;
	/** 生成中的流式草稿——只在本轮未收束时非空。 */
	draft: { turnId: string; text: string } | undefined;
	/** 在飞的轮次 id；空串 = 空闲。 */
	inflightTurnId: string;
	/** 最近一个 pipeline 阶段。 */
	phase: PhaseState | undefined;
	logs: Array<{ level: "info" | "ok" | "warn" | "err"; text: string }>;
	warnings: string[];
	loading: boolean;
}

const TURNS_PAGE = 40;

export interface StudioActions {
	refreshStories: () => Promise<StorySummary[]>;
	createStory: () => Promise<void>;
	openStory: (story: StorySummary) => Promise<void>;
	send: (input: string) => Promise<void>;
	abort: () => Promise<void>;
	swipe: () => Promise<void>;
	loadMoreTurns: () => Promise<void>;
}

export function useStudio(transport: Transport): { state: StudioState; actions: StudioActions } {
	const [stories, setStories] = useState<StorySummary[]>([]);
	const [sessionId, setSessionId] = useState("");
	const [mode, setMode] = useState("");
	const [turns, setTurns] = useState<TurnLogRow[]>([]);
	const [turnsTotal, setTurnsTotal] = useState(0);
	const [draft, setDraft] = useState<{ turnId: string; text: string } | undefined>(undefined);
	const [inflightTurnId, setInflightTurnId] = useState("");
	const [phase, setPhase] = useState<PhaseState | undefined>(undefined);
	const [logs, setLogs] = useState<StudioState["logs"]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);

	// 订阅回调里要读到**最新**的 inflightTurnId（闭包会捕获旧值）——
	// 这正是「delta 认错轮次、把上一轮的尾巴画进本轮」这类 bug 的成因，故用 ref 兜住。
	const inflightRef = useRef("");
	inflightRef.current = inflightTurnId;

	const log = useCallback((level: StudioState["logs"][number]["level"], text: string) => {
		setLogs((prev) => [...prev, { level, text }]);
	}, []);

	// ---- 推送订阅：整个 hook 生命周期只挂一次 ----
	useEffect(() => {
		const offs: Array<() => void> = [];
		offs.push(
			transport.subscribe("turn:delta", (payload) => {
				const p = payload as { turnId: string; text: string };
				// 认轮次：上一个轮次的尾巴不该画进这一轮。
				if (p.turnId !== inflightRef.current) return;
				setDraft((prev) => (prev?.turnId === p.turnId ? { turnId: p.turnId, text: prev.text + p.text } : { turnId: p.turnId, text: p.text }));
			}),
		);
		offs.push(
			transport.subscribe("event:pipeline", (payload) => {
				setPhase(payload as PhaseState);
			}),
		);
		offs.push(
			transport.subscribe("turn:done", (payload) => {
				const p = payload as { turnId: string; ok: boolean };
				// 轮末：丢掉草稿（它可能已被 stylize/打回改过），正文改由 turn_log 提供。
				setDraft(undefined);
				setPhase(undefined);
				if (!p.ok) log("warn", "本轮未完成（已中止或失败），零落库。");
			}),
		);
		offs.push(
			transport.subscribe("warning", (payload) => {
				const p = payload as { message: string };
				setWarnings((prev) => [...prev, p.message]);
				log("warn", `告警：${p.message}`);
			}),
		);
		offs.push(
			transport.subscribe("story:changed", (payload) => {
				const p = payload as { sessionId: string };
				setSessionId(p.sessionId);
			}),
		);
		return () => {
			for (const off of offs) off();
		};
	}, [transport, log]);

	/** 读 turn_log（正文事实源）。倒序，最新在前。 */
	const loadTurns = useCallback(
		async (limit: number) => {
			try {
				const res = await transport.request("story:turns", { limit });
				setTurns(res.turns);
				setTurnsTotal(res.total);
			} catch (err) {
				log("err", `读轮次失败：${err instanceof Error ? err.message : String(err)}`);
			}
		},
		[transport, log],
	);

	const refreshStories = useCallback(async () => {
		const list = await transport.request("story:list", {});
		setStories(list);
		return list;
	}, [transport]);

	const createStory = useCallback(async () => {
		setLoading(true);
		try {
			const created = await transport.request("story:create", {});
			setSessionId(created.sessionId);
			setMode(created.mode);
			setTurns([]);
			setTurnsTotal(0);
			log("ok", `新故事 ${created.sessionId}（模式 ${created.mode}）`);
			await refreshStories();
		} catch (err) {
			log("err", `新建失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setLoading(false);
		}
	}, [transport, refreshStories, log]);

	const openStory = useCallback(
		async (story: StorySummary) => {
			if (story.sessionFile === undefined) {
				log("warn", `这个故事还没跑过任何轮次，没有会话文件可续写：${story.sessionId}`);
				return;
			}
			setLoading(true);
			try {
				const opened = await transport.request("story:open", { sessionFile: story.sessionFile });
				setSessionId(opened.sessionId);
				setMode(opened.mode);
				// 打开即从 DB 拉正文——阅读流的事实源是 turn_log。
				await loadTurns(TURNS_PAGE);
				log("ok", `已打开 ${opened.sessionId}（模式 ${opened.mode}）`);
			} catch (err) {
				log("err", `打开失败：${err instanceof Error ? err.message : String(err)}`);
			} finally {
				setLoading(false);
			}
		},
		[transport, loadTurns, log],
	);

	const send = useCallback(
		async (input: string) => {
			if (input.trim() === "" || inflightRef.current !== "") return;
			const turnId = `turn-${Date.now()}`;
			setInflightTurnId(turnId);
			setDraft({ turnId, text: "" });
			try {
				const result = await transport.request("turn:run", { turnId, input });
				log("ok", `第 ${result.turnSeq} 轮完成 · ${result.narrativeText.length} 字 · 快照 ${result.snapshotTaken ? "已拍" : "未拍"}`);
			} catch (err) {
				log("err", `本轮失败：${err instanceof Error ? err.message : String(err)}`);
			} finally {
				setInflightTurnId("");
				// 轮末从 DB 重取：正文以落库的终稿为准（草稿可能被改过）。
				await loadTurns(TURNS_PAGE);
			}
		},
		[transport, loadTurns, log],
	);

	const abort = useCallback(async () => {
		const turnId = inflightRef.current;
		if (turnId === "") return;
		try {
			await transport.request("turn:abort", { turnId });
			log("warn", "已请求中止（本轮零落库）");
		} catch (err) {
			log("err", `中止失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}, [transport, log]);

	const swipe = useCallback(async () => {
		if (inflightRef.current !== "") return;
		const turnId = `swipe-${Date.now()}`;
		setInflightTurnId(turnId);
		setDraft({ turnId, text: "" });
		try {
			const result = await transport.request("turn:swipe", { turnId });
			log("ok", `重骰完成 · ${result.narrativeText.length} 字`);
		} catch (err) {
			log("err", `重骰失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setInflightTurnId("");
			await loadTurns(TURNS_PAGE);
		}
	}, [transport, loadTurns, log]);

	const loadMoreTurns = useCallback(async () => {
		await loadTurns(turns.length + TURNS_PAGE);
	}, [loadTurns, turns.length]);

	// 首屏拉故事列表。
	useEffect(() => {
		void refreshStories().catch((err: unknown) => {
			log("err", `列故事失败：${err instanceof Error ? err.message : String(err)}`);
		});
	}, [refreshStories, log]);

	const state = useMemo<StudioState>(
		() => ({
			stories,
			sessionId,
			mode,
			turns,
			turnsTotal,
			draft,
			inflightTurnId,
			phase,
			logs,
			warnings,
			loading,
		}),
		[stories, sessionId, mode, turns, turnsTotal, draft, inflightTurnId, phase, logs, warnings, loading],
	);

	return {
		state,
		actions: { refreshStories, createStory, openStory, send, abort, swipe, loadMoreTurns },
	};
}
