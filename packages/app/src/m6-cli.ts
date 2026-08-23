// M6 交互 CLI（人工验收入口，创作规划 §10.1 三模式 + §8 决策记录「输入渠道校验判定」）：模式切换 + 输入校验叙事循环。
//
// 与 m5-cli 的关系：命令/LineQueue/fork 重建全同，差异是内核级模式连通——
//   新故事经 createStory 传 mode（仅创建时有效）；runtime 模式解析（option → story.meta.json → creation）；
//   `/mode` 查看/切换模式（catch 非法切换错）；`/plot` 创造模式专属（剧情大纲指令）；
//   用户输入以 `/! ` 开头 → 去前缀 + force:true（输入渠道校验强制提交，留痕 warning）；
//   catch InputRejectedError → 打印 reason/suggestion（叙事不产生）；`--resume` 从 meta 恢复 mode。
// 目的：验收 §10.1 契约——三模式预设/切换规则/adventure 锁定/fork 继承模式；§8 输入渠道校验
//   （生存/冒险拒非 user 输入、`/!` 强制提交、创造不校验、/plot 指令）。
//
// 接线（app 层只消费 core API）：
//   SessionManager ↔ StoryDb ↔ SnapshotsDb ↔ createStoryRuntime（§10.2 API 面 + mode + story/npc/stylize/data）
// 全部 subagent 阶段默认全开——creation 下 story 开任意组合合法、survival 仅 stylize 可关、adventure 全开，
//   全开组合在三种模式下均合法（build-time 校验不报错）。
//
// 坑（同 m4/m5-cli）：session.prompt 必须 await 完才能 navigateTree；退出不删故事目录。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildAncestorChain,
	computeNextTurnSeq,
	createPipelineEventLog,
	createStory,
	createStoryRuntime,
	defaultGlobalPromptsDir,
	defaultStoriesRoot,
	forkStoryDb,
	inheritStoryMeta,
	loadSettings,
	openSnapshotsDb,
	openStoryDb,
	snapshotsDbPath,
	storyDbPath as coreStoryDbPath,
	type PromptLayerDirs,
	type SnapshotRestoreResult,
	type StoryMetaFile,
	type StoryMode,
	type StoryRuntime,
	type StoryState,
	type StylizeRuntimeOptions,
	type TavernSettings,
	type TurnResult,
} from "@tavernpi/core";
import { InputRejectedError } from "@tavernpi/core";

// ---------------------------------------------------------------------------
// 常量与参数
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, "../../..");
const MODE_SET: readonly StoryMode[] = ["creation", "survival", "adventure"];

interface CliArgs {
	root?: string;
	resume?: string;
	pack: string[];
	mode?: StoryMode;
	style?: string;
}

interface CliCtx {
	storiesRoot: string;
	cwd: string;
	settings: TavernSettings;
	modelRuntime: ModelRuntime;
	prompts: PromptLayerDirs;
	/** 文风（--style；stylize 阶段全开，styleHint 供其使用）。 */
	style?: string;
}

/** 全开 combo：story/npc 必开，stylize 全开（adventure 须全开；creation/survival 全开也合法）。 */
function runtimeExtras(ctx: CliCtx): {
	npc: { enabled: boolean };
	story: { enabled: boolean };
	stylize?: StylizeRuntimeOptions;
} {
	return {
		npc: { enabled: true },
		story: { enabled: true },
		stylize: { enabled: true, ...(ctx.style ? { styleHint: ctx.style } : {}) },
	};
}

// ---------------------------------------------------------------------------
// 文本/转录工具（沿 m5-cli）
// ---------------------------------------------------------------------------

function messageText(message: { role: string; content?: unknown }): string {
	if (Array.isArray(message.content)) {
		return (message.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

function messageEntries(sessionManager: SessionManager): Array<Extract<SessionEntry, { type: "message" }>> {
	return sessionManager.getEntries().filter((e) => e.type === "message") as Array<
		Extract<SessionEntry, { type: "message" }>
	>;
}

function resolveTreeTarget(sessionManager: SessionManager, arg: string): Extract<SessionEntry, { type: "message" }> {
	const entries = messageEntries(sessionManager);
	if (/^\d+$/.test(arg)) {
		const idx = Number(arg);
		const entry = entries[idx - 1];
		if (!entry) throw new Error(`序号 ${arg} 超出范围（共 ${entries.length} 条消息）`);
		return entry;
	}
	const hit = entries.find((e) => e.id.startsWith(arg));
	if (!hit) throw new Error(`找不到 entry id 前缀: ${arg}`);
	return hit;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function readStoryMeta(storyDir: string): StoryMetaFile | undefined {
	try {
		return JSON.parse(readFileSync(join(storyDir, "story.meta.json"), "utf8")) as StoryMetaFile;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// CLI 命令（沿 m5-cli，增 /mode /plot）
// ---------------------------------------------------------------------------

function printTree(sessionManager: SessionManager): void {
	const entries = messageEntries(sessionManager);
	const leafId = sessionManager.getLeafId();
	console.log(`--- branch（${entries.length} 条消息）---`);
	for (const [i, e] of entries.entries()) {
		const mark = e.id === leafId ? " *" : "";
		const text = truncate(messageText(e.message), 40);
		console.log(`#${i + 1} [${e.message.role}]${mark} ${text}  (${e.id.slice(0, 8)})`);
	}
}

function printRestoreResult(result: SnapshotRestoreResult | undefined, runtime: ReturnType<typeof createStoryRuntime> extends Promise<infer T> ? T : never): void {
	const clock = runtime.storyState.storyDb.reader.getClock();
	const events = runtime.storyState.storyDb.reader.listEvents();
	if (result === undefined) {
		console.log("> 恢复结果: 未执行（无钩子状态）");
	} else if (!result.ok) {
		console.log(`> 恢复失败: ${result.error ?? "未知错误"}`);
	} else if (result.restoredTurnSeq !== undefined) {
		console.log(`> 恢复成功: turn${result.restoredTurnSeq}（entry ${result.restoredEntryId}）`);
	} else {
		console.log("> 恢复成功（空库兜底，§3.1）");
	}
	console.log(`> 当前 clock: ${clock?.current_time ?? "(未初始化)"}，events: ${events.length} 行`);
}

function printStatus(runtime: ReturnType<typeof createStoryRuntime> extends Promise<infer T> ? T : never): void {
	const { sessionManager, storyState } = runtime;
	const clock = storyState.storyDb.reader.getClock();
	const events = storyState.storyDb.reader.listEvents();
	const turns = storyState.storyDb.reader.getTurnLog();
	const snaps = storyState.snapshotsDb.listSnapshots();
	const dataStatus = storyState.storyDb.reader.listDataStatus();
	console.log("--- status ---");
	console.log(`sessionId: ${sessionManager.getSessionId()}`);
	console.log(`sessionFile: ${sessionManager.getSessionFile()}`);
	console.log(`leafId: ${sessionManager.getLeafId()}`);
	console.log(`storyDir: ${storyState.storyDir}`);
	console.log(`mode: ${runtime.mode}`);
	console.log(`clock: ${clock ? `${clock.current_time}（${clock.calendar}/${clock.granularity}）` : "(未初始化)"}`);
	console.log(
		`events: ${events.length} 行 | turn_log: ${turns.length} 行 | snapshots: ${snaps.length} 份 | data_status: ${dataStatus.length} 行`,
	);
}

function printHelp(): void {
	console.log(
		[
			"可用命令：",
			"  /tree              列出当前 branch 的消息条目",
			"  /tree <序号|entryId>  跳转到目标条目（钩子自动恢复 DB）",
			"  /fork <序号|entryId>  从目标条目分叉新故事（fork 产物继承 mode，adventure 继承锁定）",
			"  /status            打印 sessionId / mode / clock / 行数",
			"  /mode              查看当前内核级模式（creation/survival/adventure）",
			"  /mode <模式>         切换模式（catch 非法切换错；adventure 锁定不可切）",
			"  /plot <文本>         创造模式专属：写入剧情大纲指令（生存/冒险报错）",
			"  /help              本帮助",
			"  空行               退出（不删故事目录，可 --resume 续写）",
			"",
			"模式（§10.1）：--mode creation|survival|adventure 仅创建时生效；--resume 从 story.meta.json 恢复。",
			"输入校验（§8）：生存/冒险拒非 user 角色输入（命令 NPC/指定剧情结局）→ 打印 reason/suggestion，",
			"  可用 /! 前缀强制提交（留痕 warning）；创造模式不校验。",
			"story/npc/stylize/data 阶段全开（all-on 在三种模式下均满足预设）。",
		].join("\n"),
	);
}

function printTurn(report: TurnResult): void {
	console.log(`\n========== 第 ${report.turnSeq} 轮 ==========`);
	console.log("--- 正文 ---");
	console.log(report.narrativeText);
	if (report.npc) {
		const onstageIds = report.npc.onstageNpcIds;
		const offIds = report.npc.offscreenTriggeredIds;
		console.log(
			`--- npc 阶段（§6.2） ---\n在场预演: ${onstageIds.length} 个（${onstageIds.length > 0 ? onstageIds.join(", ") : "无"}）| 离线推演: ${offIds.length} 个`,
		);
	}
	if (report.story) {
		const s = report.story;
		console.log(
			`--- story 阶段（§6.3） ---\n场景卡: ${s.sceneFallback ? "fallback" : "ok"} | 硬冲突: ${s.hardConflicts.length} | 报疑: ${s.suspicions.length} | 重写: ${s.revisions} 次${s.releasedWithWarnings ? " | 超限放行" : ""}`,
		);
	}
	if (report.stylize) {
		console.log(
			`--- stylize（§6.4） ---\n${report.stylize.applied ? "✓ 已润色" : "✗ 回退原文"}${report.stylize.drift ? `，drift: ${report.stylize.drift.join("; ")}` : ""}`,
		);
	}
	console.log("--- data 落库（§6.1） ---");
	if (report.data.ok) {
		const a = report.data.applied;
		console.log(
			`✓ 成功（attempts=${report.data.attempts}）events=${a.events} new_npcs=${a.newNpcs} time_advance=${a.timeAdvanced ? "是" : "否"}${report.data.dropped ? `，strictDrop 剔除 ${report.data.dropped.length} 项` : ""}`,
		);
	} else {
		console.log(`✗ 失败（attempts=${report.data.attempts}）: ${truncate(report.data.error, 300)}`);
	}
	console.log(`--- 快照: ${report.snapshotTaken ? "已拍" : "跳过"} ---`);
}

async function cmdFork(arg: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime> {
	const { session, sessionManager, storyState } = runtime;
	const target = resolveTreeTarget(sessionManager, arg);
	const truncateId = target.message.role === "user" ? (target.parentId ?? target.id) : target.id;
	const chain = buildAncestorChain(sessionManager.getEntries(), target.id);
	const oldSessionId = sessionManager.getSessionId();
	const oldStoryState = storyState;

	const newFile = sessionManager.createBranchedSession(truncateId);
	const newSessionId = sessionManager.getSessionId();
	const newStoryDir = join(ctx.storiesRoot, newSessionId);
	console.log(`> createBranchedSession → 新 sessionId=${newSessionId}（文件 ${newFile}）`);

	const forkResult = forkStoryDb(oldStoryState.snapshotsDb, chain, newStoryDir);
	console.log(
		`> forkStoryDb → 新故事目录 ${newStoryDir}（events=${forkResult.storyDb.reader.listEvents().length}，snapshots=${forkResult.snapshotsDb.listSnapshots().length} 份）`,
	);

	session.dispose();
	oldStoryState.storyDb.close();
	oldStoryState.snapshotsDb.close();

	// fork 产物继承元数据（§10.1）：复制 story.meta.json——模式与锁定（adventure）随 mode 继承。
	inheritStoryMeta(oldStoryState.storyDir, newStoryDir);

	const newStoryState = {
		storyDir: newStoryDir,
		storyDb: forkResult.storyDb,
		snapshotsDb: forkResult.snapshotsDb,
	};
	const newRuntime = await createStoryRuntime({
		cwd: ctx.cwd,
		sessionManager,
		storyState: newStoryState,
		settings: ctx.settings,
		modelRuntime: ctx.modelRuntime,
		prompts: ctx.prompts,
		eventLog: createPipelineEventLog(join(newStoryDir, "pipeline-events.jsonl")),
		onWarning: (m) => console.warn(`[warn] ${m}`),
		...runtimeExtras(ctx),
	});
	console.log(`> 已切换故事: ${oldSessionId} → ${newSessionId}`);
	return newRuntime;
}

async function runCommand(line: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime | undefined> {
	const [cmd, ...rest] = line.slice(1).split(/\s+/);
	const arg = rest.join(" ").trim();
	switch (cmd) {
		case "tree": {
			if (arg === "") {
				printTree(runtime.sessionManager);
				return undefined;
			}
			const target = resolveTreeTarget(runtime.sessionManager, arg);
			console.log(`> navigateTree(${target.id})（${target.message.role} 消息）`);
			const { session } = runtime;
			if (session.isStreaming) {
				console.log("> isStreaming 期间不能 navigateTree（须等上一轮完成）");
				return undefined;
			}
			await session.navigateTree(target.id);
			printRestoreResult(runtime.hooks.state.lastRestoreResult, runtime);
			return undefined;
		}
		case "fork": {
			if (arg === "") {
				console.log("用法: /fork <序号|entryId>");
				return undefined;
			}
			return cmdFork(arg, runtime, ctx);
		}
		case "status":
			printStatus(runtime);
			return undefined;
		case "mode": {
			if (arg === "") {
				console.log(`> 当前模式: ${runtime.mode}`);
				return undefined;
			}
			if (!MODE_SET.includes(arg as StoryMode)) {
				console.log(`> 非法模式: ${arg}（可选: ${MODE_SET.join(" / ")}）`);
				return undefined;
			}
			try {
				runtime.setMode(arg as StoryMode);
				console.log(`> 已切换到 ${arg}（story.meta.json 已持久化）`);
			} catch (err) {
				console.log(`> 切换失败: ${err instanceof Error ? err.message : String(err)}`);
			}
			return undefined;
		}
		case "plot": {
			if (arg === "") {
				console.log("用法: /plot <剧情大纲>");
				return undefined;
			}
			if (runtime.mode !== "creation") {
				console.log(`该模式不可用：/plot 仅创造模式合法（剧情大纲指令；生存/冒险拒绝非 user 角色输入）。`);
				return undefined;
			}
			const turnSeq = computeNextTurnSeq(runtime.storyState.storyDb);
			const directive = runtime.storyState.storyDb.writer.insertDirective({ turnSeq, content: arg });
			console.log(`> 已写入剧情指令 #${directive.id}: ${arg}`);
			return undefined;
		}
		case "help":
			printHelp();
			return undefined;
		default:
			console.log(`未知命令 /${cmd}（/help 查看）`);
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// 行队列（沿 m5-cli）
// ---------------------------------------------------------------------------

class LineQueue {
	private readonly lines: string[] = [];
	private readonly waiters: Array<(line: string) => void> = [];
	private eof = false;

	constructor(rl: Interface) {
		rl.on("line", (line) => {
			const waiter = this.waiters.shift();
			if (waiter) waiter(line);
			else this.lines.push(line);
		});
		rl.on("close", () => {
			this.eof = true;
			const waiter = this.waiters.shift();
			if (waiter) waiter("");
		});
	}

	async nextLine(prompt: string): Promise<string> {
		process.stdout.write(prompt);
		if (this.lines.length > 0) return this.lines.shift()!;
		if (this.eof) return "";
		return new Promise<string>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

// ---------------------------------------------------------------------------
// 启动与参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = { pack: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--root") {
			i++;
			args.root = argv[i];
		} else if (a === "--resume") {
			i++;
			args.resume = argv[i];
		} else if (a === "--pack") {
			i++;
			args.pack.push(argv[i]!);
		} else if (a === "--mode") {
			i++;
			const v = argv[i];
			if (!MODE_SET.includes(v as StoryMode)) throw new Error(`--mode 只允许 ${MODE_SET.join(" / ")}`);
			args.mode = v as StoryMode;
		} else if (a === "--style") {
			i++;
			args.style = argv[i];
		} else {
			throw new Error(`未知参数: ${a}`);
		}
	}
	return args;
}

export async function main(argv: readonly string[]): Promise<void> {
	const args = parseArgs(argv);
	const storiesRoot = args.root ?? defaultStoriesRoot();
	const cwd = repoRoot;

	let sessionManager: SessionManager;
	let storyState: StoryState;
	let packDirs = args.pack.map((d) => resolve(d));

	if (args.resume !== undefined) {
		// 续写：session 文件恢复；mode 从 story.meta.json 恢复（runtime 解析）；subagent 开关全开满足各模式预设。
		sessionManager = SessionManager.open(args.resume);
		const sessionId = sessionManager.getSessionId();
		const dbPath = coreStoryDbPath(storiesRoot, sessionId);
		storyState = {
			storyDir: join(storiesRoot, sessionId),
			storyDb: openStoryDb(dbPath),
			snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
		};
		const meta = readStoryMeta(storyState.storyDir);
		if (meta?.mode !== undefined) {
			console.log(`> 恢复模式: ${meta.mode}（来自 story.meta.json）`);
		}
		if (packDirs.length === 0 && meta !== undefined) {
			packDirs = meta.packs.map((p) => p.dir);
		}
	} else {
		// 新故事：--mode 仅在创建时有效（createStory 写入 meta；adventure 创建时锁定）。
		const created = await createStory({ storiesRoot, packDirs, cwd, ...(args.mode !== undefined ? { mode: args.mode } : {}) });
		sessionManager = created.sessionManager;
		storyState = created.storyState;
		if (created.packs.length > 0) {
			const clock = storyState.storyDb.reader.getClock();
			console.log(`> clock 初值: ${clock?.current_time}（${clock?.calendar}/${clock?.granularity}）`);
		}
	}
	const sessionId = sessionManager.getSessionId();

	const { settings, warnings: settingsWarnings } = loadSettings();
	const prompts: PromptLayerDirs = {
		globalDir: defaultGlobalPromptsDir(),
		...(packDirs.length > 0 ? { packDir: packDirs[0] } : {}),
	};
	const modelRuntime = await ModelRuntime.create();
	const eventLog = createPipelineEventLog(join(storyState.storyDir, "pipeline-events.jsonl"));

	console.log(`> sessionId: ${sessionId}`);
	console.log(`> storyDir: ${storyState.storyDir}`);
	for (const w of settingsWarnings) console.warn(`[warn] ${w}`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const queue = new LineQueue(rl);

	const ctx: CliCtx = {
		storiesRoot,
		cwd,
		settings,
		modelRuntime,
		prompts,
		...(args.style !== undefined ? { style: args.style } : {}),
	};

	let runtime: StoryRuntime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		settings,
		modelRuntime,
		prompts,
		eventLog,
		onWarning: (m) => console.warn(`[warn] ${m}`),
		...runtimeExtras(ctx),
	});
	console.log(
		`> 工具白名单: [${runtime.session.getActiveToolNames().join(", ")}]（应为空：主叙事零 DB 工具，§6.0）`,
	);
	if (runtime.mode !== "creation") {
		const modeInfo = runtime.mode === "adventure" ? "（锁定不可切换）" : "（story/输入校验生效）";
		console.log(`> 当前模式: ${runtime.mode}${modeInfo}`);
	}

	console.log("\n输入行动/对话开始叙事；斜杠命令见 /help；空行退出。");
	try {
		for (;;) {
			const line = (await queue.nextLine("> ")).trim();
			if (line === "") break;
			// /! 前缀：输入渠道校验强制提交（去前缀 + force:true）
			if (line.startsWith("/! ")) {
				const forcedInput = line.slice(2).trim();
				const report = await runtime.runTurn(forcedInput, { force: true });
				printTurn(report);
				continue;
			}
			if (line.startsWith("/")) {
				const next = await runCommand(line, runtime, ctx);
				if (next !== undefined) runtime = next;
			} else {
				try {
					const report = await runtime.runTurn(line);
					printTurn(report);
				} catch (err) {
					if (err instanceof InputRejectedError) {
						console.log(`> 输入被拒绝（§8 输入渠道校验）：${err.reason}`);
						console.log(`> 建议改写：${err.suggestion}`);
						console.log(`> 如确需原样提交，以 /! 开头强制提交（将留痕 warning）。`);
					} else {
						throw err;
					}
				}
			}
		}
	} finally {
		rl.close();
		runtime.dispose();
		runtime.storyState.storyDb.close();
		runtime.storyState.snapshotsDb.close();
		console.log(
			`> 故事目录保留（未删）: ${runtime.storyState.storyDir}\n> 可续写: node packages/app/src/m6-cli.ts --resume ${runtime.sessionManager.getSessionFile()}`,
		);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	});
}
