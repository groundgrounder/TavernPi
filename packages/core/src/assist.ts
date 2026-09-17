// 带外顾问 assist：会话式、无开关、只读、草稿制。
//
// 契约：
// - 会话式 session：跨轮存续（inMemory 常驻；故事重载时重建、历史不持久 v0）。回溯/前进/fork 时
//   经 runtime 的 session_tree 钩子调 rebuild() 同步重建——记忆不得包含被回滚掉的剧情。
// - 三模式人格：创造=作者顾问（全知视角）；生存/冒险=玩家副驾（RP 建议、行动选项）；冒险只知道
//   「用户该知道的」——DB 读取走 DbView "user-related" 视图过滤（db/view.ts），createDbView 层已做。
// - 只读 DB；输出均为草稿，由用户决定是否作为输入发出（写者纪律不破）。无写工具。
// - 不进叙事流、不影响 pipeline、不触发落库；无开关（用户主动发起，不找它即零开销——session 懒创建）。
//
// 冒险视图过滤的形态：本模块只消费 createDbView 的 filter（"none"|"user-related"），不改 db/view.ts 语义。
// choice 集成（选项→交互）不在本 lane——跟踪项，注释说明即可，不做。

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	defineTool,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderLocationLevels, renderLocationPath } from "./db/location-path.ts";
import type { StoryDb } from "./db/story-db.ts";
import { createDbView, type DbView } from "./db/view.ts";
import { MODE_PRESETS, type StoryMode } from "./mode.ts";
import { loadPrompt, renderPlaceholders, type PromptLayerDirs } from "./prompts/loader.ts";
import type { PipelineEventLog } from "./pipeline/events.ts";

// ---------------------------------------------------------------------------
// 工具集（只读，typebox 参数，ToolDefinition 形状——参照 db/tools.ts createDbTools）
// ---------------------------------------------------------------------------

const EMPTY_PARAMS = Type.Object({}, { additionalProperties: false });

export interface AssistToolOptions {
	/** 创造/生存给 list_directives（作者顾问要看大纲意图）；冒险不给（directives 是作者意图，玩家不可见）。 */
	allowDirectives: boolean;
}

/** 冒险模式：越集 get_npc 返回「不可见」文案（不抛错）；none 模式全量透传。 */
function formatNpcText(view: DbView, npcId: number): string {
	const comp = view.getNpc(npcId);
	if (!comp || comp.npc === undefined) {
		return `NPC #${npcId} 不存在或对你（玩家角色）不可见`;
	}
	const npc = comp.npc;
	const traitsText = comp.traits.map((t) => `${t.trait}=${t.weight}`).join(", ") || "(无)";
	const memoriesText = comp.memories.map((m) => `${m.kind}: ${m.content}`).join("；") || "(无)";
	const relationsText = comp.relations.map((r) => `${r.npc_a}↔${r.npc_b}=${r.disposition}`).join(", ") || "(无)";
	const locationText = npc.current_location !== null ? `#${npc.current_location} ${npc.current_location_name ?? "?"}` : "(未定位)";
	return `NPC #${npc.id} ${npc.name}（status: ${npc.status}，位置: ${locationText}）\n特征: ${traitsText}\n记忆: ${memoriesText}\n关系: ${relationsText}`;
}

/** 为一组只读 DbView 定义 assist 工具集（只读，无写工具；createAgentSession 白名单据此装配）。
 *  view 传给 getter（每次 execute 现建 createDbView+resolveRelatedNpcSet，开销小）——保证跨轮存续期间
 *  冒险可见性新鲜（离场 NPC 不可见、新同地点 NPC 可见），而不是每会话冻结一次 RelatedNpcSet。 */
export function createAssistTools(viewFactory: () => DbView, opts: AssistToolOptions): ToolDefinition[] {
	const tools: ToolDefinition[] = [];

	tools.push(
		defineTool({
			name: "get_clock",
			label: "读取故事时钟",
			description: "返回当前故事时间、历法与粒度（只读）。",
			parameters: EMPTY_PARAMS,
			execute: async () => {
				const view = viewFactory();
				const clock = view.getClock();
				return {
					content: [{ type: "text", text: clock ? `当前故事时间: ${clock.current_time}（${clock.calendar}/${clock.granularity}）` : "(时钟未初始化)" }],
					details: { clock: clock ?? null },
				};
			},
		}),
	);

	tools.push(
		defineTool({
			name: "get_player_location",
			label: "读取玩家位置",
			description: "返回玩家当前所在地的完整路径（从根到叶，如 大雍（国） > #2 王城（城） > 庭院）（只读）。",
			parameters: EMPTY_PARAMS,
			execute: async () => {
				const view = viewFactory();
				const path = view.getPlayerLocationPath();
				return {
					content: [
						{
							type: "text",
							text: path !== undefined ? `当前玩家位置: ${renderLocationPath(path, { withIds: true })}` : "(玩家尚未定位)",
						},
					],
					details: { path: path ?? null },
				};
			},
		}),
	);

	tools.push(
		defineTool({
			name: "list_locations",
			label: "列出地点",
			description: "逐层列出全部已登记地点（含 id；只读）。",
			parameters: EMPTY_PARAMS,
			execute: async () => {
				const view = viewFactory();
				const locations = view.listLocations();
				const lines = renderLocationLevels(locations);
				return {
					content: [{ type: "text", text: lines.length === 0 ? "(无地点)" : lines.join("\n") }],
					details: { locations },
				};
			},
		}),
	);

	tools.push(
		defineTool({
			name: "list_npcs",
			label: "列出 NPC",
			description: "列出可见 NPC（冒险模式仅玩家相关域；只读）。",
			parameters: EMPTY_PARAMS,
			execute: async () => {
				const view = viewFactory();
				const npcs = view.listNpcs();
				const text =
					npcs.length === 0
						? "(无 NPC)"
						: npcs.map((n) => `#${n.id} ${n.name}（status: ${n.status}${n.current_location_name !== null ? `，位置 ${n.current_location_name}` : ""}）`).join("\n");
				return { content: [{ type: "text", text }], details: { npcs } };
			},
		}),
	);

	tools.push(
		defineTool({
			name: "get_npc",
			label: "读取 NPC",
			description: "返回指定 NPC 的基本信息、性格特征、记忆与关系（只读；不可见/不存在则告知不可见）。",
			parameters: Type.Object({ npc_id: Type.Integer({ description: "NPC 的 id" }) }, { additionalProperties: false }),
			execute: async (_toolCallId, params) => {
				const view = viewFactory();
				return { content: [{ type: "text", text: formatNpcText(view, params.npc_id) }], details: { npc_id: params.npc_id } };
			},
		}),
	);

	tools.push(
		defineTool({
			name: "list_events",
			label: "列出近期事件",
			description: "返回近期 N 条事件摘要（只读；默认最近 20 条）。",
			parameters: EMPTY_PARAMS,
			execute: async () => {
				const view = viewFactory();
				const events = view.listEvents().slice(-20);
				const text = events.length === 0 ? "(无事件)" : events.map((e) => `- turn${e.turn_seq} ${e.summary}`).join("\n");
				return { content: [{ type: "text", text }], details: { events } };
			},
		}),
	);

	tools.push(
		defineTool({
			name: "list_phases",
			label: "列出阶段",
			description: "列出全部故事阶段（含目标；只读）。",
			parameters: EMPTY_PARAMS,
			execute: async () => {
				const view = viewFactory();
				const phases = view.listPhases();
				const text =
					phases.length === 0
						? "(无阶段)"
						: phases
								.map((p) => `- ${p.name}（status: ${p.status}，started_turn: ${p.started_turn}，ended_turn: ${p.ended_turn ?? "未结束"}${p.goals ? `，目标: ${p.goals}` : ""}）`)
								.join("\n");
				return { content: [{ type: "text", text }], details: { phases } };
			},
		}),
	);

	if (opts.allowDirectives) {
		tools.push(
			defineTool({
				name: "list_directives",
				label: "列出剧情大纲指令",
				description: "列出存量的 active 剧情大纲指令（作者意图；只读）。创造/生存顾问可见；冒险玩家不可见。",
				parameters: EMPTY_PARAMS,
				execute: async () => {
					const view = viewFactory();
					const directives = view.listDirectives("active");
					const text = directives.length === 0 ? "(无活跃指令)" : directives.map((d) => `- ${d.content}`).join("\n");
					return { content: [{ type: "text", text }], details: { directives } };
				},
			}),
		);
	}

	return tools;
}

// ---------------------------------------------------------------------------
// 会话辅助
// ---------------------------------------------------------------------------

/** message 条目文本（content 数组或纯字符串）；assist 会话消息同形。 */
function messageText(message: { role?: string; content?: unknown } | undefined): string {
	if (!message) return "";
	if (Array.isArray(message.content)) {
		return (message.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

/** 最后一个非空 assistant 文本回复。 */
function extractLastAssistantReply(messages: ReadonlyArray<{ role: string; content?: unknown }>): string | undefined {
	for (const msg of [...messages].reverse()) {
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		const text = (msg.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		if (text.trim() !== "") return text;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// AssistAdvisor
// ---------------------------------------------------------------------------

export type AssistMode = StoryMode;

export interface AssistAdvisorOptions {
	/** storyDb 实例或 getter（恢复替换实例后工具始终访问当前库）。 */
	storyDb: StoryDb | (() => StoryDb);
	/** 当前模式（getter：mode 切换后 rebuild 用新模式人格/视图）。 */
	mode: StoryMode | (() => StoryMode);
	cwd: string;
	prompts?: PromptLayerDirs;
	modelRuntime?: ModelRuntime;
	/** assist 模型（settings.models.assist）；缺省走 pi 默认。 */
	model?: NonNullable<CreateAgentSessionOptions["model"]>;
	eventLog?: PipelineEventLog;
	/** 会话工厂（故障注入/测试）；缺省 createAgentSession。 */
	sessionFactory?: (opts: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
}

export interface AssistAdvisor {
	/** 发一条消息给带外顾问，返回助手文本（跨轮存续）。 */
	chat(message: string): Promise<string>;
	/** 丢弃 inMemory 会话重建（回溯/前进/fork 时调用；历史清零，不持久）。 */
	rebuild(): Promise<void>;
	dispose(): void;
}

const MODE_LABEL: Record<StoryMode, string> = {
	creation: "创造模式",
	survival: "生存模式",
	adventure: "冒险模式",
};

/** DB 视图标签（供 {{db_view}} 占位符；派生自 MODE_PRESETS[mode].dbViewFilter）。 */
function dbViewLabel(mode: StoryMode): string {
	return MODE_PRESETS[mode].dbViewFilter === "user-related" ? "仅玩家相关域" : "全部事实（创作者）";
}

/** 组装并渲染 assist 系统提示（创建时渲染一次；DB 事实经工具现查）。模板用 {{story_time}}/{{mode_label}}/{{db_view}} 占位符。 */
function buildSystemPrompt(mode: StoryMode, storyDb: StoryDb, prompts: PromptLayerDirs | undefined): string {
	const template = loadPrompt(`assist_${mode}`, prompts).content;
	const clock = storyDb.reader.getClock();
	return renderPlaceholders(template, {
		story_time: clock ? clock.current_time : "(未初始化)",
		mode_label: MODE_LABEL[mode],
		db_view: dbViewLabel(mode),
	}).text;
}

/** 除 viewFilter 派生自 MODE_PRESETS[mode].dbViewFilter 外，仅剩 allowDirectives 需模式裁剪（冒险不给大纲指令）。 */
const MODE_META: Record<StoryMode, { allowDirectives: boolean }> = {
	creation: { allowDirectives: true },
	survival: { allowDirectives: true },
	adventure: { allowDirectives: false },
};

export function createAssistAdvisor(opts: AssistAdvisorOptions): AssistAdvisor {
	const getStoryDb = (): StoryDb => (typeof opts.storyDb === "function" ? opts.storyDb() : opts.storyDb);
	const getMode = (): StoryMode => (typeof opts.mode === "function" ? opts.mode() : opts.mode);
	const sessionFactory = opts.sessionFactory ?? ((o: CreateAgentSessionOptions) => createAgentSession(o));

	let session: AgentSession | undefined;
	let ensurePromise: Promise<AgentSession> | undefined;

	// 懒创建 inMemory 会话（不找它即零开销）；rebuild 后下次 chat 以最新 mode/库重建。
	// 并发互斥：两个并发 chat 共享同一 ensurePromise，不各建会话。
	async function createSession(): Promise<AgentSession> {
		const mode = getMode();
		const storyDb = getStoryDb();
		const systemPrompt = buildSystemPrompt(mode, storyDb, opts.prompts);
		const meta = MODE_META[mode];
		const viewFactory = (): DbView => createDbView(storyDb.reader, MODE_PRESETS[mode].dbViewFilter);
		const tools = createAssistTools(viewFactory, { allowDirectives: meta.allowDirectives });
		const toolNames = tools.map((t) => t.name);

		const loader = new DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			systemPromptOverride: () => systemPrompt,
			agentsFilesOverride: () => ({ agentsFiles: [] }),
			skillsOverride: () => ({ skills: [], diagnostics: [] }),
			promptsOverride: () => ({ prompts: [], diagnostics: [] }),
			extensionFactories: [],
		});
		await loader.reload();

		const created = await sessionFactory({
			cwd: opts.cwd,
			sessionManager: SessionManager.inMemory(opts.cwd),
			resourceLoader: loader,
			customTools: tools,
			tools: toolNames,
			...(opts.model !== undefined ? { model: opts.model } : {}),
			...(opts.modelRuntime !== undefined ? { modelRuntime: opts.modelRuntime } : {}),
		} as CreateAgentSessionOptions);
		const createdSession = created.session;
		// 构建后断言（对齐 narrator 纪律，防 SDK 意外塞入内置/写工具）：活动工具必须是期望只读集合的子集。
		// 用子集而非严格相等——某些运行时路径 createAgentSession 的 getActiveToolNames() 可能暂报 []（工具经
		// tools 白名单仍可调用），子集检查仍能捕获「出现了预期外的名字」这一危险情形，不会误伤良性空集。
		const expectedSet = new Set(toolNames);
		const unexpected = createdSession.getActiveToolNames().filter((n) => !expectedSet.has(n));
		if (unexpected.length > 0) {
			createdSession.dispose();
			throw new Error(`assist 会话出现预期外工具（契约违反）：${unexpected.join(",")}（期望只读集合 [${toolNames.join(",")}]）`);
		}
		opts.eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: -1,
			role: "assist",
			ok: true,
			durationMs: 0,
			// 会话创建事件：无用户输入（系统提示为静态上下文，不记入 inputChars 的「输入规模」语义）。
			inputChars: 0,
			outputChars: systemPrompt.length,
		});
		return createdSession;
	}

	async function ensureSession(): Promise<AgentSession> {
		if (session) return session;
		if (!ensurePromise) {
			ensurePromise = createSession().then(
				(s) => {
					session = s;
					return s;
				},
				(err) => {
					ensurePromise = undefined;
					throw err;
				},
			);
		}
		return ensurePromise;
	}

	return {
		async chat(message: string): Promise<string> {
			const sess = await ensureSession();
			if (sess.isStreaming) {
				throw new Error("assist 会话正在处理中，请等待");
			}
			const promptStart = sess.state.messages.length;
			await sess.prompt(message);
			const reply = extractLastAssistantReply(sess.state.messages.slice(promptStart)) ?? "";
			opts.eventLog?.record({
				ts: new Date().toISOString(),
				turnSeq: -1,
				role: "assist_chat",
				ok: true,
				durationMs: 0,
				inputChars: message.length,
				outputChars: reply.length,
			});
			return reply;
		},
		async rebuild(): Promise<void> {
			if (session) {
				session.dispose();
				session = undefined;
			}
			ensurePromise = undefined;
		},
		dispose(): void {
			if (session) {
				session.dispose();
				session = undefined;
			}
			ensurePromise = undefined;
		},
	};
}
