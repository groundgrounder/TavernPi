// 展示层单测：显示宽度（CJK/ANSI）、截断与补齐、时长文案、活动行重绘纪律、Ui 的着色退化。
// 这些都是纯函数/纯写口，无需跑一轮叙事即可断言——「先证明能跑，再谈好看」。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ActivityLine,
	charWidth,
	displayWidth,
	formatElapsed,
	padToWidth,
	stripAnsi,
	tailByWidth,
	truncateByWidth,
	Ui,
} from "../src/ui.ts";

/** 收集写入的假 stdout（非 TTY 与 TTY 两种形态）。 */
function fakeOut(isTTY: boolean): { out: NodeJS.WriteStream; chunks: string[] } {
	const chunks: string[] = [];
	const out = {
		isTTY,
		columns: 80,
		write: (s: string) => {
			chunks.push(s);
			return true;
		},
	} as unknown as NodeJS.WriteStream;
	return { out, chunks };
}

test("显示宽度：CJK 记 2 列、ASCII 记 1 列、ANSI 转义不计入", () => {
	assert.equal(charWidth("中"), 2);
	assert.equal(charWidth("a"), 1);
	assert.equal(displayWidth("中文"), 4);
	assert.equal(displayWidth("a中b"), 4);
	assert.equal(displayWidth("\x1b[36m中\x1b[0m"), 2);
	assert.equal(stripAnsi("\x1b[1m中\x1b[0m"), "中");
});

test("truncateByWidth：不切断宽字符，结果恒不超过限宽", () => {
	assert.equal(truncateByWidth("中文字符串", 5), "中文…");
	assert.equal(truncateByWidth("abc", 5), "abc");
	assert.equal(truncateByWidth("abc", 0), "");
	for (let max = 0; max <= 12; max++) {
		assert.ok(displayWidth(truncateByWidth("中文字符串测试abc", max)) <= Math.max(max, 1));
	}
});

test("tailByWidth：省略号在左，保留最新的一段", () => {
	assert.equal(tailByWidth("中文字符串", 5), "…符串");
	assert.equal(tailByWidth("abc", 5), "abc");
	for (let max = 0; max <= 12; max++) {
		assert.ok(displayWidth(tailByWidth("中文字符串测试abc", max)) <= Math.max(max, 1));
	}
});

test("padToWidth：按显示宽补空格，着色不参与计算，已超宽原样返回", () => {
	assert.equal(padToWidth("中", 4), "中  ");
	assert.equal(padToWidth("\x1b[36m中\x1b[0m", 4), "\x1b[36m中\x1b[0m  ");
	assert.equal(padToWidth("中中中", 4), "中中中");
	assert.equal(displayWidth(padToWidth("中文", 9)), 9);
});

test("formatElapsed：秒 / 分秒 / 时分三档，负值不崩", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(8000), "8s");
	assert.equal(formatElapsed(74200), "1m14s");
	assert.equal(formatElapsed(128000), "2m08s");
	assert.equal(formatElapsed(3720000), "1h02m");
	assert.equal(formatElapsed(-5), "0s");
});

test("活动行：启用时首帧即绘、用 \\r + 清行原地重绘、尾巴不超出宽度", () => {
	const { out, chunks } = fakeOut(true);
	const line = new ActivityLine({ out, width: 40, enabled: true, paint: (_tone, t) => t });
	line.start("thinking");
	assert.match(chunks.join(""), /thinking/);
	assert.ok(chunks[0]!.startsWith("\r\x1b[2K"));
	line.setPhase("writing", true);
	line.append("她把灯拨亮了一些");
	line.append("，火苗抖了抖，还是稳住了");
	// 渲染发生在定时器上；resume() 强制重绘一次，断言才有意义。
	line.resume();
	assert.match(chunks.at(-1)!, /writing/);
	// 尾巴取最新的一段（省略号在左），不是开头那几个字。
	assert.match(chunks.at(-1)!, /还是稳住了/);
	assert.ok(displayWidth(stripAnsi(chunks.at(-1)!)) <= 40, `超宽：${chunks.at(-1)}`);
	line.stop();
	assert.equal(chunks.at(-1), "\r\x1b[2K");
});

test("活动行：切阶段清空预览（新一轮/重写都是新稿）", () => {
	const { out, chunks } = fakeOut(true);
	const line = new ActivityLine({ out, width: 60, enabled: true, paint: (_tone, t) => t });
	line.start("thinking");
	line.setPhase("writing", true);
	line.append("上一稿的正文尾巴");
	line.resume();
	assert.match(chunks.at(-1)!, /上一稿/);
	line.setPhase("checking", true);
	line.setPhase("writing", true);
	line.append("新稿");
	line.resume();
	assert.match(chunks.at(-1)!, /新稿/);
	assert.doesNotMatch(chunks.at(-1)!, /上一稿/);
	line.stop();
});

test("活动行：非 TTY 时一个字节都不写（管道输出保持干净纯文本）", () => {
	const { out, chunks } = fakeOut(false);
	const line = new ActivityLine({ out, width: 40, enabled: false, paint: (_tone, t) => t });
	line.start("thinking");
	line.append("x");
	line.setPhase("writing", true);
	line.stop();
	assert.deepEqual(chunks, []);
});

test("Ui：非 TTY 退化时不着色，TTY 下按 tone 上色", () => {
	const quiet = new Ui({ width: 80, color: false, animate: false, out: fakeOut(false).out });
	assert.equal(quiet.paint("err", "x"), "x");
	const colored = new Ui({ width: 80, color: true, animate: false, out: fakeOut(true).out });
	assert.equal(colored.paint("err", "x"), "\x1b[31mx\x1b[0m");
});

test("Ui：标题线补到行宽（留 1 列，避免终端折行）", () => {
	const { out } = fakeOut(false);
	const ui = new Ui({ width: 40, color: false, animate: false, out });
	const w = displayWidth(ui.heading("status"));
	assert.ok(w <= 40 && w >= 38, `标题线宽 ${w}，应贴近 40 但不写满`);

	const rows = ui.fields([
		["time", "0001-03-04"],
		["location", "王城 > 庭院"],
		["mode", "adventure"],
	]);
	// 值列起点一致（标签列按最宽标签对齐，中文标签也不算错位）。
	const valueStart = (line: string): number => {
		const m = /^ {2}(\S+)( +)/.exec(stripAnsi(line))!;
		return 2 + m[1]!.length + m[2]!.length;
	};
	assert.equal(new Set(rows.map(valueStart)).size, 1);
	assert.equal(rows[1], "  location  王城 > 庭院");
});

test("Ui：阶段行只给存在的时长列留位，缺时长的行不塞假数字", () => {
	const { out } = fakeOut(false);
	const ui = new Ui({ width: 80, color: false, animate: false, out });
	const lines = ui.stages([
		{ glyph: "✓", tone: "ok", label: "story", time: "12s", facts: "scene card ok" },
		{ glyph: "·", tone: "dim", label: "snapshot", facts: "saved" },
	]);
	assert.match(lines[0]!, /^ {2}✓ story\s+12s\s+scene card ok$/);
	// 无时长的行不给时长；事实列仍与上一行同列起（宽度留白，不是删列）。
	assert.match(lines[1]!, /^ {2}· snapshot\s+saved$/);
	const factsAt = (line: string, facts: string) => line.length - facts.length;
	assert.equal(factsAt(lines[0]!, "scene card ok"), factsAt(lines[1]!, "saved"));
});

test("Ui：写出口先擦活动行（lines 一次整块写、line 单行写）", () => {
	const { out, chunks } = fakeOut(true);
	const ui = new Ui({ width: 40, color: false, animate: true, out });
	ui.activity.start("thinking");
	assert.match(chunks.join(""), /thinking/);
	ui.lines(["a", "b"]);
	assert.equal(chunks.at(-1), "a\nb\n");
	ui.line("c");
	assert.equal(chunks.at(-1), "c\n");
	ui.warn("boom");
	assert.equal(chunks.at(-1), "  ! boom\n");
	ui.activity.stop();
});
