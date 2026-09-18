// 渲染进程的边界纪律（机器判据，不是文档承诺）：renderer / dev / preload 里的代码**不得值导入**内核。
//
// 为什么：模式过滤（DbView）、唯一写路径（trustedWrite）、快照恢复都在 main 侧的内核实例里。
// 渲染进程只要能值导入内核，就等于把内核信任边界搬到了页面上——写在文档里的架构边界，
// 第一次赶进度就会被绕过。
//
// 覆盖范围含 **.js/.cjs**：S0 的壳是经典脚本（file:// 下 Chromium 不支持 ESM，故暂不引构建），
// 纪律不能因为文件扩展名换了就失效。允许的形态是 `import type { ... } from "@tavernpi/core"`
// （类型剥离后不留运行时代码，且类型必须共用一份，否则两侧自己抄必然漂移）。

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const STUDIO_ROOT = join(import.meta.dirname, "..");
/** 受本纪律约束的路径（渲染进程、开发脚手架、preload）——main 侧反过来必须用内核，不受此限。 */
const GUARDED_PATHS = ["src/renderer", "src/dev", "src/preload.cjs"];
const CORE_PACKAGE = "@tavernpi/core";

/**
 * 找出源码里对内核的值导入（返回违规片段）。
 * 判据：出现 `from "@tavernpi/core"` 的 import 语句且不是 `import type ...`；以及任何
 * `import("@tavernpi/core")` 动态导入与 `require("@tavernpi/core")`。
 */
export function findValueImports(source: string): string[] {
	const violations: string[] = [];
	// 单条 import 语句：import 到 "from "<pkg>"" 之间不跨行、不含分号（本项目风格每句一行，够用）。
	const staticImport = new RegExp(`^[ \\t]*import\\s([^;\\n]*?)from\\s*["']${CORE_PACKAGE}["']`, "gm");
	for (const match of source.matchAll(staticImport)) {
		if (/^[ \t]*import\s+type\b/.test(match[0])) continue;
		violations.push(match[0].trim());
	}
	const sideEffect = new RegExp(`^[ \\t]*import\\s*["']${CORE_PACKAGE}["']`, "gm");
	for (const match of source.matchAll(sideEffect)) {
		violations.push(match[0].trim());
	}
	const dynamicImport = new RegExp(`import\\s*\\(\\s*["']${CORE_PACKAGE}["']\\s*\\)`, "g");
	for (const match of source.matchAll(dynamicImport)) {
		violations.push(match[0]);
	}
	const requireCall = new RegExp(`require\\s*\\(\\s*["']${CORE_PACKAGE}["']\\s*\\)`, "g");
	for (const match of source.matchAll(requireCall)) {
		violations.push(match[0]);
	}
	return violations;
}

const SOURCE_EXT = [".ts", ".mts", ".js", ".mjs", ".cjs"];

/** 递归收集目录下的源码文件（跳过 .d.ts）。 */
function collectSources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectSources(full));
		} else if (SOURCE_EXT.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

/** 把受约束路径展开成文件清单（目录递归，文件直接算）。 */
function guardedFiles(): string[] {
	const files: string[] = [];
	for (const path of GUARDED_PATHS) {
		const abs = join(STUDIO_ROOT, path);
		const stat = statSync(abs); // 路径消失 = 纪律失效，直接抛错而不是静默放行
		files.push(...(stat.isDirectory() ? collectSources(abs) : [abs]));
	}
	return files;
}

test("判据自检：构造的违规样本必须被抓住（否则这条纪律是空的）", () => {
	assert.deepEqual(findValueImports("import { openStory } from \"@tavernpi/core\";\n"), [
		"import { openStory } from \"@tavernpi/core\"",
	]);
	assert.deepEqual(findValueImports("import \"@tavernpi/core\";\n"), ["import \"@tavernpi/core\""]);
	assert.deepEqual(findValueImports("const m = await import(\"@tavernpi/core\");\n"), ["import(\"@tavernpi/core\")"]);
	assert.deepEqual(findValueImports("const m = require(\"@tavernpi/core\");\n"), ["require(\"@tavernpi/core\")"]);
	// 合法形态：纯类型导入
	assert.deepEqual(findValueImports("import type { StorySummary } from \"@tavernpi/core\";\n"), []);
	// 注释里提到包名不算违规（只认语句里的导入）
	assert.deepEqual(
		findValueImports("// 以后不要 import { openStory } from \"@tavernpi/core\"\nconst x = 1;\n"),
		[],
		"注释不是导入语句",
	);
	assert.deepEqual(findValueImports("import { saveSettings } from \"@tavernpi/core\"; // 配置写口\n"), [
		"import { saveSettings } from \"@tavernpi/core\"",
	]);
});

test("renderer / dev / preload 里不存在对内核的值导入", () => {
	const offenders: string[] = [];
	const files = guardedFiles();
	assert.ok(files.length > 0, "至少要扫到文件，否则判据形同虚设");
	for (const file of files) {
		for (const violation of findValueImports(readFileSync(file, "utf-8"))) {
			offenders.push(`${file}: ${violation}`);
		}
	}
	assert.deepEqual(offenders, [], `这些位置不得值导入 @tavernpi/core:\n${offenders.join("\n")}`);
});

test("判据覆盖到 S0 壳的实际文件（.js / .cjs 也在扫，别只有 TS 达标）", () => {
	const scanned = guardedFiles().map((f) => f.slice(STUDIO_ROOT.length + 1));
	assert.ok(scanned.includes("src/renderer/shell.js"), `必须扫到 shell.js：${scanned.join(", ")}`);
	assert.ok(scanned.includes("src/renderer/transport.js"));
	assert.ok(scanned.includes("src/preload.cjs"));
});
