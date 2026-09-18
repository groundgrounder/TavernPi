// listStories 单测（缺口 4：故事枚举——studio/CLI 故事选择器的取数入口）。
// 判据：目录名合规 + 含 story.db 或 story.meta.json；不打开库（只 stat）。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { characterEntry, createPack, locationEntry } from "./fixtures/pack-fixtures.ts";
import { createStory } from "../src/story.ts";
import { listStories } from "../src/story.ts";

const STORY_YAML = [
	"title: 守陵人",
	"calendar: 大雍历",
	"granularity: elastic",
	"opening: 夜幕低垂，你踏入王陵。",
	"defaultStyle: 冷峻简练",
	"",
].join("\n");

function shoulingPack(root: string): string {
	return createPack(root, {
		name: "shouling",
		story: STORY_YAML,
		entries: [
			{ type: "characters", id: "shen-qiu", yaml: characterEntry("沈秋", { refs: ["location:royal-tomb"] }) },
			{ type: "locations", id: "royal-tomb", yaml: locationEntry("王陵") },
		],
	});
}

test("listStories：根目录不存在 → 空列表且不抛错（首次运行路径）", () => {
	const root = makeTempDir();
	try {
		assert.deepEqual(listStories(join(root, "no-such-root")), []);
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：空根目录 → 空列表", () => {
	const root = makeTempDir();
	try {
		assert.deepEqual(listStories(root), []);
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：真实 createStory 产物——字段来自 meta，尺寸/时间来自盘上文件", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const created = await createStory({ storiesRoot, packDirs: [shoulingPack(root)], cwd: root });
		created.storyState.storyDb.close();
		created.storyState.snapshotsDb.close();

		const list = listStories(storiesRoot);
		assert.equal(list.length, 1);
		const item = list[0]!;
		assert.equal(item.sessionId, created.sessionId);
		assert.equal(item.storyDir, join(storiesRoot, created.sessionId));
		assert.equal(item.title, "守陵人");
		assert.equal(item.mode, "creation");
		assert.deepEqual(item.packNames, ["shouling"]);
		assert.equal(item.defaultStyle, "冷峻简练");
		assert.match(item.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
		assert.ok((item.updatedAt ?? 0) > 0, "updatedAt 取故事库 mtime");
		assert.ok((item.dbBytes ?? 0) > 0, "dbBytes 取 story.db 实际字节数");
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：sessions 目录 / 非故事目录 / 非法目录名 一律不算故事", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const created = await createStory({ storiesRoot, packDirs: [], cwd: root });
		created.storyState.storyDb.close();
		created.storyState.snapshotsDb.close();

		// createStory 自己会建 sessions/（session 文件目录）
		assert.ok(listStories(storiesRoot).some((s) => s.sessionId === "sessions") === false, "sessions/ 必须被跳过");

		mkdirSync(join(storiesRoot, "empty-dir"), { recursive: true });
		mkdirSync(join(storiesRoot, "非法 名字"), { recursive: true });
		writeFileSync(join(storiesRoot, "not-a-dir.txt"), "x");
		// 非法名目录里放齐 meta + db：仍须跳过（下游 storyDbPath/openStory 都吃不下这个名字）
		writeFileSync(join(storiesRoot, "非法 名字", "story.meta.json"), JSON.stringify({ packs: [], createdAt: "x" }));
		writeFileSync(join(storiesRoot, "非法 名字", "story.db"), "x");

		const ids = listStories(storiesRoot).map((s) => s.sessionId);
		assert.deepEqual(ids, [created.sessionId]);
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：坏 meta 不隐藏故事——按无 meta 处理（mode 回落 creation）", () => {
	const root = makeTempDir();
	try {
		const dir = join(root, "broken-meta");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "story.meta.json"), "{ 这不是 JSON");
		writeFileSync(join(dir, "story.db"), "not a real db");

		const list = listStories(root);
		assert.equal(list.length, 1);
		assert.equal(list[0]!.mode, "creation");
		assert.equal(list[0]!.title, undefined);
		assert.deepEqual(list[0]!.packNames, []);
		assert.ok((list[0]!.dbBytes ?? 0) > 0);
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：meta 记录非法 mode → 回落 creation（不抛错，也不让故事消失）", () => {
	const root = makeTempDir();
	try {
		const dir = join(root, "bad-mode");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "story.meta.json"),
			JSON.stringify({ title: "x", mode: "Survival", packs: [], createdAt: "2026-01-01T00:00:00.000Z" }),
		);
		writeFileSync(join(dir, "story.db"), "x");

		const list = listStories(root);
		assert.equal(list[0]!.mode, "creation");
		assert.equal(list[0]!.title, "x");
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：只有 story.db（无 meta）也算故事——mode 缺省 creation", () => {
	const root = makeTempDir();
	try {
		const dir = join(root, "db-only");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "story.db"), "x");
		const list = listStories(root);
		assert.equal(list.length, 1);
		assert.equal(list[0]!.mode, "creation");
		assert.equal(list[0]!.createdAt, undefined);
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：给出会话文件路径（openStory 续写的入参）；无消息的故事缺省该字段", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		// 带开场白 → pi 写了 session 文件
		const withOpening = await createStory({
			storiesRoot,
			packDirs: [shoulingPack(root)],
			cwd: root,
		});
		withOpening.storyState.storyDb.close();
		withOpening.storyState.snapshotsDb.close();
		// 无包无开场白 → 没产生任何消息，pi 还没写文件
		const bare = await createStory({ storiesRoot, packDirs: [], cwd: root });
		bare.storyState.storyDb.close();
		bare.storyState.snapshotsDb.close();

		const byId = new Map(listStories(storiesRoot).map((s) => [s.sessionId, s]));
		const openingSummary = byId.get(withOpening.sessionId)!;
		assert.ok(openingSummary.sessionFile !== undefined, "有开场白的故事应有会话文件");
		assert.equal(existsSync(openingSummary.sessionFile!), true, "给出的路径必须真实存在");
		assert.match(openingSummary.sessionFile!, new RegExp(`${withOpening.sessionId}\\.jsonl$`));
		assert.equal(byId.get(bare.sessionId)!.sessionFile, undefined, "无消息的故事没有会话文件");
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：同一 sessionId 命中多个会话文件时取时间戳最大者（确定性，不看 readdir 顺序）", () => {
	const root = makeTempDir();
	try {
		const sessions = join(root, "sessions");
		mkdirSync(sessions, { recursive: true });
		const sessionId = "01a0aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		mkdirSync(join(root, sessionId), { recursive: true });
		writeFileSync(join(root, sessionId, "story.db"), "x");
		// 故意先写「新」的、再写「旧」的：结果是按名字定序，不是按写入顺序（readdir 顺序不可依赖）
		writeFileSync(join(sessions, `2026-09-18T10-00-00-000Z_${sessionId}.jsonl`), "{}\n");
		writeFileSync(join(sessions, `2026-01-01T10-00-00-000Z_${sessionId}.jsonl`), "{}\n");

		const item = listStories(root)[0]!;
		assert.match(item.sessionFile ?? "", /2026-09-18T10-00-00-000Z/, "应取时间戳最大的那份");
	} finally {
		cleanupTempDir(root);
	}
});

test("listStories：按最后活动时间倒序（mtime 定序，与目录创建顺序无关）", () => {
	const root = makeTempDir();
	try {
		for (const [id, mtimeSec] of [
			["older", 1_700_000_000],
			["newest", 1_800_000_000],
			["middle", 1_750_000_000],
		] as const) {
			const dir = join(root, id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "story.db"), "x");
			utimesSync(join(dir, "story.db"), mtimeSec, mtimeSec);
		}
		assert.deepEqual(
			listStories(root).map((s) => s.sessionId),
			["newest", "middle", "older"],
		);
	} finally {
		cleanupTempDir(root);
	}
});
