// 渲染进程入口（S1：React + Vite + TS）。
//
// 与 S0 壳的关系：S0 的 shell.js 被本文件取代，但**验收钩子 `__s0Result` 原样保留**——
// 它是 S0 那 14 项判据（含「生成中切故事被拒」「中止后盘上零新增」两条端到端覆盖）的驱动入口，
// 换渲染层不该让已有的回归手段失效。故 ?s0=1 时的行为与 shell.js 逐项对齐。
//
// 两条数据纪律（同 useStudio.ts，此处不重复）在验收脚本里也要遵守：
// 验收读的是 turn:run 的返回值与 turn_log，不是草稿。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createIpcTransport } from "./transport.ts";
import { useStudio } from "./useStudio.ts";
import { App } from "./App.tsx";
import { runS0Acceptance } from "./s0-acceptance.ts";
import type { Transport } from "../contract/index.ts";
import "./styles.css";

function StudioRoot({ transport }: { transport: Transport }) {
	const { state, actions } = useStudio(transport);
	return <App state={state} actions={actions} />;
}

const transport = createIpcTransport();
const container = document.getElementById("root");
if (container === null) throw new Error("DOM 缺 #root 容器");

createRoot(container).render(
	<StrictMode>
		<StudioRoot transport={transport} />
	</StrictMode>,
);

globalThis.__studioReady = true;

// ---- S0 验收钩子（?s0=1 时由主进程驱动；结果放 globalThis.__s0Result）----
// 刻意用裸 transport 而不是 hook：验收要的是「链路通不通」，不是「界面画得对不对」——
// 走 hook 会引入 React 状态更新的时序，让判据依赖渲染时机，那是在测 UI 而不是测契约。
if (new URLSearchParams(location.search).get("s0") === "1") {
	void runS0Acceptance(transport);
}
