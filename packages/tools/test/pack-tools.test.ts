// 卡包工具链的可复用面（缺口 9）：checkPacks / initPack 不打印、不碰退出码，只回结构化报告。
//
// 为什么值得钉住：这两个函数存在的唯一理由是「卡包管理器能复用校验/新建逻辑」。
// 若它们偷偷往 stdout 写字或依赖 process.exitCode，复用的前提就没了——故下面的断言
// 专门盯这两件事，而不只是看 ok 字段。

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPacks, initPack } from "../src/cli.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

/** 在 dir 下生成一个最小可过检的骨架包，返回其绝对路径。 */
function makeSkeletonPack(root: string, name: string): string {
	const dir = join(root, name);
	const result = initPack(dir);
	assert.equal(result.ok, true, `骨架包生成失败: ${JSON.stringify(result.errors)}`);
	return dir;
}

/**
 * 断言 fn 期间 stdout/stderr 都没有输出。
 * 这是「可复用」的核心判据：能复用的函数据数不写终端。
 */
async function assertSilent<T>(fn: () => Promise<T> | T): Promise<T> {
	const origLog = console.log;
	const origErr = console.error;
	const leaked: string[] = [];
	console.log = (...args: unknown[]) => void leaked.push(args.join(" "));
	console.error = (...args: unknown[]) => void leaked.push(args.join(" "));
	try {
		return await fn();
	} finally {
		console.log = origLog;
		console.error = origErr;
		if (leaked.length > 0) {
			assert.fail(`承诺面函数不应写终端，实际输出: ${leaked.join(" | ")}`);
		}
	}
}

test("checkPacks：合法卡包 → ok:true + 包/迁移/seed 事实，且不写终端", async () => {
	const root = makeTempDir();
	try {
		const dir = makeSkeletonPack(root, "demo_world");
		const report = await assertSilent(() => checkPacks([dir]));

		assert.equal(report.ok, true, `期望过检，错误: ${JSON.stringify(report.errors)}`);
		assert.equal(report.command, "check");
		assert.equal(report.errors.length, 0);
		assert.equal(report.packs?.length, 1);
		assert.equal(report.packs?.[0]?.name, "demo_world");
		assert.ok((report.packs?.[0]?.entries ?? 0) > 0, "骨架包应含一个示例条目");
		// hasCode 指「有代码入口」（index.ts / pi.extensions），不是「有 db/」——骨架包是纯内容包。
		assert.equal(report.packs?.[0]?.hasCode, false, "骨架包无 index.ts / pi.extensions → 纯内容包");
		assert.ok((report.migrations?.applied.length ?? 0) > 0, "core 迁移应已应用");
		assert.deepEqual(report.migrations?.rerunApplied, [], "迁移必须幂等：重跑无新增");
		assert.ok(report.seed !== undefined, "应报出 seed 行数");
		// 骨架 schema.sql 刻意「只有注释、无任何表」（保持最小可过检），故这里不该有包前缀表。
		assert.deepEqual(report.packs?.[0]?.tables, [], "骨架包无自建表——加表由作者复制模板");
	} finally {
		cleanupTempDir(root);
	}
});

test("checkPacks：目录不存在 → ok:false + 错误指到具体路径（不抛错、不写终端）", async () => {
	const root = makeTempDir();
	try {
		const missing = join(root, "nope");
		const report = await assertSilent(() => checkPacks([missing]));

		assert.equal(report.ok, false);
		assert.equal(report.errors.length, 1);
		assert.equal(report.errors[0]?.file, missing, "错误须归因到具体路径，否则调用侧不知找谁");
		assert.match(report.errors[0]?.message ?? "", /不存在/);
	} finally {
		cleanupTempDir(root);
	}
});

test("checkPacks：路径指向普通文件（不是目录）→ 报「不是目录」而非崩掉", async () => {
	const root = makeTempDir();
	try {
		const file = join(root, "plain.txt");
		writeFileSync(file, "x");
		const report = await assertSilent(() => checkPacks([file]));

		assert.equal(report.ok, false);
		assert.match(report.errors[0]?.message ?? "", /不是目录/);
	} finally {
		cleanupTempDir(root);
	}
});

test("checkPacks：无参数 → ok:false + 提示用法（不抛错）", async () => {
	const report = await assertSilent(() => checkPacks([]));
	assert.equal(report.ok, false);
	assert.match(report.errors[0]?.message ?? "", /缺少卡包目录参数/);
});

test("checkPacks：条目多一个未知字段 → ok:false 且错误归因到条目文件（strict 是为了抓笔误）", async () => {
	const root = makeTempDir();
	try {
		const dir = makeSkeletonPack(root, "broken_pack");
		// 条目 schema 是 zod strict（unknown field 报错到人）；注意 story.yaml 是**宽松**的（未知字段 strip），
		// 故这条纪律的落点在 collection/*.yaml，不在 story.yaml。
		const entryPath = join(dir, "collection", "characters", "example.yaml");
		writeFileSync(entryPath, `${readFileSync(entryPath, "utf-8")}\nunexpected_field: 1\n`);
		const report = await assertSilent(() => checkPacks([dir]));

		assert.equal(report.ok, false, "条目未知字段必须过不了 strict 校验");
		assert.ok(
			report.errors.some((e) => (e.file ?? "").includes("example.yaml")),
			`错误应归因到条目文件，实际: ${JSON.stringify(report.errors)}`,
		);
	} finally {
		cleanupTempDir(root);
	}
});

test("checkPacks：story.yaml 未知字段被 strip（宽松面），不误报为错", async () => {
	const root = makeTempDir();
	try {
		const dir = makeSkeletonPack(root, "lenient_pack");
		const storyPath = join(dir, "story.yaml");
		// 宽度不是缺陷：作者多加一个注释性字段不该让包过不了检（与条目 strict 是刻意不同的口径）。
		writeFileSync(storyPath, `${readFileSync(storyPath, "utf-8")}\nunexpected_field: 1\n`);
		const report = await assertSilent(() => checkPacks([dir]));

		assert.equal(report.ok, true, `story.yaml 未知字段应被 strip，实际报错: ${JSON.stringify(report.errors)}`);
	} finally {
		cleanupTempDir(root);
	}
});

test("checkPacks：schema.sql 执行失败 → 错误归因到 db/schema.sql（迁移试跑真的跑了）", async () => {
	const root = makeTempDir();
	try {
		const dir = makeSkeletonPack(root, "bad_sql");
		writeFileSync(join(dir, "db", "schema.sql"), "CREATE TABLE 这不是合法 SQL (;");
		const report = await assertSilent(() => checkPacks([dir]));

		assert.equal(report.ok, false);
		assert.ok(
			report.errors.some((e) => e.file === "db/schema.sql"),
			`错误应归因到 db/schema.sql，实际: ${JSON.stringify(report.errors)}`,
		);
	} finally {
		cleanupTempDir(root);
	}
});

test("initPack：生成骨架 → 文件真的落盘、包名前缀正确，且不写终端", async () => {
	const root = makeTempDir();
	try {
		const dir = join(root, "my_world");
		const result = await assertSilent(() => initPack(dir));

		assert.equal(result.ok, true);
		assert.equal(result.command, "init");
		assert.equal(result.packName, "my_world");
		assert.equal(result.prefix, "my_world_");
		assert.deepEqual(result.files, [
			"package.json",
			"story.yaml",
			"collection/characters/example.yaml",
			"db/schema.sql",
			"db/seed.sql",
		]);

		// 判据取「盘上真有这些文件」（非内存自报）
		for (const rel of result.files ?? []) {
			assert.doesNotThrow(() => readFileSync(join(dir, rel), "utf-8"), `${rel} 应真的落盘`);
		}
		assert.match(readFileSync(join(dir, "db", "schema.sql"), "utf-8"), /my_world_/, "SQL 表名须带包前缀");
	} finally {
		cleanupTempDir(root);
	}
});

test("initPack：目录已有卡包 → 拒绝覆盖（手滑不清空既有作品）", async () => {
	const root = makeTempDir();
	try {
		const dir = join(root, "existing");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "story.yaml"), "name: 已有作品\n");
		const before = readFileSync(join(dir, "story.yaml"), "utf-8");

		const result = await assertSilent(() => initPack(dir));

		assert.equal(result.ok, false);
		assert.match(result.errors[0]?.message ?? "", /拒绝覆盖/);
		assert.equal(readFileSync(join(dir, "story.yaml"), "utf-8"), before, "既有的 story.yaml 一个字节都不该变");
	} finally {
		cleanupTempDir(root);
	}
});

test("闭环：initPack 产出的包，checkPacks 必须判过（骨架包承诺「最小可过检」）", async () => {
	const root = makeTempDir();
	try {
		const dir = join(root, "roundtrip_world");
		const init = initPack(dir);
		assert.equal(init.ok, true);

		const report = await assertSilent(() => checkPacks([dir]));
		assert.equal(report.ok, true, `骨架包自称「最小可过检」，实际没过: ${JSON.stringify(report.errors)}`);
	} finally {
		cleanupTempDir(root);
	}
});
