// 故事创建 API（M5：createStory 故事创建：卡包加载校验 → 建故事目录 →
// openStoryDb/openSnapshotsDb → 卡包 SQL+条目 seed 迁移 → story.yaml 消费（历法/粒度写 clock、
// 开场白首轮 assistant + turn_log 0 + 初始快照）→ story.meta.json）。
//
// 与 m4-cli 的 storyDir 约定一致：sessionId 由 SessionManager.create 生成，
// 故事目录 = <storiesRoot>/<sessionId>/（story.db + snapshots.db + story.meta.json）。
//
// 卡包迁移调用形式沿 packages/tools/src/cli.ts：migrate(db) 已含 core（openStoryDb 已跑），
// 这里逐包 migrate(db, [m]) 应用 <包名>_schema / <包名>_seed（schema_migrations 追踪，幂等有序）。
//
// 卡包代码挂载（加载形态 / M6-P4a）：createStory 只把 WorldPack.extensionEntryPaths 透传进
// story.meta.json（--resume 恢复载体）；实际加载（additionalExtensionPaths 委托 pi loader）发生在
// runtime 侧，挂到主叙事 session（见 pipeline/runtime.ts 的代码包挂载段）。

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_STORY_CLOCK } from "./db/types.ts";
import { defaultStoriesRoot, openStoryDb, SESSION_ID_RE, storyDbPath } from "./db/story-db.ts";
import { migrate } from "./db/migrate.ts";
import { openSnapshotsDb, snapshotsDbPath, takeSnapshot } from "./snapshot/snapshots-db.ts";
import { loadPacks } from "./pack/loader.ts";
import { packMigrations } from "./pack/seed.ts";
import type { StoryMeta, WorldPack } from "./pack/types.ts";
import type { StoryState } from "./pipeline/runtime.ts";
import { isStoryMode, type StoryMode } from "./mode.ts";

export interface CreateStoryOptions {
	/** 故事根目录（缺省 ~/.tavernpi/stories）。 */
	storiesRoot?: string;
	/** 卡包目录（可空 = 无包故事）。 */
	packDirs: string[];
	cwd: string;
	/** 故事标题（覆盖 story.yaml title，写 story.meta.json）。 */
	title?: string;
	/** 内核级模式预设（★信任边界）；缺省 "creation"。adventure 创建时选定后锁定。 */
	mode?: StoryMode;
}

/** story.meta.json 内容（--resume 恢复 packDirs / stylize defaultStyle / mode / extensionEntryPaths 的载体）。 */
export interface StoryMetaFile {
	title?: string;
	packs: Array<{ name: string; dir: string; version?: string; extensionEntryPaths?: string[] }>;
	defaultStyle?: string;
	/** 内核级模式；adventure 由其派生 locked，随 meta 持久化并 fork/clone 继承。 */
	mode?: StoryMode;
	/**
	 * subagent 开关（缺口 7：原先是纯会话级，重启即回到全开）。三态语义：
	 * - 字段缺省（老故事 / 未改过）→ 调用侧缺省全开，与历史行为一致；
	 * - `stylize` 缺省表示「按规则自动」（见 assembly 的 resolveStylizeEnabled：
	 *   显式 style ／ adventure ／ 卡包 defaultStyle 三条规则），写成布尔才是调用侧定死。
	 * 只记录 **false** 也有意义——「作者刻意关掉了 npc」是可复现的偏好，不该每次重启问一遍。
	 */
	agents?: { story?: boolean; npc?: boolean; stylize?: boolean };
	/** 手动钉（`包名:类型:id`）持久化（缺口 10）；缺省 = 无钉。 */
	pinned?: string[];
	createdAt: string;
}

/**
 * 读 story.meta.json（--resume / mode 解析 / fork 继承共用）。读不到（文件缺失/损坏）返回 undefined。
 * 注意：不校验 mode 字段合法性——非法值按「未记录」处理（resolveStoryMode 缺省回落 creation）。
 */
export function readStoryMeta(storyDir: string): StoryMetaFile | undefined {
	try {
		return JSON.parse(readFileSync(join(storyDir, "story.meta.json"), "utf8")) as StoryMetaFile;
	} catch {
		return undefined;
	}
}

/** 写 story.meta.json（小 JSON，覆盖写即可；createStory 与 setMode 落盘共用）。 */
export function writeStoryMeta(storyDir: string, meta: StoryMetaFile): void {
	writeFileSync(join(storyDir, "story.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * fork/clone 时继承原故事元数据：复制 story.meta.json 到新故事目录（fork 产物继承模式与锁定）。
 * 模式与锁定随 mode 字段天然继承（adventure 由 mode 派生，无需单独复制锁标记）。
 * 源无 meta（非 createStory 产物）→ 不写（目标无 meta = 无模式，缺省 creation）。
 */
export function inheritStoryMeta(srcStoryDir: string, dstStoryDir: string): void {
	const meta = readStoryMeta(srcStoryDir);
	if (meta === undefined) return;
	writeStoryMeta(dstStoryDir, meta);
}

/** `story.meta.json` 的 agents 字段形态（三态；缺省字段 = 未记录）。 */
export interface StoryAgentsMeta {
	story?: boolean;
	npc?: boolean;
	stylize?: boolean;
}

/**
 * 持久化 subagent 开关到 `story.meta.json`（缺口 7）。**合并写**：保留 meta 里的其他字段
 * （title / packs / mode / defaultStyle / pinned …），只覆盖 `agents`。
 * 读不懂的 meta 一律拒绝覆盖（与 saveSettings 同一条纪律：宁可不写，也不把用户的东西抹掉）——
 * 报错而不是静默丢失，因为这里写的是一份能决定「重启后跑不跑 subagent」的记录。
 */
export function persistAgents(storyDir: string, agents: StoryAgentsMeta): void {
	const meta = readStoryMeta(storyDir);
	if (meta === undefined) {
		throw new Error(
			`无法持久化 subagent 开关：读不懂 ${join(storyDir, "story.meta.json")}（文件缺失或不是合法 JSON）。` +
				"拒绝覆盖——请先修好或删掉该文件。",
		);
	}
	// stylize 只在显式定死时才落盘（undefined = 按规则自动，落盘反而会把「自动」冻成一次快照）。
	writeStoryMeta(storyDir, {
		...meta,
		agents: {
			...(agents.story !== undefined ? { story: agents.story } : {}),
			...(agents.npc !== undefined ? { npc: agents.npc } : {}),
			...(agents.stylize !== undefined ? { stylize: agents.stylize } : {}),
		},
	});
}

/**
 * 从 `story.meta.json` 的 agents 字段复原开关（续写路径）。
 * 字段缺省（老故事 / 从未改过）→ 返回 undefined，由调用侧走缺省全开（与历史行为一致）。
 * 注意：**只信布尔**（`typeof value !== "boolean"` 即拒），meta 手改成 `"yes"` 之类的垃圾值会被
 * 当成非法值拒掉而不是悄悄当 false，与 readStoryMeta 对 mode 的宽处理刻意不同——模式有安全的
 * 缺省（creation），而开关没有：猜错了会让作者以为关掉的 subagent 其实在跑。
 */
export function resolveAgentsFromMeta(storyDir: string): StoryAgentsMeta | undefined {
	const raw = readStoryMeta(storyDir)?.agents;
	if (raw === undefined) return undefined;
	for (const key of ["story", "npc", "stylize"] as const) {
		const value = raw[key];
		if (value !== undefined && typeof value !== "boolean") {
			throw new Error(
				`story.meta.json 的 agents.${key} 不是布尔值（读到 ${JSON.stringify(value)}）。` +
					"开关没有安全的缺省，拒绝猜测——请把它改成 true / false，或删掉该字段。",
			);
		}
	}
	return {
		...(raw.story !== undefined ? { story: raw.story } : {}),
		...(raw.npc !== undefined ? { npc: raw.npc } : {}),
		...(raw.stylize !== undefined ? { stylize: raw.stylize } : {}),
	};
}

/**
 * 持久化手动钉列表到 `story.meta.json`（缺口 10）。合并写；读不懂的 meta 拒绝覆盖。
 * 空列表落成**字段缺失**（无钉 = 不写）：保持 meta 干净，也让「删掉字段」与「清空钉」同义。
 */
export function persistPinned(storyDir: string, pinned: string[]): void {
	const meta = readStoryMeta(storyDir);
	if (meta === undefined) {
		throw new Error(
			`无法持久化钉列表：读不懂 ${join(storyDir, "story.meta.json")}（文件缺失或不是合法 JSON）。` +
				"拒绝覆盖——请先修好或删掉该文件。",
		);
	}
	const { pinned: _drop, ...rest } = meta;
	writeStoryMeta(storyDir, pinned.length > 0 ? { ...rest, pinned: [...pinned] } : rest);
}

export interface CreateStoryResult {
	sessionId: string;
	storyDir: string;
	sessionManager: SessionManager;
	storyState: StoryState;
	packs: WorldPack[];
}

/** 故事列表项（listStories 的返回单元）。 */
export interface StorySummary {
	/** sessionId = 故事目录名（openStory 的 resume/storyDbPath 都以它为准）。 */
	sessionId: string;
	storyDir: string;
	/** story.meta.json 的 title；未记录则缺省（调用侧自行回落「未命名」类文案）。 */
	title?: string;
	/** 内核级模式；meta 缺失或字段非法一律按 creation（与 resolveStoryMode 的缺省一致，不抛错）。 */
	mode: StoryMode;
	/** 世界包名（meta 记录顺序 = 提示词覆盖顺序）。 */
	packNames: string[];
	/** 世界包声明的默认文风。 */
	defaultStyle?: string;
	/** meta.createdAt（ISO 串原样透传，不解析——解析失败的历史值不该让故事从列表里消失）。 */
	createdAt?: string;
	/** 最后活动时间（ms）：story.db 的 mtime，库缺席时回落故事目录 mtime。 */
	updatedAt?: number;
	/** story.db 字节数（库文件缺席则缺省）。 */
	dbBytes?: number;
	/**
	 * 会话文件路径（`<storiesRoot>/sessions/<时间戳>_<sessionId>.jsonl`）——`openStory({ resume })` 的入参。
	 * 该故事还没产生过任何消息时缺省（pi 尚未写文件）：此时能看元数据、能打开库，但续写要先跑一轮。
	 */
	sessionFile?: string;
}

/**
 * 枚举故事根目录下的全部故事（CLI / studio 的故事选择器）。
 *
 * 判据：目录名符合 sessionId 字符集，且含 story.db 或 story.meta.json（两者皆无 = 非故事目录，
 * 例如 `sessions/` 与散落的杂目录）。目录名不合规的一律跳过——它无法被 storyDbPath / openStory 消费，
 * 列出来只会让调用侧在打开时炸。
 *
 * **刻意不打开 story.db**：列表页要瞬间出结果，且不能与正在运行的故事抢写锁（同步 SQLite 会阻塞）。
 * 需要轮次 / 时钟 / 事件等库内事实时，由调用侧对选中的故事单独走 openStory。故此处只给
 * 「元数据 + 文件 stat」能回答的字段。
 */
export function listStories(storiesRoot: string = defaultStoriesRoot()): StorySummary[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(storiesRoot, { withFileTypes: true });
	} catch {
		// 根目录不存在 = 还没建过故事（首次运行即此路径），不是错误。
		return [];
	}

	const stories: StorySummary[] = [];
	const sessionFiles = indexSessionFiles(storiesRoot);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const sessionId = entry.name;
		if (!SESSION_ID_RE.test(sessionId)) continue;
		const storyDir = join(storiesRoot, sessionId);
		const meta = readStoryMeta(storyDir);
		const dbStat = statOrUndefined(join(storyDir, "story.db"));
		if (meta === undefined && dbStat === undefined) continue;
		const updatedAt = (dbStat ?? statOrUndefined(storyDir))?.mtimeMs;
		const metaMode = meta?.mode;
		const sessionFile = sessionFiles.get(sessionId);
		stories.push({
			sessionId,
			storyDir,
			...(meta?.title !== undefined ? { title: meta.title } : {}),
			mode: isStoryMode(metaMode) ? metaMode : "creation",
			packNames: (meta?.packs ?? []).map((p) => p.name),
			...(meta?.defaultStyle !== undefined ? { defaultStyle: meta.defaultStyle } : {}),
			...(meta?.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
			...(updatedAt !== undefined ? { updatedAt } : {}),
			...(dbStat !== undefined ? { dbBytes: dbStat.size } : {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
		});
	}

	// 最近活动的在前；同一毫秒（或都缺 mtime）时按 sessionId 定序，保证列表稳定。
	return stories.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
}

/**
 * 扫 `<storiesRoot>/sessions/` 建 sessionId → 会话文件 的索引（pi 的命名：`<时间戳>_<sessionId>.jsonl`）。
 * 一次列目录、整表复用，不按故事逐个 stat（列表页要快）。目录不存在 = 还没跑过任何故事 → 空索引。
 *
 * 同一 sessionId 命中多个文件时取**时间戳最大者**（名字里带 ISO 时间戳，字典序即时间序）：
 * 正常路径一故事一文件，但历史遗留 / 手工拷贝 / 会话被重新落盘都可能留下多份，
 * 此处必须是确定性的——「readdir 顺序」不是判据。
 */
function indexSessionFiles(storiesRoot: string): Map<string, string> {
	/** sessionId → 文件名（时间戳最大者）。 */
	const names = new Map<string, string>();
	let entries: Dirent[];
	try {
		entries = readdirSync(join(storiesRoot, "sessions"), { withFileTypes: true });
	} catch {
		return new Map();
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const matched = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(entry.name);
		if (matched === null) continue;
		const sessionId = matched[1]!;
		const existing = names.get(sessionId);
		if (existing === undefined || entry.name > existing) {
			names.set(sessionId, entry.name);
		}
	}
	return new Map([...names].map(([sessionId, name]) => [sessionId, join(storiesRoot, "sessions", name)]));
}

/** stat 取不到（不存在 / 无权限 / 非常规文件）返回 undefined——列表不因单个条目炸掉。 */
function statOrUndefined(path: string): { mtimeMs: number; size: number } | undefined {
	try {
		const s = statSync(path);
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return undefined;
	}
}

/** story.yaml 的历法/粒度/开场白/文风字段（StoryMeta 消费面）。 */
const STORY_META_FIELDS = ["title", "calendar", "granularity", "opening", "defaultStyle"] as const;

/**
 * 创建新故事：加载校验 → 建目录/DB → 卡包迁移 → story.yaml 消费 → 开场白首轮 → 元数据。
 * 加载失败（PackLoadError）在创建任何文件之前抛出（fail fast，不留下半成品故事目录）。
 */
export async function createStory(opts: CreateStoryOptions): Promise<CreateStoryResult> {
	// 入口校验模式（★信任边界）：非法值（如 "Survival"）建故事即报错，避免后续消费才 TypeError。
	if (opts.mode !== undefined && !isStoryMode(opts.mode)) {
		throw new Error(`非法模式值: ${JSON.stringify(opts.mode)}（应为 creation|survival|adventure）`);
	}
	const storiesRoot = opts.storiesRoot ?? defaultStoriesRoot();
	// 1) 加载 + 全量校验先行（zod strict / 引用完整性 / 前缀静态扫描 / id 冲突）
	const dirs = opts.packDirs.map((d) => resolve(d));
	const packs = dirs.length > 0 ? loadPacks(dirs) : [];

	// 2) session 与故事目录（sessionId 生成沿用 m4-cli：SessionManager.create 到 <storiesRoot>/sessions）
	const sessionManager = SessionManager.create(opts.cwd, join(storiesRoot, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const storyDir = join(storiesRoot, sessionId);
	mkdirSync(storyDir, { recursive: true });

	// 3) 打开 DB（openStoryDb 已跑 core 迁移并种入默认 clock）
	const storyDb = openStoryDb(storyDbPath(storiesRoot, sessionId));
	const snapshotsDb = openSnapshotsDb(snapshotsDbPath(storyDb.path));

	try {
		// 4) 卡包 SQL + 条目 seed：命名迁移逐包应用（schema_migrations 追踪；seed 幂等）
		for (const m of packMigrations(packs)) {
			migrate(storyDb.rawDb, [m]);
		}

		// 5) story.yaml 消费：历法/粒度写 clock 初值（多包时按包序取先定义者）
		const story = mergeStoryMeta(packs);
		if (story.calendar !== undefined || story.granularity !== undefined) {
			const clock = storyDb.reader.getClock() ?? DEFAULT_STORY_CLOCK;
			storyDb.writer.upsertClock({
				current_time: clock.current_time,
				calendar: story.calendar ?? clock.calendar,
				granularity: story.granularity ?? clock.granularity,
			});
		}

		// 6) 开场白：首轮 assistant 消息（session 树根）+ turn_log(turnSeq=0) + 初始快照。
		//    初始快照绑定 opening entry——导航到首条 user 消息时 newLeaf = opening entry，
		//    祖先链命中该快照 → 恢复到「开场白后」初始态（首 user 空库兜底的替代：有开场白的
		//    故事其「初始态」就是开场白后的世界，不该清空 seed）。
		if (story.opening !== undefined && story.opening.trim() !== "") {
			const opening = story.opening.trim();
			const openingEntryId = appendOpeningMessage(sessionManager, opening);
			storyDb.writer.recordTurnLog({
				turnSeq: 0,
				sessionEntryId: openingEntryId,
				userInput: "（开场白）",
				narrativeText: opening,
			});
			await takeSnapshot(storyDb, { turnSeq: 0, sessionEntryId: openingEntryId });
		}

		// 7) 故事元数据（--resume 恢复 packDirs / stylize defaultStyle / mode 的载体；模式缺省 creation）
		const meta: StoryMetaFile = {
			...(opts.title !== undefined
				? { title: opts.title }
				: story.title !== undefined
					? { title: story.title }
					: {}),
			packs: packs.map((p) => ({
				name: p.name,
				dir: p.dir,
				...readPackVersion(p.dir),
				// 代码挂载（M6-P4a）：extensionEntryPaths 透传进 meta，--resume 可恢复。
				...(p.extensionEntryPaths.length > 0 ? { extensionEntryPaths: p.extensionEntryPaths } : {}),
			})),
			...(story.defaultStyle !== undefined ? { defaultStyle: story.defaultStyle } : {}),
			mode: opts.mode ?? "creation",
			createdAt: new Date().toISOString(),
		};
		writeStoryMeta(storyDir, meta);
	} catch (error) {
		storyDb.close();
		snapshotsDb.close();
		throw error;
	}

	return {
		sessionId,
		storyDir,
		sessionManager,
		storyState: { storyDir, storyDb, snapshotsDb },
		packs,
	};
}

/** 多包 story.yaml 消费：按包序取每个字段的「先定义者」（title/calendar/granularity/opening/defaultStyle）。 */
function mergeStoryMeta(packs: WorldPack[]): StoryMeta {
	const merged: StoryMeta = {};
	for (const pack of packs) {
		for (const field of STORY_META_FIELDS) {
			if (merged[field] === undefined && pack.story[field] !== undefined) {
				merged[field] = pack.story[field];
			}
		}
	}
	return merged;
}

/** 开场白落 session：首轮 assistant 消息（pi session 树根，无父）。返回 entry id。
 *  provider/model 是**占位值**，不是真实模型调用：pi SDK 会遍历 session 路径、取最后一条
 *  assistant 消息的 provider/model 当作「本会话模型」去恢复（session-manager.js 的
 *  getSessionContextSettings）。开场白是新建故事里唯一的 assistant 消息，必然被取到；
 *  它没有真实模型可恢复，SDK 于是打一条 `Could not restore model ...` 并回退到默认模型
 *  ——属预期行为，不影响运行。试图删掉这两个字段只会让报错变成更难懂的 `undefined/undefined`。
 *  主叙事解析出真实模型后（sessionOptions.model 有值），SDK 不再走恢复分支，该提示即消失。 */
function appendOpeningMessage(sessionManager: SessionManager, opening: string): string {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: opening }],
		api: "pi-messages",
		provider: "tavernpi",
		model: "story-opening",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as Parameters<SessionManager["appendMessage"]>[0];
	return sessionManager.appendMessage(message);
}

/** 读包 package.json 的 version（best-effort；读不到省略字段）。 */
function readPackVersion(dir: string): { version: string } | {} {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? { version: pkg.version } : {};
	} catch {
		return {};
	}
}
