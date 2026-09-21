// 渲染层产物的边界判据（构建产物的机器验证）。
//
// boundary.test.ts 扫的是**源码**：它证明「源码里没写值导入」。但源码被读对不等于产物干净——
// 一个 `import { X } from "@tavernpi/core"` 藏在第三方包的传递依赖里、或 Vite 的依赖优化把某个
// re-export 拉了进来，源码扫描都看不见，而产物里内核已经进去了。
//
// 故这条判据扫**构建产物**：内核的特征标识一个都不该出现。两道判据互补——
// 源码扫描防手滑，产物扫描防「我以为它是 type-only 结果被打了进去」。
//
// 依赖构建产物存在：没建过就 skip 并说明怎么建，不伪装成通过（也不 fail——
// 未构建不是缺陷，是「还没跑过 npm run build:renderer」）。CI 上应先构建再跑 test。

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const STUDIO_ROOT = join(import.meta.dirname, "..");
const ASSETS_DIR = join(STUDIO_ROOT, "src/renderer/dist/assets");

/**
 * 内核「进了产物就说明边界破了」的标识。
 * 逐类取样：DB 驱动 / 信任边界函数 / 装配入口 / 视图过滤 / 表清单常量——
 * 只挑那种**改了名就该跟着改测试**的稳定标识，不用「core」这种到处都有的词。
 */
const KERNEL_MARKERS = [
	"node:sqlite",
	"KERNEL_TABLE_WHITELIST",
	"trustedWrite",
	"openStoryDb",
	"TableNotVisibleError",
	"resolveRelatedNpcSet",
];

test("渲染层构建产物里不含内核代码（值导入逃过源码扫描时的兜底判据）", (t) => {
	if (!existsSync(ASSETS_DIR)) {
		t.skip("尚未构建渲染层产物——先跑 npm --workspace @tavernpi/studio run build:renderer");
		return;
	}
	const chunks = readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".js"));
	assert.ok(chunks.length > 0, "产物目录里应有 .js（否则这条判据形同虚设）");

	const bundle = chunks.map((f) => readFileSync(join(ASSETS_DIR, f), "utf-8")).join("\n");
	assert.ok(bundle.length > 1000, `产物太小，不像真实 bundle：${bundle.length} 字节`);

	const leaked = KERNEL_MARKERS.filter((marker) => bundle.includes(marker));
	assert.deepEqual(
		leaked,
		[],
		`这些内核标识出现在渲染产物里，说明内核被打进了渲染进程：\n${leaked.join("\n")}`,
	);
});

test("产物判据自检：构造的样本必须被这套比对抓住", () => {
	// 判据若写错（比如把 markers 拼成了空数组），这条会红。
	const sample = 'const x = require("node:sqlite");';
	const hit = KERNEL_MARKERS.filter((m) => sample.includes(m));
	assert.deepEqual(hit, ["node:sqlite"], "构造样本必须命中，否则判据是空的");
});
