// studio 主界面（S1）：故事列表 → 阅读流 → 输入 → 中止/重骰。
//
// 本文件只管**呈现**：所有状态与数据纪律在 useStudio.ts 里。UI 不做判断，只读 state 画。

import { useEffect, useRef, useState } from "react";
import type { StudioActions, StudioState } from "./useStudio.ts";

function formatTime(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function App({ state, actions }: { state: StudioState; actions: StudioActions }) {
	const [input, setInput] = useState("");
	const logRef = useRef<HTMLDivElement>(null);
	const busy = state.inflightTurnId !== "";

	// 日志跟随底部（只在有日志时滚，避免抢走用户阅读流的位置）。
	useEffect(() => {
		const node = logRef.current;
		if (node !== null) node.scrollTop = node.scrollHeight;
	}, [state.logs.length]);

	const submit = () => {
		const text = input;
		setInput("");
		void actions.send(text);
	};

	return (
		<div className="studio">
			<header>
				<h1>tavern studio</h1>
				<span className="muted">S1（内核同进程 · 不走 RPC）</span>
				<span className="muted">session</span>
				<span className="muted mono">{state.sessionId === "" ? "—" : state.sessionId}</span>
				<span className="muted">{state.mode === "" ? "" : `模式 ${state.mode}`}</span>
				<span className="phase">
					{state.phase === undefined
						? ""
						: state.phase.phase === "start"
							? `阶段 ${state.phase.role} · 进行中`
							: `阶段 ${state.phase.role} · ${state.phase.durationMs ?? 0}ms${state.phase.ok === false ? "（失败）" : ""}`}
				</span>
			</header>

			<aside>
				<div className="aside-head">
					<span>
						故事（<span>{state.stories.length}</span>）
					</span>
					<button type="button" onClick={() => void actions.createStory()} disabled={busy || state.loading}>
						新建故事
					</button>
				</div>
				<div className="stories">
					{state.stories.length === 0 ? (
						<div className="muted pad">（没有故事，点「新建故事」）</div>
					) : (
						state.stories.map((story) => (
							<button
								type="button"
								key={story.sessionId}
								className={story.sessionId === state.sessionId ? "story active" : "story"}
								onClick={() => void actions.openStory(story)}
								disabled={busy || state.loading}
							>
								<span className="story-title">{story.title ?? "未命名"}</span>
								<span className="muted small">
									{story.mode} · {story.sessionId.slice(0, 8)}
									{story.sessionFile === undefined ? " · 无会话文件" : ""}
								</span>
								<span className="muted small">{formatTime(story.updatedAt)}</span>
							</button>
						))
					)}
				</div>
			</aside>

			<main>
				<div className="turns">
					{state.turns.length === 0 && state.draft === undefined ? (
						<div className="muted pad">
							{state.sessionId === "" ? "选择或新建一个故事开始。" : "还没有轮次。发一句开始。"}
						</div>
					) : null}

					{/* 生成中的草稿排在最上（因为轮次是倒序的，最新在最前）。 */}
					{state.draft !== undefined ? (
						<article className="turn assistant streaming">
							<div className="turn-body">{state.draft.text === "" ? "……" : state.draft.text}</div>
							<div className="turn-meta muted small">生成中（草稿，轮末以落库终稿为准）</div>
						</article>
					) : null}

					{state.turns.map((turn) => (
						<article className="turn assistant" key={turn.turn_seq}>
							<div className="turn-input muted">{turn.user_input}</div>
							<div className="turn-body">{turn.narrative_text}</div>
							<div className="turn-meta muted small">
								第 {turn.turn_seq} 轮 · 落库正文 {turn.narrative_text.length} 字
								{turn.warnings === null ? "" : " · 有告警"}
							</div>
						</article>
					))}

					{state.turns.length < state.turnsTotal ? (
						<button type="button" className="more" onClick={() => void actions.loadMoreTurns()}>
							载入更早的轮次（{state.turns.length} / {state.turnsTotal}）
						</button>
					) : null}
				</div>

				<div className="log" ref={logRef}>
					{state.logs.map((line, i) => (
						<div className={`line ${line.level}`} key={`${i}-${line.text}`}>
							{line.text}
						</div>
					))}
				</div>
			</main>

			<footer>
				<input
					type="text"
					value={input}
					placeholder="输入行动或对话，Ctrl/⌘+Enter 发送"
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
					}}
					disabled={state.sessionId === ""}
				/>
				<button type="button" onClick={submit} disabled={busy || state.sessionId === ""}>
					发送
				</button>
				<button type="button" onClick={() => void actions.swipe()} disabled={busy || state.sessionId === ""}>
					重骰
				</button>
				<button type="button" className="danger" onClick={() => void actions.abort()} disabled={!busy}>
					中止
				</button>
			</footer>
		</div>
	);
}
