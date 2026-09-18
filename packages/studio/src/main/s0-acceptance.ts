// S0 收尾验收（主进程侧）：空壳 app 里真跑「列故事 → 新建 → 发一轮（真 LLM）」，判据取盘上 story.db。
//
// 分工是刻意的：
//   · **渲染进程**执行流程（`window.__s0Result`，由 ?s0=1 触发），全程走 preload → IPC → main → 内核
//     —— 这条链路本身就是要验的东西；
//   · **主进程**只做两件事：等结果、并**独立**核对盘上数据库（raw SQLite 直读，不复用内核读取路径，
//     免得「用被验对象证明自己」）。
// 断言：turn_log 出现本轮行、narrative_text 与渲染进程收到的终稿逐字符一致、快照落了一份。

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserWindow } from "electron";
import type { StudioSession } from "./session.ts";

export interface S0Args {
	storiesRoot: string;
}

/**
 * 解析 `--s0-accept [--stories-root <dir>]`。
 * 默认给一个全新的临时目录：验收**绝不**写进用户真实故事库（`~/.tavernpi/stories`）。
 */
export function parseS0Args(argv: readonly string[]): S0Args | undefined {
	if (!argv.includes("--s0-accept")) return undefined;
	const idx = argv.indexOf("--stories-root");
	const given = idx >= 0 ? argv[idx + 1] : undefined;
	const storiesRoot = given !== undefined && given !== "" ? given : mkdtempSync(join(tmpdir(), "tavernpi-s0-"));
	return { storiesRoot };
}

interface RendererReport {
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
	warnings: string[];
	elapsedMs: number;
}

/** 轮询渲染进程结果。真 LLM 单轮实测可达 200 秒，故超时给足。 */
async function awaitRendererReport(win: BrowserWindow, timeoutMs: number): Promise<RendererReport> {
	const started = Date.now();
	for (;;) {
		const raw = (await win.webContents.executeJavaScript(
			"JSON.stringify(globalThis.__s0Result ?? null)",
		)) as string;
		const parsed = JSON.parse(raw) as RendererReport | null;
		if (parsed !== null) return parsed;
		if (Date.now() - started > timeoutMs) {
			throw new Error(`渲染进程未在 ${Math.round(timeoutMs / 1000)} 秒内产出验收结果`);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/** 独立读盘：不复用内核读取路径。 */
function readDbEvidence(storyDir: string): {
	turns: Array<{ turnSeq: number; userInput: string; narrativeText: string }>;
	events: number;
	snapshotBytes: number;
} {
	const db = new DatabaseSync(join(storyDir, "story.db"));
	try {
		const rows = db
			.prepare("SELECT turn_seq, user_input, narrative_text FROM turn_log ORDER BY turn_seq")
			.all() as Array<{ turn_seq: number; user_input: string; narrative_text: string }>;
		const events = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
		return {
			turns: rows.map((r) => ({ turnSeq: r.turn_seq, userInput: r.user_input, narrativeText: r.narrative_text })),
			events: events.c,
			snapshotBytes: safeSize(join(storyDir, "snapshots.db")),
		};
	} finally {
		db.close();
	}
}

function safeSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export async function runS0Acceptance(ctx: {
	win: BrowserWindow;
	session: StudioSession;
	storiesRoot: string;
}): Promise<number> {
	const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
	const report = await awaitRendererReport(ctx.win, 300_000);

	checks.push({ name: "渲染进程流程完成", ok: report.ok, ...(report.error !== undefined ? { detail: report.error } : {}) });
	checks.push({ name: "流式增量到达渲染进程", ok: report.deltas > 0, detail: `${report.deltas} 片 / ${report.deltaChars} 字` });
	checks.push({ name: "轮末 turn:done 推送到达（终稿覆写路径）", ok: report.doneEvents >= 1, detail: `${report.doneEvents} 次` });
	checks.push({
		name: "pipeline 事件到达渲染进程",
		ok: report.pipelineRoles.includes("narrator"),
		detail: report.pipelineRoles.join(","),
	});

	const storyDir = join(ctx.storiesRoot, report.sessionId);
	const db = readDbEvidence(storyDir);
	checks.push({ name: "turn_log 含本轮行", ok: db.turns.some((t) => t.turnSeq === report.turnSeq) });
	const row = db.turns.find((t) => t.turnSeq === report.turnSeq);
	checks.push({
		name: "盘上终稿与渲染进程收到的终稿逐字符一致",
		ok: row !== undefined && row.narrativeText === report.narrativeText,
		detail: row === undefined ? "无对应行" : `盘上 ${row.narrativeText.length} 字 / 渲染 ${report.narrativeText.length} 字`,
	});
	checks.push({ name: "本轮落了快照", ok: report.snapshotTaken && db.snapshotBytes > 0, detail: `snapshots.db ${db.snapshotBytes}B` });
	checks.push({ name: "data 阶段落库（事件表非空）", ok: db.events > 0, detail: `${db.events} 条事件` });
	checks.push({ name: "story:list 给出会话文件路径", ok: report.listedSessionFile });
	checks.push({
		name: "story:open 续写路径打通（sessionId 一致）",
		ok: report.reopenedSessionId === report.sessionId,
		detail: report.reopenedSessionId === "" ? "未打开" : `${report.reopenedSessionId} · ${report.reopenedMode}`,
	});

	const ok = checks.every((c) => c.ok);
	console.log(
		`S0_SHELL_RESULT ${JSON.stringify(
			{
				ok,
				renderer: {
					sessionId: report.sessionId,
					mode: report.mode,
					storiesBefore: report.storiesBefore,
					turnSeq: report.turnSeq,
					narrativeChars: report.narrativeChars,
					deltas: report.deltas,
					pipelineRoles: report.pipelineRoles,
					reopenedSessionId: report.reopenedSessionId,
					elapsedMs: report.elapsedMs,
				},
				db: { turns: db.turns.length, events: db.events, snapshotBytes: db.snapshotBytes },
				checks,
			},
			null,
			2,
		)}`,
	);
	return ok ? 0 : 1;
}
