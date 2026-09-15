// 内核级模式预设单测（★信任边界）。
// 覆盖：预设矩阵 validateSubagentSwitches / 切换规则矩阵 canSwitchMode|assertCanSwitchMode /
// createStory mode 写 meta + readStoryMeta 回读 / inheritStoryMeta 复制 / runtime 模式解析与 setMode 持久化。

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import {
	assertCanSwitchMode,
	canSwitchMode,
	isStoryMode,
	MODE_PRESETS,
	validateSubagentSwitches,
	type StoryMode,
	type SubagentSwitchFlags,
} from "../src/mode.ts";
import {
	createStory,
	inheritStoryMeta,
	readStoryMeta,
	writeStoryMeta,
	type StoryMetaFile,
} from "../src/story.ts";
import { applyModeSwitch, createStoryRuntime, resolveStoryMode } from "../src/pipeline/runtime.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { StoryState } from "../src/pipeline/runtime.ts";

// ---------------------------------------------------------------------------
// 预设矩阵：validateSubagentSwitches
// ---------------------------------------------------------------------------

test("creation：story 开 → 任意组合合法（npc/stylize 无关）", () => {
	const combos: SubagentSwitchFlags[] = [
		{ story: true, npc: true, stylize: true },
		{ story: true, npc: true, stylize: false },
		{ story: true, npc: false, stylize: true },
		{ story: true, npc: false, stylize: false },
	];
	for (const c of combos) assert.deepEqual(validateSubagentSwitches("creation", c), []);
});

test("creation：story 关前提 npp 与 stylize 均已关——违规列举", () => {
	// story 关 + stylize 开 → 违规
	assert.deepEqual(
		validateSubagentSwitches("creation", { story: false, npc: false, stylize: true }),
		["story 已关，但 stylize 仍开——创造模式下 story 可关的前提是 npc 与 stylize 均已关"],
	);
	// story 关 + npc 开 → 违规
	assert.deepEqual(
		validateSubagentSwitches("creation", { story: false, npc: true, stylize: false }),
		["story 已关，但 npc 仍开——创造模式下 story 可关的前提是 npc 与 stylize 均已关"],
	);
	// story 关 + npc 与 stylize 都开 → 两条违规
	const both = validateSubagentSwitches("creation", { story: false, npc: true, stylize: true });
	assert.equal(both.length, 2);
	assert.ok(both.join("").includes("npc 仍开"));
	assert.ok(both.join("").includes("stylize 仍开"));
	// 全关 → 合法
	assert.deepEqual(validateSubagentSwitches("creation", { story: false, npc: false, stylize: false }), []);
});

test("survival：仅 stylize 可关——story/npc 必须开", () => {
	assert.deepEqual(validateSubagentSwitches("survival", { story: true, npc: true, stylize: false }), []);
	assert.deepEqual(validateSubagentSwitches("survival", { story: true, npc: true, stylize: true }), []);
	assert.deepEqual(validateSubagentSwitches("survival", { story: false, npc: true, stylize: false }), [
		"survival（生存）模式下 story 必须开",
	]);
	assert.deepEqual(validateSubagentSwitches("survival", { story: true, npc: false, stylize: false }), [
		"survival（生存）模式下 npc 必须开",
	]);
	const both = validateSubagentSwitches("survival", { story: false, npc: false, stylize: false });
	assert.equal(both.length, 2);
});

test("adventure：story/npc/stylize 全部强制开", () => {
	assert.deepEqual(validateSubagentSwitches("adventure", { story: true, npc: true, stylize: true }), []);
	assert.deepEqual(validateSubagentSwitches("adventure", { story: false, npc: true, stylize: true }), [
		"adventure（冒险）模式下 story 必须开",
	]);
	assert.deepEqual(validateSubagentSwitches("adventure", { story: true, npc: false, stylize: true }), [
		"adventure（冒险）模式下 npc 必须开",
	]);
	assert.deepEqual(validateSubagentSwitches("adventure", { story: true, npc: true, stylize: false }), [
		"adventure（冒险）模式下 stylize 必须开",
	]);
	const allOff = validateSubagentSwitches("adventure", { story: false, npc: false, stylize: false });
	assert.equal(allOff.length, 3);
});

// ---------------------------------------------------------------------------
// 预设声明（MODE_PRESETS 字段）
// ---------------------------------------------------------------------------

test("MODE_PRESETS：声明字段符合契约", () => {
	assert.equal(MODE_PRESETS.creation.directivesAllowed, true);
	assert.equal(MODE_PRESETS.creation.inputValidation, false);
	assert.equal(MODE_PRESETS.creation.dbViewFilter, "none");
	assert.deepEqual([...MODE_PRESETS.creation.toggleable].sort(), ["interaction", "npc", "story", "stylize"]);

	assert.equal(MODE_PRESETS.survival.directivesAllowed, false);
	assert.equal(MODE_PRESETS.survival.inputValidation, true);
	assert.equal(MODE_PRESETS.survival.dbViewFilter, "none");
	assert.deepEqual([...MODE_PRESETS.survival.toggleable], ["stylize"]);

	assert.equal(MODE_PRESETS.adventure.directivesAllowed, false);
	assert.equal(MODE_PRESETS.adventure.inputValidation, true);
	assert.equal(MODE_PRESETS.adventure.dbViewFilter, "user-related");
	assert.deepEqual([...MODE_PRESETS.adventure.toggleable], []);
	assert.equal(MODE_PRESETS.adventure.locked, true);
	assert.equal(MODE_PRESETS.creation.locked, false);
	assert.equal(MODE_PRESETS.survival.locked, false);
});

// ---------------------------------------------------------------------------
// 切换规则矩阵
// ---------------------------------------------------------------------------

test("canSwitchMode：创造↔生存互切，冒险锁定（双向拒绝）", () => {
	assert.equal(canSwitchMode("creation", "survival"), true);
	assert.equal(canSwitchMode("survival", "creation"), true);
	// 创造 → 冒险 非法（冒险只能创建时选定）
	assert.equal(canSwitchMode("creation", "adventure"), false);
	assert.equal(canSwitchMode("survival", "adventure"), false);
	// 冒险 → 任意（含切出）拒绝
	assert.equal(canSwitchMode("adventure", "creation"), false);
	assert.equal(canSwitchMode("adventure", "survival"), false);
	assert.equal(canSwitchMode("adventure", "adventure"), false);
	// 自切换也非法（仅允许目标的单箭头）
	assert.equal(canSwitchMode("creation", "creation"), false);
	assert.equal(canSwitchMode("survival", "survival"), false);
});

test("assertCanSwitchMode：合法通过；非法抛中文 Error（adventure 锁双向）", () => {
	assert.doesNotThrow(() => assertCanSwitchMode("creation", "survival"));
	assert.doesNotThrow(() => assertCanSwitchMode("survival", "creation"));

	assert.throws(
		() => assertCanSwitchMode("creation", "adventure"),
		/不能从 creation 切换到 adventure/,
	);
	assert.throws(() => assertCanSwitchMode("survival", "adventure"), /不能从 survival 切换到 adventure/);
	// adventure 切出 → 锁定错误信息
	assert.throws(() => assertCanSwitchMode("adventure", "creation"), /已锁定为 adventure/);
	assert.throws(() => assertCanSwitchMode("adventure", "survival"), /已锁定为 adventure/);
});

// ---------------------------------------------------------------------------
// createStory mode 写 meta + readStoryMeta 回读 + 默认 creation
// ---------------------------------------------------------------------------

test("createStory：mode 写入 story.meta.json 且 readStoryMeta 回读（默认 creation）", async () => {
	const root = makeTempDir();
	try {
		// 显式 survival
		const survival = await createStory({ storiesRoot: join(root, "s1"), packDirs: [], cwd: root, mode: "survival" });
		try {
			const meta = readStoryMeta(survival.storyDir)!;
			assert.equal(meta.mode, "survival");
		} finally {
			survival.storyState.storyDb.close();
			survival.storyState.snapshotsDb.close();
		}

		// 显式 adventure
		const adventure = await createStory({ storiesRoot: join(root, "s2"), packDirs: [], cwd: root, mode: "adventure" });
		try {
			assert.equal(readStoryMeta(adventure.storyDir)!.mode, "adventure");
		} finally {
			adventure.storyState.storyDb.close();
			adventure.storyState.snapshotsDb.close();
		}

		// 缺省模式 = creation
		const defaultStory = await createStory({ storiesRoot: join(root, "s3"), packDirs: [], cwd: root });
		try {
			const metaFile = JSON.parse(readFileSync(join(defaultStory.storyDir, "story.meta.json"), "utf8")) as StoryMetaFile;
			assert.equal(metaFile.mode, "creation");
			assert.equal(readStoryMeta(defaultStory.storyDir)!.mode, "creation");
		} finally {
			defaultStory.storyState.storyDb.close();
			defaultStory.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

// ---------------------------------------------------------------------------
// inheritStoryMeta 复制（tmpdir fixture）
// ---------------------------------------------------------------------------

test("inheritStoryMeta：复制 meta 到新目录（模式与锁随 mode 继承）；源无 meta 不写", () => {
	const root = makeTempDir();
	try {
		const src = join(root, "src");
		const dst = join(root, "dst");
		mkdirSync(src, { recursive: true });
		mkdirSync(dst, { recursive: true });

		const meta: StoryMetaFile = { packs: [], mode: "adventure", createdAt: new Date().toISOString() };
		writeStoryMeta(src, meta);
		inheritStoryMeta(src, dst);
		assert.deepEqual(readStoryMeta(dst), meta);
		assert.equal(readStoryMeta(dst)!.mode, "adventure");

		// 源无 meta → 不写
		const empty = join(root, "empty");
		mkdirSync(empty, { recursive: true });
		inheritStoryMeta(empty, dst);
		// dst 上回的 meta 仍在（未覆盖）
		assert.equal(readStoryMeta(dst)!.mode, "adventure");
	} finally {
		cleanupTempDir(root);
	}
});

// ---------------------------------------------------------------------------
// runtime 模式解析：adventure 锁 + 缺省从 meta 恢复
// ---------------------------------------------------------------------------

function writeModeMeta(dir: string, mode: StoryMode | undefined): string {
	writeStoryMeta(dir, { packs: [], ...(mode !== undefined ? { mode } : {}), createdAt: new Date().toISOString() });
	return dir;
}

test("resolveStoryMode：adventure 锁不可绕（option 传别的值抛错）", () => {
	const dir = makeTempDir();
	try {
		writeModeMeta(dir, "adventure");
		assert.throws(() => resolveStoryMode("survival", dir), /已锁定为 adventure/);
		assert.throws(() => resolveStoryMode("creation", dir), /已锁定为 adventure/);
		// 同 mode 与缺省 option 均放行
		assert.equal(resolveStoryMode("adventure", dir), "adventure");
		assert.equal(resolveStoryMode(undefined, dir), "adventure");
	} finally {
		cleanupTempDir(dir);
	}
});

test("resolveStoryMode：升级守卫——meta 非 adventure + option=adventure 抛错（冒险只能在创建时选定）", () => {
	const dir = makeTempDir();
	try {
		// meta=creation + option=adventure → 拒绝（已存在的故事不可升级为冒险）
		writeModeMeta(dir, "creation");
		assert.throws(() => resolveStoryMode("adventure", dir), /adventure（冒险）打开已存在的故事/);
		// meta=survival + option=adventure → 拒绝
		writeModeMeta(dir, "survival");
		assert.throws(() => resolveStoryMode("adventure", dir), /adventure（冒险）打开已存在的故事/);
		// meta 存在但无 mode 字段（视为缺省 creation）→ 拒绝
		writeModeMeta(dir, undefined);
		assert.throws(() => resolveStoryMode("adventure", dir), /adventure（冒险）打开已存在的故事/);
		// 无 meta（非 createStory 产物）+ option=adventure → 拒绝（无法确认曾以冒险创建）
		const noMeta = makeTempDir();
		try {
			assert.throws(() => resolveStoryMode("adventure", noMeta), /冒险模式只能在创建故事时选定；该故事无模式元数据/);
		} finally {
			cleanupTempDir(noMeta);
		}
		// 合法组合：meta=adventure + option=adventure 放行；meta=creation + option 非 adventure 放行
		writeModeMeta(dir, "adventure");
		assert.equal(resolveStoryMode("adventure", dir), "adventure");
		writeModeMeta(dir, "creation");
		assert.equal(resolveStoryMode(undefined, dir), "creation");
		assert.equal(resolveStoryMode("survival", dir), "survival");
	} finally {
		cleanupTempDir(dir);
	}
});

test("resolveStoryMode：解析顺序 option → meta → creation", () => {
	const dir = makeTempDir();
	try {
		// 无 meta → creation
		assert.equal(resolveStoryMode(undefined, dir), "creation");
		// 有 meta → 缺省取 meta
		writeModeMeta(dir, "creation");
		assert.equal(resolveStoryMode(undefined, dir), "creation");
		writeModeMeta(dir, "survival");
		assert.equal(resolveStoryMode(undefined, dir), "survival");
		// 显式 option 优先于 meta（非 adventure lock 时）
		writeModeMeta(dir, "creation");
		assert.equal(resolveStoryMode("survival", dir), "survival");
		assert.equal(resolveStoryMode("creation", dir), "creation");
	} finally {
		cleanupTempDir(dir);
	}
});

test("isStoryMode：三值精确匹配 + 非法形态拒绝", () => {
	assert.equal(isStoryMode("creation"), true);
	assert.equal(isStoryMode("survival"), true);
	assert.equal(isStoryMode("adventure"), true);
	assert.equal(isStoryMode("Survival"), false);
	assert.equal(isStoryMode(""), false);
	assert.equal(isStoryMode("adventure "), false);
	assert.equal(isStoryMode(undefined), false);
	assert.equal(isStoryMode(null), false);
	assert.equal(isStoryMode(42), false);
	assert.equal(isStoryMode({}), false);
});

test("resolveStoryMode：非法 optsMode / 非法 meta.mode → 构建期抛错（不回落）", () => {
	const dir = makeTempDir();
	try {
		writeModeMeta(dir, "creation");
		// 非法 option（"Survival"）→ 抛错
		assert.throws(() => resolveStoryMode("Survival" as unknown as StoryMode, dir), /非法模式值/);
		// 非法 meta.mode → 抛错（不回落 creation）
		writeModeMeta(dir, "Survival" as unknown as StoryMode);
		assert.throws(() => resolveStoryMode(undefined, dir), /meta 记录非法模式值/);
		// 合法值不受影响
		writeModeMeta(dir, "creation");
		assert.equal(resolveStoryMode(undefined, dir), "creation");
	} finally {
		cleanupTempDir(dir);
	}
});

test("createStory：非法 options.mode → 抛错（建故事即拒）", async () => {
	const root = makeTempDir();
	try {
		await assert.rejects(
			createStory({ storiesRoot: join(root, "s"), packDirs: [], cwd: root, mode: "Survival" as unknown as StoryMode }),
			/非法模式值/,
		);
	} finally {
		cleanupTempDir(root);
	}
});

test("setMode：非法模式值 → 抛错且不改当前 mode", async () => {
	const root = makeTempDir();
	try {
		const story = await createStory({ storiesRoot: join(root, "s"), packDirs: [], cwd: root, mode: "creation" });
		const rt = await createStoryRuntime({
			cwd: root,
			sessionManager: story.sessionManager,
			storyState: story.storyState,
		});
		try {
			assert.equal(rt.mode, "creation");
			assert.throws(() => rt.setMode("Survival" as unknown as StoryMode), /非法模式值/);
			assert.throws(() => rt.setMode("" as unknown as StoryMode), /非法模式值/);
			// 非法值不改变当前 mode、不写 meta
			assert.equal(rt.mode, "creation");
			assert.equal(readStoryMeta(story.storyDir)?.mode, "creation");
		} finally {
			rt.dispose();
			story.storyState.storyDb.close();
			story.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("createStoryRuntime：meta=adventure + option=survival → 构建期抛错（锁不可绕）", async () => {
	const dir = makeTempDir();
	try {
		writeModeMeta(dir, "adventure");
		// 模式解析在构建期最前，抛错早于会话/模型建立——用桩 sessionManager/storyState 即可触发。
		await assert.rejects(
			createStoryRuntime({
				cwd: dir,
				sessionManager: {} as unknown as SessionManager,
				storyState: { storyDir: dir, storyDb: null, snapshotsDb: null } as unknown as StoryState,
				mode: "survival",
			}),
			/已锁定为 adventure/,
		);
	} finally {
		cleanupTempDir(dir);
	}
});

test("createStoryRuntime：构建期校验 subagent 开关与模式冲突 → 抛中文错列出问题", async () => {
	const dir = makeTempDir();
	try {
		writeModeMeta(dir, "creation");
		// creation + story 关 + npc 开 → 违规（校验在模型建立前抛错）
		await assert.rejects(
			createStoryRuntime({
				cwd: dir,
				sessionManager: {} as unknown as SessionManager,
				storyState: { storyDir: dir, storyDb: null, snapshotsDb: null } as unknown as StoryState,
				npc: { enabled: true },
			}),
			/npc 仍开/,
		);
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// applyModeSwitch：切换持久化 + 目标预设校验
// ---------------------------------------------------------------------------

test("applyModeSwitch：切换写回 story.meta.json，readStoryMeta 可读到新模式", () => {
	const dir = makeTempDir();
	try {
		writeModeMeta(dir, "creation");
		applyModeSwitch("creation", "survival", { story: true, npc: true, stylize: false }, dir);
		assert.equal(readStoryMeta(dir)!.mode, "survival");
	} finally {
		cleanupTempDir(dir);
	}
});

test("applyModeSwitch：切换时 subagent 开关违反目标预设 → 抛中文错列出需先重开项（不自动改）", () => {
	const dir = makeTempDir();
	try {
		// creation 切 survival：npc 已关（survival 要求 npc 开）→ 列出 npc
		writeModeMeta(dir, "creation");
		assert.throws(
			() => applyModeSwitch("creation", "survival", { story: true, npc: false, stylize: false }, dir),
			/npc 必须开/,
		);
		// 未切换成功 → meta 仍为 creation
		assert.equal(readStoryMeta(dir)!.mode, "creation");
	} finally {
		cleanupTempDir(dir);
	}
});

test("applyModeSwitch：adventure 锁定——切出与切入均拒绝", () => {
	const dir = makeTempDir();
	try {
		// 切入 adventure（creation → adventure）
		writeModeMeta(dir, "creation");
		assert.throws(
			() => applyModeSwitch("creation", "adventure", { story: true, npc: true, stylize: true }, dir),
			/不能从 creation 切换到 adventure/,
		);
		// 从 adventure 切出
		writeModeMeta(dir, "adventure");
		assert.throws(
			() => applyModeSwitch("adventure", "creation", { story: true, npc: true, stylize: true }, dir),
			/已锁定为 adventure/,
		);
	} finally {
		cleanupTempDir(dir);
	}
});

test("applyModeSwitch：切换后 meta 保留其他字段（title/defaultStyle 不丢）", () => {
	const dir = makeTempDir();
	try {
		writeStoryMeta(dir, { packs: [], title: "守陵人", defaultStyle: "冷峻简练", mode: "creation", createdAt: new Date().toISOString() });
		applyModeSwitch("creation", "survival", { story: true, npc: true, stylize: false }, dir);
		const meta = readStoryMeta(dir)!;
		assert.equal(meta.title, "守陵人");
		assert.equal(meta.defaultStyle, "冷峻简练");
		assert.equal(meta.mode, "survival");
	} finally {
		cleanupTempDir(dir);
	}
});
