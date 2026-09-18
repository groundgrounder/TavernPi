// 世界包加载器单测（M5 定稿）：
// 好包全要素 / 坏 YAML / story.yaml 坏 YAML / zod strict 未知字段 / type 与目录不一致 /
// id 冲突 / 断链包内 + 跨包 / 前缀违规 / 内核保留表写入 / 包名非法 / 多包共存同名 id 不冲突 /
// 重复包名 / schema.sql 缺失。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { characterEntry, cleanupTempDir, createPack, entryYaml, locationEntry, makeTempDir, writeFile } from "./fixtures/pack-fixtures.ts";
import { loadPack, loadPacks } from "../src/pack/loader.ts";
import { PackLoadError } from "../src/pack/types.ts";

test("loadPack：好包全要素（story/entries/schema/seed/code），字段正确", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			story: "title: 守陵人\ncalendar: imperial\nopening: 皇陵之下……\n",
			entries: [
				{
					type: "characters",
					id: "shen-qiu",
					yaml: entryYaml({
						type: "character",
						name: "沈秋",
						keys: ["沈秋", "守陵人"],
						always_on: true,
						position: "system",
						refs: ["location:royal-tomb", "faction:old-crown"],
						identity: "守陵人的领袖",
						personality: "沉默寡言",
						voice: "冷峻",
						dialogue_examples: ["嗯。"],
					}),
				},
				{
					type: "locations",
					id: "royal-tomb",
					yaml: entryYaml({
						type: "location",
						name: "皇陵",
						keys: ["皇陵"],
						position: "recent",
						overview: "幽暗的皇陵深处",
						features: ["石刻壁画", "甬道"],
						parent: "tomb-court",
					}),
				},
				{
					type: "locations",
					id: "tomb-court",
					yaml: entryYaml({ type: "location", name: "陵前广场", overview: "皇陵前的广场", features: [] }),
				},
				{
					type: "factions",
					id: "old-crown",
					yaml: entryYaml({
						type: "faction",
						name: "旧王冠",
						overview: "没落王族",
						goals: ["夺回王位"],
						members: ["character:shen-qiu"],
					}),
				},
			],
			schemaSql:
				"CREATE TABLE IF NOT EXISTS shouling_relics (id INTEGER PRIMARY KEY, name TEXT);\n" +
				"INSERT INTO shouling_relics (name) VALUES ('青铜灯');\n",
			seedSql: "INSERT INTO shouling_relics (name) VALUES ('玉玺');\n",
			hasIndexTs: true,
		});
		const pack = loadPack(dir);
		assert.equal(pack.name, "shouling");
		assert.equal(pack.hasCode, true);
		assert.deepEqual(pack.extensionEntryPaths, [join(dir, "index.ts")]);
		assert.equal(pack.story.title, "守陵人");
		assert.equal(pack.story.calendar, "imperial");
		assert.equal(pack.story.opening, "皇陵之下……");
		assert.equal(pack.entries.length, 4);

		const shen = pack.entries.find((e) => e.id === "shen-qiu");
		assert.ok(shen);
		assert.equal(shen.pack, "shouling");
		assert.equal(shen.type, "character");
		assert.equal(shen.alwaysOn, true);
		assert.equal(shen.position, "system");
		assert.deepEqual(shen.keys, ["沈秋", "守陵人"]);
		assert.deepEqual(shen.refs, ["location:royal-tomb", "faction:old-crown"]);
		assert.ok(shen.body.includes("身份：守陵人的领袖"), "body 含身份行");
		assert.ok(shen.body.includes("性格：沉默寡言"), "body 含性格行");
		assert.ok(shen.body.includes("对话示例：\n- 嗯。"), "body 含对话示例");
		assert.equal(shen.summaryLine, "沈秋：身份：守陵人的领袖");
		assert.equal(shen.data.identity, "守陵人的领袖");
		assert.equal(shen.data.personality, "沉默寡言");

		const tomb = pack.entries.find((e) => e.id === "royal-tomb");
		assert.ok(tomb);
		assert.equal(tomb.position, "recent");
		assert.equal(tomb.data.parent, "tomb-court");
		assert.equal(tomb.summaryLine, "皇陵：概述：幽暗的皇陵深处");
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：缺省字段（keys/always_on/position/refs）有默认值，story.yaml 缺失 = 空 StoryMeta", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "minimal",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("甲") }],
		});
		const pack = loadPack(dir);
		assert.deepEqual(pack.story, {});
		assert.equal(pack.entries.length, 1);
		const entry = pack.entries[0]!;
		assert.deepEqual(entry.keys, []);
		assert.equal(entry.alwaysOn, false);
		assert.equal(entry.position, "system");
		assert.deepEqual(entry.refs, []);
		assert.equal(entry.summaryLine, "甲：身份：身份");
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：story.yaml 坏 YAML → PackLoadError（含文件名）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, { name: "p", story: "title: [未闭合\n  - x\n" });
		assert.throws(() => loadPack(dir), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const issue = err.issues.find((i) => i.file?.endsWith("story.yaml") === true);
			assert.ok(issue, `应有 story.yaml issue: ${JSON.stringify(err.issues)}`);
			assert.match(issue.message, /解析失败/);
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：条目坏 YAML → PackLoadError（含文件名）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: "type: character\nname: [未闭合\n  - x\n" }],
		});
		assert.throws(() => loadPack(dir), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const issue = err.issues.find((i) => i.file?.endsWith("a.yaml"));
			assert.ok(issue, `应有 a.yaml 的 issue: ${JSON.stringify(err.issues)}`);
			assert.match(issue.message, /解析失败/);
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：未知字段（zod strict）→ PackLoadError（笔误优于静默吞掉）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [
				{
					type: "characters",
					id: "a",
					yaml: entryYaml({ type: "character", name: "甲", identity: "i", personality: "p", bogus_field: 1 }),
				},
			],
		});
		assert.throws(() => loadPack(dir), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const issue = err.issues.find((i) => /校验失败/.test(i.message));
			assert.ok(issue, `应有校验失败 issue: ${JSON.stringify(err.issues)}`);
			assert.match(issue.message, /bogus_field/);
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：特化字段缺必填（character 无 identity）→ PackLoadError", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: entryYaml({ type: "character", name: "甲" }) }],
		});
		assert.throws(() => loadPack(dir), /identity/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：type 与目录不一致 → PackLoadError", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [
				{ type: "locations", id: "a", yaml: entryYaml({ type: "character", name: "甲", identity: "i", personality: "p" }) },
			],
		});
		assert.throws(() => loadPack(dir), /type 与目录不一致/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：条目 id 冲突（跨 type 唯一）→ PackLoadError", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [
				{ type: "characters", id: "same", yaml: characterEntry("甲") },
				{ type: "locations", id: "same", yaml: locationEntry("乙") },
			],
		});
		assert.throws(() => loadPack(dir), /id 冲突/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：包内断链 refs → PackLoadError（含文件名）；合法引用放行", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [
				{
					type: "characters",
					id: "a",
					yaml: characterEntry("甲", { refs: ["location:missing"] }),
				},
			],
		});
		assert.throws(() => loadPack(dir), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const issue = err.issues.find((i) => /断链: 包内引用 location:missing/.test(i.message));
			assert.ok(issue, `应有断链 issue: ${JSON.stringify(err.issues)}`);
			assert.equal(issue.file?.endsWith("characters/a.yaml"), true);
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：faction.members 与 location.parent 断链也报错到人", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [
				{
					type: "factions",
					id: "f",
					yaml: entryYaml({ type: "faction", name: "F", overview: "o", goals: [], members: ["character:nobody"] }),
				},
				{ type: "locations", id: "l", yaml: locationEntry("L", { parent: "missing-loc" }) },
			],
		});
		assert.throws(() => loadPack(dir), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const messages = err.issues.map((i) => i.message).join("\n");
			assert.match(messages, /character:nobody/, "members 断链");
			assert.match(messages, /parent 断链/, "parent 断链");
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPacks：跨包断链 → PackLoadError（含源条目文件名）", () => {
	const root = makeTempDir();
	try {
		const a = createPack(root, {
			name: "pack_a",
			entries: [
				{
					type: "characters",
					id: "hero",
					yaml: characterEntry("H", { refs: ["pack_b:character:nobody"] }),
				},
			],
		});
		createPack(root, {
			name: "pack_b",
			entries: [{ type: "characters", id: "other", yaml: characterEntry("O") }],
		});
		assert.throws(() => loadPacks([a, join(root, "pack_b")]), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const issue = err.issues.find((i) => /跨包引用 pack_b:character:nobody 不存在/.test(i.message));
			assert.ok(issue, `应有跨包断链 issue: ${JSON.stringify(err.issues)}`);
			assert.equal(issue.file?.endsWith("characters/hero.yaml"), true);
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPacks：跨包引用存在 → 通过；多包共存同名条目 id 不冲突（命名空间 = 包名）", () => {
	const root = makeTempDir();
	try {
		const a = createPack(root, {
			name: "pack_a",
			entries: [
				{
					type: "characters",
					id: "hero",
					yaml: characterEntry("H", { refs: ["pack_b:character:hero"] }),
				},
			],
		});
		const b = createPack(root, {
			name: "pack_b",
			entries: [{ type: "characters", id: "hero", yaml: characterEntry("H2") }],
		});
		const packs = loadPacks([a, b]);
		assert.equal(packs.length, 2);
		assert.equal(packs[0]!.entries[0]!.pack, "pack_a");
		assert.equal(packs[1]!.entries[0]!.pack, "pack_b");
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPacks：重复包名 → PackLoadError", () => {
	const root = makeTempDir();
	try {
		const a = createPack(root, { name: "dup", entries: [{ type: "characters", id: "x", yaml: characterEntry("X") }] });
		const b = createPack(root, { name: "dup", entries: [{ type: "characters", id: "y", yaml: characterEntry("Y") }] });
		assert.throws(() => loadPacks([a, b]), /重复的卡包名: dup/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：SQL 前缀违规（表名不以 <包名>_ 开头）→ PackLoadError（含 SQL 文件名）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			schemaSql: "CREATE TABLE evil_thing (id INTEGER PRIMARY KEY);\n",
		});
		assert.throws(() => loadPack(dir), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const issue = err.issues.find((i) => /命名空间前缀违规/.test(i.message));
			assert.ok(issue, `应有前缀违规 issue: ${JSON.stringify(err.issues)}`);
			assert.match(issue.message, /evil_thing/);
			assert.equal(issue.file?.endsWith("schema.sql"), true);
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：卡包 SQL 写内核保留表（clock）→ PackLoadError；前缀合法表放行", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			schemaSql: "CREATE TABLE clock (id INTEGER);\nCREATE TABLE IF NOT EXISTS shouling_relics (id INTEGER);\n",
			seedSql: "INSERT INTO shouling_relics (id) VALUES (1);\n",
		});
		assert.throws(() => loadPack(dir), /卡包 SQL 不应写内核保留表: clock/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：INSERT INTO 也做前缀扫描（seed.sql 违规同样报错）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			schemaSql: "CREATE TABLE shouling_relics (id INTEGER);\n",
			seedSql: "INSERT INTO other_table (id) VALUES (1);\n",
		});
		assert.throws(() => loadPack(dir), /命名空间前缀违规: 表名 "other_table"/);
	} finally {
		cleanupTempDir(root);
	}
});

// 内核表拦截不能只认 CREATE TABLE / INSERT INTO。
// 旧实现只扫这两个动词，`DELETE FROM turn_log;`（turn_log 是「数据库才是事实」的载体）
// 与 `CREATE INDEX ... ON events` 曾静默通过校验——卡包作者唯一的防线放行数据清空。
// 改为反向扫描内核表名后，成败不再取决于动词覆盖面：以下每条都是"能改写内核表"的合法 SQL。
for (const sql of [
	"DELETE FROM turn_log;\n",
	"DROP TABLE events;\n",
	"DROP TABLE IF EXISTS npcs;\n",
	"UPDATE clock SET id = 1;\n",
	"ALTER TABLE locations ADD COLUMN evil TEXT;\n",
	"CREATE INDEX ix_evil ON events (id);\n",
	"CREATE TRIGGER trg_evil AFTER INSERT ON world_state BEGIN SELECT 1; END;\n",
	"CREATE VIEW v_evil AS SELECT * FROM npc_memories;\n",
	"create index ix2 on TURN_LOG (id);\n",
]) {
	test(`loadPack：破坏性动词改写内核保留表也报错 — ${sql.trim()}`, () => {
		const root = makeTempDir();
		try {
			const dir = createPack(root, {
				name: "shouling",
				schemaSql: "CREATE TABLE shouling_relics (id INTEGER);\n",
				seedSql: sql,
			});
			assert.throws(() => loadPack(dir), /卡包 SQL 不应写内核保留表/);
		} finally {
			cleanupTempDir(root);
		}
	});
}

test("loadPack：DROP/DELETE 的表名同样做命名空间前缀扫描（不止 CREATE/INSERT）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			schemaSql: "CREATE TABLE shouling_relics (id INTEGER);\n",
			seedSql: "DROP TABLE other_table;\n",
		});
		assert.throws(() => loadPack(dir), /命名空间前缀违规: 表名 "other_table"/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：注释与字符串字面量里的内核表名不算引用（不假阳性）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			// init 生成的骨架 schema.sql 说明注释里就写着「/ world_state 键须以 <包名>_ 前缀」；
			// seed 里的字符串则是数据值，不是表引用。
			schemaSql:
				"-- 所有表名 / world_state 键必须以「shouling_」前缀开头（内核保留表除外）\nCREATE TABLE shouling_log (id INTEGER, msg TEXT);\n",
			seedSql: "INSERT INTO shouling_log (id, msg) VALUES (1, 'DELETE FROM turn_log');\n",
		});
		assert.equal(loadPack(dir).name, "shouling");
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：内核表名作子串的自建表名不误报（shouling_events / shouling_clockwork）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			schemaSql:
				"CREATE TABLE shouling_events (id INTEGER);\nCREATE TABLE shouling_clockwork (id INTEGER);\n",
			seedSql: "INSERT INTO shouling_events (id) VALUES (1);\n",
		});
		assert.equal(loadPack(dir).name, "shouling");
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：clockwork 不被当内核表 clock（词边界），但缺前缀仍报前缀违规", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			schemaSql: "CREATE TABLE clockwork (id INTEGER);\n",
		});
		assert.throws(() => loadPack(dir), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const messages = err.issues.map((i) => i.message).join("\n");
			assert.match(messages, /命名空间前缀违规/);
			assert.doesNotMatch(messages, /内核保留表/, "clockwork 不是内核表 clock，不该按内核拦");
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：非法包名（含连字符，不转换直接拒绝）→ PackLoadError", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "bad-name",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("甲") }],
		});
		assert.throws(() => loadPack(dir), /非法包名: "bad-name"/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：package.json 缺失 → PackLoadError", () => {
	const root = makeTempDir();
	try {
		const dir = join(root, "no_pkg");
		writeFile(dir, "story.yaml", "title: x\n");
		assert.throws(() => loadPack(dir), /package.json 缺失/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：db/schema.sql 缺失 → PackLoadError（布局必填，内容可为空）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, { name: "p", schemaSql: null });
		assert.throws(() => loadPack(dir), /db\/schema\.sql 缺失/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPacks：多包各自的问题一次收集合并抛出", () => {
	const root = makeTempDir();
	try {
		const a = createPack(root, {
			name: "pack_a",
			entries: [{ type: "characters", id: "a", yaml: entryYaml({ type: "character", name: "甲", bogus: 1 }) }],
		});
		createPack(root, {
			name: "pack_b",
			schemaSql: "CREATE TABLE bad (id INTEGER);\n",
		});
		assert.throws(() => loadPacks([a, join(root, "pack_b")]), (err: unknown) => {
			assert.ok(err instanceof PackLoadError);
			const messages = err.issues.map((i) => i.message).join("\n");
			assert.match(messages, /bogus/, "pack_a 未知字段");
			assert.match(messages, /命名空间前缀违规/, "pack_b 前缀违规");
			return true;
		});
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：pi.extensions 声明收集进 extensionEntryPaths（不加载）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, { name: "code_pack", piExtensions: ["src/ext.ts"] });
		const pack = loadPack(dir);
		assert.equal(pack.hasCode, true);
		assert.deepEqual(pack.extensionEntryPaths, [join(dir, "src", "ext.ts")]);
	} finally {
		cleanupTempDir(root);
	}
});

// pi.extensions 是自由字符串数组，会照原样交给 pi 的 loader 加载。写成包外路径时作者
// 以为挂的是自己的文件，实际加载的是别处——越界必须响亮报错，不能静默剔除或静默放行。
for (const declared of ["../outside.ts", "./../outside.ts", "/etc/hostname"]) {
	test(`loadPack：pi.extensions 指向包外 → PackLoadError — ${declared}`, () => {
		const root = makeTempDir();
		try {
			const dir = createPack(root, { name: "code_pack", piExtensions: [declared] });
			assert.throws(() => loadPack(dir), (err: unknown) => {
				assert.ok(err instanceof PackLoadError);
				assert.match(err.issues.map((i) => i.message).join("\n"), /指向包外路径/);
				return true;
			});
		} finally {
			cleanupTempDir(root);
		}
	});
}

// 越界判断用 path.relative 而非前缀字符串比较：`<root>/code_pack-evil` 的字符串前缀
// 恰好是 `<root>/code_pack`，用 startsWith 判会把它误当包内放行。
test("loadPack：与前缀相似的兄弟目录（code_pack-evil）不被当成包内", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, { name: "code_pack", piExtensions: ["../code_pack-evil/x.ts"] });
		createPack(root, { name: "code_pack-evil" });
		assert.throws(() => loadPack(dir), /指向包外路径/);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：包内相对路径（含 ./ 与多级子目录）照常收集，不误判越界", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, { name: "mine", piExtensions: ["./src/ext.ts", "src/nested/deep.ts"] });
		assert.deepEqual(loadPack(dir).extensionEntryPaths, [
			join(dir, "src", "ext.ts"),
			join(dir, "src", "nested", "deep.ts"),
		]);
	} finally {
		cleanupTempDir(root);
	}
});

test("loadPack：未知 collection 类型目录 → PackLoadError（防目录名笔误静默吞掉）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, { name: "p" });
		writeFile(dir, "collection/characterss/a.yaml", characterEntry("甲"));
		assert.throws(() => loadPack(dir), /未知 collection 类型目录: characterss/);
	} finally {
		cleanupTempDir(root);
	}
});
