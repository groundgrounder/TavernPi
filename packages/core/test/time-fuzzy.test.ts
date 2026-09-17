// 时间精度衰减单测（纯函数）：档位渲染（相对日 → 时段 → 月 → 季）、重大事件节点不衰减、
// 非分层时间串退化。用户拍板的档位：≤3 天完整；3~7 天保时段；1~2 周约 N 天前；
// 2 周~1 年月；1 年开外季节。

import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyTimeLabel, memoryTimeLabel, parseTimeYear, PIVOTAL_SALIENCE } from "../src/db/time-fuzzy.ts";

test("fuzzyTimeLabel：≤3 天保留具体（相对日 + 时段）", () => {
	assert.equal(fuzzyTimeLabel("0000-03-05", 0), "今天");
	assert.equal(fuzzyTimeLabel("0000-03-05", 1), "昨天");
	assert.equal(fuzzyTimeLabel("0000-03-05", 2), "前天");
	assert.equal(fuzzyTimeLabel("0000-03-05 傍晚", 2), "前天傍晚");
	assert.equal(fuzzyTimeLabel("0000-03-05", 3), "三天前");
});

test("fuzzyTimeLabel：3~7 天丢日期保时段", () => {
	assert.equal(fuzzyTimeLabel("0000-03-05 傍晚", 5), "几天前的一个傍晚");
	assert.equal(fuzzyTimeLabel("0000-03-05", 5), "几天前", "无时段则只给「几天前」");
});

test("fuzzyTimeLabel：7~14 天只记得约第几天", () => {
	assert.equal(fuzzyTimeLabel("0000-03-05 傍晚", 10), "约 10 天前");
	assert.equal(fuzzyTimeLabel("0000-03-05", 14), "约 14 天前");
});

test("fuzzyTimeLabel：2 周~1 年只记得月份（带年份词）", () => {
	assert.equal(fuzzyTimeLabel("0000-03-05", 100, 0), "今年三月");
	assert.equal(fuzzyTimeLabel("0000-03-05", 100), "三月", "无当前年则省略年份词");
	assert.equal(fuzzyTimeLabel("0000-03-05", 200, 1), "去年三月");
});

test("fuzzyTimeLabel：1 年开外只记得季节", () => {
	assert.equal(fuzzyTimeLabel("0000-03-05", 400, 1), "去年春天");
	assert.equal(fuzzyTimeLabel("0000-12-05", 800, 2), "前年冬天");
	assert.equal(fuzzyTimeLabel("0000-06-05", 1600, 4), "4 年前夏天");
});

test("fuzzyTimeLabel：非分层时间串退化为相对天数表达", () => {
	assert.equal(fuzzyTimeLabel("很久以前", 20), "约 1 个月前");
	assert.equal(fuzzyTimeLabel("远古", 800), "约 2 年前");
});

test("memoryTimeLabel：重大事件（salience ≥ 阈值）作节点不衰减，保留完整时间", () => {
	const timeView = { timeText: "0000-03-05 傍晚", daysAgo: 400, currentYear: 1 };
	assert.equal(memoryTimeLabel({ salience: PIVOTAL_SALIENCE }, timeView), "0000-03-05 傍晚", "达到阈值即节点");
	assert.equal(memoryTimeLabel({ salience: 0.9 }, timeView), "0000-03-05 傍晚");
	assert.equal(memoryTimeLabel({ salience: 0.3 }, timeView), "去年春天", "普通记忆按天数衰减");
});

test("parseTimeYear：分层时间串首段为纯数字时取出年份", () => {
	assert.equal(parseTimeYear("0000-03-05"), 0);
	assert.equal(parseTimeYear("0123-03-05 傍晚"), 123);
	assert.equal(parseTimeYear("很久以前"), undefined);
	assert.equal(parseTimeYear("第三纪-冬"), undefined);
});
