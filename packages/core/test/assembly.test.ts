// 故事会话装配单测（缺口 8：openStory / rebuildRuntime / forkFrom）。
// 全程离线：新建带 opening 的故事由 createStory 本地写盘（不调用模型），fork/rebuild 亦然。
// 判据取盘上事实（story.meta.json、库内表与 seed 行、session 文件），不是内存字段自证。

import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { characterEntry, createPack, locationEntry } from "./fixtures/pack-fixtures.ts";
import { forkFrom, openStory, rebuildRuntime, resolveStylizeEnabled, type OpenedStory } from "../src/assembly.ts";
import { readStoryMeta } from "../src/story.ts";

const STORY_YAML = [
	"title: 守陵人",
	"calendar: 大雍历",
	"granularity: elastic",
	"opening: 夜幕低垂，你踏入王陵。",
	"defaultStyle: 冷峻简练",
	"",
].join("\n");

/** 带自建表 + seed 行的包：fork 是否重放迁移，靠它的表与行来判。 */
function shoulingPack(root: string): string {
	return createPack(root, {
		name: "shouling",
		story: STORY_YAML,
		entries: [
			{ type: "characters", id: "shen-qiu", yaml: characterEntry("沈秋", { refs: ["location:royal-tomb"] }) },
			{ type: "locations", id: "royal-tomb", yaml: locationEntry("王陵") },
		],
		schemaSql: "CREATE TABLE IF NOT EXISTS shouling_favor (npc_ref TEXT PRIMARY KEY, favor INTEGER);\n",
		seedSql: "INSERT OR IGNORE INTO shouling_favor (npc_ref, favor) VALUES ('shouling:shen-qiu', 0);\n",
	});
}

function cleanup(opened: OpenedStory): void {
	opened.runtime.dispose();
	opened.storyState.storyDb.close();
	opened.storyState.snapshotsDb.close();
}

/** 包里自建表的行数（判 fork 是否重放了卡包迁移）。 */
function favorRows(opened: OpenedStory): number {
	const row = opened.storyState.storyDb.rawDb.prepare("SELECT COUNT(*) AS c FROM shouling_favor").get() as {
		c: number;
	};
	return row.c;
}

test("openStory：新建无包故事——mode creation、无注入形态、无告警、事件流落在故事目录", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const opened = await openStory({ cwd: root, storiesRoot });
		try {
			assert.equal(opened.runtime.mode, "creation");
			assert.equal(opened.storyState.storyDir, join(storiesRoot, opened.sessionManager.getSessionId()));
			assert.equal(existsSync(opened.storyState.storyDir), true);
			assert.equal(opened.packs, undefined, "无包故事没有注入形态");
			assert.deepEqual(opened.packDirs, []);
			assert.deepEqual(opened.pinned, []);
			assert.deepEqual(opened.agents, { story: true, npc: true });
			assert.equal(opened.modeFromMeta, false);
			assert.deepEqual(opened.settingsWarnings, []);
			assert.equal(opened.eventLog.filePath, join(opened.storyState.storyDir, "pipeline-events.jsonl"));
			assert.deepEqual(opened.prompts, { globalDir: opened.prompts.globalDir });
			assert.ok(opened.prompts.globalDir !== undefined, "提示词全局层目录必须已装配");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("openStory：带包新建——packDirs 进提示词层与 pack 注入；defaultStyle 让 stylize 自动开", async () => {
	const root = makeTempDir();
	try {
		const packDir = shoulingPack(root);
		const opened = await openStory({ cwd: root, storiesRoot: join(root, "stories"), packDirs: [packDir] });
		try {
			assert.deepEqual(opened.packDirs, [packDir], "packDirs 归一为绝对路径");
			assert.deepEqual(opened.prompts.packDirs, [packDir]);
			assert.ok(opened.packs !== undefined, "有包必须有注入形态");
			assert.deepEqual(opened.packs.cache.getPacks().packs.map((p) => p.name), ["shouling"]);
			assert.equal(resolveStylizeEnabled(opened), true, "卡包声明 defaultStyle → stylize 自动开");
			assert.equal(favorRows(opened), 1, "新建故事已应用包 seed");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("openStory：续写——模式与卡包从 story.meta.json 恢复（调用侧不必再传 packDirs）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packDir = shoulingPack(root);
		const first = await openStory({ cwd: root, storiesRoot, packDirs: [packDir], mode: "survival" });
		const sessionFile = first.sessionManager.getSessionFile();
		assert.ok(sessionFile !== undefined, "session 文件必须已落盘");
		cleanup(first);

		const resumed = await openStory({ cwd: root, storiesRoot, resume: sessionFile });
		try {
			assert.equal(resumed.runtime.mode, "survival", "模式来自 meta 而非参数");
			assert.equal(resumed.modeFromMeta, true);
			assert.deepEqual(resumed.packDirs, [packDir], "卡包从 meta 恢复");
			assert.equal(favorRows(resumed), 1, "续写打开的是同一个库");
		} finally {
			cleanup(resumed);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("resolveStylizeEnabled：显式开关优先，其次 style，其次 adventure，最后无", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const opened = await openStory({ cwd: root, storiesRoot, style: "冷峻" });
		try {
			assert.equal(resolveStylizeEnabled(opened), true, "有 --style → 开");
			opened.agents.stylize = false;
			assert.equal(resolveStylizeEnabled(opened), false, "显式关优先于 style");
			opened.agents.stylize = true;
			opened.style = undefined;
			assert.equal(resolveStylizeEnabled(opened), true, "显式开");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("forkFrom：新 session / 新故事目录 / 继承 meta / 重放卡包迁移（自建表与 seed 行都在）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [shoulingPack(root)] });
		try {
			const entry = opened.sessionManager.getEntries()[0];
			assert.ok(entry !== undefined, "带 opening 的故事至少有开场白条目");
			const oldSessionId = opened.sessionManager.getSessionId();
			const oldStoryDir = opened.storyState.storyDir;

			const info = await forkFrom(opened, entry!.id);

			assert.equal(info.oldSessionId, oldSessionId);
			assert.notEqual(info.newSessionId, oldSessionId, "fork 产出一个新 session");
			assert.equal(opened.sessionManager.getSessionId(), info.newSessionId);
			assert.equal(opened.storyState.storyDir, join(storiesRoot, info.newSessionId));
			assert.notEqual(opened.storyState.storyDir, oldStoryDir);
			assert.equal(existsSync(opened.storyState.storyDir), true, "fork 目录已建");
			// 重建后的 runtime 必须指向新故事（而不是还攥着旧 storyState）
			assert.equal(opened.runtime.storyState.storyDir, opened.storyState.storyDir);
			// meta 继承：模式随 fork 继承（此处 creation）
			const meta = readStoryMeta(opened.storyState.storyDir);
			assert.equal(meta?.mode, "creation");
			assert.deepEqual(meta?.packs?.map((p) => p.name), ["shouling"]);
			// 卡包迁移重放：自建表存在且 seed 行在（否则 fork 产物的库只有内核表）
			assert.equal(favorRows(opened), 1, "fork 必须重放卡包 schema+seed");
			assert.ok(info.eventCount >= 0);
			assert.ok(info.snapshotCount >= 0);
			// 新故事目录的库事件数应与 info 一致（同一来源）
			assert.equal(opened.storyState.storyDb.reader.listEvents().length, info.eventCount);
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("forkFrom：**无快照链**（从故事开头 fork）也必须重放卡包迁移", async () => {
	// 这条与上一条走的是不同分支：有快照时 fork 是「拷 dump」（包表天然在内），
	// 无快照时才走 openInitialStoryDb(path, extraMigrations)——漏了 extraMigrations 的产物只剩内核表。
	// 构造无快照链：故事**不带 opening**（初始快照绑定开场白条目，无开场白即无快照），
	// 再直接往 session 追一条 user 消息（不需要模型）作为分叉点。
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packDir = createPack(root, {
			name: "shouling",
			story: "title: 无开场\ncalendar: 大雍历\n",
			entries: [{ type: "locations", id: "royal-tomb", yaml: locationEntry("王陵") }],
			schemaSql: "CREATE TABLE IF NOT EXISTS shouling_favor (npc_ref TEXT PRIMARY KEY, favor INTEGER);\n",
			seedSql: "INSERT OR IGNORE INTO shouling_favor (npc_ref, favor) VALUES ('shouling:shen-qiu', 0);\n",
		});
		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [packDir] });
		try {
			const userEntryId = opened.sessionManager.appendMessage({
				role: "user",
				content: "我推门而入。",
				timestamp: Date.now(),
			});
			assert.equal(opened.storyState.snapshotsDb.listSnapshots().length, 0, "无开场白的故事不该有初始快照");

			const info = await forkFrom(opened, userEntryId);

			assert.equal(info.snapshotCount, 0, "分叉点链上无快照 → fork 产物快照库为空（走的是空库初始化分支）");
			assert.equal(favorRows(opened), 1, "空链 fork 必须重放卡包 schema+seed，否则包表与 seed 行永久缺失");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("forkFrom：条目不存在 → 抛中文错且装配态原封不动（不半途改 session）", async () => {
	const root = makeTempDir();
	try {
		const opened = await openStory({ cwd: root, storiesRoot: join(root, "stories") });
		try {
			const sessionIdBefore = opened.sessionManager.getSessionId();
			const storyDirBefore = opened.storyState.storyDir;
			await assert.rejects(forkFrom(opened, "no-such-entry-id"), /找不到会话条目/);
			assert.equal(opened.sessionManager.getSessionId(), sessionIdBefore);
			assert.equal(opened.storyState.storyDir, storyDirBefore);
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

/**
 * 进程内指向某文件的打开句柄（Linux /proc/self/fd）。
 * 用途：验证 openStory 失败时**真的**把已打开的两个库收回了——不是靠读代码相信 catch 会跑。
 */
function openHandlesFor(target: string): string[] {
	const hits: string[] = [];
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			const link = readlinkSync(join("/proc/self/fd", fd));
			if (link.includes(target)) hits.push(`${fd} -> ${link}`);
		} catch {
			// fd 在读取瞬间被关闭：忽略
		}
	}
	return hits;
}

test("判据自检：句柄探针能看见打开的故事库（否则下面那条断言是空的）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const opened = await openStory({ cwd: root, storiesRoot });
		try {
			const dbPath = join(opened.storyState.storyDir, "story.db");
			assert.ok(openHandlesFor(dbPath).length > 0, "故事打开时应当能看见 story.db 的句柄");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("openStory：装配失败（模式与开关冲突）→ 两个库的句柄被收回，不留泄漏", async () => {
	const root = makeTempDir();
	try {
		// survival 预设要求 story 开；显式关掉会让 createStoryRuntime 在构建期抛错——
		// 此时故事目录已建、两个库已开，正是「失败后是否收回句柄」要验的那条路径。
		const storiesRoot = join(root, "stories");
		await assert.rejects(
			openStory({ cwd: root, storiesRoot, mode: "survival", agents: { story: false, npc: true } }),
			/冲突/,
		);
		// 故事目录仍在（不删用户数据），但库不该被这个进程攥着。
		// 判据用「谁有 story.db」而不是名字——`sessions/` 也符合 sessionId 字符集，不是故事。
		const storyDirs = readdirSync(storiesRoot).filter((name) => existsSync(join(storiesRoot, name, "story.db")));
		assert.equal(storyDirs.length, 1, "新建的故事目录保留，供用户之后打开");
		const dbPath = join(storiesRoot, storyDirs[0]!, "story.db");
		assert.equal(existsSync(dbPath), true);
		assert.deepEqual(openHandlesFor(dbPath), [], "失败的 openStory 不得留下打开的库句柄");
		assert.deepEqual(openHandlesFor(join(storiesRoot, storyDirs[0]!, "snapshots.db")), []);
	} finally {
		cleanupTempDir(root);
	}
});

test("rebuildRuntime：换新 runtime 实例、复用同一个 session 与 storyState、事件流文件不变", async () => {
	const root = makeTempDir();
	try {
		const opened = await openStory({ cwd: root, storiesRoot: join(root, "stories") });
		try {
			const runtimeBefore = opened.runtime;
			const sessionManagerBefore = opened.sessionManager;
			const storyStateBefore = opened.storyState;
			const eventLogPathBefore = opened.eventLog.filePath;

			const returned = await rebuildRuntime(opened);

			assert.equal(returned, opened, "原地更新并返回同一容器");
			assert.notEqual(opened.runtime, runtimeBefore, "runtime 必须换新实例（旧实例已 dispose）");
			assert.equal(opened.sessionManager, sessionManagerBefore, "session 复用");
			assert.equal(opened.storyState, storyStateBefore, "storyState 复用");
			assert.equal(opened.eventLog.filePath, eventLogPathBefore);
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});
