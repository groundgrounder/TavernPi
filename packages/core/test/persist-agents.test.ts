// 缺口 7（subagent 开关持久化）与缺口 10（钉列表持久化）的单测。
// 全程离线：新建故事由 createStory 本地写盘，不调用模型。
// 判据取盘上事实（story.meta.json 的实际字段），不是内存字段自证——内存自证正是
// 这条缺口原先的病根：「重启即回到全开」，只有读盘才能发现。
//
// 变异测试（每条断言都应可被一处改动弄红）：
//  - 去掉 persistAgents 的落盘 → 「盘上 agents 字段」断言变红；
//  - 把 resolveAgentsFromMeta 改成只认 truthy → 「垃圾值拒绝」断言变红；
//  - 去掉 openStory 的 agentsFromMeta 回填 → 「续写读回」断言变红；
//  - 去掉 setAgents 里的 assertAgentsShape → 「形态校验」断言变红。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { characterEntry, createPack, locationEntry } from "./fixtures/pack-fixtures.ts";
import { openStory, setAgents, type OpenedStory } from "../src/assembly.ts";
import { persistAgents, persistPinned, readStoryMeta, resolveAgentsFromMeta, writeStoryMeta } from "../src/story.ts";

function cleanup(opened: OpenedStory): void {
	opened.runtime.dispose();
	opened.storyState.storyDb.close();
	opened.storyState.snapshotsDb.close();
}

/** 直接读盘上 meta 的原始 JSON（绕开 readStoryMeta 的解析，看得见字段在不在）。 */
function rawMeta(storyDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(storyDir, "story.meta.json"), "utf8")) as Record<string, unknown>;
}

/**
 * 带开场白的包。**这不是多余的装饰**：pi 的 session 文件是懒写的，只有故事里存在消息时
 * 才会真正落盘；没有开场白的故事 `getSessionFile()` 给的路径压根不存在，`--resume` 会静默
 * 造出一个新 session（见本文件末尾的回归测试）。要验「续写读回」就必须用有开场白的故事。
 */
function storyPack(root: string): string {
	return createPack(root, {
		name: "shouling",
		story: "title: 守陵人\ncalendar: 大雍历\ngranularity: elastic\nopening: 夜幕低垂，你踏入王陵。\n",
		entries: [
			{ type: "characters", id: "shen-qiu", yaml: characterEntry("沈秋", { refs: ["location:royal-tomb"] }) },
			{ type: "locations", id: "royal-tomb", yaml: locationEntry("王陵") },
		],
	});
}

test("缺口 7：setAgents 落盘到 story.meta.json，续写时读回（重启不再回到全开）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const first = await openStory({ cwd: root, storiesRoot, packDirs: [storyPack(root)] });
		const sessionFile = first.sessionManager.getSessionFile();
		const storyDir = first.storyState.storyDir;
		assert.ok(sessionFile !== undefined, "session 文件必须已落盘");
		assert.equal(existsSync(sessionFile!), true, "给出的 session 路径必须真实存在（否则 resume 是死路）");

		// 关掉 npc（创造模式下合法：story 开、npc 关）
		await setAgents(first, { story: true, npc: false });
		try {
			const onDisk = rawMeta(storyDir).agents as Record<string, unknown>;
			assert.deepEqual(onDisk, { story: true, npc: false }, "开关必须落盘");
			assert.equal(first.agents.npc, false, "重建后的 runtime 回答新值");
			assert.equal(first.runtime.agents.npc, false, "runtime 的 getter 与之一致");
		} finally {
			cleanup(first);
		}

		// 续写：不传 agents，应从 meta 读回（这是缺口的本体）
		const resumed = await openStory({ cwd: root, storiesRoot, resume: sessionFile });
		try {
			assert.deepEqual(resumed.agents, { story: true, npc: false }, "续写读回：npc 仍是关的");
			assert.equal(resumed.runtime.agents.npc, false, "runtime 真的按关掉后的形态构建");
		} finally {
			cleanup(resumed);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 7：显式传入的 agents 优先于 meta（命令行是更明确的意图）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const first = await openStory({ cwd: root, storiesRoot, packDirs: [storyPack(root)] });
		const sessionFile = first.sessionManager.getSessionFile()!;
		await setAgents(first, { story: true, npc: false });
		cleanup(first);

		const resumed = await openStory({
			cwd: root,
			storiesRoot,
			resume: sessionFile,
			agents: { story: true, npc: true },
		});
		try {
			assert.equal(resumed.agents.npc, true, "调用侧显式给的值不被 meta 的记忆盖掉");
		} finally {
			cleanup(resumed);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 7：stylize=false 落盘（而非折成「未记录」）——作者关掉它要能复现", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const opened = await openStory({ cwd: root, storiesRoot });
		const storyDir = opened.storyState.storyDir;
		try {
			await setAgents(opened, { story: true, npc: true, stylize: false });
			const onDisk = rawMeta(storyDir).agents as Record<string, unknown>;
			assert.equal(onDisk.stylize, false, "显式 false 必须落盘（不能等同于未记录）");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 7：setAgents 形态非法 → 中文错、零副作用（meta 不动、runtime 不换）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const opened = await openStory({ cwd: root, storiesRoot });
		const storyDir = opened.storyState.storyDir;
		try {
			const metaBefore = rawMeta(storyDir);
			const runtimeBefore = opened.runtime;

			// 字符串 "false" 是 truthy——不拦的话作者以为关掉了、其实在跑。
			await assert.rejects(
				setAgents(opened, { story: "false", npc: true } as unknown as { story: boolean; npc: boolean }),
				/必须是布尔值/,
			);

			assert.equal(opened.runtime, runtimeBefore, "校验失败不得重建（否则旧实例已 dispose，调用侧拿废引用）");
			assert.deepEqual(rawMeta(storyDir).agents, metaBefore.agents, "校验失败不得动 meta");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 7：与模式预设冲突 → 中文错列出需先重开项，meta 不动", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const opened = await openStory({ cwd: root, storiesRoot, mode: "survival" });
		const storyDir = opened.storyState.storyDir;
		try {
			const metaBefore = rawMeta(storyDir);
			// survival 预设要求 npc 必须开；关掉应被拒。
			await assert.rejects(setAgents(opened, { story: true, npc: false }), /survival（生存）模式下 npc 必须开/);
			assert.deepEqual(rawMeta(storyDir).agents, metaBefore.agents, "冲突时 meta 不动");
			assert.equal(opened.runtime.agents.npc, true, "runtime 保持原样");
		} finally {
			cleanup(opened);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 7：meta 读不懂 → 拒绝覆盖（宁可不写，也不把用户的东西抹掉）", async () => {
	const root = makeTempDir();
	try {
		const storyDir = join(root, "story");
		mkdirSync(storyDir, { recursive: true });
		assert.throws(() => persistAgents(storyDir, { story: true, npc: false }), /读不懂/);
		assert.throws(() => persistPinned(storyDir, ["p:type:id"]), /读不懂/);
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 7：resolveAgentsFromMeta 只信布尔——垃圾值响亮拒绝而非静默当 false", async () => {
	const root = makeTempDir();
	try {
		const storyDir = join(root, "story");
		mkdirSync(storyDir, { recursive: true });
		writeStoryMeta(storyDir, {
			packs: [],
			createdAt: new Date().toISOString(),
			agents: { npc: "no" as unknown as boolean },
		});
		assert.throws(() => resolveAgentsFromMeta(storyDir), /不是布尔值/);

		// 字段缺省 → undefined（调用侧回落全开），不是 {story:false,...}
		writeStoryMeta(storyDir, { packs: [], createdAt: new Date().toISOString() });
		assert.equal(resolveAgentsFromMeta(storyDir), undefined);

		// 只记录一态也不该把另一态填成 false
		writeStoryMeta(storyDir, { packs: [], createdAt: new Date().toISOString(), agents: { npc: false } });
		assert.deepEqual(resolveAgentsFromMeta(storyDir), { npc: false }, "未记录的字段不得被凭空补成值");
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：persistPinned 合并写保留其他字段；清空 → 字段消失（不留空数组）", async () => {
	const root = makeTempDir();
	try {
		const storyDir = join(root, "story");
		mkdirSync(storyDir, { recursive: true });
		writeStoryMeta(storyDir, {
			packs: [{ name: "p", dir: "/tmp/p" }],
			mode: "survival",
			createdAt: "2026-09-19T00:00:00.000Z",
			agents: { npc: false },
		});

		persistPinned(storyDir, ["p:location:royal-tomb"]);
		const withPin = rawMeta(storyDir);
		assert.deepEqual(withPin.pinned, ["p:location:royal-tomb"]);
		assert.deepEqual(withPin.agents, { npc: false }, "合并写不得碰 agents");
		assert.equal(withPin.mode, "survival", "合并写不得碰 mode");

		persistPinned(storyDir, []);
		assert.equal("pinned" in rawMeta(storyDir), false, "清空 = 字段消失，不留空数组");
		assert.equal(rawMeta(storyDir).mode, "survival", "清空钉不得波及 mode");
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：pinned 经 openStory 传入 / 续写读回", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const first = await openStory({
			cwd: root,
			storiesRoot,
			packDirs: [storyPack(root)],
			pinned: ["p:location:royal-tomb"],
		});
		const sessionFile = first.sessionManager.getSessionFile()!;
		try {
			assert.deepEqual(first.pinned, ["p:location:royal-tomb"], "新建时按传入值初始化");
			persistPinned(first.storyState.storyDir, first.pinned);
		} finally {
			cleanup(first);
		}

		const resumed = await openStory({ cwd: root, storiesRoot, resume: sessionFile });
		try {
			assert.deepEqual(resumed.pinned, ["p:location:royal-tomb"], "续写从 meta 读回钉");
			assert.deepEqual(resumed.packs?.pinned(), ["p:location:royal-tomb"], "注入层拿到同一份钉");
		} finally {
			cleanup(resumed);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 10：续写未在 meta 记钉 → 空列表（老故事兼容）", async () => {
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const first = await openStory({ cwd: root, storiesRoot, packDirs: [storyPack(root)] });
		const sessionFile = first.sessionManager.getSessionFile()!;
		const meta = readStoryMeta(first.storyState.storyDir);
		assert.equal(meta?.pinned, undefined, "未给钉时不写字段");
		cleanup(first);

		const resumed = await openStory({ cwd: root, storiesRoot, resume: sessionFile });
		try {
			assert.deepEqual(resumed.pinned, [], "字段缺省 → 空钉列表，不抛错");
		} finally {
			cleanup(resumed);
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("回归：resume 指向不存在的 session 文件 → 响亮拒绝，不静默造新故事", async () => {
	// 这条不是缺口 7/10 的正题，是写上面的测试时**撞出来的既有缺陷**，现已修并钉住。
	//
	// 病根：pi 的 session 文件是懒写的，只有故事里存在消息时才落盘。无开场白的故事
	// （无包的新故事就是这种）没有任何消息 → 文件从没写过。此时 getSessionFile() 照样返回
	// 一个路径，调用侧若直接把它喂给 openStory({resume})，pi 的 _setSessionFile 会走
	// 「文件不存在 → newSession()」分支，**生成一个全新 sessionId**——续写变成「打开另一个
	// 新故事」，用户的库被撇在一边，且不报任何错。静默 + 看起来正常 = 最坏的一类失败。
	//
	// 判据：抛错（不是「换了个 session 继续跑」），且**不留下新故事目录**。
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const first = await openStory({ cwd: root, storiesRoot }); // 无包 = 无开场白
		const sessionFile = first.sessionManager.getSessionFile();
		assert.ok(sessionFile !== undefined, "pi 仍会给出一个路径");
		assert.equal(existsSync(sessionFile!), false, "无消息 → session 文件从未落盘（本缺陷的判据）");
		const dirsBefore = readdirSync(storiesRoot).sort();
		cleanup(first);

		await assert.rejects(
			openStory({ cwd: root, storiesRoot, resume: sessionFile }),
			/session 文件不存在/,
			"不存在的 resume 路径必须响亮拒绝",
		);
		assert.deepEqual(
			readdirSync(storiesRoot).sort(),
			dirsBefore,
			"被拒的 resume 不得留下任何新目录（既没建新故事，也没建空库）",
		);
	} finally {
		cleanupTempDir(root);
	}
});

test("回归：session 文件的 sessionId 指向不存在的故事目录 → 拒绝，不新建空库", async () => {
	// 第二道纵深防御：session 文件在、但对应故事目录被移走/删掉。
	// 若无此闸，openStoryDb 会就地建一个新库（它有建目录语义），「续写」就成了「造一个空故事」。
	const root = makeTempDir();
	try {
		const storiesRoot = join(root, "stories");
		const first = await openStory({ cwd: root, storiesRoot, packDirs: [storyPack(root)] });
		const sessionFile = first.sessionManager.getSessionFile()!;
		const sessionId = first.sessionManager.getSessionId();
		cleanup(first);

		// 移走故事目录（模拟用户手动挪过/删过），保留 session 文件。
		renameSync(join(storiesRoot, sessionId), join(root, "moved-away"));
		const dirsBefore = readdirSync(storiesRoot).sort();

		await assert.rejects(
			openStory({ cwd: root, storiesRoot, resume: sessionFile }),
			/故事目录不存在/,
			"孤儿 session 必须响亮拒绝",
		);
		assert.deepEqual(readdirSync(storiesRoot).sort(), dirsBefore, "不得就地建出空故事目录");
	} finally {
		cleanupTempDir(root);
	}
});
