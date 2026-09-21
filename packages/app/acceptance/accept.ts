// M6 模式与输入渠道校验集成验收（三模式 +「输入渠道校验判定」）：自断言脚本。
//
// 两区：
// A. 模式预设（确定性，无需真实 LLM —— 运行时创建 + setMode / 构建期抛错 / meta 持久化）：
//    ① creation 创建 → setMode("survival") 生效且 meta 持久化；
//    ② survival → setMode("adventure") 抛错；
//    ③ adventure 创建 → setMode 任何方向抛错（锁定）；
//    ④ adventure 故事 fork（inheritStoryMeta 等价流程）→ 新故事 meta 仍 adventure 且 setMode 抛错；
//    ⑤ 生存模式构建期关 npc → 抛错；
//    ⑥ 非 adventure meta + option mode:"adventure" → 抛错（任务 1 升级守卫）。
// B. 输入渠道校验（⑦ 确定性桩 + 真实 LLM 冒烟；⑧⑨⑩ 场景桩 + 真实叙事 LLM；⑪ /plot 指令流）：
//    ⑦ 生存模式「我命令卫兵立刻打开城门放走囚犯」→ InputRejectedError + DB 零痕迹（turn_log 行数不变 + session 树不进）；
//    ⑦b 真实 LLM 场景分析冒烟（判定指令注入 → 场景卡含 input_validity 字段）；
//    ⑧ 同输入 /! 强制 → 正常出叙事 + turn_log.warnings 含「强制提交」；
//    ⑨ 正常角色行动输入 → 不误拒（valid:true 放行，出叙事）；
//    ⑩ 创造模式同⑦输入 → 不校验正常进行；
//    ⑪ /plot 在创造写 directives 且下轮场景分析输入含该指令；生存模式 /plot 报错（cli 冒烟）。
//
// 成本控制：A 区零 LLM；B 区真实 LLM ≈ 3 轮叙事 + 1 次场景分析冒烟 + 1 次 cli 冒烟。
// 需要 auth.json（M0 已配）。结束时清理临时目录。运行：npm run accept。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SessionManager, ModelRuntime, SettingsManager, createAgentSession, type AgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
	createPipelineEventLog,
	createStory,
	createStoryRuntime,
	createDbView,
	inheritStoryMeta,
	loadPrompt,
	loadSettings,
	openSnapshotsDb,
	openStoryDb,
	readStoryMeta,
	resolvePromptChain,
	runSceneAnalysis,
	snapshotsDbPath,
	storyDbPath,
	writeStoryMeta,
	type SceneCard,
	type SnapshotRestoreResult,
	type StoryMode,
	type StoryRuntime,
	type StoryState,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
	type TurnResult,
	type PipelineEvent,
} from "@tavernpi/core";
import { InputRejectedError } from "@tavernpi/core";

const repoRoot = resolve(import.meta.dirname, "../../..");
// 跨区汇总的 pipeline 事件（端到端延迟实测用；打印即可，不做硬断言）。
const ALL_EVENTS: PipelineEvent[] = [];
const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

// ---------------------------------------------------------------------------
// 检查表
// ---------------------------------------------------------------------------

interface Check {
	label: string;
	ok: boolean;
}

function check(label: string, ok: boolean): Check {
	return { label, ok };
}

function printChecks(checks: Check[]): void {
	let failed = 0;
	for (const c of checks) {
		console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.label}`);
		if (!c.ok) failed++;
	}
	const passCount = checks.length - failed;
	console.log(`===== M6 验收: ${failed === 0 ? "PASS" : "FAIL"}（${passCount}/${checks.length} 通过） =====`);
	if (failed > 0) process.exitCode = 1;
}

/** 端到端延迟实测（打印即可，不做硬断言）：按轮汇总 narrator 墙钟 + 各阶段耗时（事件流聚合）。 */
function printLatencySummary(): void {
	console.log("\n===== 端到端延迟实测（观测，非断言） =====");
	const narratorByTurn = new Map<number, { count: number; totalMs: number }>();
	const stageMs: Record<string, number> = {};
	// 只统计结束事件（缺口 6）：start 事件没有 durationMs，混进来会把轮数/耗时算重。旧日志无 phase，按 end。
	const END_EVENTS = ALL_EVENTS.filter((e) => (e.phase ?? "end") === "end");
	for (const e of END_EVENTS) {
		if (e.role === "narrator") {
			const cur = narratorByTurn.get(e.turnSeq) ?? { count: 0, totalMs: 0 };
			cur.count++;
			cur.totalMs += e.durationMs ?? 0;
			narratorByTurn.set(e.turnSeq, cur);
		}
		stageMs[e.role] = (stageMs[e.role] ?? 0) + (e.durationMs ?? 0);
	}
	if (narratorByTurn.size === 0) {
		console.log("（无 narrator 事件，跳过）");
		return;
	}
	for (const [turnSeq, { count, totalMs }] of [...narratorByTurn.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(`  turn ${turnSeq}: 端到端墙钟 ${totalMs}ms（narrator 事件 ${count} 次）`);
	}
	console.log("  各阶段累计耗时（ms）:");
	for (const [role, ms] of Object.entries(stageMs).sort((a, b) => b[1] - a[1])) {
		console.log(`    ${role}: ${ms}ms`);
	}
}

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO_USAGE, durationMs: 1 };
}

/** navigateTree 到目标条目，返回快照钩子恢复结果。 */
async function navigate(runtime: StoryRuntime, targetId: string): Promise<SnapshotRestoreResult | undefined> {
	if (runtime.session.isStreaming) throw new Error("isStreaming 期间不能 navigateTree");
	await runtime.session.navigateTree(targetId);
	return runtime.hooks.state.lastRestoreResult;
}

/** 消息条目中 role=assistant 的数量。 */
function countAssistant(entries: ReadonlyArray<{ type?: string; message?: { role?: string } }>): number {
	return entries.filter((e) => e.type === "message" && e.message?.role === "assistant").length;
}

/** buildSessionContext 消息文本：compactionSummary 用 summary 字段；其余用 content（字符串或 content 块数组）。 */
function contextText(msg: unknown): string {
	const m = msg as { content?: unknown; summary?: unknown };
	if (typeof m.summary === "string") return m.summary;
	const content = m.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return "";
}

/** 桩 assist 会话（D4 只用白名单断言，不需真实模型回复）。 */
function makeStubAssistSession(): AgentSession {
	const messages: Array<{ role: string; content: unknown }> = [];
	return {
		isStreaming: false,
		state: { messages },
		async prompt(message: string): Promise<void> {
			messages.push({ role: "user", content: [{ type: "text", text: message }] });
			messages.push({ role: "assistant", content: [{ type: "text", text: "assist 桩建议" }] });
		},
		dispose(): void {},
		getActiveToolNames(): string[] {
			return [];
		},
	} as unknown as AgentSession;
}

function isProviderError(err: unknown): boolean {
	const text = String(err instanceof Error ? err.message : err);
	return /402|insufficient|balance|quota|rate.?limit|ECONN|ETIMEDOUT|fetch failed/i.test(text);
}

// ---------------------------------------------------------------------------
// 工具（seed 王城 + 卫兵；合法场景卡；确定性 story/npc 桩）
// ---------------------------------------------------------------------------

interface M6Seed {
	wangChengId: number;
	guardId: number;
}

function seedStoryStage(storyDb: StoryState["storyDb"]): M6Seed {
	const w = storyDb.writer;
	const wangCheng = w.insertLocation({ name: "王城" });
	w.moveSubject({ turnSeq: 0, subject: "player", toLocationId: wangCheng.id, note: "seed" });
	const guard = w.insertNpc({ name: "卫兵" });
	w.moveSubject({ turnSeq: 0, subject: `npc:${guard.id}`, toLocationId: wangCheng.id, note: "seed" });
	return { wangChengId: wangCheng.id, guardId: guard.id };
}

/** 合法场景卡（王城 + clock 初值 0000-01-01；onstage 空由场景卡决定，offscreen 由 runtime K 轮兜底）。 */
function validSceneCard(iv: SceneCard["input_validity"]): SceneCard {
	return {
		onstage_npc_ids: [],
		offscreen_npc_ids: [],
		scene_location_name: "王城",
		current_story_time: "0000-01-01",
		time_span_estimate: "几句话的工夫",
		to_time_suggestion: "0000-01-01",
		scene_goal: "与卫兵交涉",
		tone: "紧张",
		major_event: false,
		...(iv !== undefined ? { input_validity: iv } : {}),
	};
}

/** 场景分析桩：可控 input_validity 卡 + review 放行 + oversee（不触发）放行。 */
function storyExecutor(card: SceneCard, capture?: (userPrompt: string) => void): (o: SubagentRunOptions) => Promise<SubagentResult<unknown>> {
	return async (o: SubagentRunOptions) => {
		if (o.role === "story_scene") {
			if (capture) capture(o.userPrompt);
			return stubResult(card);
		}
		if (o.role === "story_review") return stubResult({ findings: [] });
		return stubResult(null); // story_oversee：null 走 schema 失败路径（不触发则无调用）
	};
}

/** npc 桩：schema 垃圾 → 在场/离线预演丢弃（非致命；输入校验不依赖预演产物）。 */
function npcExecutor(): (o: SubagentRunOptions) => Promise<SubagentResult<unknown>> {
	return async () => stubResult({});
}

function dataExecutorStub(): (o: SubagentRunOptions) => Promise<SubagentResult<unknown>> {
	return async () =>
		stubResult({
			events: [{ summary: "M6 数据落库" }],
			time_advance: { to_time: "0000-01-02", span_note: "校验推进" },
			new_locations: [],
			location_moves: [],
			new_npcs: [],
			npc_updates: [],
			world_state: [],
		});
}

// ---------------------------------------------------------------------------
// 运行时构造
// ---------------------------------------------------------------------------

interface M6Bundle {
	runtime: StoryRuntime;
	sessionManager: SessionManager;
	storyState: StoryState;
	storyDir: string;
	seed: M6Seed;
	systemPrompts: string[];
	warnings: string[];
	/** pipeline 事件流（收集，供 assist 污染断言/可区分性校验）。 */
	eventRecords: PipelineEvent[];
}

async function newM6Runtime(
	root: string,
	opts: {
		mode: StoryMode;
		storyExecutor?: (o: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
		npc?: { enabled: boolean };
		stylize?: { enabled: boolean };
		dataExecutor?: (o: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
		onSystemPromptRender?: (rendered: string) => void;
		settings?: Parameters<typeof createStoryRuntime>[0]["settings"];
		modelRuntime?: Parameters<typeof createStoryRuntime>[0]["modelRuntime"];
		settingsManager?: Parameters<typeof createStoryRuntime>[0]["settingsManager"];
		chapterSummaryExecutor?: Parameters<typeof createStoryRuntime>[0]["chapterSummary"] extends infer U
			? U extends { executor?: infer E }
				? E
				: never
			: never;
		assist?: Parameters<typeof createStoryRuntime>[0]["assist"];
		/** 若提供，给卫兵 NPC 种入一条含该标记的记忆（renderDbSummary 会带上，供章节摘要断言伏笔要素）。 */
		seedNpcMemory?: string;
	},
): Promise<M6Bundle> {
	const cwd = root;
	const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const storyDir = join(root, sessionId);
	const dbPath = storyDbPath(root, sessionId);
	const storyState: StoryState = {
		storyDir,
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};
	writeStoryMeta(storyDir, { packs: [], mode: opts.mode, createdAt: new Date().toISOString() });
	const seed = seedStoryStage(storyState.storyDb);
	if (opts.seedNpcMemory !== undefined) {
		storyState.storyDb.writer.insertNpcMemory({ npcId: seed.guardId, turnSeq: 0, kind: "观察", content: opts.seedNpcMemory, salience: 0.9 });
	}
	const systemPrompts: string[] = [];
	const warnings: string[] = [];
	const eventLog = createPipelineEventLog();
	const eventRecords: PipelineEvent[] = [];
	eventLog.on((e) => {
		eventRecords.push(e);
		ALL_EVENTS.push(e);
	});
	const runtime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		settings: opts.settings,
		modelRuntime: opts.modelRuntime,
		...(opts.settingsManager !== undefined ? { settingsManager: opts.settingsManager } : {}),
		...(opts.chapterSummaryExecutor !== undefined ? { chapterSummary: { executor: opts.chapterSummaryExecutor } } : {}),
		...(opts.assist !== undefined ? { assist: opts.assist } : {}),
		eventLog,
		npc: { enabled: opts.npc?.enabled ?? true, executor: npcExecutor() },
		story: { enabled: true, executor: opts.storyExecutor ?? storyExecutor(validSceneCard({ valid: true })) },
		stylize: opts.stylize?.enabled ? { enabled: true } : { enabled: false },
		dataExecutor: opts.dataExecutor ?? dataExecutorStub(),
		onWarning: (m) => warnings.push(m),
		onSystemPromptRender: opts.onSystemPromptRender ?? ((rendered) => systemPrompts.push(rendered)),
	});
	return { runtime, sessionManager, storyState, storyDir, seed, systemPrompts, warnings, eventRecords };
}

function disposeBundle(b: M6Bundle): void {
	b.runtime.dispose();
	b.storyState.storyDb.close();
	b.storyState.snapshotsDb.close();
}

/** 子进程跑 cli（stdin 喂输入，超时保护）。 */
function runCli(script: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			done({ code: -1, stdout, stderr: `${stderr}\n[timeout] cli 冒烟超时被杀` });
		}, opts.timeoutMs ?? 120_000);
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? -1, stdout, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			done({ code: -1, stdout, stderr: `${stderr}\n${String(err)}` });
		});
		if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
		child.stdin.end();
	});
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "tavernpi-accept-"));
	const checks: Check[] = [];
	let settings: Parameters<typeof createStoryRuntime>[0]["settings"];
	let modelRuntime: Parameters<typeof createStoryRuntime>[0]["modelRuntime"];
	try {
		({ settings } = loadSettings());
		modelRuntime = await ModelRuntime.create();
	} catch (err) {
		console.log(`[warn] 模型环境加载失败（A 区确定性可继续；B 区需真实 LLM）: ${String(err)}`);
		throw err;
	}

	try {
		// ================= A. 模式预设（确定性） =================
		console.log("\n===== A. 模式预设（确定性） =====");

		// A①：creation 创建 → setMode("survival") 生效且 meta 持久化
		{
			const a = await newM6Runtime(root, { mode: "creation" });
			try {
				a.runtime.setMode("survival");
				const meta = readStoryMeta(a.storyDir);
				checks.push(check("A1: creation → setMode(survival) 生效且 runtime.mode=survival", a.runtime.mode === "survival"));
				checks.push(check("A1: story.meta.json mode 持久化为 survival", meta?.mode === "survival"));
			} finally {
				disposeBundle(a);
			}
		}

		// A②：survival → setMode("adventure") 抛错
		{
			const a = await newM6Runtime(root, { mode: "survival" });
			try {
				let threw = false;
				try {
					a.runtime.setMode("adventure");
				} catch {
					threw = true;
				}
				checks.push(check("A2: survival → setMode(adventure) 抛错（冒险只能创建时选定）", threw));
				checks.push(check("A2: 切换失败后 meta 仍 survival", readStoryMeta(a.storyDir)?.mode === "survival"));
			} finally {
				disposeBundle(a);
			}
		}

		// A③：adventure 创建 → setMode 任何方向抛错
		{
			// adventure 要求 stylize 全开：runtime 传 stylize on；newM6Runtime 默认全开（story+npc+stylize）。
			const a = await newM6Runtime(root, { mode: "adventure", stylize: { enabled: true } });
			try {
				let threwToCreation = false;
				let threwToSurvival = false;
				try {
					a.runtime.setMode("creation");
				} catch {
					threwToCreation = true;
				}
				try {
					a.runtime.setMode("survival");
				} catch {
					threwToSurvival = true;
				}
				checks.push(check("A3: adventure → setMode(creation) 抛错（锁定）", threwToCreation));
				checks.push(check("A3: adventure → setMode(survival) 抛错（锁定）", threwToSurvival));
				checks.push(check("A3: meta 仍 adventure", readStoryMeta(a.storyDir)?.mode === "adventure"));
			} finally {
				disposeBundle(a);
			}
		}

		// A④：adventure 故事 fork（inheritStoryMeta 等价）→ 新故事 meta 仍 adventure 且 setMode 抛错
		{
			const src = await createStory({ storiesRoot: join(root, "a4-src"), packDirs: [], cwd: root, mode: "adventure" });
			const dstDir = join(root, "a4-dst");
			mkdirSync(dstDir, { recursive: true });
			// 新故事目录开空库（fork 产物；此处仅测 meta 继承与模式锁定，不跑 forkStoryDb 快照机翻）。
			const dstStoryState: StoryState = {
				storyDir: dstDir,
				storyDb: openStoryDb(join(dstDir, "story.db")),
				snapshotsDb: openSnapshotsDb(snapshotsDbPath(join(dstDir, "story.db"))),
			};
			// createStory 已写 src meta；fork 产物经 inheritStoryMeta 复制到目标目录（模式与锁定随 mode 继承）。
			inheritStoryMeta(src.storyDir, dstDir);
			const sm = SessionManager.create(root, join(root, "a4-sessions"));
			const rt = await createStoryRuntime({
				cwd: root,
				sessionManager: sm,
				storyState: dstStoryState,
				stylize: { enabled: true },
				npc: { enabled: true, executor: npcExecutor() },
				story: { enabled: true, executor: storyExecutor(validSceneCard({ valid: true })) },
			});
			try {
				let threw = false;
				try {
					rt.setMode("creation");
				} catch {
					threw = true;
				}
				checks.push(check("A4: fork 后新故事 meta.mode=adventure（继承）", readStoryMeta(dstDir)?.mode === "adventure"));
				checks.push(check("A4: fork 后新故事 runtime.mode=adventure", rt.mode === "adventure"));
				checks.push(check("A4: fork 后新故事 setMode 抛错（锁定继承）", threw));
			} finally {
				rt.dispose();
				dstStoryState.storyDb.close();
				dstStoryState.snapshotsDb.close();
				src.storyState.storyDb.close();
				src.storyState.snapshotsDb.close();
			}
		}

		// A⑤：生存模式构建期关 npc → 抛错
		{
			const dir = join(root, "a5");
			mkdirSync(dir, { recursive: true });
			writeStoryMeta(dir, { packs: [], mode: "survival", createdAt: new Date().toISOString() });
			let threw = false;
			try {
				await createStoryRuntime({
					cwd: root,
					sessionManager: {} as unknown as SessionManager,
					storyState: { storyDir: dir, storyDb: null, snapshotsDb: null } as unknown as StoryState,
					npc: { enabled: false }, // survival 要求 npc 开
					story: { enabled: true },
				});
			} catch {
				threw = true;
			}
			checks.push(check("A5: 生存模式构建期关 npc → 抛错（subagent 开关冲突）", threw));
		}

		// A⑥：非 adventure meta + option mode:"adventure" → 抛错（任务 1 升级守卫）
		{
			const dir = join(root, "a6");
			mkdirSync(dir, { recursive: true });
			writeStoryMeta(dir, { packs: [], mode: "creation", createdAt: new Date().toISOString() });
			let threw = false;
			try {
				await createStoryRuntime({
					cwd: root,
					sessionManager: {} as unknown as SessionManager,
					storyState: { storyDir: dir, storyDb: null, snapshotsDb: null } as unknown as StoryState,
					mode: "adventure",
				});
			} catch {
				threw = true;
			}
			checks.push(check("A6: 非 adventure meta + option=adventure 抛错（冒险只能在创建时选定）", threw));
		}

		// ================= B. 输入渠道校验 =================
		console.log("\n===== B. 输入渠道校验 =====");

		// B7a. ⑦ 确定性拒绝路径：survival + 场景桩 invalid → InputRejectedError + DB 零痕迹
		{
			const invalidCard = validSceneCard({ valid: false, reason: "直接命令 NPC（命令卫兵开城门/放囚犯）", suggestion: "改为「我试着说服卫兵放走囚犯」" });
			const a = await newM6Runtime(root, {
				mode: "survival",
				storyExecutor: storyExecutor(invalidCard),
			});
			try {
				const turnLogBefore = a.storyState.storyDb.reader.getTurnLog().length;
				const msgsBefore = a.sessionManager.getEntries().length;
				let threw: InputRejectedError | null = null;
				try {
					await a.runtime.runTurn("我命令卫兵立刻打开城门放走囚犯");
				} catch (err) {
					if (err instanceof InputRejectedError) threw = err;
				}
				console.log(`[obs] B7a: threw=${threw !== null} reason="${threw?.reason}" suggestion="${threw?.suggestion}"`);
				checks.push(check("B7a: 生存模式非法输入 → InputRejectedError（reason/suggestion）", threw !== null && threw!.reason.includes("命令 NPC")));
				checks.push(check("B7a: DB 零痕迹——turn_log 行数不变", a.storyState.storyDb.reader.getTurnLog().length === turnLogBefore));
				checks.push(check("B7a: session 树不进入该输入（主叙事未 prompt）", a.sessionManager.getEntries().length === msgsBefore));
			} finally {
				disposeBundle(a);
			}
		}

		// B7b. ⑦ 真实 LLM 场景分析冒烟：判定指令注入 → 场景卡含 input_validity 字段（plumbing 验证；LLM 判定结果仅观测）
		{
			const a = await newM6Runtime(root, { mode: "survival" });
			try {
				let card: SceneCard | undefined;
				try {
					const result = await runSceneAnalysis(
						{ turnSeq: 1, userInput: "我命令卫兵立刻打开城门放走囚犯", recentNarratives: [], validateInput: true },
						{
							storyDb: a.storyState.storyDb,
							cwd: root,
							model: resolveStoryModel(settings, modelRuntime),
							modelRuntime,
						},
					);
					card = result.card;
				} catch (err) {
					console.log(`[warn] B7b 真实 LLM 场景分析失败（疑似 provider）：${String(err)}`);
				}
				const iv = card?.input_validity;
				console.log(`[obs] B7b: sceneCard.input_validity=${JSON.stringify(iv)}（valid 判定仅观测，不硬断言）`);
				checks.push(check("B7b: 真实场景分析产出 card 且含 input_validity 字段（判定指令已注入）", card !== undefined && iv !== undefined));
			} finally {
				disposeBundle(a);
			}
		}

		// B8. ⑧ /! 强制提交：survival + 场景桩 invalid + force → 正常出叙事 + warnings 含「强制提交」
		{
			const invalidCard = validSceneCard({ valid: false, reason: "直接命令 NPC", suggestion: "改写" });
			const a = await newM6Runtime(root, { mode: "survival", storyExecutor: storyExecutor(invalidCard) });
			try {
				let report: TurnResult | null = null;
				let err: unknown = null;
				try {
					report = await a.runtime.runTurn("我命令卫兵立刻打开城门放走囚犯", { force: true });
				} catch (e) {
					err = e;
				}
				const turnLog = a.storyState.storyDb.reader.getTurnLog().at(-1);
				const warning = turnLog?.warnings ?? "";
				console.log(`[obs] B8: err=${err ? String(err) : "无"} narrative=${(report?.narrativeText ?? "").length} 字 warnings="${warning.slice(0, 80)}"`);
				checks.push(check("B8: /! 强制提交不抛 InputRejectedError（放行）", err === null && report !== null));
				checks.push(check("B8: 正常出叙事", (report?.narrativeText.trim().length ?? 0) > 0));
				checks.push(check("B8: turn_log.warnings 含「强制提交」", warning.includes("强制提交")));
			} finally {
				disposeBundle(a);
			}
		}

		// B8b. /! 无条件留痕（第二次判合法仍留痕）：先 reject（invalid 卡）→ 再 force 同输入（第二判 valid:true）
		//      → warnings 仍含「强制提交」+ 首次拒绝 reason（不依赖第二次场景判定，审计痕迹不丢）。
		{
			const input = "我命令卫兵立刻打开城门放走囚犯";
			let currentCard: SceneCard = validSceneCard({ valid: false, reason: "直接命令 NPC", suggestion: "改写" });
			const a = await newM6Runtime(root, {
				mode: "survival",
				storyExecutor: async (o: SubagentRunOptions) => {
					if (o.role === "story_scene") return stubResult(currentCard);
					if (o.role === "story_review") return stubResult({ findings: [] });
					return stubResult(null);
				},
			});
			try {
				let threw: InputRejectedError | null = null;
				try {
					await a.runtime.runTurn(input);
				} catch (err) {
					if (err instanceof InputRejectedError) threw = err;
				}
				// 第二次：同意输入 /! 强制，场景卡改为 valid:true（本次判合法）
				currentCard = validSceneCard({ valid: true });
				let err: unknown = null;
				try {
					await a.runtime.runTurn(input, { force: true });
				} catch (e) {
					err = e;
				}
				const turnLog = a.storyState.storyDb.reader.getTurnLog().at(-1);
				const warning = turnLog?.warnings ?? "";
				console.log(`[obs] B8b: turn1 拒=${threw !== null} turn2 err=${err ? String(err) : "无"} warning="${warning.slice(0, 80)}"`);
				checks.push(check("B8b: 第一次拒绝（InputRejectedError）", threw !== null));
				checks.push(
					check("B8b: 第二次 force（判 valid:true）仍留痕「强制提交」+ 首次拒绝 reason", err === null && warning.includes("强制提交") && warning.includes("直接命令 NPC")),
				);
			} finally {
				disposeBundle(a);
			}
		}

		// B9. ⑨ 正常角色行动输入 → 不误拒（valid:true 放行）
		{
			const validCard = validSceneCard({ valid: true });
			const a = await newM6Runtime(root, { mode: "survival", storyExecutor: storyExecutor(validCard) });
			try {
				let report: TurnResult | null = null;
				let err: unknown = null;
				try {
					report = await a.runtime.runTurn("我走进城门，向卫兵点头问好。");
				} catch (e) {
					err = e;
				}
				console.log(`[obs] B9: err=${err ? String(err) : "无"} narrative=${(report?.narrativeText ?? "").length} 字`);
				checks.push(check("B9: 正常扮演输入 valid:true 放行（不抛 InputRejectedError 且出叙事）", err === null && (report?.narrativeText.trim().length ?? 0) > 0));
			} finally {
				disposeBundle(a);
			}
		}

		// B10. ⑩ 创造模式同⑦输入 → 不校验（正常进行）
		{
			const invalidCard = validSceneCard({ valid: false, reason: "直接命令 NPC", suggestion: "改写" });
			const a = await newM6Runtime(root, { mode: "creation", storyExecutor: storyExecutor(invalidCard) });
			try {
				let report: TurnResult | null = null;
				let err: unknown = null;
				try {
					report = await a.runtime.runTurn("我命令卫兵立刻打开城门放走囚犯");
				} catch (e) {
					err = e;
				}
				console.log(`[obs] B10: err=${err ? String(err) : "无"} narrative=${(report?.narrativeText ?? "").length} 字`);
				checks.push(check("B10: 创造模式同输入不校验（正常进行，不抛 InputRejectedError 且出叙事）", err === null && (report?.narrativeText.trim().length ?? 0) > 0));
			} finally {
				disposeBundle(a);
			}
		}

		// B11a. /plot 在创造写 directives 且场景分析输入含该指令（直接 API，确定性；capturing 场景桩）
		{
			const directiveContent = "主角必须在黎明前离开王城";
			let captured = "";
			const a = await newM6Runtime(root, {
				mode: "creation",
				storyExecutor: storyExecutor(validSceneCard({ valid: true }), (p) => (captured = p)),
			});
			try {
				// /plot 等价：writer.insertDirective（turn_seq 取 turn_log max+1）
				const turnSeq = a.storyState.storyDb.reader.getTurnLog().length + 1;
				const dir = a.storyState.storyDb.writer.insertDirective({ turnSeq, content: directiveContent });
				checks.push(check("B11a: /plot 等价 insertDirective 写入指令", dir.content === directiveContent && a.storyState.storyDb.reader.listDirectives("active").length === 1));
				try {
					await a.runtime.runTurn("我走向城门，试探卫兵的口风。");
				} catch (err) {
					// creation 下正常进行；若叙事失败（provider），captured 已在场景分析时记录（断言目标仍可达）。
					if (isProviderError(err)) console.log(`[PROVIDER] B11a 叙事调用失败（非验收断言）：${String(err)}`);
				}
				checks.push(check("B11a: 下轮场景分析输入含该剧情指令", captured.includes(directiveContent)));
			} finally {
				disposeBundle(a);
			}
		}

		// B11b. 生存模式 /plot 报错（cli 冒烟，无叙事）
		{
			const cliRoot = join(root, "cli-b11b");
			mkdirSync(cliRoot, { recursive: true });
			const r = await runCli(join(repoRoot, "packages/app/src/cli.ts"), ["--root", cliRoot, "--mode", "survival"], {
				stdin: "/plot 主角必须活下来\n\n",
				timeoutMs: 60_000,
			});
			console.log(`[obs] B11b: exit=${r.code} /plot 输出含「该模式不可用」=${r.stdout.includes("该模式不可用")}`);
			if (r.code !== 0) console.log(`[obs] B11b stderr: ${r.stderr.slice(0, 200)}`);
			checks.push(check("B11b: cli 生存模式 /plot 报错「该模式不可用」", r.code === 0 && r.stdout.includes("该模式不可用")));
		}

		// ================= C. 章节摘要 compaction + /swipe（真实 LLM） =================
		console.log("\n===== C. 章节摘要 compaction + /swipe =====");

		// C1a. 章节摘要 compaction：数轮叙事 → /compact → 摘要含章节摘要特征（伏笔标记）；上下文替换；后续连贯
		{
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-flash",
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			});
			const a = await newM6Runtime(root, {
				mode: "creation",
				settings,
				modelRuntime,
				settingsManager,
				seedNpcMemory: "我曾在王陵见过一枚刻着暗纹的青铜钥匙（伏笔）",
			});
			try {
				const inputs = [
					"我走进王城，向卫兵打听青铜钥匙的来历。",
					"我追问那枚青铜钥匙上的暗纹是什么意思。",
					"我决定去王陵查证这条线索。",
				];
				let ok = true;
				for (const input of inputs) {
					const r = await a.runtime.runTurn(input);
					ok = ok && r.data.ok;
				}
				checks.push(check("C1a: 数轮叙事 data.ok（供 compaction 前置）", ok));
				const comp = await a.runtime.session.compact();
				console.log(`[obs] C1a: compact summary（前 200 字）: ${comp.summary.slice(0, 200)}`);
				checks.push(
					check("C1a: compaction 摘要含章节摘要特征（在场 NPC/伏笔标记 青铜钥匙或暗纹）", comp.summary.includes("青铜钥匙") || comp.summary.includes("暗纹")),
				);
				// 压缩后上下文含摘要、被吞并原文（首个 user 输入原文）不再进上下文
				const ctx = a.sessionManager.buildSessionContext();
				const ctxAll = ctx.messages.map((m) => contextText(m)).join("\n");
				checks.push(check("C1a: 压缩后上下文含摘要（青铜钥匙/暗纹伏笔要素）", ctxAll.includes("青铜钥匙") || ctxAll.includes("暗纹")));
				checks.push(check("C1a: 被吞并原文（首个 user 输入）不再进上下文", !ctxAll.includes(inputs[0]!)));
				// 后续一轮叙事连贯（能引用摘要中的伏笔；DB 摘要仍含该标记，故叙事应提到）
				const follow = await a.runtime.runTurn("我顺着那条线索，问卫兵可否让我看一眼那把钥匙。");
				console.log(`[obs] C1a: compaction 后后续叙事（前 100 字）: ${follow.narrativeText.slice(0, 100)}`);
				// 连贯性：后续叙事引用伏笔（钥匙/暗纹，摘要与 DB 权威事实中的前设）；LLM 措辞可能不同，放宽为「钥」或「暗纹」。
				checks.push(check("C1a: compaction 后后续叙事连贯（引用伏笔 青铜钥匙/钥匙/暗纹）", follow.narrativeText.includes("钥") || follow.narrativeText.includes("暗纹")));
			} finally {
				disposeBundle(a);
			}
		}

		// C1b. 迭代 compaction（桩）：第二次 compact 的 chapter_summary 输入含第一次摘要的独特标记（前情不丢）
		{
			const firstMarker = "前情摘要独特标记：紫晶王座";
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-flash",
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			});
			const prompts: string[] = [];
			let call = 0;
			const chapterStub = async (o: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
				prompts.push(o.userPrompt);
				call++;
				// 第一次返回带标记摘要（成为第二次 previousSummary）；第二次返回普通摘要（避免真跑 LLM）。
				return stubResult({ summary: call === 1 ? firstMarker : `第二次章节摘要（迭代）` });
			};
			const a = await newM6Runtime(root, {
				mode: "creation",
				settings,
				modelRuntime,
				settingsManager,
				chapterSummaryExecutor: chapterStub,
				seedNpcMemory: "青铜钥匙伏笔",
			});
			try {
				await a.runtime.runTurn("我走进王城，向卫兵打听青铜钥匙。");
				await a.runtime.runTurn("我向卫兵借来一盏灯笼。");
				await a.runtime.session.compact(); // 第一次 compact（summary = firstMarker）
				// 第一次 compact 后追加一轮（产生第二次吞并区段，且分支末不再是 compaction 条目）
				await a.runtime.runTurn("我沿着线索走出城门。");
				await a.runtime.session.compact(); // 第二次 compact（previousSummary = firstMarker）
				const secondPrompt = prompts[1] ?? "";
				console.log(`[obs] C1b: prompts=${prompts.length} 第二次输入含前情标记=${secondPrompt.includes(firstMarker)} 含前情小节=${secondPrompt.includes("## 前情章节摘要")}`);
				checks.push(check("C1b: 第二次 compact 的 chapter_summary 输入含第一次摘要独特标记（前情不丢）", secondPrompt.includes(firstMarker)));
				checks.push(check("C1b: 第二次 compact 输入含「前情章节摘要」小节", secondPrompt.includes("## 前情章节摘要")));
			} finally {
				disposeBundle(a);
			}
		}

		// C2. 压缩区快照语义：compaction 后 navigateTree 到压缩区内部 entry → DB 恢复到对应祖先快照；后退再前进 data/快照正常
		{
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-flash",
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			});
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime, settingsManager, seedNpcMemory: "青铜钥匙伏笔" });
			try {
				const inputs = [
					"我走进王城，向卫兵打听青铜钥匙。",
					"我向卫兵借来一盏灯笼。",
					"我沿着线索走出城门。",
				];
				const reports: TurnResult[] = [];
				for (const input of inputs) {
					reports.push(await a.runtime.runTurn(input));
				}
				const eventsBefore = a.storyState.storyDb.reader.listEvents().length;
				await a.runtime.session.compact();
				console.log(`[obs] C2: compaction 后 eventsBefore=${eventsBefore}`);
				// navigateTree 到压缩区内部 entry（第 2 轮 user，位于 compaction 之前）→ DB 恢复到第 1 轮末快照
				const restore = await navigate(a.runtime, reports[1]!.userEntryId);
				console.log(`[obs] C2: navigateTree 到第 2 轮 user → restore=${restore?.ok} restoredTurnSeq=${restore?.restoredTurnSeq}`);
				checks.push(check("C2: compaction 后 navigateTree 到压缩区 entry 恢复 ok", restore?.ok === true));
				checks.push(check(`C2: 恢复到的快照轮次=1（第 1 轮末；实际 ${restore?.restoredTurnSeq}）`, restore?.restoredTurnSeq === 1));
				// 恢复后正常前进一轮：data.ok + 快照正常（turn 2 复用）
				const fwd = await a.runtime.runTurn("我重新审视这条线索。");
				console.log(`[obs] C2: 恢复后前进一轮 turnSeq=${fwd.turnSeq} data.ok=${fwd.data.ok} snapshot=${fwd.snapshotTaken}`);
				checks.push(check("C2: 恢复后前进一轮 data.ok + 快照正常", fwd.data.ok && fwd.snapshotTaken));
			} finally {
				disposeBundle(a);
			}
		}

		// C3. /swipe：基于分支重生成最后一个 user 轮次（旧稿留树、DB 不双重落库）；首轮 swipe 不报错
		{
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-flash",
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			});
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime, settingsManager, seedNpcMemory: "青铜钥匙伏笔" });
			try {
				await a.runtime.runTurn("我走进王城，向卫兵打听青铜钥匙。");
				await a.runtime.runTurn("我向卫兵借来一盏灯笼。");
				const assistantBefore = countAssistant(a.sessionManager.getEntries());
				const eventsBefore = a.storyState.storyDb.reader.listEvents().length;
				// swipe：重生成最后一个 user 轮次（turn 2）
				const sw = await a.runtime.swipe();
				const assistantAfter = countAssistant(a.sessionManager.getEntries());
				const eventsAfter = a.storyState.storyDb.reader.listEvents().length;
				console.log(
					`[obs] C3: swipe turnSeq=${sw.turnSeq} assistant ${assistantBefore}→${assistantAfter} events ${eventsBefore}→${eventsAfter} data.ok=${sw.data.ok} snapshot=${sw.snapshotTaken}`,
				);
				checks.push(check("C3: swipe 后旧稿留树（assistant 条目 +1，b 分支可见两稿）", assistantAfter === assistantBefore + 1));
				checks.push(check("C3: swipe 后 DB 不双重落库（events 数不变）", eventsAfter === eventsBefore));
				checks.push(check("C3: swipe 后数据正常落库 + 快照正常", sw.data.ok && sw.snapshotTaken));
			} finally {
				disposeBundle(a);
			}
		}

		// C3b. 首轮 swipe（u1，唯一 user 消息）→ 空库兜底不报错
		{
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-flash",
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			});
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime, settingsManager, seedNpcMemory: "青铜钥匙伏笔" });
			try {
				await a.runtime.runTurn("我走进王城。");
				let threw: unknown = null;
				try {
					await a.runtime.swipe();
				} catch (err) {
					threw = err;
				}
				checks.push(check("C3b: 首轮 swipe（u1）空库兜底不报错", threw === null));
			} finally {
				disposeBundle(a);
			}
		}

		// ================= D. 带外顾问 assist（真实 LLM） =================
		console.log("\n===== D. 带外顾问 assist =====");

		// D1. 创造：/assist 等价调用返回非空建议；不进叙事流（turn_log/session 分支不变）；pipeline 事件流无 assist 污染
		{
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime, seedNpcMemory: "青铜钥匙伏笔" });
			try {
				await a.runtime.runTurn("我走进王城，向卫兵打听青铜钥匙。");
				const turnLogBefore = a.storyState.storyDb.reader.getTurnLog().length;
				const branchBefore = a.sessionManager.getEntries().length;
				const nonAssistBefore = a.eventRecords.filter((e) => e.role !== "assist" && e.role !== "assist_chat").length;
				const reply = await a.runtime.assist.chat("这一段我该放慢节奏突出悬念，还是加快节奏推进？");
				console.log(`[obs] D1: assist reply（前 100 字）: ${reply.slice(0, 100)}`);
				checks.push(check("D1: /assist 返回非空建议", reply.trim().length > 0));
				checks.push(check("D1: assist 不进叙事流——turn_log 行数不变", a.storyState.storyDb.reader.getTurnLog().length === turnLogBefore));
				checks.push(check("D1: assist 不进 session 分支（分支条目数不变）", a.sessionManager.getEntries().length === branchBefore));
				const nonAssistAfter = a.eventRecords.filter((e) => e.role !== "assist" && e.role !== "assist_chat").length;
				checks.push(check("D1: pipeline 事件流无 assist 污染（非 assist 事件数不变；assist 用独立 role 可区分）", nonAssistAfter === nonAssistBefore));
			} finally {
				disposeBundle(a);
			}
		}

		// D2. 冒险过滤：seed 两 NPC（同城相关 + 远郊无关）；assist 问无关 NPC → 不含其私密信息；createDbView 层 get_npc 不可见
		{
			const a = await newM6Runtime(root, { mode: "adventure", settings, modelRuntime, stylize: { enabled: true }, seedNpcMemory: "青铜钥匙伏笔" });
			try {
				const w = a.storyState.storyDb.writer;
				const market = w.insertLocation({ name: "市集" });
				const far = w.insertNpc({ name: "远郊者" });
				w.moveSubject({ turnSeq: 0, subject: `npc:${far.id}`, toLocationId: market.id });
				w.insertNpcMemory({ npcId: far.id, turnSeq: 0, kind: "秘密", content: "远郊者把玉玺藏在井底", salience: 0.9 });
				// 确定性：createDbView 层无关 NPC 不可见
				const advView = createDbView(a.storyState.storyDb.reader, "user-related");
				checks.push(check("D2: createDbView 层——无关 NPC get_npc 返回 undefined（不可见）", advView.getNpc(far.id) === undefined));
				checks.push(check("D2: createDbView 层——无关 NPC 不在 list_npcs", !advView.listNpcs().some((n) => n.id === far.id)));
				// 真实 LLM：让 assist 查询该 NPC（工具返回不可见），回复不得含私密信息
				const reply = await a.runtime.assist.chat(`请用工具查询 #${far.id} 号 NPC 的信息，告诉我你知道什么。`);
				console.log(`[obs] D2: assist reply（前 120 字）: ${reply.slice(0, 120)}`);
				checks.push(check("D2: 冒险 assist 不透露无关 NPC 私密信息（玉玺/井底）", !reply.includes("玉玺") && !reply.includes("井底")));
				// 跨轮新鲜：assist 工具须每次现建视图——相关 NPC（卫兵，与玩家同地点）离场后不可见；
				// 无关 NPC（远郊者）移到玩家地点后可见。createDbView 层确定性断言。
				w.moveSubject({ turnSeq: 20, subject: `npc:${a.seed.guardId}`, toLocationId: market.id });
				const advViewAfter = createDbView(a.storyState.storyDb.reader, "user-related");
				checks.push(check("D2: 跨轮——相关 NPC 离场后 get_npc 返回 undefined（视图须现建）", advViewAfter.getNpc(a.seed.guardId) === undefined));
				w.moveSubject({ turnSeq: 21, subject: `npc:${far.id}`, toLocationId: a.seed.wangChengId });
				const advViewAfter2 = createDbView(a.storyState.storyDb.reader, "user-related");
				checks.push(check("D2: 跨轮——无关 NPC 移到玩家地点后变为可见", advViewAfter2.getNpc(far.id) !== undefined));
			} finally {
				disposeBundle(a);
			}
		}

		// D3. 回溯重建：第 2 轮后与 assist 聊过 → navigateTree 回第 1 轮末 → assist rebuild 被触发（sessionFactory 计数断言）
		{
			let assistSessions = 0;
			const sessionFactory = async (o: CreateAgentSessionOptions) => {
				assistSessions++;
				return createAgentSession(o);
			};
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime, assist: { sessionFactory }, seedNpcMemory: "青铜钥匙伏笔" });
			try {
				await a.runtime.runTurn("我走进王城，向卫兵打听青铜钥匙。"); // turn 1
				await a.runtime.assist.chat("我该怎么推进剧情？"); // 创建 assist 会话#1
				await a.runtime.runTurn("我向卫兵借来一盏灯笼。"); // turn 2
				await a.runtime.assist.chat("我该继续追查还是离开？"); // 复用会话#1
				const sessionsAfterTurn2 = assistSessions;
				// 回溯到第 1 轮末：navigateTree 到第 2 轮 user entry（newLeaf=parent，恢复 turn-1-end 快照）
				const userEntries = a.sessionManager
					.getEntries()
					.filter((e) => e.type === "message" && e.message?.role === "user");
				const turn2User = userEntries[1];
				const restore = await navigate(a.runtime, turn2User!.id);
				console.log(`[obs] D3: navigateTree 到第 2 轮 user → restore=${restore?.ok} assistSessions ${sessionsAfterTurn2} → （rebuild 后 chat 递推）`);
				// rebuild 已由 session_tree 钩子触发；再 chat → 新建会话#2
				await a.runtime.assist.chat("我再问一次剧情建议。");
				checks.push(check("D3: navigateTree 后 assist rebuild 被触发（sessionFactory 计数递增）", assistSessions > sessionsAfterTurn2));
			} finally {
				disposeBundle(a);
			}
		}

		// D4. 只读：assist session 工具白名单无写工具（sessionFactory 捕获 createAgentSession args 断言 tools）
		{
			let capturedTools: string[] | undefined;
			const sessionFactory = async (o: CreateAgentSessionOptions) => {
				capturedTools = (o.tools ?? []).map((n) => String(n));
				return { session: makeStubAssistSession() };
			};
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime, assist: { sessionFactory }, seedNpcMemory: "青铜钥匙伏笔" });
			try {
				await a.runtime.assist.chat("随便问问");
				console.log(`[obs] D4: assist 工具白名单=[${(capturedTools ?? []).join(", ")}]`);
				checks.push(check("D4: assist session 工具白名单无写工具（写/推进/移动/插入/更新）", capturedTools !== undefined && !capturedTools.some((n) => /write|advance|move|insert|update/i.test(n))));
				checks.push(check("D4: 工具白名单含只读工具（get_clock/list_npcs 等）", capturedTools !== undefined && capturedTools.includes("get_clock") && capturedTools.includes("list_npcs")));
			} finally {
				disposeBundle(a);
			}
		}

		// ================= E. 承诺面定型（受信任写入 / prompts 管理 / 卡包代码挂载 / 多包提示词合并） =================
		console.log("\n===== E. 承诺面定型 =====");

		// E1. 受信任写入：合法落库+快照立拍；非法 changeset 拒绝零落库；editor 直改场景的 pipeline 外唯一写路径。
		{
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime });
			try {
				const eventsBefore = a.storyState.storyDb.reader.listEvents().length;
				const res = await a.runtime.trustedWrite({
					events: [{ summary: "受信任编辑事件" }],
					time_advance: { to_time: "0000-01-02", span_note: "编辑器直改" },
					new_locations: [],
					location_moves: [],
					new_npcs: [],
					npc_updates: [],
					world_state: [],
				});
				checks.push(check("E1: trustedWrite 合法变更集落库（events +1）", a.storyState.storyDb.reader.listEvents().length === eventsBefore + 1));
				checks.push(check("E1: trustedWrite 后立即拍快照（绑定当前 leaf）", res.snapshotTaken === true));
				// 非法 changeset（未登记地点）→ 拒绝零落库
				await assert.rejects(
					a.runtime.trustedWrite({
						events: [{ summary: "x", location_name: "不存在之地" }],
						time_advance: undefined,
						new_locations: [],
						location_moves: [],
						new_npcs: [],
						npc_updates: [],
						world_state: [],
					}),
					/未登记/,
				);
				checks.push(check("E1: trustedWrite 非法变更集拒绝零落库", a.storyState.storyDb.reader.listEvents().length === eventsBefore + 1));
			} finally {
				disposeBundle(a);
			}
		}

		// E2. prompts 分层管理：覆盖链查询、story 级覆盖后 loadPrompt 命中、清除后回退。
		{
			const a = await newM6Runtime(root, { mode: "creation", settings, modelRuntime });
			try {
				const chainBuiltin = a.runtime.prompts.resolveChain("narrator");
				checks.push(check("E2: resolveChain 默认生效层 builtin（无覆盖）", chainBuiltin.effectiveLayer === "builtin"));
				a.runtime.prompts.setStoryOverride("narrator", "故事层覆盖内容");
				const loaded = loadPrompt("narrator", { storyDir: a.storyState.storyDir });
				checks.push(check("E2: story 级覆盖后 loadPrompt 命中 story 层", loaded.layer === "story" && loaded.content === "故事层覆盖内容"));
				checks.push(check("E2: resolveChain 反映 story 生效层", a.runtime.prompts.resolveChain("narrator").effectiveLayer === "story"));
				a.runtime.prompts.clearStoryOverride("narrator");
				checks.push(check("E2: 清除后回退 builtin", loadPrompt("narrator", { storyDir: a.storyState.storyDir }).layer === "builtin"));
			} finally {
				disposeBundle(a);
			}
		}

		// E2b. story 层覆盖进活管线（Gate 4 M1）：narrator 下轮生效（每轮现载）+ subagent 逐调用现载。
		{
			const narratorMarker = "故事层标记_narrator_紫晶";
			const sceneMarker = "故事层标记_scene_紫晶";
			let capturedSceneSystemPrompt = "";
			const a = await newM6Runtime(root, {
				mode: "creation",
				settings,
				modelRuntime,
				storyExecutor: async (o) => {
					if (o.role === "story_scene") capturedSceneSystemPrompt = o.systemPrompt;
					return storyExecutor(validSceneCard({ valid: true }))(o);
				},
			});
			try {
				a.runtime.prompts.setStoryOverride("narrator", narratorMarker);
				a.runtime.prompts.setStoryOverride("story_scene", sceneMarker);
				await a.runtime.runTurn("我在王城门口驻足观望片刻。");
				const lastNarratorPrompt = a.systemPrompts.at(-1) ?? "";
				checks.push(check("E2b: narrator story 覆盖下轮生效（活管线捕获）", lastNarratorPrompt.includes(narratorMarker)));
				checks.push(check("E2b: story_scene story 覆盖进 subagent 活管线", capturedSceneSystemPrompt.includes(sceneMarker)));
			} finally {
				disposeBundle(a);
			}
		}

		// E3. 卡包代码挂载：主叙事 session 活动工具含 roll_check 且无 DB/内置工具混入。
		{
			const packDir = join(repoRoot, "packages/app/acceptance/fixtures/codepack");
			const story = await createStory({ storiesRoot: join(root, "e3-stories"), packDirs: [packDir], cwd: root });
			const rt = await createStoryRuntime({
				cwd: root,
				sessionManager: story.sessionManager,
				storyState: story.storyState,
				stylize: { enabled: false },
				npc: { enabled: true, executor: npcExecutor() },
				story: { enabled: true },
			});
			try {
				const active = rt.session.getActiveToolNames();
				console.log(`[obs] E3: 主叙事活动工具=${JSON.stringify(active)}`);
				checks.push(check("E3: 主叙事 session 活动工具含 roll_check（卡包 extension 挂载）", active.includes("roll_check")));
				checks.push(check("E3: 活动工具 = 卡包工具集（无 DB/内置工具混入）", active.length === 1 && active[0] === "roll_check"));
			} finally {
				rt.dispose();
				story.storyState.storyDb.close();
				story.storyState.snapshotsDb.close();
			}
		}

		// E4. 多包提示词合并：后包覆盖先包 + warning。
		{
			const packA = join(root, "e4-packA");
			const packB = join(root, "e4-packB");
			for (const [dir, name, content] of [
				[packA, "packa", "包A的narrator"],
				[packB, "packb", "包B的narrator（后包覆盖）"],
			] as Array<[string, string, string]>) {
				mkdirSync(join(dir, "prompts"), { recursive: true });
				mkdirSync(join(dir, "db"), { recursive: true });
				writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }, null, 2) + "\n");
				writeFileSync(join(dir, "db", "schema.sql"), "");
				writeFileSync(join(dir, "prompts", "narrator.md"), content);
			}
			const loaded = loadPrompt("narrator", { packDirs: [packA, packB] });
			checks.push(check("E4: 后包覆盖先包（效包为 packB）", loaded.layer === "pack" && loaded.content === "包B的narrator（后包覆盖）"));
			checks.push(check("E4: 覆盖 warning", loaded.warnings.some((w: string) => w.includes("被后包覆盖"))));
			checks.push(check("E4: resolvePromptChain pack 层命中", resolvePromptChain({ packDirs: [packA, packB] }, "narrator").effectiveLayer === "pack"));
		}

		console.log("\n===== M6 验收检查表 =====");
		printChecks(checks);
		printLatencySummary();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** 解析 story subagent 模型（settings.models.story → modelRuntime.getModel）；缺省 undefined（走 pi 默认）。 */
function resolveStoryModel(
	settings: Parameters<typeof createStoryRuntime>[0]["settings"],
	modelRuntime: Parameters<typeof createStoryRuntime>[0]["modelRuntime"],
): Parameters<typeof runSceneAnalysis>[1]["model"] {
	const ref = settings?.models.story;
	if (!ref || !modelRuntime) return undefined;
	return modelRuntime.getModel(ref.provider, ref.id) ?? undefined;
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
