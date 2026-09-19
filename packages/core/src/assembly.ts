// 故事会话装配（缺口 8）：把「session 文件 / 新故事」到「可跑的 StoryRuntime」这段接线收进内核。
//
// 为什么这段必须在内核：它是**引擎装配知识**，不是 UI 知识。其中几条都是踩过坑才对的细节——
//   · 续写要从 session 文件反推 storyDir 与两个库，并从 meta 恢复 packDirs；
//   · fork 必须重放卡包迁移（否则新库只有内核表，包内 `<包名>_*` 表与 seed 行缺失）；
//   · subagent 开关在 runtime 创建时固化 → 改开关只能整个重建 runtime；
//   · 轮中交互 handler 挂在 runtime 实例上 → 每次重建都要重挂（漏挂 = 卡包工具静默降级）。
// 放在 app 层意味着 studio 会复刻一份，然后与 CLI 漂移。故收成 openStory / rebuildRuntime / forkFrom。
//
// 状态容器语义：OpenedStory 是**原地更新**的可变容器——rebuildRuntime / forkFrom 会替换其中的
// runtime / storyState / eventLog / packs 字段，调用侧持有的引用始终有效（改开关后不必重取对象）。

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createPipelineEventLog, type PipelineEventLog } from "./pipeline/events.ts";
import {
	createStoryRuntime,
	resolveStoryMode,
	type StoryRuntime,
	type StoryState,
	type StylizeRuntimeOptions,
} from "./pipeline/runtime.ts";
import { createStory, inheritStoryMeta, persistPacks, readStoryMeta, resolveAgentsFromMeta } from "./story.ts";
import { defaultStoriesRoot, openStoryDb, storyDbPath } from "./db/story-db.ts";
import { openSnapshotsDb, snapshotsDbPath } from "./snapshot/snapshots-db.ts";
import { buildAncestorChain } from "./snapshot/ancestors.ts";
import { forkStoryDb } from "./snapshot/fork.ts";
import { PackCache } from "./pack/cache.ts";
import { loadPacks } from "./pack/loader.ts";
import { packMigrations } from "./pack/seed.ts";
import { defaultGlobalPromptsDir, type PromptLayerDirs } from "./prompts/loader.ts";
import { loadSettings, type TavernSettings } from "./settings.ts";
import type { StoryMode } from "./mode.ts";
import type { InteractionHandler } from "./interaction/broker.ts";

/**
 * subagent 开关。story/npc 为显式布尔；
 * stylize 三态——undefined = 按规则自动（见 resolveStylizeEnabled），true/false = 调用侧定死。
 *
 * 缺口 7：本组开关随 `story.meta.json` 的 `agents` 字段持久化（见 persistAgents），
 * 续写时由 resolveAgentsFromMeta 读回——重启不再回到全开。
 */
export interface StoryAgents {
	story: boolean;
	npc: boolean;
	stylize?: boolean;
}

/**
 * 持久化 subagent 开关到 `story.meta.json`（缺口 7）。**合并写**：保留 meta 里的其他字段
 * （title / packs / mode / defaultStyle / pinned …），只覆盖 `agents`。
 * 读不懂的 meta 一律拒绝覆盖（与 saveSettings 同一条纪律：宁可不写，也不把用户的东西抹掉）——
 * 报错而不是静默丢失，因为这里写的是一份能决定「重启后跑不跑 subagent」的记录。
 *
 * 实现落在 story.ts（meta 的读写都归它）；此处再导出，让装配层的调用点就近可读。
 */
export { persistAgents, persistPinned, resolveAgentsFromMeta } from "./story.ts";

/**
 * `story.meta.json` 的 agents 字段形态（三态；缺省字段 = 未记录）。
 * 事实源与读写实现都在 story.ts；此处别名再导出，让装配层调用点就近可读。
 */
export type { StoryAgentsMeta } from "./story.ts";

/** 卡包检索注入（packDirs 为空 = 无注入形态）。 */
export interface PackInjection {
	/** 设定集热更新缓存（getPacks：mtime 变化重载，失败回退上次成功快照 + warning）。 */
	cache: PackCache;
	/** 手动钉（getter：调用侧会话级动态改）。 */
	pinned: () => string[];
}

/**
 * 装配态（OpenedStory 去掉 runtime 本身）——runtime 的构建需要这些字段，故容器与 runtime
 * 分两步：先攒状态（StoryAssembly），再据此构建 runtime，最后合成 OpenedStory。
 */
export interface StoryAssembly {
	sessionManager: SessionManager;
	storyState: StoryState;
	eventLog: PipelineEventLog;
	settings: TavernSettings;
	/** loadSettings 的告警（配置文件缺失/坏字段）——调用侧决定怎么呈现。 */
	settingsWarnings: string[];
	/** 提示词分层目录（global + packDirs；story 层由 runtime 自行并入）。 */
	prompts: PromptLayerDirs;
	packDirs: string[];
	/** 手动钉列表（/pin /unpin 维护；随 story.meta.json 持久化，见 persistPinned）。 */
	pinned: string[];
	/** 无包故事（packDirs 为空）时缺省。fork 后按同一 packDirs 重建 cache。 */
	packs?: PackInjection;
	agents: StoryAgents;
	/** 文风（启用 stylize 并作为 styleHint 注入）。 */
	style?: string;
	/** 续写时模式来自 story.meta.json（不是调用参数）——供调用侧提示来源。 */
	modeFromMeta: boolean;
	cwd: string;
	storiesRoot: string;
	modelRuntime: ModelRuntime;
	onWarning?: (m: string) => void;
	/** 轮中交互 handler；fork/rebuild 后由本模块自动重挂。 */
	onInteraction?: InteractionHandler;
}

/** 已打开的故事会话：装配态 + 当前的 runtime（rebuild/fork 原地替换本字段）。 */
export interface OpenedStory extends StoryAssembly {
	runtime: StoryRuntime;
}

export interface OpenStoryOptions {
	cwd: string;
	/** 故事根目录（缺省 ~/.tavernpi/stories）。 */
	storiesRoot?: string;
	/** 续写：session 文件路径（SessionManager.open）。给了它就不新建故事。 */
	resume?: string;
	/** 卡包目录（新建时用；续写未给且 meta 有记录时从 meta 恢复）。 */
	packDirs?: string[];
	/** 内核级模式预设；仅新建有效（续写以 story.meta.json 记录为准，adventure 锁不可绕）。 */
	mode?: StoryMode;
	/** 故事标题；仅新建有效（写进 story.meta.json，覆盖卡包 story.yaml 的 title）。 */
	title?: string;
	/** 文风（- -style：启用 stylize 并作为 styleHint 注入）。 */
	style?: string;
	/** subagent 开关（缺省 { story: true, npc: true }；续写未给时从 story.meta.json 的 agents 复原）。 */
	agents?: StoryAgents;
	/** 手动钉（`包名:类型:id`）；续写未给时从 story.meta.json 的 pinned 复原。 */
	pinned?: string[];
	/** settings.json 路径（缺省 ~/.tavernpi/settings.json）；测试/多环境注入用。 */
	settingsPath?: string;
	/** 告警出口（模型配置告警、卡包告警、pipeline 事件写失败等）。 */
	onWarning?: (m: string) => void;
	/** 轮中交互 handler；fork/rebuild 后由本模块自动重挂。 */
	onInteraction?: InteractionHandler;
}

/**
 * 打开（新建或续写）一个故事会话：装配出可直接 runTurn 的 StoryRuntime 及其周边状态。
 * 装配失败时抛出，且不留下半成品（新建路径由 createStory 保证「校验先行、失败不留故事目录」）。
 */
export async function openStory(opts: OpenStoryOptions): Promise<OpenedStory> {
	const storiesRoot = opts.storiesRoot ?? defaultStoriesRoot();
	const cwd = opts.cwd;
	let sessionManager: SessionManager;
	let storyState: StoryState;
	let packDirs = (opts.packDirs ?? []).map((d) => resolve(d));
	let modeFromMeta = false;
	/** 续写时从 meta 复原的开关/钉列表（新建路径留空 → 走调用参数与缺省）。 */
	let agentsFromMeta: StoryAgents | undefined;
	let pinnedFromMeta: string[] = [];

	if (opts.resume !== undefined) {
		// 续写：session 文件恢复；模式与卡包从 story.meta.json 恢复。
		//
		// **先拒绝对不存在的 resume 路径**（不交给 pi 兜底）。理由：pi 的 session 文件是懒写的，
		// 只有故事里存在消息时才落盘；无开场白的故事（无包新故事就是这种）文件从未写过。
		// SessionManager.open 遇到不存在的文件会走「newSession()」分支**生成全新 sessionId**——
		// 于是「续写」悄悄变成「打开另一个新故事」：用户的库被撇在一边，且不报任何错。
		// 这是最坏的一类失败（静默 + 看起来正常），故在此响亮拒绝。
		//
		// 注意判据是「文件是否存在」而非「是否像 session 文件」：后者交给 pi（它有版本校验与
		// header 解析，坏文件在那里会抛错）。这里只堵住「压根没有这个文件」这一条。
		if (!existsSync(opts.resume)) {
			throw new Error(
				`续写失败：session 文件不存在 ${opts.resume}。` +
					"（无开场白的故事可能从未落盘——请改用故事枚举 listStories 取当下有效的 sessionFile。）",
			);
		}
		sessionManager = SessionManager.open(opts.resume);
		const sessionId = sessionManager.getSessionId();
		const dbPath = storyDbPath(storiesRoot, sessionId);
		// 纵深防御：即便 session 文件在，其 sessionId 也必须指向一个**已存在的故事目录**。
		// 否则 openStoryDb 会就地建一个新库（openStoryDb 有建目录语义）——那等于把
		// 「续写」变成「造一个空故事」，同样是静默失败。
		if (!existsSync(join(storiesRoot, sessionId))) {
			throw new Error(
				`续写失败：session ${sessionId} 对应的故事目录不存在 ${join(storiesRoot, sessionId)}。` +
					"（库被移动或删除？拒绝静默新建一个空故事。）",
			);
		}
		storyState = {
			storyDir: join(storiesRoot, sessionId),
			storyDb: openStoryDb(dbPath),
			snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
		};
		const meta = readStoryMeta(storyState.storyDir);
		modeFromMeta = meta?.mode !== undefined;
		if (packDirs.length === 0 && meta !== undefined) {
			packDirs = (meta.packs ?? []).map((p) => p.dir);
		}
		// 缺口 7/10：开关与钉随 meta 复原。**只在调用侧未显式给时**才复原——
		// 命令行 -agents/-pin 是更明确的意图，不该被上次会话的记忆盖掉。
		// 复原失败（meta 里是垃圾值）按响亮失败处理：resolveAgentsFromMeta 会抛错。
		// meta 里的字段缺省（老故事）→ 回落缺省全开，与历史行为一致（此处不做三态保留：
		// 装配层的 StoryAgents 里 stylize 才是三态的，story/npc 一直是显式布尔）。
		if (opts.agents === undefined) {
			const restored = resolveAgentsFromMeta(storyState.storyDir);
			if (restored !== undefined) {
				agentsFromMeta = {
					story: restored.story ?? true,
					npc: restored.npc ?? true,
					...(restored.stylize !== undefined ? { stylize: restored.stylize } : {}),
				};
			}
		}
		if (opts.pinned === undefined) pinnedFromMeta = readStoryMeta(storyState.storyDir)?.pinned ?? [];
	} else {
		// 新故事：mode/title 仅在创建时有效（createStory 写进 meta；adventure 创建即锁定）。
		const created = await createStory({
			storiesRoot,
			packDirs,
			cwd,
			...(opts.mode !== undefined ? { mode: opts.mode } : {}),
			...(opts.title !== undefined ? { title: opts.title } : {}),
		});
		sessionManager = created.sessionManager;
		storyState = created.storyState;
	}

	// 从装配依赖开始，任何一步失败都要**收回已打开的两个库**：否则句柄泄漏，而调用方拿不到任何
	// 可关闭的句柄（openStory 抛出时没东西可关）。
	// 会走到这里的真实失败：settings 读取、ModelRuntime 创建、subagent 开关与模式冲突
	// （validateSubagentSwitches）、卡包加载/代码包挂载、pi 的 createAgentSession。
	// 注意：新建路径的故事目录**不删**——那是个合法（可能为空）的故事，用户之后能打开它；
	// 「删数据」需要额外授权，此处不是那种场合。
	try {
		const { settings, warnings: settingsWarnings } = loadSettings(opts.settingsPath);
		const prompts: PromptLayerDirs = {
			globalDir: defaultGlobalPromptsDir(),
			// 多包提示词合并：传全部包 prompts/ 目录（后包覆盖先包；存在的才被探测）。
			...(packDirs.length > 0 ? { packDirs } : {}),
		};
		const modelRuntime = await ModelRuntime.create();
		// pinned 数组就地维护（push/splice）：packs 的 getter 直接闭包它，故容器建成后无需回调重绑。
		// 初值优先级与 agents 一致：调用侧显式给 > meta 复原 > 空。
		const pinned: string[] = [...(opts.pinned ?? pinnedFromMeta)];

		const assembly: StoryAssembly = {
			sessionManager,
			storyState,
			eventLog: createPipelineEventLog(join(storyState.storyDir, "pipeline-events.jsonl"), opts.onWarning),
			settings,
			settingsWarnings,
			prompts,
			packDirs,
			pinned,
			...(packDirs.length > 0 ? { packs: { cache: new PackCache(packDirs), pinned: () => pinned } } : {}),
			agents: opts.agents ?? agentsFromMeta ?? { story: true, npc: true },
			...(opts.style !== undefined ? { style: opts.style } : {}),
			modeFromMeta,
			cwd,
			storiesRoot,
			modelRuntime,
			...(opts.onWarning !== undefined ? { onWarning: opts.onWarning } : {}),
			...(opts.onInteraction !== undefined ? { onInteraction: opts.onInteraction } : {}),
		};
		// 先把 assembly 装进 OpenedStory（同一个对象，不浅拷），再建 runtime。
		// 顺序刻意：buildRuntime 的 onAgentsChanged 闭包要写回调用侧持有的对象，
		// 若此处 `{...assembly}` 浅拷，闭包写的会是调用侧拿不到的那份（rebuild 按旧开关构建）。
		const opened = assembly as OpenedStory;
		opened.runtime = await buildRuntime(opened);
		return opened;
	} catch (error) {
		storyState.storyDb.close();
		storyState.snapshotsDb.close();
		throw error;
	}
}

/**
 * 以当前装配态重建 runtime（原地更新 opened.runtime）。
 * 用途：subagent 开关在创建时固化，改开关必须重建（见 runtime 的 validateSubagentSwitches）。
 * 旧实例先 dispose（级联释放 assist 会话与 broker 注册），复用同一个 sessionManager 与 storyState。
 */
export async function rebuildRuntime(opened: OpenedStory): Promise<OpenedStory> {
	opened.runtime.dispose();
	opened.eventLog = createPipelineEventLog(
		join(opened.storyState.storyDir, "pipeline-events.jsonl"),
		opened.onWarning,
	);
	opened.runtime = await buildRuntime(opened);
	return opened;
}

/**
 * 改 subagent 开关并让它生效（缺口 7）。
 *
 * 顺序是刻意的：**runtime.setAgents 先校验 + 持久化**（校验不过则零副作用，meta 不动），
 * 成功后才重建 runtime——重建会让旧实例 dispose，若先重建再发现开关非法，旧实例已经没了，
 * 调用侧拿着一个废 runtime 却不知道自己做错了什么。
 *
 * 为什么必须重建：subagent 选项在 createStoryRuntime 里固化（validateSubagentSwitches 构建期跑），
 * 实例创建后改不了。这也是原先开关「只在启动时有效」的原因——现在由本函数把「改开关」这件事
 * 收敛到一处，studio / CLI 都走它，不再各自记得「改完要重建」。
 */
export async function setAgents(opened: OpenedStory, agents: StoryAgents): Promise<OpenedStory> {
	opened.runtime.setAgents(agents); // 校验 + 落盘（onAgentsChanged 已把 assembly.agents 同步好）
	await rebuildRuntime(opened);
	return opened;
}

/**
 * 改故事的卡包列表并让它生效（缺口 10 的余项：`setPacks`）。
 *
 * **为什么必须重建，而不能只换 cache**：卡包目录列表在两个地方被冻结成构建期常量——
 * ① `runtimePromptDirs.packDirs`（提示词 pack 层解析）；② `collectCodePackEntryPaths`
 * 读 `story.meta.json` 拿 `additionalExtensionPaths`（代码包 extension 注册进主叙事 session）。
 * 这两者都只在 `createStoryRuntime` 里算一次，实例建好后改不了。故加/减包 = 重建 runtime。
 *
 * **热更新与换包是两回事，别混**：包内**文本**（集合条目 / story.yaml / 提示词）本来就是热的——
 * `PackCache.getPacks()` 每次调用重扫 mtime，而 narrator 每轮调它，作者改文本下一轮就生效，
 * 不需要本函数。本函数管的是**增删整个包**（改的是「装载哪些包」，不是「包里写了什么」）。
 * 因此本函数**重建 PackCache**：新包的 mtime 指纹从未被记录过，沿用旧实例会让首次 getPacks
 * 拿旧快照回退。
 *
 * **顺序同 setAgents，理由也同**：先加载 + 全量校验（`loadPacks` 会跑 zod strict / 引用完整性 /
 * 前缀扫描 / id 冲突，任一不过则抛错、零副作用），再落盘 meta，**最后**才重建。
 * 若先重建后校验，旧实例已 dispose，调用侧拿着废引用还不知道自己错在哪。
 *
 * **懒建 packs 注入**：`assembly.packs` 在 packDirs 为空时是 undefined（无注入形态）。
 * 从「无包」换成「有包」时必须把它建出来，否则重建后 narrator 仍渲染「（无世界包注入）」；
 * 反之从「有包」换成「无包」时必须删掉，否则残留的 cache 会继续注入已移除的包。
 *
 * 失败语义：本函数**不删任何磁盘文件**——移出一个包只是让故事不再装载它，包目录原样留着。
 */
export async function setPacks(opened: OpenedStory, packDirs: string[]): Promise<OpenedStory> {
	// 归一化为绝对路径（与 openStory 的 packDirs 处理一致）——否则 meta 里存相对路径，
	// 续写时按不同 cwd 解析会指向别处。
	const dirs = packDirs.map((d) => resolve(d));
	// 校验先行：loadPacks 收集**全部**问题一次性抛（不是遇到第一个就停），且此刻零副作用。
	const packs = dirs.length > 0 ? loadPacks(dirs) : [];
	// 落盘（读不懂的 meta 拒绝覆盖，persistPacks 抛错）；写成功后才动内存态。
	persistPacks(opened.storyState.storyDir, packs);

	opened.packDirs = dirs;
	opened.prompts = {
		globalDir: opened.prompts.globalDir,
		...(dirs.length > 0 ? { packDirs: dirs } : {}),
	};
	if (dirs.length > 0) {
		// 重建 cache：新包的 mtime 指纹从未记录，沿用旧实例会回退到旧快照。
		opened.packs = { cache: new PackCache(dirs), pinned: () => opened.pinned };
	} else {
		delete opened.packs;
	}
	await rebuildRuntime(opened);
	return opened;
}

export interface ForkInfo {	oldSessionId: string;
	newSessionId: string;
	/** 分叉点：用户形态的条目退回其父条目（「这条输入之后重来」），其余取自身。 */
	truncateId: string;
	/** 新 session 文件路径（pi 可能给空值，故可缺省）。 */
	sessionFile?: string;
	/** 新库的事件数 / 快照数（供调用侧播报 fork 结果）。 */
	eventCount: number;
	snapshotCount: number;
}

/**
 * 从指定会话条目分叉出新故事（原地更新 opened 指向新故事）。
 *
 * 顺序是刻意的：先 createBranchedSession（此刻旧 runtime 已与新 session 撕裂——它改的就是同一个
 * SessionManager）→ 建新库 → dispose 旧 runtime 与两个旧库 → 继承 meta → 重建 runtime。
 * 中途失败会留下「旧 runtime 已 dispose、opened 指向半新状态」，属可接受（调用侧报错、让用户重开故事），
 * 但**绝不半途删故事目录**。
 */
export async function forkFrom(opened: OpenedStory, entryId: string): Promise<ForkInfo> {
	const entries = opened.sessionManager.getEntries();
	const entry = entries.find((e) => e.id === entryId);
	if (entry === undefined) {
		throw new Error(`找不到会话条目: ${entryId}`);
	}
	const truncateId =
		entry.type === "message" && entry.message.role === "user" ? (entry.parentId ?? entry.id) : entry.id;
	const chain = buildAncestorChain(entries, entry.id);
	const oldSessionId = opened.sessionManager.getSessionId();
	const oldStoryState = opened.storyState;

	const sessionFile = opened.sessionManager.createBranchedSession(truncateId);
	const newSessionId = opened.sessionManager.getSessionId();
	const newStoryDir = join(opened.storiesRoot, newSessionId);

	// 从故事开头 fork（空链/无快照）时新 story.db 由 core 迁移新建——必须一并重放卡包迁移，
	// 否则 fork 产物的库只有内核表（包内 `<包名>_*` 表与 seed 行缺失）。取包失败沿用 cache 的
	// 报错路径；此刻旧故事尚未 dispose，未受影响。
	const forkPackMigrations = opened.packs === undefined ? [] : packMigrations(opened.packs.cache.getPacks().packs);
	const forkResult = forkStoryDb(oldStoryState.snapshotsDb, chain, newStoryDir, forkPackMigrations);

	// 旧 runtime 与新 session 已撕裂：先 dispose（级联释放 assist 会话与 broker 注册），再放两个旧库。
	opened.runtime.dispose();
	oldStoryState.storyDb.close();
	oldStoryState.snapshotsDb.close();

	// fork 产物继承元数据：复制 story.meta.json——模式与锁定（adventure）随 mode 继承。
	inheritStoryMeta(oldStoryState.storyDir, newStoryDir);
	// fork 重建 cache（注入热更按当前磁盘包内容）。
	if (opened.packDirs.length > 0) {
		opened.packs = { cache: new PackCache(opened.packDirs), pinned: () => opened.pinned };
	}

	opened.storyState = {
		storyDir: newStoryDir,
		storyDb: forkResult.storyDb,
		snapshotsDb: forkResult.snapshotsDb,
	};
	opened.eventLog = createPipelineEventLog(join(newStoryDir, "pipeline-events.jsonl"), opened.onWarning);
	opened.runtime = await buildRuntime(opened);

	return {
		oldSessionId,
		newSessionId,
		truncateId,
		...(sessionFile !== undefined ? { sessionFile } : {}),
		eventCount: forkResult.storyDb.reader.listEvents().length,
		snapshotCount: forkResult.snapshotsDb.listSnapshots().length,
	};
}

/**
 * stylize 是否启用。显式开关优先；否则按规则：显式 style ／ 模式为 adventure（预设强制全开、
 * 不可关）／ 卡包在 story.yaml 里声明了 defaultStyle（作者写下它就是想让这部作品用它，
 * 否则该字段对「没传 style」的玩家形同虚设）。
 */
export function resolveStylizeEnabled(opened: StoryAssembly): boolean {
	if (opened.agents.stylize !== undefined) return opened.agents.stylize;
	const storyDir = opened.storyState.storyDir;
	return (
		resolveStoryMode(undefined, storyDir) === "adventure" ||
		opened.style !== undefined ||
		readStoryMeta(storyDir)?.defaultStyle !== undefined
	);
}

/** 按装配态构建 runtime（openStory / rebuildRuntime / forkFrom 共用同一份装配，杜绝三处漂移）。 */
async function buildRuntime(assembly: StoryAssembly): Promise<StoryRuntime> {
	const stylize: StylizeRuntimeOptions | undefined = resolveStylizeEnabled(assembly)
		? { enabled: true, ...(assembly.style !== undefined ? { styleHint: assembly.style } : {}) }
		: undefined;
	// 注意：onAgentsChanged 必须写**调用侧最终持有的那个对象**，而不是这里的 assembly 形参——
	// openStory 返回的是 `{...assembly, runtime}` 浅拷贝，若闭包写形参，setAgents 改的是一份
	// 调用侧看不见的副本，重建出来的 runtime 仍按旧开关构建（已由 persist-agents 测试抓出）。
	const runtime = await createStoryRuntime({
		cwd: assembly.cwd,
		sessionManager: assembly.sessionManager,
		storyState: assembly.storyState,
		settings: assembly.settings,
		modelRuntime: assembly.modelRuntime,
		prompts: assembly.prompts,
		eventLog: assembly.eventLog,
		...(assembly.onWarning !== undefined ? { onWarning: assembly.onWarning } : {}),
		// story/npc 开关：创造模式下可关，缺省全开；组合合法性由 runtime 构建期校验（违规抛中文错）。
		...(assembly.agents.npc ? { npc: { enabled: true } } : {}),
		...(assembly.agents.story ? { story: { enabled: true } } : {}),
		...(stylize !== undefined ? { stylize } : {}),
		...(assembly.packs !== undefined ? { packs: assembly.packs } : {}),
		// 缺口 7：runtime 只管校验 + 持久化，重建由装配层负责（此处把它接回装配态）。
		onAgentsChanged: (agents) => {
			assembly.agents = agents;
		},
	});
	// 轮中交互 handler 是实例级的（broker 随 runtime 重建），此处统一重挂。
	if (assembly.onInteraction !== undefined) {
		runtime.interaction.registerHandler(assembly.onInteraction);
	}
	return runtime;
}
