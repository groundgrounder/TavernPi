// M6 模式与输入渠道校验集成验收（创作规划 §10.1 三模式 + §8 决策记录「输入渠道校验判定」）：自断言脚本。
//
// 两区：
// A. 模式预设（确定性，无需真实 LLM —— 运行时创建 + setMode / 构建期抛错 / meta 持久化）：
//    ① creation 创建 → setMode("survival") 生效且 meta 持久化；
//    ② survival → setMode("adventure") 抛错；
//    ③ adventure 创建 → setMode 任何方向抛错（锁定）；
//    ④ adventure 故事 fork（inheritStoryMeta 等价流程）→ 新故事 meta 仍 adventure 且 setMode 抛错；
//    ⑤ 生存模式构建期关 npc → 抛错；
//    ⑥ 非 adventure meta + option mode:"adventure" → 抛错（任务 1 升级守卫）。
// B. 输入渠道校验（§8；⑦ 确定性桩 + 真实 LLM 冒烟；⑧⑨⑩ 场景桩 + 真实叙事 LLM；⑪ /plot 指令流）：
//    ⑦ 生存模式「我命令卫兵立刻打开城门放走囚犯」→ InputRejectedError + DB 零痕迹（turn_log 行数不变 + session 树不进）；
//    ⑦b 真实 LLM 场景分析冒烟（判定指令注入 → 场景卡含 input_validity 字段）；
//    ⑧ 同输入 /! 强制 → 正常出叙事 + turn_log.warnings 含「强制提交」；
//    ⑨ 正常角色行动输入 → 不误拒（valid:true 放行，出叙事）；
//    ⑩ 创造模式同⑦输入 → 不校验正常进行；
//    ⑪ /plot 在创造写 directives 且下轮场景分析输入含该指令；生存模式 /plot 报错（m6-cli 冒烟）。
//
// 成本控制：A 区零 LLM；B 区真实 LLM ≈ 3 轮叙事 + 1 次场景分析冒烟 + 1 次 m6-cli 冒烟。
// 需要 auth.json（M0 已配）。结束时清理临时目录。运行：npm run m6:accept。

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createPipelineEventLog,
	createStory,
	createStoryRuntime,
	defaultGlobalPromptsDir,
	inheritStoryMeta,
	loadSettings,
	openSnapshotsDb,
	openStoryDb,
	readStoryMeta,
	runSceneAnalysis,
	snapshotsDbPath,
	storyDbPath,
	writeStoryMeta,
	type PromptLayerDirs,
	type SceneCard,
	type StoryMode,
	type StoryRuntime,
	type StoryState,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
	type TurnResult,
} from "@tavernpi/core";
import { InputRejectedError } from "@tavernpi/core";

const repoRoot = resolve(import.meta.dirname, "../../..");
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

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO_USAGE, durationMs: 1 };
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
	const systemPrompts: string[] = [];
	const warnings: string[] = [];
	const runtime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		settings: opts.settings,
		modelRuntime: opts.modelRuntime,
		eventLog: createPipelineEventLog(),
		npc: { enabled: opts.npc?.enabled ?? true, executor: npcExecutor() },
		story: { enabled: true, executor: opts.storyExecutor ?? storyExecutor(validSceneCard({ valid: true })) },
		stylize: opts.stylize?.enabled ? { enabled: true } : { enabled: false },
		dataExecutor: opts.dataExecutor ?? dataExecutorStub(),
		onWarning: (m) => warnings.push(m),
		onSystemPromptRender: opts.onSystemPromptRender ?? ((rendered) => systemPrompts.push(rendered)),
	});
	return { runtime, sessionManager, storyState, storyDir, seed, systemPrompts, warnings };
}

function disposeBundle(b: M6Bundle): void {
	b.runtime.dispose();
	b.storyState.storyDb.close();
	b.storyState.snapshotsDb.close();
}

/** 子进程跑 m6-cli（stdin 喂输入，超时保护）。 */
function runCli(script: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			done({ code: -1, stdout, stderr: `${stderr}\n[timeout] m6-cli 冒烟超时被杀` });
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
	const root = mkdtempSync(join(tmpdir(), "tavernpi-m6-accept-"));
	const checks: Check[] = [];
	let settings: Parameters<typeof createStoryRuntime>[0]["settings"];
	let modelRuntime: Parameters<typeof createStoryRuntime>[0]["modelRuntime"];
	let prompts: PromptLayerDirs;
	try {
		({ settings } = loadSettings());
		modelRuntime = await ModelRuntime.create();
		prompts = { globalDir: defaultGlobalPromptsDir() };
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
			// createStory 已写 src meta；fork 产物经 inheritStoryMeta 复制到目标目录（§10.1 模式与锁定随 mode 继承）。
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
		console.log("\n===== B. 输入渠道校验（§8） =====");

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
				let report: TurnResult | null = null;
				let err: unknown = null;
				try {
					report = await a.runtime.runTurn(input, { force: true });
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

		// B11b. 生存模式 /plot 报错（m6-cli 冒烟，无叙事）
		{
			const cliRoot = join(root, "cli-b11b");
			mkdirSync(cliRoot, { recursive: true });
			const r = await runCli(join(repoRoot, "packages/app/src/m6-cli.ts"), ["--root", cliRoot, "--mode", "survival"], {
				stdin: "/plot 主角必须活下来\n\n",
				timeoutMs: 60_000,
			});
			console.log(`[obs] B11b: exit=${r.code} /plot 输出含「该模式不可用」=${r.stdout.includes("该模式不可用")}`);
			if (r.code !== 0) console.log(`[obs] B11b stderr: ${r.stderr.slice(0, 200)}`);
			checks.push(check("B11b: m6-cli 生存模式 /plot 报错「该模式不可用」", r.code === 0 && r.stdout.includes("该模式不可用")));
		}

		console.log("\n===== M6 验收检查表 =====");
		printChecks(checks);
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
