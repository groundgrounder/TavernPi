// 各屏视图单测：视图是纯函数（数据进、string[] 出），所以不用跑一轮叙事也能断言排版。
// 判据放在「结构不变量」上（列对齐、阶段齐全、不给假数字），而不是硬编码空格数——
// 硬编码的空格断言一改列宽就假红，反而会让人不敢动排版。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DbView, TurnResult } from "@tavernpi/core";
import {
	modeLabel,
	renderHelp,
	renderInputRejected,
	renderPacks,
	renderStartup,
	renderStatus,
	renderTurn,
} from "../src/cli-view.ts";
import { EN } from "../src/cli-text-en.ts";
import { stripAnsi, Ui } from "../src/ui.ts";

const ui = new Ui({ width: 80, color: false, animate: false, out: null as never });

/** 一轮报告的最小 TurnResult（只填视图真正读到的字段）。 */
function turnResult(over: Partial<Record<string, unknown>> = {}): TurnResult {
	return {
		turnSeq: 7,
		userEntryId: "u7",
		leafId: "a7",
		narrativeText: "她把灯拨亮了一些，火苗抖了抖，还是稳住了。",
		data: { ok: true, applied: { events: 2, newNpcs: 0, timeAdvanced: false }, attempts: 1, error: "" },
		snapshotTaken: true,
		consecutiveDataFailures: 0,
		...over,
	} as unknown as TurnResult;
}

/** 行 → 去掉 ANSI 后按「两个及以上空格」切段，便于断言结构。 */
const cols = (line: string): string[] => stripAnsi(line).trim().split(/\s{2,}/);

/** 值/说明列的起点：`<缩进><标签若干空格><值>`，标签内不含双空格。 */
const valueStart = (line: string, indent = 2): number => {
	const m = new RegExp(`^ {${indent}}(\\S+)( +)`).exec(stripAnsi(line))!;
	return indent + m[1]!.length + m[2]!.length;
};

/** 阶段行的阶段名（`  ✓ story  12s  facts` 的第二段）。 */
const stageLabel = (line: string): string => cols(line)[0]!.split(" ")[1]!;

test("renderTurn：正文只打一次，阶段行按报告里真实存在的阶段出现", () => {
	const lines = renderTurn(ui, {
		report: turnResult({
			story: {
				sceneCard: {},
				sceneFallback: false,
				hardConflicts: [],
				suspicions: [],
				revisions: 0,
				releasedWithWarnings: false,
			},
			npc: { onstageNpcIds: [3], rehearsals: [], offscreenTriggeredIds: [], offscreenDeltas: [] },
			snapshotTaken: false,
		}),
		durationMs: 74200,
		stageMs: { story: 12400, npc: 8900, data: 20100 },
	});
	assert.equal(lines[0], "turn 7  1m14s");
	assert.equal(lines.filter((l) => l.includes("她把灯")).length, 1);

	const stages = lines.filter((l) => /^ {2}[!✓✗·] \S/.test(l)).map(stageLabel);
	assert.deepEqual(stages, ["story", "npc", "data", "snapshot"]);
	// 未跑的 stylize 不占行——不编造没发生的阶段。
	assert.ok(!lines.some((l) => l.includes(EN.stageStylize)));
});

test("renderTurn：冲突与疑点各成细节行，缩进比阶段行深一级", () => {
	const lines = renderTurn(ui, {
		report: turnResult({
			story: {
				sceneCard: {},
				sceneFallback: true,
				hardConflicts: ["时间线冲突：场景卡说「入夜」，正文写成「天刚亮」"],
				suspicions: ["正文提到「她记得」但该角色记忆里没有这条"],
				revisions: 1,
				releasedWithWarnings: true,
			},
		}),
	});
	const stage = lines.find((l) => l.includes(EN.stageStory))!;
	const details = lines.filter((l) => /^ {6}[!?]/.test(l));
	assert.equal(details.length, 3); // 1 冲突 + 1 疑点 + 1 超限放行说明
	assert.ok(stripAnsi(stage).startsWith("  ! story"));
	assert.match(details[0]!, /时间线冲突/);
	assert.match(details[2]!, new RegExp(EN.turnReleasedNote.replace(/[()]/g, "\\$&")));
});

test("renderTurn：data 失败给出次数与错误，快照未拍如实标「未保存」", () => {
	const lines = renderTurn(ui, {
		report: turnResult({
			data: { ok: false, attempts: 3, error: "schema 校验失败", applied: undefined },
			snapshotTaken: false,
		}),
	});
	assert.match(lines.find((l) => l.includes(EN.stageData))!, /✗ data.*3 attempts.*schema 校验失败/);
	assert.match(lines.find((l) => l.includes(EN.stageSnapshot))!, /not saved/);
});

test("renderTurn：阶段没给耗时就不显示时长列（不给假数字比给数字诚实）", () => {
	const lines = renderTurn(ui, {
		report: turnResult({
			story: { sceneCard: {}, sceneFallback: false, hardConflicts: [], suspicions: [], revisions: 0, releasedWithWarnings: false },
			npc: { onstageNpcIds: [], rehearsals: [], offscreenTriggeredIds: [], offscreenDeltas: [] },
		}),
		durationMs: 2000,
	});
	// 只有 snapshot 的 facts 里可能含 "saved"，阶段行里不该出现任何时长串。
	assert.ok(!lines.some((l) => /\d+m?\d*s\s/.test(stripAnsi(l).slice(2))));
	assert.deepEqual(renderTurn(ui, { report: turnResult({ narrativeText: "   " }) })[2], "(no prose produced this turn; see the warning above)");
});

test("renderStartup：标题行带模式，冒险追加锁定徽章；字段块列对齐", () => {
	const base = { story: "雨夜的旅店", tools: EN.toolsEmpty, sessionId: "s1", storyDir: "/tmp/s1", clock: "0001-03-04 (tavern/hour)" };
	const creation = renderStartup(ui, { ...base, mode: modeLabel("creation"), locked: false });
	assert.equal(stripAnsi(creation[0]!), "雨夜的旅店 · creation");
	assert.ok(!creation.some((l) => l.includes("locked")));

	const adventure = renderStartup(ui, {
		...base,
		mode: modeLabel("adventure"),
		locked: true,
		modeNote: EN.modeNoteLocked,
	});
	assert.equal(stripAnsi(adventure[0]!), "雨夜的旅店 · adventure · locked");
	assert.match(stripAnsi(adventure[1]!), /locked, cannot switch/);

	const rows = creation.filter((l) => /^ {2}\S.+ {2}/.test(stripAnsi(l)));
	assert.equal(new Set(rows.map((r) => valueStart(r))).size, 1);
	assert.match(stripAnsi(rows[0]!), /^ {2}session {2}s1$/);
});

test("modeLabel：显示名与标识符相同时不重复（英文版不写 creation (creation)）", () => {
	assert.equal(modeLabel("creation"), "creation");
	assert.equal(modeLabel("adventure"), "adventure");
});

test("renderHelp：命令两列对齐，三组齐全且含全部命令", () => {
	const lines = renderHelp(ui);
	assert.match(stripAnsi(lines[0]!), /^Commands ─+$/);
	// 说明列在所有分组之间同一列起（说明文本按 lastIndexOf 定位，避免落在命令名里的同名词上）。
	const descStarts = new Set<number>();
	for (const group of EN.helpGroups) {
		for (const [cmd, desc] of group.items) {
			const row = lines.find((l) => stripAnsi(l).trimStart().startsWith(cmd));
			assert.ok(row !== undefined, `缺命令：${cmd}`);
			const s = stripAnsi(row!);
			assert.ok(s.lastIndexOf(desc) > 0, `缺说明：${cmd}`);
			descStarts.add(s.lastIndexOf(desc));
		}
	}
	assert.equal(descStarts.size, 1);
});

test("renderStatus：模式行不重复标识符，无角色时给明确说明", () => {
	const view = {
		getClock: () => ({ current_time: "0001-03-04", calendar: "tavern", granularity: "hour" }),
		listEvents: () => [],
		getTurnLog: () => [],
		listDataStatus: () => [],
		getPlayerLocation: () => undefined,
		getPlayerLocationPath: () => undefined,
		listLocations: () => [],
		listNpcs: () => [],
		getNpc: () => undefined,
	} as unknown as DbView;
	const lines = renderStatus(ui, {
		view,
		snapshotCount: 0,
		mode: "adventure",
		sessionId: "s1",
		entryId: "e1",
		packDirs: [],
		pinned: [],
	});
	const text = stripAnsi(lines.join("\n"));
	assert.match(text, /mode\s+adventure/);
	assert.ok(!text.includes("adventure (adventure)"));
	assert.match(text, /counts\s+turns 0 · events 0 · snapshots 0 · data 0/);
	assert.match(text, /characters[\s\S]*no characters yet/);
});

test("renderPacks：无包时明说「检索注入已关闭」，有包时按类型归并计数", () => {
	assert.match(stripAnsi(renderPacks(ui, [])[1]!), /no world packs/);
	const lines = renderPacks(ui, [
		{
			name: "moonlit-inn",
			dir: "/packs/moonlit-inn",
			entries: [
				{ type: "character", id: "a" },
				{ type: "character", id: "b" },
				{ type: "location", id: "c" },
			],
			hasCode: false,
			story: { title: "雨夜", calendar: "tavern", granularity: "hour" },
		},
	] as never);
	const text = stripAnsi(lines.join("\n"));
	assert.match(text, /moonlit-inn\s+\/packs\/moonlit-inn/);
	assert.match(text, /3 entries \(character 2, location 1\) · content only/);
	assert.match(text, /雨夜 \(tavern \/ hour\)/);
});

test("renderInputRejected：三行分别是原因（带错字形）/ 建议 / 强制提交提示", () => {
	const lines = renderInputRejected(ui, "非玩家输入", "改成角色行动");
	assert.equal(lines.length, 3);
	assert.match(stripAnsi(lines[0]!), /^ {2}✗ input rejected \(input-channel check\): 非玩家输入$/);
	assert.match(stripAnsi(lines[1]!), /^ {2}• try instead: 改成角色行动$/);
	assert.match(stripAnsi(lines[2]!), /prefix it with \/!/);
});
