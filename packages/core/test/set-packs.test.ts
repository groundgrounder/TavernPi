// 缺口 10 余项：运行期增删卡包（setPacks）的单测。
// 全程离线：卡包由 fixtures 本地现建，不调用模型。
//
// 判据分两类，缺一不可：
//  - **盘上事实**：story.meta.json 的 packs 字段（这是续写装载哪些包的唯一依据）；
//  - **运行时可见后果**：提示词 pack 层的 effectiveLayer、注入报告是否出现——
//    只断言 meta 会漏掉「meta 对了但 runtime 还按旧包跑」这类半生效。
//
// 变异测试（每条断言都应能被一处改动弄红）：
//  - 去掉 setPacks 里的 persistPacks → 「meta 落盘」断言变红；
//  - 去掉 opened.prompts 的更新 → 「pack 层提示词生效」断言变红；
//  - 有包时不重建 cache / 无包时不 delete → 「增删后注入形态」断言变红；
//  - 去掉 loadPacks 的校验先行 → 「非法包拒绝且零副作用」断言变红。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { characterEntry, createPack, locationEntry } from "./fixtures/pack-fixtures.ts";
import { openStory, setPacks, type OpenedStory } from "../src/assembly.ts";
import { listStories, persistPinned, resolvePackDirsFromMeta } from "../src/story.ts";

function cleanup(opened: OpenedStory): void {
	opened.runtime.dispose();
	opened.storyState.storyDb.close();
	opened.storyState.snapshotsDb.close();
}

/** 直接读盘上 meta 的原始 JSON（绕开 readStoryMeta，看得见字段在不在）。 */
function rawMeta(storyDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(storyDir, "story.meta.json"), "utf8")) as Record<string, unknown>;
}

/**
 * 取 pack 层当下的候选路径列表。PromptChainInfo 不直接给「生效路径」，
 * 只给每层的 candidates + effectiveLayer；pack 层的路径列表恰好就是「装了哪些包的提示词目录」，
 * 这正是换包要验的东西（比 effectiveLayer 更强：它能分辨换没换对包）。
 */
function packLayerPaths(opened: OpenedStory, role: string): string[] {
	const chain = opened.runtime.prompts.resolveChain(role);
	return chain.layers.find((l) => l.layer === "pack")?.paths ?? [];
}

/**
 * 断言「narrator 不再由 pack 层接管」。
 *
 * **刻意不写 `effectiveLayer === "builtin"`**：这台机器上 `~/.tavernpi/prompts/narrator.md`
 * 可能存在（作者的全局偏好），此时合法的落点就是 `global`——断言绝对层会把测试绑死在
 * 某台机器的家目录状态上（本测试初版正是这么红的两条）。
 * 判据取「pack 层不再是生效层」+「pack 层没有候选路径」，与家目录无关。
 */
function assertPackNotEffective(opened: OpenedStory, role: string): void {
	const chain = opened.runtime.prompts.resolveChain(role);
	assert.notEqual(chain.effectiveLayer, "pack", `${role} 不该再由 pack 层接管`);
	assert.deepEqual(packLayerPaths(opened, role), [], `${role} 的 pack 层不该还有候选路径`);
}

/** 带开场白 + 一个 role 提示词的卡包（提示词层断言需要 prompts/<role>.md）。 */
function namedPack(root: string, name: string, prompt?: { role: string; content: string }): string {
	const dir = createPack(root, {
		name,
		story: `title: ${name} 世界\ncalendar: 大雍历\ngranularity: elastic\nopening: 你睁开眼。\n`,
		entries: [
			{ type: "characters", id: `${name}-hero`, yaml: characterEntry(`${name} 主角`) },
			{ type: "locations", id: `${name}-tomb`, yaml: locationEntry(`${name} 王陵`) },
		],
	});
	if (prompt !== undefined) {
		mkdirSync(join(dir, "prompts"), { recursive: true });
		writeFileSync(join(dir, "prompts", `${prompt.role}.md`), prompt.content);
	}
	return dir;
}

test("缺口 10：无包故事 → setPacks 加包：meta 落盘、提示词 pack 层生效、注入形态建起来", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packDir = namedPack(root, "shouling", { role: "narrator", content: "来自卡包的 narrator 提示词" });

		const opened = await openStory({ cwd: root, storiesRoot }); // 无包开局
		try {
			assert.equal(opened.packDirs.length, 0);
			assert.equal(opened.packs, undefined, "无包时不该有注入对象");
			assertPackNotEffective(opened, "narrator");

			await setPacks(opened, [packDir]);

			// 盘上事实：meta 记了包（续写才有依据）
			const onDisk = rawMeta(opened.storyState.storyDir).packs as Array<Record<string, unknown>>;
			assert.equal(onDisk.length, 1, "卡包必须落盘");
			assert.equal(onDisk[0]!.name, "shouling");
			assert.equal(onDisk[0]!.dir, packDir);
			assert.equal(resolvePackDirsFromMeta(opened.storyState.storyDir).length, 1, "复原入口能读到");

			// 运行时后果：pack 层真的接管了 narrator 提示词
			assert.equal(opened.packDirs.length, 1, "装配态的 packDirs 同步更新");
			assert.notEqual(opened.packs, undefined, "从无包换成有包必须建出注入对象");
			assert.equal(
				opened.runtime.prompts.resolveChain("narrator").effectiveLayer,
				"pack",
				"重建后的 runtime 必须认新包的提示词层（meta 对了但 runtime 没跟上是半生效）",
			);
			assert.deepEqual(packLayerPaths(opened, "narrator"), [join(packDir, "prompts", "narrator.md")]);
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：有包 → setPacks 减包：meta 摘掉、注入对象删除、提示词落回下一层", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packDir = namedPack(root, "shouling", { role: "narrator", content: "来自卡包的 narrator 提示词" });

		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [packDir] });
		try {
			assert.equal(opened.runtime.prompts.resolveChain("narrator").effectiveLayer, "pack");

			await setPacks(opened, []);

			assert.equal("packs" in rawMeta(opened.storyState.storyDir), false, "空列表 = 字段消失（不留空数组）");
			assert.equal(opened.packDirs.length, 0);
			assert.equal(opened.packs, undefined, "减到无包必须删掉注入对象（否则残留 cache 继续注入已移除的包）");
			assertPackNotEffective(opened, "narrator");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：换包（A → B）：注入与提示词都跟着换，不留 A 的残留", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packA = namedPack(root, "packa", { role: "narrator", content: "A 的提示词" });
		const packB = namedPack(root, "packb", { role: "narrator", content: "B 的提示词" });

		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [packA] });
		try {
			assert.deepEqual(packLayerPaths(opened, "narrator"), [join(packA, "prompts", "narrator.md")]);

			await setPacks(opened, [packB]);

			const chain = opened.runtime.prompts.resolveChain("narrator");
			assert.equal(chain.effectiveLayer, "pack");
			assert.deepEqual(packLayerPaths(opened, "narrator"), [join(packB, "prompts", "narrator.md")], "必须是 B 的，不是 A 的");
			const names = (rawMeta(opened.storyState.storyDir).packs as Array<{ name: string }>).map((p) => p.name);
			assert.deepEqual(names, ["packb"], "meta 里只该剩 B");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：非法卡包 → setPacks 抛错且零副作用（meta 不动、runtime 不换）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const goodPack = namedPack(root, "good", { role: "narrator", content: "好包的提示词" });
		// 坏包：条目缺必填字段（zod strict 会拒），且名字与好包不同，便于分辨
		const badPack = createPack(root, {
			name: "bad",
			story: "title: 坏包\n",
			entries: [{ type: "characters", id: "broken", yaml: "type: character\nname: 残缺\n" }],
		});

		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [goodPack] });
		const storyDir = opened.storyState.storyDir;
		try {
			const metaBefore = rawMeta(storyDir);
			const runtimeBefore = opened.runtime;
			const packsBefore = opened.packs;

			await assert.rejects(setPacks(opened, [badPack]), /卡包|character|校验/, "非法卡包必须响亮拒绝");

			// 零副作用：校验先行，失败时不重建（否则旧实例已 dispose，调用侧拿废引用）
			assert.equal(opened.runtime, runtimeBefore, "校验失败不得重建 runtime");
			assert.equal(opened.packs, packsBefore, "校验失败不得换注入对象");
			assert.deepEqual(rawMeta(storyDir), metaBefore, "校验失败不得动 meta");
			assert.equal(opened.packDirs.length, 1, "装配态 packDirs 不动");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：续写读回 setPacks 的结果（换包是持久的，不是会话级的）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packA = namedPack(root, "packa", { role: "narrator", content: "A 的提示词" });
		const packB = namedPack(root, "packb", { role: "narrator", content: "B 的提示词" });

		const first = await openStory({ cwd: root, storiesRoot, packDirs: [packA] });
		const sessionFile = first.sessionManager.getSessionFile()!;
		try {
			await setPacks(first, [packB]);
		} finally {
			cleanup(first);
		}

		// 续写：不传 packDirs，应从 meta 读回 B
		const resumed = await openStory({ cwd: root, storiesRoot, resume: sessionFile });
		try {
			assert.deepEqual(resumed.packDirs, [packB], "续写须装载换过之后的包");
			assert.deepEqual(
				packLayerPaths(resumed, "narrator"),
				[join(packB, "prompts", "narrator.md")],
				"续写后的 runtime 真的按 B 构建",
			);
		} finally {
			cleanup(resumed);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：setPacks 只改装载关系，绝不删磁盘上的包目录", async () => {
	// 减包容易让人以为「顺手把包也清了」。包目录是作者的作品，挪走一个包只是让
	// **这个故事**不再装载它——磁盘文件一个字节都不该动。
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packDir = namedPack(root, "shouling", { role: "narrator", content: "提示词" });
		const marker = join(packDir, "db", "schema.sql");

		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [packDir] });
		try {
			await setPacks(opened, []);
			assert.equal(existsSync(packDir), true, "包目录必须还在");
			assert.equal(existsSync(marker), true, "包内文件必须还在");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：persistPacks 合并写保留其他字段；空列表 → 字段消失", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packDir = namedPack(root, "shouling", { role: "narrator", content: "提示词" });
		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [packDir] });
		const storyDir = opened.storyState.storyDir;
		try {
			// 先把 agents / pinned 落盘，再换包，检验合并写不碰它们
			opened.runtime.setAgents({ story: true, npc: false });
			persistPinned(storyDir, ["shouling:location:shouling-tomb"]);

			await setPacks(opened, []);
			const after = rawMeta(storyDir);
			assert.equal("packs" in after, false, "空列表 → 字段消失");
			assert.deepEqual(after.agents, { story: true, npc: false }, "合并写不得碰 agents");
			assert.deepEqual(after.pinned, ["shouling:location:shouling-tomb"], "合并写不得碰 pinned");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：setPacks 之后 listStories 的 packNames 跟着更新（故事选择器读的是同一份 meta）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const packA = namedPack(root, "packa", { role: "narrator", content: "A" });
		const opened = await openStory({ cwd: root, storiesRoot, packDirs: [packA] });
		const sessionId = opened.sessionManager.getSessionId();
		try {
			assert.deepEqual(listStories(storiesRoot).find((s) => s.sessionId === sessionId)?.packNames, ["packa"]);
			await setPacks(opened, []);
			assert.deepEqual(
				listStories(storiesRoot).find((s) => s.sessionId === sessionId)?.packNames,
				[],
				"减包后列表页不该还报旧包名",
			);
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});
