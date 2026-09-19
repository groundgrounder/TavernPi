// 提示词分层加载器单测：四层优先级、空/读失败回退、role 白名单、占位符渲染。

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import {
	assertValidRole,
	builtinPromptsDir,
	clearGlobalPromptOverride,
	clearStoryPromptOverride,
	defaultGlobalPromptsDir,
	loadPrompt,
	renderPlaceholders,
	resolvePromptChain,
	setGlobalPromptOverride,
	setStoryPromptOverride,
} from "../src/prompts/loader.ts";

/** 在 <root>/prompts/ 下写 <role>.md（层目录语义：pack/story 是根目录）。 */
function writeLayerPrompt(root: string, role: string, content: string): void {
	const promptsDir = join(root, "prompts");
	mkdirSync(promptsDir, { recursive: true });
	writeFileSync(join(promptsDir, `${role}.md`), content);
}

test("builtin 层：真实 packages/core/prompts/narrator.md 存在且可直接加载", () => {
	const result = loadPrompt("narrator");
	assert.equal(result.layer, "builtin");
	assert.equal(result.path, join(builtinPromptsDir(), "narrator.md"));
	assert.ok(result.content.length > 0, "narrator.md 内容非空");
	assert.deepEqual(result.warnings, []);
});

test("各层单独命中：global/pack/story 均以自身内容覆盖低层", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "全局内容");
		assert.equal(loadPrompt("narrator", { globalDir }).layer, "global");
		assert.equal(loadPrompt("narrator", { globalDir }).content, "全局内容");

		writeLayerPrompt(packDir, "narrator", "卡包内容");
		assert.equal(loadPrompt("narrator", { globalDir, packDirs: [packDir] }).layer, "pack");
		assert.equal(loadPrompt("narrator", { globalDir, packDirs: [packDir] }).content, "卡包内容");

		writeLayerPrompt(storyDir, "narrator", "故事内容");
		assert.equal(loadPrompt("narrator", { globalDir, packDirs: [packDir], storyDir }).layer, "story");
		assert.equal(loadPrompt("narrator", { globalDir, packDirs: [packDir], storyDir }).content, "故事内容");
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("四层同时存在：story 最高层生效，warnings 为空", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		writeLayerPrompt(packDir, "narrator", "P");
		writeLayerPrompt(storyDir, "narrator", "S");
		const result = loadPrompt("narrator", { globalDir, packDirs: [packDir], storyDir });
		assert.equal(result.layer, "story");
		assert.equal(result.content, "S");
		assert.deepEqual(result.warnings, []);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("高层文件缺失：静默回退到下一存在层（无 warning）", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		writeLayerPrompt(packDir, "narrator", "P");
		// story 层未提供文件 → 回退 pack
		const result = loadPrompt("narrator", { globalDir, packDirs: [packDir], storyDir });
		assert.equal(result.layer, "pack");
		assert.equal(result.content, "P");
		assert.deepEqual(result.warnings, []);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("高层文件为空（含纯空白）：warning 并回退到下一层", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		writeLayerPrompt(packDir, "narrator", "P");
		writeLayerPrompt(storyDir, "narrator", "   \n\t  "); // 纯空白 = 空
		const result = loadPrompt("narrator", { globalDir, packDirs: [packDir], storyDir });
		assert.equal(result.layer, "pack");
		assert.equal(result.content, "P");
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0]!, /story 层提示词为空/);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("高层文件读取失败（非 ENOENT）：warning 并回退到下一层", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		// pack 层的 narrator.md 用一个目录占位 → readFileSync 抛 EISDIR（非 ENOENT）
		mkdirSync(join(packDir, "prompts", "narrator.md"), { recursive: true });
		const result = loadPrompt("narrator", { globalDir, packDirs: [packDir] });
		assert.equal(result.layer, "global");
		assert.equal(result.content, "G");
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0]!, /pack 层提示词读取失败/);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
	}
});

test("role 白名单校验：非法字符拒绝（防路径穿越），合法标识符放行", () => {
	for (const bad of ["../evil", "a/b", "narrator-x", "Narrator", "1narrator", "", "a b", ".", ".."]) {
		assert.throws(() => loadPrompt(bad), /非法提示词角色名/, `role ${JSON.stringify(bad)} 应被拒绝`);
	}
	// 合法：小写字母开头 + 数字/下划线 → 过校验；但内置层缺失该角色 → 未命中任何层抛错
	assert.equal(loadPrompt("narrator").role, "narrator");
	assert.throws(() => loadPrompt("data_reader_2"), /未命中任何层/);
});

test("renderPlaceholders：已知替换 / 未知原样保留并去重 / 两侧空白", () => {
	// 已知替换
	const known = renderPlaceholders("你好 {{name}}，今天是 {{date}}。", { name: "艾琳", date: "仲夏" });
	assert.equal(known.text, "你好 艾琳，今天是 仲夏。");
	assert.deepEqual(known.unknownPlaceholders, []);

	// 两侧空白允许
	assert.equal(renderPlaceholders("{{  name  }}", { name: "x" }).text, "x");

	// 重复出现全部替换
	assert.equal(renderPlaceholders("{{a}}-{{a}}", { a: "x" }).text, "x-x");

	// 未知：原样保留（含原始空白），去重保首现顺序
	const unknown = renderPlaceholders("{{ a }} 与 {{b}} 与 {{a}}", { c: "忽略" });
	assert.equal(unknown.text, "{{ a }} 与 {{b}} 与 {{a}}");
	assert.deepEqual(unknown.unknownPlaceholders, ["a", "b"]);

	// 已知值为空字符串也替换
	assert.equal(renderPlaceholders("[{{a}}]", { a: "" }).text, "[]");

	// 混合：已知替换、未知保留
	const mixed = renderPlaceholders("{{a}} 与 {{c}}", { a: "1" });
	assert.equal(mixed.text, "1 与 {{c}}");
	assert.deepEqual(mixed.unknownPlaceholders, ["c"]);
});

test("defaultGlobalPromptsDir 路径形态：~/.tavernpi/prompts", () => {
	assert.equal(defaultGlobalPromptsDir(), join(homedir(), ".tavernpi", "prompts"));
});

// ---------------------------------------------------------------------------
// 多包提示词合并（后包覆盖先包 + 覆盖 warning）+ 分层管理 API
// ---------------------------------------------------------------------------

test("多包提示词合并：后包覆盖先包（效包），命中层为 pack + 覆盖 warning", () => {
	const packA = makeTempDir();
	const packB = makeTempDir();
	try {
		writeLayerPrompt(packA, "narrator", "包A内容");
		writeLayerPrompt(packB, "narrator", "包B内容");
		const result = loadPrompt("narrator", { packDirs: [packA, packB] });
		assert.equal(result.layer, "pack");
		assert.equal(result.content, "包B内容", "后包（packB）覆盖先包（packA）");
		assert.equal(result.path, join(packB, "prompts", "narrator.md"));
		assert.ok(result.warnings.some((w) => w.includes("被后包覆盖")), "覆盖 warning");
	} finally {
		cleanupTempDir(packA);
		cleanupTempDir(packB);
	}
});

test("resolvePromptChain：四层各自状态 + 生效层标记（pack 层多包）", () => {
	const globalDir = makeTempDir();
	const packA = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		writeLayerPrompt(packA, "narrator", "P");
		const chain = resolvePromptChain({ globalDir, packDirs: [packA], storyDir }, "narrator");
		assert.equal(chain.role, "narrator");
		assert.equal(chain.effectiveLayer, "pack", "pack 命中则生效层=pack（故事层无该 role）");
		const storyLayer = chain.layers.find((l) => l.layer === "story")!;
		assert.equal(storyLayer.exists, false);
		const packLayer = chain.layers.find((l) => l.layer === "pack")!;
		assert.equal(packLayer.exists, true);
		assert.equal(packLayer.effective, true);
		assert.ok(packLayer.contentLength > 0);
		assert.equal(chain.layers.length, 4);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packA);
		cleanupTempDir(storyDir);
	}
});

test("setStoryPromptOverride / clearStoryPromptOverride：story 层覆盖命中、清除后回退；非法 role 抛错", () => {
	const storyDir = makeTempDir();
	try {
		// 未覆盖时 → builtin
		assert.equal(loadPrompt("narrator", { storyDir }).layer, "builtin");
		// 覆盖 story 层
		setStoryPromptOverride(storyDir, "narrator", "故事覆盖内容");
		const loaded = loadPrompt("narrator", { storyDir });
		assert.equal(loaded.layer, "story");
		assert.equal(loaded.content, "故事覆盖内容");
		// resolvePromptChain 反映
		assert.equal(resolvePromptChain({ storyDir }, "narrator").effectiveLayer, "story");
		// 清除后回退 builtin
		clearStoryPromptOverride(storyDir, "narrator");
		assert.equal(loadPrompt("narrator", { storyDir }).layer, "builtin");
		// 非法 role 抛错
		assert.throws(() => setStoryPromptOverride(storyDir, "../evil", "x"), /非法提示词角色名/);
		assert.throws(() => clearStoryPromptOverride(storyDir, "a/b"), /非法提示词角色名/);
		assert.throws(() => assertValidRole("Narrator"), /非法提示词角色名/);
	} finally {
		cleanupTempDir(storyDir);
	}
});

// ---------------------------------------------------------------------------
// 缺口 5：global 层提示词可写（pack 层刻意只读）
// ---------------------------------------------------------------------------

test("setGlobalPromptOverride：写入 <globalDir>/<role>.md，返回落盘路径，loadPrompt 立刻读到", () => {
	const root = makeTempDir();
	try {
		const globalDir = join(root, "global-prompts");
		const path = setGlobalPromptOverride("narrator", "全局版提示词", globalDir);

		assert.equal(path, join(globalDir, "narrator.md"), "返回路径要与实际落盘位置一致");
		const loaded = loadPrompt("narrator", { globalDir });
		assert.equal(loaded.layer, "global", "global 层应生效");
		assert.equal(loaded.content, "全局版提示词");
	} finally {
		cleanupTempDir(root);
	}
});

test("setGlobalPromptOverride：覆盖已存在的 global 提示词（改写是它的本分）", () => {
	const root = makeTempDir();
	try {
		const globalDir = join(root, "g");
		setGlobalPromptOverride("data", "第一版", globalDir);
		setGlobalPromptOverride("data", "第二版", globalDir);

		assert.equal(loadPrompt("data", { globalDir }).content, "第二版", "后写应覆盖先写");
	} finally {
		cleanupTempDir(root);
	}
});

test("setGlobalPromptOverride：目录不存在会建出来（首次使用 global 层不该要求手建目录）", () => {
	const root = makeTempDir();
	try {
		const globalDir = join(root, "a", "b", "c");
		assert.doesNotThrow(() => setGlobalPromptOverride("narrator", "深目录", globalDir));
		assert.equal(loadPrompt("narrator", { globalDir }).content, "深目录");
	} finally {
		cleanupTempDir(root);
	}
});

test("setGlobalPromptOverride：role 非法 → 抛错（防路径穿越，与 story 层同一道闸）", () => {
	const root = makeTempDir();
	try {
		assert.throws(() => setGlobalPromptOverride("../../etc/passwd", "x", join(root, "g")), /非法提示词角色名/);
		assert.throws(() => setGlobalPromptOverride("Data", "x", join(root, "g")), /非法提示词角色名/);
	} finally {
		cleanupTempDir(root);
	}
});

test("clearGlobalPromptOverride：删掉后回退到下一层；返回值区分「真删了」与「本来就没有」", () => {
	const root = makeTempDir();
	try {
		const globalDir = join(root, "g");
		setGlobalPromptOverride("narrator", "全局版", globalDir);

		assert.equal(clearGlobalPromptOverride("narrator", globalDir), true, "存在 → 真删掉了");
		assert.equal(loadPrompt("narrator", { globalDir }).layer, "builtin", "删掉后应回退到 builtin");
		assert.equal(clearGlobalPromptOverride("narrator", globalDir), false, "第二次 → 本来就没有");
	} finally {
		cleanupTempDir(root);
	}
});

test("global 层缺省目录是 ~/.tavernpi/prompts（显式传参只用于测试/多份配置）", () => {
	assert.equal(defaultGlobalPromptsDir(), join(homedir(), ".tavernpi", "prompts"));
});

test("分层写：story 覆盖 global（高层压低层），两层各自独立", () => {
	const root = makeTempDir();
	try {
		const globalDir = join(root, "g");
		const storyDir = join(root, "s");
		setGlobalPromptOverride("stylize", "全局版", globalDir);
		setStoryPromptOverride(storyDir, "stylize", "故事版");

		// 判据取「哪一层生效」，不是只看内容——否则分不清是覆盖生效还是回退读到别的层
		const loaded = loadPrompt("stylize", { globalDir, storyDir });
		assert.equal(loaded.layer, "story", "story 是最高层");
		assert.equal(loaded.content, "故事版");

		clearStoryPromptOverride(storyDir, "stylize");
		const fallback = loadPrompt("stylize", { globalDir, storyDir });
		assert.equal(fallback.layer, "global", "删掉 story 覆盖后应由 global 接管（不是直接掉到 builtin）");
		assert.equal(fallback.content, "全局版");
	} finally {
		cleanupTempDir(root);
	}
});

test("缺口 5 的边界：global 写口不碰 pack 层（改别人分发的包会与更新冲突）", () => {
	const root = makeTempDir();
	try {
		const globalDir = join(root, "g");
		const packDir = join(root, "pack");
		writeLayerPrompt(packDir, "narrator", "卡包自带");

		// 优先级是 story > pack > global > builtin：卡包**压过** global。
		// 所以「改了全局提示词却没生效」在装了卡包的角色上是正常现象——排查时要看覆盖链，别猜。
		setGlobalPromptOverride("narrator", "全局版", globalDir);
		const loaded = loadPrompt("narrator", { globalDir, packDirs: [packDir] });
		assert.equal(loaded.layer, "pack", "pack 层优先级更高，应压过 global");

		// 本层写口**只**写 globalDir：卡包目录里的文件一个字节都不该被这条路径动过
		assert.equal(loadPrompt("narrator", { packDirs: [packDir] }).content, "卡包自带", "pack 层内容未被改动");
		// 不装卡包时 global 才接管
		assert.equal(loadPrompt("narrator", { globalDir }).layer, "global");
		assert.equal(loadPrompt("narrator", { globalDir }).content, "全局版");
	} finally {
		cleanupTempDir(root);
	}
});
