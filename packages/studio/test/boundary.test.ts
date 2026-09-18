// 渲染进程的边界纪律（机器判据，不是文档承诺）：renderer / dev 目录下的代码**不得值导入**内核。
//
// 为什么：模式过滤（DbView）、唯一写路径（trustedWrite）、快照恢复都在 main 侧的内核实例里。
// 渲染进程只要能值导入内核，就等于把内核信任边界搬到了页面上——写在文档里的架构边界，
// 第一次赶进度就会被绕过。
//
// 允许的形态：`import type { ... } from "@tavernpi/core"`（类型剥离后不留运行时代码，
// 且类型必须共用一份，否则两侧自己抄类型必然漂移）。

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const STUDIO_ROOT = join(import.meta.dirname, "..");
/** 受本纪律约束的目录：渲染进程与开发脚手架（main 侧反过来必须用内核，不受此限）。 */
const GUARDED_DIRS = ["src/renderer", "src/dev"];
const CORE_PACKAGE = "@tavernpi/core";

/**
 * 找出源码里对内核的值导入（返回违规行号与片段）。
 * 判据：出现 `from "@tavernpi/core"` / `from '@tavernpi/core'` 的 import 语句，且该语句**不是**
 * `import type ...`；以及任何 `import("@tavernpi/core")` 动态导入与 `require("@tavernpi/core")`。
 */
export function findValueImports(source: string): string[] {
	const violations: string[] = [];
	// 单条 import 语句：import 到 "from "<pkg>"" 之间不含分号（本项目风格每句一行，够用）。
	const staticImport = new RegExp(`^[ \\t]*import\\s([^;\\n]*?)from\\s*["']${CORE_PACKAGE}["']`, "gm");
	for (const match of source.matchAll(staticImport)) {
		const whole = match[0]!;
		if (/^[ \t]*import\s+type\b/.test(whole)) continue;
		violations.push(whole.trim());
	}
	const sideEffect = new RegExp(`^[ \\t]*import\\s*["']${CORE_PACKAGE}["']`, "gm");
	for (const match of source.matchAll(sideEffect)) {
		violations.push(match[0]!.trim());
	}
	const dynamicImport = new RegExp(`import\\s*\\(\\s*["']${CORE_PACKAGE}["']\\s*\\)`, "g");
	for (const match of source.matchAll(dynamicImport)) {
		violations.push(match[0]!);
	}
	const requireCall = new RegExp(`require\\s*\\(\\s*["']${CORE_PACKAGE}["']\\s*\\)`, "g");
	for (const match of source.matchAll(requireCall)) {
		violations.push(match[0]!);
	}
	return violations;
}

/** 递归收集目录下的 .ts（不含 .d.ts）。 */
function collectTs(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectTs(full));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
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

test("renderer / dev 目录里不存在对内核的值导入（只有 import type）", () => {
	const offenders: string[] = [];
	let scanned = 0;
	for (const dir of GUARDED_DIRS) {
		const abs = join(STUDIO_ROOT, dir);
		assert.equal(statSync(abs).isDirectory(), true, `${dir} 必须存在（被扫的目录消失＝纪律失效）`);
		for (const file of collectTs(abs)) {
			scanned++;
			for (const violation of findValueImports(readFileSync(file, "utf-8"))) {
				offenders.push(`${file}: ${violation}`);
			}
		}
	}
	assert.ok(scanned > 0, "至少要扫到文件，否则判据形同虚设");
	assert.deepEqual(offenders, [], `渲染进程不得值导入 @tavernpi/core:\n${offenders.join("\n")}`);
});
