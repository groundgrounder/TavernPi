// M6 交互 CLI（人工验收入口，三模式 +「输入渠道校验判定」）：模式切换 + 输入校验叙事循环。
//
// 与 m5-cli 的关系：命令/LineQueue/fork 重建全同，差异是内核级模式连通——
//   新故事经 createStory 传 mode（仅创建时有效）；runtime 模式解析（option → story.meta.json → creation）；
//   `/mode` 查看/切换模式（catch 非法切换错）；`/plot` 创造模式专属（剧情大纲指令）；
//   用户输入以 `/! ` 开头 → 去前缀 + force:true（输入渠道校验强制提交，留痕 warning）；
//   catch InputRejectedError → 打印 reason/suggestion（叙事不产生）；`--resume` 从 meta 恢复 mode。
// 目的：验收契约——三模式预设/切换规则/adventure 锁定/fork 继承模式；输入渠道校验
//   （生存/冒险拒非 user 输入、`/!` 强制提交、创造不校验、/plot 指令）。
//
// 接线（app 层只消费 core API）：
//   装配全部走内核 openStory（session ↔ StoryDb ↔ SnapshotsDb ↔ 卡包 ↔ 提示词层 ↔ settings ↔
//   runtime）；改 subagent 开关走内核 rebuildRuntime，`/fork` 走内核 forkFrom。三者都**原地更新**
//   openStory 返回的装配态（ctx.opened），故本文件不再自己拼 runtime，也不手工同步字段。
//   app 层只保留：UI 出口、行队列、命令分派、轮中交互 handler（readline 实现）。
// subagent 开关：story/npc 恒开、data 无开关恒开；stylize 默认关——传 --style 才开，
//   故事模式为 adventure 时强制开（预设要求全开，关闭会被 build-time 校验拒）。判定在内核
//   resolveStylizeEnabled（含卡包 defaultStyle 那条规则）。
//
// 呈现：本文件只管**流程**（读行、分派命令、跑轮次），排版全部外包——
//   `ui.ts` 管主题与写出口，`cli-view.ts` 管每屏的行怎么排，`cli-text-*.ts` 管措辞。
//   本文件不出现 console.log：生成期活动行靠 `\r` 原地重绘，任何绕过 ui 的写都会把它撕裂。
//
// 坑（同 m4/m5-cli）：session.prompt 必须 await 完才能 navigateTree；退出不删故事目录。

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	assertValidRole,
	clearStoryPromptOverride,
	computeNextTurnSeq,
	createDbView,
	forkFrom,
	MODE_PRESETS,
	openStory,
	readStoryMeta,
	rebuildRuntime,
	resolvePromptChain,
	resolveStylizeEnabled,
	setStoryPromptOverride,
	validateSubagentSwitches,
	type InteractionRequest,
	type OpenedStory,
	type PromptLayerDirs,
	type StoryAgents,
	type StoryMode,
	type StoryRuntime,
	type TurnResult,
} from "@tavernpi/core";
import { InputRejectedError } from "@tavernpi/core";
import {
	modeLabel,
	renderHelp,
	renderInputRejected,
	renderModels,
	renderPacks,
	renderPromptChain,
	renderPromptLayerList,
	renderRestore,
	renderStartup,
	renderStatus,
	renderTree,
	renderTurn,
	type PromptChainRow,
	type StageTimings,
} from "./cli-view.ts";
import { EN, EN_LABELS, EN_ERRORS } from "./cli-text-en.ts";
import { Ui } from "./ui.ts";

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
	/** 展示层：app 层唯一的 stdout 出口。 */
	ui: Ui;
	/** 行输入队列：轮中交互 handler 要用。 */
	queue: LineQueue;
	/**
	 * 内核装配态（openStory 的产物）：runtime / session / 故事库 / 事件流 / 卡包注入 / 开关 /
	 * 文风 / 提示词层 / 模型配置全在里面。fork 与改开关走内核的 forkFrom / rebuildRuntime——
	 * 它们**原地更新**这个对象，故此处持引用即可：app 层不再自己拼 runtime、也不再手工同步字段
	 * （装配知识归内核，app 层只管流程与排版）。
	 */
	opened: OpenedStory;
}

// ---------------------------------------------------------------------------
// 文本/转录工具（沿 m5-cli）
// ---------------------------------------------------------------------------

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
		if (!entry) throw new Error(EN.treeOutOfRange(arg, entries.length));
		return entry;
	}
	const hit = entries.find((e) => e.id.startsWith(arg));
	if (!hit) throw new Error(EN.treeNotFound(arg));
	return hit;
}

/** 查目标条目：查不到只报一行、不掀掉整个会话（手滑打错序号不该结束这一局）。
 *  只吞「找条目」这一步的错误；后续 navigateTree / 重建 runtime 的故障照旧上抛——
 *  真故障要响，不能混在「参数写错了」里面被咽掉。 */
function treeTargetHint(
	ui: Ui,
	sessionManager: SessionManager,
	arg: string,
): Extract<SessionEntry, { type: "message" }> | undefined {
	try {
		return resolveTreeTarget(sessionManager, arg);
	} catch (err) {
		ui.line(ui.note(err instanceof Error ? err.message : String(err), "err"));
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// 常量（显示名映射见 cli-text-en.ts 的 EN_LABELS；排版见 cli-view.ts）
// ---------------------------------------------------------------------------

/** 斜杠命令名（与 /help 一致；供 Tab 补全）。 */
const COMMANDS = [
	"/tree",
	"/fork",
	"/status",
	"/packs",
	"/pin",
	"/unpin",
	"/reload",
	"/agents",
	"/models",
	"/prompt",
	"/write",
	"/mode",
	"/plot",
	"/swipe",
	"/compact",
	"/assist",
	"/help",
] as const;

/** 提示词角色清单（与 core/prompts/*.md 的文件名一一对应；/prompt 用它列出生效层）。 */
const PROMPT_ROLES = [
	"narrator",
	"story_scene",
	"story_review",
	"story_oversee",
	"npc_onstage",
	"npc_offscreen",
	"data",
	"stylize",
	"chapter_summary",
	"assist_creation",
	"assist_survival",
	"assist_adventure",
] as const;

/** 事件角色 → 每轮报告里的阶段桶（耗时可归并的角色）。
 *  刻意不含 `narrator`（它的 durationMs 是**整轮**墙钟，不是主叙事阶段耗时）与 `pack`（检索）。 */
const STAGE_BUCKET: Record<string, keyof StageTimings> = {
	story_scene: "story",
	story_review: "story",
	story_oversee: "story",
	npc_onstage: "npc",
	npc_offscreen: "npc",
	stylize: "stylize",
	data: "data",
};

/** 事件角色 → 活动行里的阶段词。未收录的角色不改阶段（如 `pack` 检索、`narrator` 收尾事件）。 */
function activityPhase(role: string): string | undefined {
	switch (role) {
		case "npc_onstage":
		case "npc_offscreen":
			return EN.activityNpc;
		case "story_review":
		case "story_oversee":
			return EN.activityReview;
		case "stylize":
			return EN.activityStylize;
		case "data":
			return EN.activityData;
		default:
			return undefined;
	}
}

/** 当前时钟的展示串（启动事实块与 /status 同一口径）。 */
function clockText(runtime: StoryRuntime): string | undefined {
	const clock = runtime.storyState.storyDb.reader.getClock();
	return clock ? `${clock.current_time} (${clock.calendar}/${clock.granularity})` : undefined;
}

// ---------------------------------------------------------------------------
// 生成期反馈
// ---------------------------------------------------------------------------

/**
 * 跑一次生成（runTurn / swipe）并给出生成期反馈。
 *
 * 两路信号合到一行活动行上：**pipeline 事件流**给阶段词（谁在干活），
 * **主叙事 session 的流式增量**给正文尾巴（读者只关心最新几个字）。
 *
 * 尾巴是临时的——它可能随后被改稿/重试丢弃，所以只画在活动行上、绝不进正式输出
 * （正式正文只从 TurnResult.narrativeText 打一次，见 cli-view 的 renderTurn）。
 * 失败原样抛出（调用方决定怎么呈现），活动行在 finally 里一定收掉。
 *
 * 已知边界：仅剩 pi SDK **自身**的直写（我们够不着，不为它去改全局 console）。tavernpi 内核
 * 的告警已全部收口到 onWarning → ui.warn（见 core/src/warn.ts 的 emitWarning），不再撕裂活动行。
 */
async function runWithFeedback(
	runtime: StoryRuntime,
	ctx: CliCtx,
	run: () => Promise<TurnResult>,
): Promise<void> {
	const { ui } = ctx;
	const { eventLog } = ctx.opened;
	const stageMs: StageTimings = {};
	let phase: string = EN.activityThinking;
	const setPhase = (next: string): void => {
		if (next === phase) return;
		phase = next;
		ui.activity.setPhase(next, true);
	};
	const offEvents = eventLog.on((e) => {
		const bucket = STAGE_BUCKET[e.role];
		if (bucket !== undefined) stageMs[bucket] = (stageMs[bucket] ?? 0) + e.durationMs;
		const next = activityPhase(e.role);
		if (next !== undefined) setPhase(next);
	});
	// 只订主叙事 session：story/npc/stylize/data 各跑各的 session，增量不混进来。
	const offStream = runtime.session.subscribe((event) => {
		if (event.type !== "message_update") return;
		if (event.assistantMessageEvent.type !== "text_delta") return;
		setPhase(EN.activityWriting);
		ui.activity.append(event.assistantMessageEvent.delta);
	});
	const startedAt = Date.now();
	ui.activity.start(EN.activityThinking);
	try {
		const report = await run();
		// 必须先停活动行再写报告：定时器还活着的话，下一次重绘会把报告最后一行擦掉。
		ui.activity.stop();
		ui.lines(renderTurn(ui, { report, durationMs: Date.now() - startedAt, stageMs }));
	} finally {
		ui.activity.stop();
		offEvents();
		offStream();
	}
}

// ---------------------------------------------------------------------------
// CLI 命令（沿 m5-cli，增 /mode /plot）
// ---------------------------------------------------------------------------

async function cmdFork(arg: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime> {
	const { ui } = ctx;
	const target = treeTargetHint(ui, runtime.sessionManager, arg);
	if (target === undefined) return runtime;

	// 分叉本身（新 session / 新故事库 / 继承 meta / 重放卡包迁移 / 重建 runtime）全在内核
	// forkFrom 里——这里只负责播报结果。
	const info = await forkFrom(ctx.opened, target.id);

	ui.line(ui.note(EN.branchedSession(info.newSessionId, info.sessionFile ?? EN.unset), "info"));
	ui.line(ui.note(EN.forkedStoryDb(ctx.opened.storyState.storyDir, info.eventCount, info.snapshotCount), "info"));
	ui.line(ui.note(EN.storySwitched(info.oldSessionId, info.newSessionId), "ok"));
	return ctx.opened.runtime;
}

/** 轮中交互 handler：把 broker 的请求落到 readline 上（内置 confirm/choice/text 三种 kind）。
 *  卡包代码工具经 getInteractionBroker() 发起请求时走到这里；未挂 handler 时 broker 抛
 *  InteractionUnavailableError，由工具自行降级（不崩、不挂死）。 */
async function readlineInteractionHandler(
	req: InteractionRequest,
	deps: { ui: Ui; queue: LineQueue },
): Promise<unknown> {
	const { queue, ui } = deps;
	switch (req.kind) {
		case "confirm": {
			const answer = (await queue.nextLine(EN.interactionConfirmPrompt(req.prompt))).trim().toLowerCase();
			if (answer === "y" || answer === "yes") return { confirmed: true };
			if (answer === "n" || answer === "no") return { confirmed: false };
			throw new Error(EN.interactionBadConfirm(JSON.stringify(answer)));
		}
		case "choice": {
			const options = ((req.payload ?? {}) as { options?: unknown }).options;
			if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
				throw new Error(EN.interactionBadChoice);
			}
			ui.line(ui.note(req.prompt, "info"));
			options.forEach((opt: string, i: number) => ui.line(ui.bullet(`[${i + 1}] ${opt}`)));
			const line = (await queue.nextLine("> ")).trim();
			const idx = Number(line) - 1;
			if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
				throw new Error(EN.interactionBadIndex(JSON.stringify(line), options.length));
			}
			return { option: idx };
		}
		case "text":
			return { text: (await queue.nextLine(`${req.prompt}> `)).trim() };
		default:
			throw new Error(EN.interactionUnknownKind(req.kind));
	}
}

async function runCommand(line: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime | undefined> {
	const [cmd, ...rest] = line.slice(1).split(/\s+/);
	const arg = rest.join(" ").trim();
	const { ui } = ctx;
	switch (cmd) {
		case "tree": {
			if (arg === "") {
				ui.lines(renderTree(ui, runtime.sessionManager));
				return undefined;
			}
			const target = treeTargetHint(ui, runtime.sessionManager, arg);
			if (target === undefined) return undefined;
			if (runtime.session.isStreaming) {
				ui.line(ui.note(EN.navigatingBusy, "warn"));
				return undefined;
			}
			ui.line(ui.note(EN.treeNavigating(target.id, target.message.role), "info"));
			await runtime.session.navigateTree(target.id);
			const clock = runtime.storyState.storyDb.reader.getClock();
			ui.lines(
				renderRestore(
					ui,
					runtime.hooks.state.lastRestoreResult,
					clock?.current_time ?? EN.unset,
					runtime.storyState.storyDb.reader.listEvents().length,
				),
			);
			return undefined;
		}
		case "fork": {
			if (arg === "") {
				ui.line(ui.note(EN.forkUsage, "warn"));
				return undefined;
			}
			return cmdFork(arg, runtime, ctx);
		}
		case "status": {
			// 走模式视图（与 /assist 同一套口径）：冒险（信息迷雾）下 DB 查看仅「与 user 相关」。
			const view = createDbView(runtime.storyState.storyDb.reader, MODE_PRESETS[runtime.mode].dbViewFilter);
			ui.lines(
				renderStatus(ui, {
					view,
					snapshotCount: runtime.storyState.snapshotsDb.listSnapshots().length,
					mode: runtime.mode,
					sessionId: runtime.sessionManager.getSessionId(),
					entryId: runtime.sessionManager.getLeafId() ?? EN.unset,
					packDirs: ctx.opened.packDirs,
					pinned: ctx.opened.pinned,
				}),
			);
			return undefined;
		}
		case "packs": {
			if (ctx.opened.packs === undefined) {
				ui.lines(renderPacks(ui, []));
			} else {
				const { packs, warnings } = ctx.opened.packs.cache.getPacks();
				ui.lines(renderPacks(ui, packs));
				for (const w of warnings) ui.warn(w);
			}
			return undefined;
		}
		case "pin": {
			if (arg === "") {
				ui.line(ui.note(EN.pinUsage, "warn"));
				return undefined;
			}
			if (!ctx.opened.pinned.includes(arg)) ctx.opened.pinned.push(arg);
			ui.line(ui.note(EN.pinnedList(ctx.opened.pinned.length > 0 ? ctx.opened.pinned.join(EN.listSep) : EN.none), "ok"));
			return undefined;
		}
		case "unpin": {
			const idx = ctx.opened.pinned.indexOf(arg);
			if (idx >= 0) ctx.opened.pinned.splice(idx, 1);
			ui.line(ui.note(EN.pinnedList(ctx.opened.pinned.length > 0 ? ctx.opened.pinned.join(EN.listSep) : EN.none), "ok"));
			return undefined;
		}
		case "reload": {
			if (ctx.opened.packs === undefined) {
				ui.line(ui.note(EN.reloadNone, "warn"));
				return undefined;
			}
			const { packs, warnings } = ctx.opened.packs.cache.getPacks();
			ui.line(
				ui.note(
					EN.packsReloaded(packs.map((p) => EN.packsReloadEntry(p.name, p.entries.length)).join(EN.listSep)),
					"ok",
				),
			);
			for (const w of warnings) ui.warn(w);
			return undefined;
		}
		case "prompt": {
			// /prompt                     列出各角色的生效层
			// /prompt <角色>               查看该角色的四层覆盖链（story > pack > global > builtin）
			// /prompt <角色> load <文件>    用文件内容设置 story 层覆盖
			// /prompt <角色> clear         清除 story 层覆盖
			const parts = arg.split(/\s+/).filter((s) => s !== "");
			const storyDir = runtime.storyState.storyDir;
			const dirs: PromptLayerDirs = { ...ctx.opened.prompts, storyDir };
			if (parts.length === 0) {
				// 查询失败的角色单独标出，不让一个错吞掉整屏。
				const rows: Array<{ role: string; layer?: string; error?: string }> = PROMPT_ROLES.map((role) => {
					try {
						return { role, layer: resolvePromptChain(dirs, role).effectiveLayer };
					} catch (err) {
						return { role, error: err instanceof Error ? err.message : String(err) };
					}
				});
				ui.lines(renderPromptLayerList(ui, rows));
				return undefined;
			}
			const [role, op, file] = parts as [string, string?, string?];
			try {
				assertValidRole(role);
			} catch (err) {
				ui.line(ui.note(err instanceof Error ? err.message : String(err), "warn"));
				return undefined;
			}
			if (op === undefined) {
				const chain = resolvePromptChain(dirs, role);
				const layers: PromptChainRow[] = chain.layers.map((l) => ({
					layer: l.layer,
					exists: l.exists,
					contentLength: l.contentLength,
					effective: l.effective,
					paths: l.paths,
				}));
				ui.lines(renderPromptChain(ui, role, chain.effectiveLayer, layers));
				return undefined;
			}
			if (op === "clear") {
				clearStoryPromptOverride(storyDir, role);
				ui.line(ui.note(EN.promptCleared(role), "ok"));
				return undefined;
			}
			if (op === "load") {
				if (file === undefined) {
					ui.line(ui.note(EN.promptLoadUsage, "warn"));
					return undefined;
				}
				const abs = resolve(file);
				const content = readFileSync(abs, "utf-8");
				setStoryPromptOverride(storyDir, role, content);
				ui.lines([
					ui.note(EN.promptSet(role, content.length, abs), "ok"),
					ui.note(EN.promptSetHint, "info"),
				]);
				return undefined;
			}
			ui.line(ui.note(EN.promptUsage, "warn"));
			return undefined;
		}
		case "write": {
			// /write <json 文件> —— 受信任写入：按 Changeset 契约直写 story.db。
			// 校验失败由 trustedWrite 抛中文错并保证零落库；此处只负责读文件与呈现结果。
			if (arg === "") {
				ui.lines([ui.note(EN.writeUsage, "warn"), ui.note(EN.writeHint, "info")]);
				return undefined;
			}
			try {
				const abs = resolve(arg);
				const raw = JSON.parse(readFileSync(abs, "utf-8")) as unknown;
				const res = await runtime.trustedWrite(raw as Parameters<StoryRuntime["trustedWrite"]>[0]);
				ui.lines([
					ui.note(EN.writeDone(res.turnSeq, res.snapshotTaken ? EN.yes : EN.no), "ok"),
					ui.note(JSON.stringify(res.summary), "info"),
				]);
			} catch (err) {
				ui.line(ui.note(EN.writeFailed(err instanceof Error ? err.message : String(err)), "err"));
			}
			return undefined;
		}
		case "agents": {
			// /agents 查看；/agents <story|npc|stylize> <on|off> 设置（会话级，不持久化）。
			// 改开关必须重建 runtime——subagent 选项在创建时固化（重建走内核 rebuildRuntime）。
			const onOff = (b: boolean): string => (b ? EN.agentsOn : EN.agentsOff);
			if (arg === "") {
				ui.lines([
					ui.note(
						EN.agentsTitle(
							onOff(ctx.opened.agents.story),
							onOff(ctx.opened.agents.npc),
							onOff(resolveStylizeEnabled(ctx.opened)),
							EN_LABELS.mode[runtime.mode],
						),
						"info",
					),
					ui.note(EN.agentsUsage, "info"),
				]);
				return undefined;
			}
			const [name, value] = arg.split(/\s+/);
			if ((name !== "story" && name !== "npc" && name !== "stylize") || (value !== "on" && value !== "off")) {
				ui.line(ui.note(EN.agentsBadArg("/agents <story|npc|stylize> <on|off>"), "warn"));
				return undefined;
			}
			const next: StoryAgents = { ...ctx.opened.agents, [name]: value === "on" };
			const stylizeOn = name === "stylize" ? value === "on" : resolveStylizeEnabled(ctx.opened);
			const problems = validateSubagentSwitches(runtime.mode, {
				story: next.story,
				npc: next.npc,
				stylize: stylizeOn,
			});
			if (problems.length > 0) {
				ui.line(ui.note(EN.agentsRejected, "warn"));
				for (const p of problems) ui.line(ui.detail(p, "warn"));
				return undefined;
			}
			ctx.opened.agents = next;
			// 重建后 runtime 换实例（旧实例已 dispose）；返回新实例给主循环。
			await rebuildRuntime(ctx.opened);
			ui.line(
				ui.note(
					EN.agentsApplied(
						onOff(ctx.opened.agents.story),
						onOff(ctx.opened.agents.npc),
						onOff(resolveStylizeEnabled(ctx.opened)),
					),
					"ok",
				),
			);
			return ctx.opened.runtime;
		}
		case "models": {
			// 角色清单与 core settings.ts 的 MODEL_ROLES 对应（那是未导出的内部常量，此处同步维护）。
			const roles = ["narrator", "data", "story", "npc", "stylize", "chapter_summary", "assist"] as const;
			const rows = roles.map((role) => {
				const ref = ctx.opened.settings.models[role];
				return [role, ref ? `${ref.provider}/${ref.id}` : EN.modelsUnset] as const;
			});
			ui.lines(renderModels(ui, rows));
			return undefined;
		}
		case "mode": {
			if (arg === "") {
				ui.line(ui.note(modeLabel(runtime.mode), "info"));
				return undefined;
			}
			if (!MODE_SET.includes(arg as StoryMode)) {
				ui.line(
					ui.note(EN.modeInvalid(arg, MODE_SET.map((m) => EN_LABELS.mode[m]).join(" / ")), "warn"),
				);
				return undefined;
			}
			try {
				runtime.setMode(arg as StoryMode);
				ui.line(ui.note(EN.modeSwitched(EN_LABELS.mode[arg as StoryMode]), "ok"));
			} catch (err) {
				ui.line(ui.note(EN.modeSwitchFailed(err instanceof Error ? err.message : String(err)), "err"));
			}
			return undefined;
		}
		case "plot": {
			if (arg === "") {
				ui.line(ui.note(EN.plotUsage, "warn"));
				return undefined;
			}
			if (runtime.mode !== "creation") {
				ui.line(ui.note(EN.plotWrongMode, "warn"));
				return undefined;
			}
			const turnSeq = computeNextTurnSeq(runtime.storyState.storyDb);
			const directive = runtime.storyState.storyDb.writer.insertDirective({ turnSeq, content: arg });
			ui.line(ui.note(EN.plotWritten(directive.id, arg), "ok"));
			return undefined;
		}
		case "swipe": {
			// /swipe（重骰）：基于分支重生成最后一个 user 轮次，旧稿留树。
			if (arg !== "") {
				ui.line(ui.note(EN.swipeUsage, "warn"));
				return undefined;
			}
			try {
				await runWithFeedback(runtime, ctx, () => runtime.swipe());
			} catch (err) {
				ui.line(ui.note(EN.swipeFailed(err instanceof Error ? err.message : String(err)), "err"));
			}
			return undefined;
		}
		case "compact": {
			// /compact：章节摘要 compaction。
			if (arg !== "") {
				ui.line(ui.note(EN.compactUsage, "warn"));
				return undefined;
			}
			try {
				const result = await runtime.session.compact();
				ui.lines([
					ui.note(EN.compactDone(`${result.summary.slice(0, 120)}${result.summary.length > 120 ? "…" : ""}`), "ok"),
					ui.note(EN.compactReplaced(result.tokensBefore), "info"),
				]);
			} catch (err) {
				const m = err instanceof Error ? err.message : String(err);
				if (/Nothing to compact|Already compacted/i.test(m)) {
					ui.line(ui.note(EN.compactSkipped(m), "warn"));
				} else {
					throw err;
				}
			}
			return undefined;
		}
		case "assist": {
			// /assist：带外顾问，只读、草稿制、不进叙事流。输出为草稿，由用户决定是否作为输入发出。
			if (arg === "") {
				ui.line(ui.note(EN.assistUsage, "warn"));
				return undefined;
			}
			try {
				const reply = await runtime.assist.chat(arg);
				ui.line();
				ui.line(ui.heading(EN.assistTitle));
				ui.line(ui.note(EN.assistHint, "info"));
				ui.line();
				ui.line(reply);
				ui.line(ui.paint("dim", "─".repeat(ui.width)));
			} catch (err) {
				ui.line(ui.note(EN.assistFailed(err instanceof Error ? err.message : String(err)), "err"));
			}
			return undefined;
		}
		case "help":
			ui.lines(renderHelp(ui));
			return undefined;
		default:
			ui.line(ui.note(EN.unknownCommand(cmd ?? ""), "warn"));
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// 行队列（沿 m5-cli）
// ---------------------------------------------------------------------------

class LineQueue {
	private readonly lines: string[] = [];
	private readonly waiters: Array<(line: string) => void> = [];
	private readonly ui: Ui;
	private eof = false;

	constructor(rl: Interface, ui: Ui) {
		this.ui = ui;
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
		// 走 ui：先把生成期活动行让出这一行，再写提示符（绕过 ui 写会把活动行撕成两截）。
		this.ui.prompt(prompt);
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
			if (!MODE_SET.includes(v as StoryMode)) throw new Error(EN_ERRORS.badModeArg(MODE_SET.join(" / ")));
			args.mode = v as StoryMode;
		} else if (a === "--style") {
			i++;
			args.style = argv[i];
		} else {
			throw new Error(EN_ERRORS.unknownArg(a ?? ""));
		}
	}
	return args;
}

export async function main(argv: readonly string[]): Promise<void> {
	const ui = new Ui();
	const args = parseArgs(argv);
	const cwd = repoRoot;

	// 行输入队列先于装配建好：openStory 拿它当轮中交互 handler 的依赖（broker 是 runtime 实例级的，
	// 装配时挂上、重建时由内核自动重挂）。
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		// Tab 补全：斜杠命令名；/mode 补模式；/prompt 与 /agents 补各自的名字。
		// 注：Ctrl+P 在 readline 里已是「上一条历史」，与「打开菜单」冲突，故菜单仍走 /help。
		completer: (line: string): [string[], string] => {
			if (!line.startsWith("/")) return [[], line];
			const parts = line.split(/\s+/);
			const cur = parts[parts.length - 1] ?? "";
			if (parts.length === 1) {
				const hits = COMMANDS.filter((c) => c.startsWith(cur));
				return [hits.length > 0 ? [...hits] : [], cur];
			}
			if (parts.length === 2) {
				const table: Record<string, readonly string[]> = {
					"/mode": MODE_SET,
					"/prompt": PROMPT_ROLES,
					"/agents": ["story", "npc", "stylize"],
				};
				const candidates = table[parts[0] ?? ""];
				if (candidates !== undefined) {
					const hits = candidates.filter((c) => c.startsWith(cur));
					return [hits.length > 0 ? [...hits] : [], cur];
				}
			}
			return [[], cur];
		},
	});
	const queue = new LineQueue(rl, ui);

	// 装配（新建/续写 → 故事目录与两个库 → 卡包与提示词层 → 模型配置 → 事件流 → runtime）全在内核
	// openStory：app 层只给 UI 侧依赖与告警出口，不再自己拼这套接线（否则 studio 会复刻一份并漂移）。
	const opened = await openStory({
		cwd,
		...(args.root !== undefined ? { storiesRoot: args.root } : {}),
		...(args.resume !== undefined ? { resume: args.resume } : {}),
		...(args.pack.length > 0 ? { packDirs: args.pack } : {}),
		...(args.mode !== undefined ? { mode: args.mode } : {}),
		...(args.style !== undefined ? { style: args.style } : {}),
		onWarning: (m) => ui.warn(m),
		onInteraction: (req) => readlineInteractionHandler(req, { ui, queue }),
	});
	const ctx: CliCtx = { ui, queue, opened };
	let runtime: StoryRuntime = ctx.opened.runtime;
	const sessionId = ctx.opened.sessionManager.getSessionId();
	// Ctrl+C：第一次请求退出（若当前轮正在生成，等它结束再退），第二次强制退出。
	// 不接管的话 readline 只会把接口关掉——若此刻卡在几百秒的主叙事里，用户按了 Ctrl+C
	// 既没有提示也不会退出，会以为进程挂了。
	let sigintCount = 0;
	rl.on("SIGINT", () => {
		sigintCount++;
		if (sigintCount >= 2) {
			ui.line(ui.note(EN.forceExit, "warn"));
			process.exit(130);
		}
		ui.line(ui.note(runtime.session.isStreaming ? EN.ctrlCGenerating : EN.ctrlCIdle, "warn"));
		rl.close();
	});

	// 启动头部：故事标题 · 模式（adventure 追加锁定徽章）+ 事实块（会话/目录/时钟/包/工具）。
	const bannerMeta = readStoryMeta(ctx.opened.storyState.storyDir);
	const loaded = ctx.opened.packs?.cache.getPacks();
	const packNames = loaded?.packs.map((p) => p.name).join(EN.listSep);
	const toolNames = runtime.session.getActiveToolNames();
	const clock = clockText(runtime);
	ui.lines(
		renderStartup(ui, {
			story: bannerMeta?.title ?? ctx.opened.sessionManager.getSessionName() ?? EN.untitled,
			mode: EN_LABELS.mode[runtime.mode],
			locked: runtime.mode === "adventure",
			...(runtime.mode === "creation"
				? {}
				: { modeNote: runtime.mode === "adventure" ? EN.modeNoteLocked : EN.modeNoteNormal }),
			sessionId,
			storyDir: ctx.opened.storyState.storyDir,
			...(clock !== undefined ? { clock } : {}),
			tools: toolNames.length > 0 ? toolNames.join(EN.listSep) : EN.toolsEmpty,
			...(packNames !== undefined && packNames !== "" ? { packs: packNames } : {}),
		}),
	);
	for (const w of ctx.opened.settingsWarnings) ui.warn(w);
	for (const w of loaded?.warnings ?? []) ui.warn(w);
	if (ctx.opened.modeFromMeta) ui.line(ui.note(EN.modeRestoredFromMeta, "info"));
	ui.line();
	ui.line(ui.note(EN.hint, "info"));

	try {
		for (;;) {
			const line = (await queue.nextLine(`[${EN_LABELS.mode[runtime.mode]}]> `)).trim();
			if (line === "") break;
			// /! 前缀：输入渠道校验强制提交（去前缀 + force:true）
			if (line.startsWith("/! ")) {
				const forcedInput = line.slice(2).trim();
				await runWithFeedback(runtime, ctx, () => runtime.runTurn(forcedInput, { force: true }));
				continue;
			}
			if (line.startsWith("/")) {
				const next = await runCommand(line, runtime, ctx);
				if (next !== undefined) runtime = next;
			} else {
				try {
					await runWithFeedback(runtime, ctx, () => runtime.runTurn(line));
				} catch (err) {
					if (err instanceof InputRejectedError) {
						ui.lines(renderInputRejected(ui, err.reason, err.suggestion));
					} else {
						throw err;
					}
				}
			}
		}
	} finally {
		rl.close();
		// 收尾一律以装配态为准（fork 后故事目录与库都换了，局部变量可能已过期）。
		ctx.opened.runtime.dispose();
		ctx.opened.storyState.storyDb.close();
		ctx.opened.storyState.snapshotsDb.close();
		ui.line();
		ui.line(ui.note(EN.storyDirKept(ctx.opened.storyState.storyDir), "info"));
		// 只在 session 文件真的落盘后才给续写命令：空故事（无开场白且未跑过轮次）pi 还没写过
		// 任何消息，文件并不存在——照着提示敲 --resume 只会得到一个 EISDIR/ENOENT。
		const sessionFile = ctx.opened.sessionManager.getSessionFile();
		if (sessionFile !== undefined && existsSync(sessionFile)) {
			ui.line(
				ui.note(EN.resumeHint(`node packages/app/src/m6-cli.ts --resume ${sessionFile}`), "info"),
			);
		}
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	});
}
