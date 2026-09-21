// main 侧的故事会话持有者：把「当前打开的故事」与「在飞轮次的中止把手」收在一处，供 channel handler 调用。
//
// 与 CLI 的分工：CLI 把装配/命令/排版揉在一个进程里；studio 的 main 侧只做三件事——
//   1. 持有内核装配态（openStory 的产物），并按 channel 语义调用它；
//   2. 把内核的两路信号转成推送：pipeline 事件（阶段）与主叙物流式增量（生成中尾巴）；
//   3. 管住在飞轮次（turnId → AbortController），中止/重骰都经它。
// 这里不出现任何 UI 判断，也不解释载荷——渲染进程要什么就搬什么。
//
// 一次只持有一个故事（`opened` 单例）：切换故事即 closeCurrent。多开是 S1 之后的事，
// 现在过早引入多实例只会让「哪个 case 指向哪个 runtime」变成 bug 来源。

import {
	createDbView,
	defaultGlobalPromptsDir,
	forkFrom,
	listStories,
	loadSettings,
	openStory,
	rebuildRuntime,
	resolvePromptChain,
	saveSettings,
	TABLE_QUERY_DEFAULT_LIMIT,
	TABLE_QUERY_MAX_LIMIT,
	type OpenedStory,
	type PromptLayerDirs,
	type StoryMode,
	type StorySummary,
	type TableInfo,
	type TablePage,
	type TavernSettings,
	type TurnLogRow,
	type TurnResult,
} from "@tavernpi/core";
import type { PushChannelName, PushPayload } from "../contract/index.ts";

/** 推送出口：生产 = IpcHost.push；验收/测试可换成收集器。 */
export interface PushSink {
	push<C extends PushChannelName>(channel: C, payload: PushPayload<C>): void;
}

export interface StoryOpenResult {
	sessionId: string;
	mode: StoryMode;
}

export interface TurnRequest {
	turnId: string;
	input: string;
	force?: boolean;
}

export interface StoryCreateRequest {
	storiesRoot?: string;
	packDirs?: string[];
	mode?: StoryMode;
	title?: string;
}

export interface StudioSessionOptions {
	/** 内核 cwd（pi 用它定位 session 目录；资源加载已关掉项目上下文文件，故不会把仓库文档灌进叙事提示）。 */
	cwd: string;
	/** settings.json 路径（缺省 ~/.tavernpi/settings.json）；允许注入便于隔离测试。 */
	settingsPath?: string;
}

export class StudioSession {
	/** 推送出口：生产 = IpcHost.push；验收/测试可换成收集器。 */
	private readonly sink: PushSink;
	/** 内核 cwd 与 settings 路径等注入项。 */
	private readonly options: StudioSessionOptions;
	private opened: OpenedStory | undefined;
	/** 在飞轮次：turnId → 中止把手。同一 turnId 不允许并发（重复即报错，不静默覆盖）。 */
	private readonly inflight = new Map<string, AbortController>();
	/** 当轮 turnId（流式增量要知道自己属于哪一轮）。 */
	private currentTurnId: string | undefined;
	/** 内核信号的解绑函数（换故事/关故事时必须全解，否则推送会打到新故事上）。 */
	private detachers: Array<() => void> = [];

	// 刻意不用构造函数参数属性：内核与 studio 主进程都靠 Node 的类型剥离直接跑 TS 源码，
	// 参数属性属不可擦除语法（tsconfig.base.json 的 erasableSyntaxOnly 会直接拒绝）。
	constructor(sink: PushSink, options: StudioSessionOptions) {
		this.sink = sink;
		this.options = options;
	}

	/** 当前打开的故事（未打开时 undefined）——验收脚本用它读装配态。 */
	get current(): OpenedStory | undefined {
		return this.opened;
	}

	async list(storiesRoot?: string): Promise<StorySummary[]> {
		return listStories(storiesRoot);
	}

	async create(req: StoryCreateRequest): Promise<StoryOpenResult> {
		this.assertIdle("切换故事");
		return this.adopt(
			await openStory({
				cwd: this.options.cwd,
				...(this.options.settingsPath !== undefined ? { settingsPath: this.options.settingsPath } : {}),
				...(req.storiesRoot !== undefined ? { storiesRoot: req.storiesRoot } : {}),
				...(req.packDirs !== undefined ? { packDirs: req.packDirs } : {}),
				...(req.mode !== undefined ? { mode: req.mode } : {}),
				...(req.title !== undefined ? { title: req.title } : {}),
				onWarning: (m) => this.sink.push("warning", { message: m }),
			}),
		);
	}

	async open(req: { storiesRoot?: string; sessionFile: string }): Promise<StoryOpenResult> {
		this.assertIdle("切换故事");
		return this.adopt(
			await openStory({
				cwd: this.options.cwd,
				...(this.options.settingsPath !== undefined ? { settingsPath: this.options.settingsPath } : {}),
				...(req.storiesRoot !== undefined ? { storiesRoot: req.storiesRoot } : {}),
				resume: req.sessionFile,
				onWarning: (m) => this.sink.push("warning", { message: m }),
			}),
		);
	}

	/**
	 * 跑一轮。中止（`turn:abort`）走内核的 AbortSignal：中止 = 未完成轮、零落库。
	 * 轮末一定推 `turn:done`（成功带终稿，中止带 ok:false）——渲染进程据此把「生成中」气泡换成定稿。
	 */
	async runTurn(req: TurnRequest): Promise<TurnResult> {
		const opened = this.requireOpen();
		if (this.inflight.has(req.turnId)) {
			throw new Error(`该轮次已在生成中: ${req.turnId}`);
		}
		const controller = new AbortController();
		this.inflight.set(req.turnId, controller);
		this.currentTurnId = req.turnId;
		try {
			const result = await opened.runtime.runTurn(req.input, {
				...(req.force !== undefined ? { force: req.force } : {}),
				signal: controller.signal,
			});
			this.sink.push("turn:done", { turnId: req.turnId, narrativeText: result.narrativeText, ok: true });
			return result;
		} catch (err) {
			// **任何失败都要收尾推送**：UI 靠 turn:done 结束「生成中」态，漏推会一直转圈。
			// 失败原因本身经请求的 rejection 回给调用方（那是契约里的错误通道），不再另推 warning——
			// 否则一次失败会被 UI 记两遍。
			this.sink.push("turn:done", { turnId: req.turnId, narrativeText: "", ok: false });
			throw err;
		} finally {
			this.inflight.delete(req.turnId);
			if (this.currentTurnId === req.turnId) this.currentTurnId = undefined;
		}
	}

	/** 中止在飞的一轮。轮次不在飞 → 抛错（不静默成功，否则 UI 会显示「已中止」而实际还在跑）。 */
	abort(req: { turnId: string }): void {
		const controller = this.inflight.get(req.turnId);
		if (controller === undefined) {
			throw new Error(`没有在飞的轮次: ${req.turnId}`);
		}
		controller.abort();
	}

	async swipe(req: { turnId: string }): Promise<TurnResult> {
		const opened = this.requireOpen();
		this.assertIdle("重骰");
		if (this.inflight.has(req.turnId)) {
			throw new Error(`该轮次已在生成中: ${req.turnId}`);
		}
		const controller = new AbortController();
		this.inflight.set(req.turnId, controller);
		this.currentTurnId = req.turnId;
		try {
			const result = await opened.runtime.swipe({ signal: controller.signal });
			this.sink.push("turn:done", { turnId: req.turnId, narrativeText: result.narrativeText, ok: true });
			return result;
		} catch (err) {
			this.sink.push("turn:done", { turnId: req.turnId, narrativeText: "", ok: false });
			throw err;
		} finally {
			this.inflight.delete(req.turnId);
			if (this.currentTurnId === req.turnId) this.currentTurnId = undefined;
		}
	}

	/**
	 * 回溯到指定条目。内核的 navigateTree 会触发快照钩子（DB 随之回退），故此后
	 * `opened.storyState.storyDb` 可能已是新实例——返回值一律现取，不缓存。
	 */
	async navigate(req: { entryId: string }): Promise<{ clock: string; eventCount: number }> {
		const opened = this.requireOpen();
		this.assertIdle("回溯");
		await opened.runtime.session.navigateTree(req.entryId);
		this.sink.push("story:changed", { sessionId: opened.sessionManager.getSessionId() });
		return {
			clock: opened.storyState.storyDb.reader.getClock()?.current_time ?? "",
			eventCount: opened.storyState.storyDb.reader.listEvents().length,
		};
	}

	/** 从指定条目分叉。内核 forkFrom 会换掉 storyState 与 eventLog，故重挂推送订阅。 */
	async fork(req: { entryId: string }): Promise<{ sessionId: string }> {
		const opened = this.requireOpen();
		this.assertIdle("分叉");
		const info = await forkFrom(opened, req.entryId);
		this.detach();
		this.attach();
		this.sink.push("story:changed", { sessionId: info.newSessionId });
		return { sessionId: info.newSessionId };
	}

	/** 读模型配置（连同告警——配置坏了要让 UI 看得见，不能静默回落默认模型）。 */
	settings(): { settings: unknown; warnings: string[] } {
		if (this.opened !== undefined) {
			return { settings: this.opened.settings, warnings: this.opened.settingsWarnings };
		}
		const { settings, warnings } = loadSettings(this.options.settingsPath);
		return { settings, warnings };
	}

	/**
	 * 写模型配置，并**立即重建 runtime** 让新配置生效。
	 * 不重建的话：盘上写了、UI 显示「已保存」，而运行中的 runtime 还持着旧配置——改了不生效且无人提示，
	 * 正是「静默无效」。生成中一律拒绝：重建会 dispose 掉正在跑轮的 runtime。
	 */
	async writeSettings(settings: unknown): Promise<void> {
		const opened = this.assertIdle("写模型配置");
		saveSettings(settings as TavernSettings, this.options.settingsPath);
		if (opened === undefined) {
			return; // 还没打开故事：只落盘，下次 openStory 自然读到
		}
		// 重建用的是装配态里的 settings，故先把它刷新成刚落盘的那份。
		const { settings: reloaded, warnings } = loadSettings(this.options.settingsPath);
		opened.settings = reloaded;
		opened.settingsWarnings = warnings;
		await rebuildRuntime(opened);
	}

	/** 提示词覆盖链（「当前生效层」展示用）。 */
	promptChain(role: string): unknown {
		return resolvePromptChain(this.promptDirs(), role);
	}

	/**
	 * 阅读流：从**当前已打开故事**的 turn_log 分页取轮次。
	 *
	 * 为什么事实源是 turn_log 而不是 pi session 转录：stylize 会润色、story 阶段可能打回重写，
	 * 转录里留着被弃的草稿，而 turn_log 只存最终落库的那版。两者不一致时以 turn_log 为准。
	 *
	 * 倒序（默认）从最新一轮往回读——打开故事先看结尾是阅读习惯，也让虚拟滚动首屏就有内容。
	 * 未打开故事时回空页而不抛错：那是 UI 的空态，不是错误。
	 */
	turns(req: { limit?: number; offset?: number; order?: "asc" | "desc" }): {
		turns: TurnLogRow[];
		total: number;
		limit: number;
		offset: number;
	} {
		const limit = clampLimit(req.limit);
		const offset = Math.max(Math.trunc(req.offset ?? 0), 0);
		const opened = this.opened;
		if (opened === undefined) return { turns: [], total: 0, limit, offset };

		// 内核的 getTurnLog 只有「全表 / 单轮」两种读法，排序与切片在这里做。
		// 故事轮次规模下（千级）整表读开销可接受；真到需要下推时再改内核，别在 studio 抄一份 SQL。
		const all = opened.storyState.storyDb.reader.getTurnLog();
		const ordered = req.order === "asc" ? all : [...all].reverse();
		return { turns: ordered.slice(offset, offset + limit), total: ordered.length, limit, offset };
	}

	/**
	 * 通用只读表查询（内核缺口 3）。不传 table → 回表清单，传了 → 回该表一页。
	 *
	 * `filter` 决定视图语义，与内核 MODE_PRESETS.dbViewFilter 同一套：
	 *   · "none"（作者视图）：全量透传，含 sys_ 簿记键与包自定义表；
	 *   · "user"（冒险视图）：内核表按 related 集合净化，包自定义表一律拒绝（TableNotVisibleError）。
	 * 注意 filter 是**调用方显式指定**，不自动跟故事模式走——模式决定的是「游玩时的默认视图」，
	 * 而 DB 浏览器是个作者工具，要看哪一面该由点开它的人决定。
	 *
	 * 每次查询新建 DbView 并 refresh：视图持有可见性缓存，跨轮复用会给出陈旧结果（缺口 12 的反面）。
	 */
	dbQuery(req: {
		table?: string;
		limit?: number;
		offset?: number;
		orderBy?: string;
		descending?: boolean;
		equals?: Record<string, string | number | null>;
		filter?: "none" | "user";
	}): { tables?: TableInfo[]; page?: TablePage } {
		const opened = this.opened;
		if (opened === undefined) return { tables: [] };

		const filter = req.filter === "user" ? "user-related" : "none";
		const view = createDbView(opened.storyState.storyDb.reader, filter);
		view.refresh();
		if (req.table === undefined) {
			// listTables 已按视图自身规则过滤（user-related 只列内核表），无需再分叉。
			return { tables: view.listTables() };
		}
		return {
			page: view.queryTable({
				table: req.table,
				limit: clampLimit(req.limit),
				offset: Math.max(Math.trunc(req.offset ?? 0), 0),
				...(req.orderBy !== undefined ? { orderBy: req.orderBy } : {}),
				...(req.descending !== undefined ? { descending: req.descending } : {}),
				...(req.equals !== undefined ? { equals: req.equals } : {}),
			}),
		};
	}

	/** 关掉当前故事：解绑推送、dispose runtime、关两个库。可反复调用。 */
	closeCurrent(): void {
		const opened = this.opened;
		if (opened === undefined) return;
		this.detach();
		this.opened = undefined;
		opened.runtime.dispose();
		opened.storyState.storyDb.close();
		opened.storyState.snapshotsDb.close();
	}

	/** 进程退出前的收尾（中止所有在飞轮次 + 关故事）。 */
	dispose(): void {
		for (const controller of this.inflight.values()) controller.abort();
		this.inflight.clear();
		this.currentTurnId = undefined;
		this.closeCurrent();
	}

	/** 接管一个装配态：换故事前先关旧的（一次只持一个），再挂推送。 */
	private adopt(opened: OpenedStory): StoryOpenResult {
		this.closeCurrent();
		this.opened = opened;
		this.attach();
		this.sink.push("story:changed", { sessionId: opened.sessionManager.getSessionId() });
		return { sessionId: opened.sessionManager.getSessionId(), mode: opened.runtime.mode };
	}

	private attach(): void {
		const opened = this.opened;
		if (opened === undefined) return;
		// pipeline 阶段事件（阶段词与耗时）
		this.detachers.push(
			opened.eventLog.on((e) => {
				this.sink.push("event:pipeline", {
					turnSeq: e.turnSeq,
					role: e.role,
					// 旧日志无 phase，按 end 处理（向后兼容）；start 事件不带 ok/durationMs，故此处条件展开。
					phase: e.phase ?? "end",
					...(e.ok !== undefined ? { ok: e.ok } : {}),
					...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
					...(e.error !== undefined ? { error: e.error } : {}),
				});
			}),
		);
		// 主叙物流式增量：**只作「生成中」临时展示**——stylize 会润色、story 可能打回重写，
		// 草稿与终稿可以不同，渲染进程必须在轮末用 turn:done 的 narrativeText 覆写。
		this.detachers.push(
			opened.runtime.session.subscribe((event) => {
				if (event.type !== "message_update") return;
				if (event.assistantMessageEvent.type !== "text_delta") return;
				const turnId = this.currentTurnId;
				if (turnId === undefined) return;
				this.sink.push("turn:delta", { turnId, text: event.assistantMessageEvent.delta });
			}),
		);
	}

	private detach(): void {
		for (const off of this.detachers) off();
		this.detachers = [];
	}

	private requireOpen(): OpenedStory {
		if (this.opened === undefined) {
			throw new Error("尚未打开故事（先 story:create 或 story:open）");
		}
		return this.opened;
	}

	/**
	 * 需要「空闲」的操作（切故事 / 重建 / 回溯 / 重骰 / 分叉 / 写配置）统一走这里。
	 * 缺了这道闸门会怎样：生成中切故事 → 把正在跑轮的 runtime dispose 掉；生成中回溯 → 动正在写的会话树。
	 * 两种都是内核明确禁止的（CLI 侧本来就有 isStreaming 守卫，studio 不能少）。
	 */
	private assertIdle(action: string): OpenedStory | undefined {
		if (this.inflight.size > 0) {
			throw new Error(`${action}被拒：有 ${this.inflight.size} 轮正在生成，请先中止（turn:abort）再操作`);
		}
		const opened = this.opened;
		if (opened !== undefined && opened.runtime.session.isStreaming) {
			throw new Error(`${action}被拒：主叙事仍在流式中，请稍候再试`);
		}
		return opened;
	}

	private promptDirs(): PromptLayerDirs {
		const opened = this.opened;
		if (opened === undefined) return { globalDir: defaultGlobalPromptsDir() };
		return { ...opened.prompts, storyDir: opened.storyState.storyDir };
	}
}

/**
 * 页大小夹取：缺省取内核默认值，上下限对齐内核（TABLE_QUERY_MAX_LIMIT）——
 * 两边各写一套常数必然漂移，故直接引用内核常量。
 * 注意这是**边界形状**夹取，不是业务判断：超限静默夹住比让内核抛错更适合分页控件。
 */
function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return TABLE_QUERY_DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(limit), 1), TABLE_QUERY_MAX_LIMIT);
}
