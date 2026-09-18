// 模型配置单测：缺文件/坏 JSON/根节点与 models 形态/字段非法形态/正常解析。

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import {
	defaultSettingsPath,
	isThinkingLevel,
	loadSettings,
	saveSettings,
	THINKING_LEVELS,
	type TavernSettings,
} from "../src/settings.ts";

function writeSettings(dir: string, content: string): string {
	const path = join(dir, "settings.json");
	writeFileSync(path, content);
	return path;
}

test("defaultSettingsPath 路径形态：~/.tavernpi/settings.json", () => {
	assert.equal(defaultSettingsPath(), join(homedir(), ".tavernpi", "settings.json"));
});

test("缺文件：空 settings 且无 warning", () => {
	const dir = makeTempDir();
	try {
		const { settings, warnings } = loadSettings(join(dir, "does-not-exist.json"));
		assert.deepEqual(settings, { models: {} });
		assert.deepEqual(warnings, []);
	} finally {
		cleanupTempDir(dir);
	}
});

test("坏 JSON：warning + 空 settings", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(dir, "{ 这不是 JSON");
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(settings, { models: {} });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /解析失败/);
	} finally {
		cleanupTempDir(dir);
	}
});

test("根节点非对象（数组/字符串/数字）：warning + 空 settings", () => {
	const dir = makeTempDir();
	try {
		for (const bad of ["[1,2]", '"x"', "42"]) {
			const path = writeSettings(dir, bad);
			const { settings, warnings } = loadSettings(path);
			assert.deepEqual(settings, { models: {} });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /根节点不是对象/);
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("models 非对象：warning + 忽略 models 字段", () => {
	const dir = makeTempDir();
	try {
		for (const bad of ['{"models": 5}', '{"models": "x"}', '{"models": [1]}']) {
			const path = writeSettings(dir, bad);
			const { settings, warnings } = loadSettings(path);
			assert.deepEqual(settings, { models: {} });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /models 不是对象/);
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("models 字段形态非法：warning + 忽略该字段，合法字段保留", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(
			dir,
			JSON.stringify({
				models: {
					narrator: { provider: "anthropic", id: "claude-3-5-sonnet" }, // 合法
					data: 42, // 非对象
					story: { provider: "openai" }, // 缺 id
					npc: { provider: "", id: "x" }, // provider 空串
					stylize: null, // null
					unknown_role: { provider: "a", id: "b" }, // 未知键：静默忽略
				},
			}),
		);
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(settings, {
			models: { narrator: { provider: "anthropic", id: "claude-3-5-sonnet" } },
		} satisfies TavernSettings);
		assert.equal(warnings.length, 4, "data/story/npc/stylize 各一条，unknown_role 不告警");
		for (const w of warnings) {
			assert.match(w, /形态非法，已忽略/);
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("正常解析：五个角色全部合法，无 warning", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(
			dir,
			JSON.stringify({
				models: {
					narrator: { provider: "anthropic", id: "m1" },
					data: { provider: "openai", id: "m2" },
					story: { provider: "anthropic", id: "m3" },
					npc: { provider: "google", id: "m4" },
					stylize: { provider: "openai", id: "m5" },
				},
			}),
		);
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(warnings, []);
		assert.equal(settings.models.narrator?.provider, "anthropic");
		assert.equal(settings.models.data?.id, "m2");
		assert.equal(settings.models.story?.provider, "anthropic");
		assert.equal(settings.models.npc?.provider, "google");
		assert.equal(settings.models.stylize?.id, "m5");
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 缺口 2：thinking 字段 + saveSettings（读—改—写闭环）
// ---------------------------------------------------------------------------

test("isThinkingLevel：全集接受，其余一律拒绝", () => {
	for (const level of THINKING_LEVELS) {
		assert.equal(isThinkingLevel(level), true, `${level} 应合法`);
	}
	for (const bad of ["", "MAX", "medium ", 5, null, undefined, {}, ["high"]]) {
		assert.equal(isThinkingLevel(bad), false, `${JSON.stringify(bad)} 应非法`);
	}
});

test("loadSettings：thinking 合法值被解析出来（narrator，无 warning）", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(
			dir,
			JSON.stringify({ models: { narrator: { provider: "anthropic", id: "m1", thinking: "high" } } }),
		);
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(warnings, []);
		assert.equal(settings.models.narrator?.thinking, "high");
	} finally {
		cleanupTempDir(dir);
	}
});

test("loadSettings：thinking 非法值 → warning + 丢该字段，provider/id 保留", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(
			dir,
			JSON.stringify({ models: { narrator: { provider: "anthropic", id: "m1", thinking: "MAX" } } }),
		);
		const { settings, warnings } = loadSettings(path);
		assert.equal(settings.models.narrator?.provider, "anthropic");
		assert.equal(settings.models.narrator?.id, "m1");
		assert.equal(settings.models.narrator?.thinking, undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /thinking 非法，已忽略该字段/);
	} finally {
		cleanupTempDir(dir);
	}
});

test("loadSettings：非 narrator 角色的 thinking → 保留但告警「当前不会被消费」", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(
			dir,
			JSON.stringify({ models: { stylize: { provider: "openai", id: "m5", thinking: "low" } } }),
		);
		const { settings, warnings } = loadSettings(path);
		assert.equal(settings.models.stylize?.thinking, "low", "值保留（将来接线即生效）");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /不会被消费/);
	} finally {
		cleanupTempDir(dir);
	}
});

test("saveSettings：往返一致（含 thinking）；不留临时文件", () => {
	const dir = makeTempDir();
	try {
		const path = join(dir, "nested", "settings.json");
		const written: TavernSettings = {
			models: {
				narrator: { provider: "anthropic", id: "m1", thinking: "xhigh" },
				data: { provider: "openai", id: "m2" },
			},
		};
		saveSettings(written, path);
		assert.ok(existsSync(path), "父目录不存在时应自动创建");
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(warnings, []);
		assert.deepEqual(settings, written);
		assert.equal(existsSync(`${path}.tmp`), false, "临时文件必须已 rename 掉");
	} finally {
		cleanupTempDir(dir);
	}
});

test("saveSettings：合并写——保留未知顶层键与未知角色，只覆盖本次给出的角色", () => {
	const dir = makeTempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({
				theme: "dark",
				futureKey: { a: 1 },
				models: {
					npc: { provider: "google", id: "keep-me" },
					future_role: { provider: "x", id: "y" },
				},
			}),
		);
		saveSettings({ models: { narrator: { provider: "anthropic", id: "m1" } } }, path);

		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		assert.equal(raw["theme"], "dark");
		assert.deepEqual(raw["futureKey"], { a: 1 });
		const models = raw["models"] as Record<string, unknown>;
		assert.deepEqual(models["npc"], { provider: "google", id: "keep-me" });
		assert.deepEqual(models["future_role"], { provider: "x", id: "y" });
		assert.deepEqual(models["narrator"], { provider: "anthropic", id: "m1" });
	} finally {
		cleanupTempDir(dir);
	}
});

test("saveSettings：整角色替换——本次给的对象就是盘上内容（thinking 缺省 = 清空）", () => {
	const dir = makeTempDir();
	try {
		const path = join(dir, "settings.json");
		saveSettings({ models: { narrator: { provider: "anthropic", id: "m1", thinking: "high" } } }, path);
		saveSettings({ models: { narrator: { provider: "anthropic", id: "m1" } } }, path);
		const { settings } = loadSettings(path);
		assert.deepEqual(settings.models.narrator, { provider: "anthropic", id: "m1" });
	} finally {
		cleanupTempDir(dir);
	}
});

test("saveSettings：校验先行——非法字段抛错且一个字都不写", () => {
	const dir = makeTempDir();
	try {
		const path = join(dir, "settings.json");
		const before = JSON.stringify({ models: { narrator: { provider: "old", id: "old" } } });
		writeFileSync(path, before);

		const bad: Array<[string, TavernSettings]> = [
			["provider 空串", { models: { narrator: { provider: "", id: "x" } } }],
			["id 空串", { models: { narrator: { provider: "p", id: "" } } }],
			["thinking 非法", { models: { narrator: { provider: "p", id: "i", thinking: "MAX" as never } } }],
		];
		for (const [label, settings] of bad) {
			assert.throws(
				() => saveSettings(settings, path),
				/写入被拒（未写任何文件）/,
				`${label} 应抛错`,
			);
			assert.equal(readFileSync(path, "utf-8"), before, `${label}：文件必须原样未动`);
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("saveSettings：已有文件不是合法 JSON → 抛错不覆盖（绝不静默毁掉手写配置）", () => {
	const dir = makeTempDir();
	try {
		const path = join(dir, "settings.json");
		const broken = "{ 这是半截的手写配置";
		writeFileSync(path, broken);
		assert.throws(() => saveSettings({ models: { narrator: { provider: "p", id: "i" } } }, path), /不是合法 JSON/);
		assert.equal(readFileSync(path, "utf-8"), broken);
		assert.equal(existsSync(`${path}.tmp`), false);
	} finally {
		cleanupTempDir(dir);
	}
});

test("saveSettings：根节点非对象 → 抛错不覆盖", () => {
	const dir = makeTempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, "[1,2,3]");
		assert.throws(() => saveSettings({ models: {} }, path), /根节点不是对象/);
		assert.equal(readFileSync(path, "utf-8"), "[1,2,3]");
	} finally {
		cleanupTempDir(dir);
	}
});

test("saveSettings：空文件视作无内容，可直接写入", () => {
	const dir = makeTempDir();
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, "   \n");
		saveSettings({ models: { narrator: { provider: "p", id: "i" } } }, path);
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(warnings, []);
		assert.deepEqual(settings.models.narrator, { provider: "p", id: "i" });
	} finally {
		cleanupTempDir(dir);
	}
});
