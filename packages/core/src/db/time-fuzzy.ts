// 时间精度衰减（记忆的拟人化渲染）。
//
// 人类记忆随时间自然模糊：几天前记得「前天傍晚」，几个月后只记得「三月」，几年后只剩「那年冬天」；
// 而重大事件（高 salience）例外——它成为时间线上的「节点」，永远清晰。
// 本模块把这条规律做成纯函数：距今天数 + 时间文本 → 模糊时间词。
//
// 两个关键约定：
// - 「距今天数」由 time_log.span_days 累加得出（历法无关）；时间文本是给 LLM 看的故事时间串。
// - 日历词（月份/季节/年份词）需要分层时间串（如 `0000-03-05`）——ISO 形态前提，
//   与 time_advance 的字典序比较同款前提；非分层形态退化为相对天数表达。
//
// 衰减是**读时计算**（不改库）：写者纪律不破、回溯到早期时按「当时」算、规则可调。

/** 重大事件的 salience 阈值：达到即作「节点」不衰减（保留完整时间）。 */
export const PIVOTAL_SALIENCE = 0.8;

const MONTH_NAMES = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];

/** 解析分层时间串的年份（首段为纯数字时）；解析不出返回 undefined。 */
export function parseTimeYear(timeText: string): number | undefined {
	const first = timeText.trim().split(/\s+/)[0]?.split(/[-/.]/)[0];
	return first !== undefined && /^\d+$/.test(first) ? Number(first) : undefined;
}

/** 月 → 季节词。 */
function seasonOf(month: number): string {
	if (month >= 3 && month <= 5) return "春天";
	if (month >= 6 && month <= 8) return "夏天";
	if (month >= 9 && month <= 11) return "秋天";
	return "冬天";
}

/** 年份词：今年 / 去年 / 前年 / N 年前。 */
function yearOf(currentYear: number, year: number): string {
	const diff = currentYear - year;
	if (diff <= 0) return "今年";
	if (diff === 1) return "去年";
	if (diff === 2) return "前年";
	return `${diff} 年前`;
}

/**
 * 时间精度衰减（用户拍板的档位）：
 * - ≤3 天：相对日 + 时段（`前天傍晚`）
 * - 3~7 天：丢日期保时段（`几天前的一个傍晚`；无时段则 `几天前`）
 * - 7~14 天：`约 N 天前`
 * - 14 天~1 年：月份（`三月` / `去年三月`）
 * - >1 年：季节（`去年冬天` / `三年前的冬天`）
 * @param timeText 故事时间文本（如 `0000-03-05 傍晚`；时段为可选尾段）
 * @param daysAgo 距今天数（time_log.span_days 累加）
 * @param currentYear 当前故事年份（给出后才能产出「去年/前年」年份词；缺省省略）
 */
export function fuzzyTimeLabel(timeText: string, daysAgo: number, currentYear?: number): string {
	const trimmed = timeText.trim();
	const [datePart = "", ...restParts] = trimmed.split(/\s+/);
	const period = restParts.join(" ").trim(); // 时段（自由文本：傍晚 / 深夜 / 午后…）

	// 1) ≤3 天：具体到天（相对日）+ 时段
	if (daysAgo <= 3) {
		const rel = daysAgo === 0 ? "今天" : daysAgo === 1 ? "昨天" : daysAgo === 2 ? "前天" : "三天前";
		return period !== "" ? `${rel}${period}` : rel;
	}

	// 2) 3~7 天：日期模糊，时段尚存
	if (daysAgo <= 7) {
		return period !== "" ? `几天前的一个${period}` : "几天前";
	}

	// 3) 7~14 天：只记得大约第几天
	if (daysAgo <= 14) {
		return `约 ${Math.round(daysAgo)} 天前`;
	}

	const segs = datePart.split(/[-/.]/);
	const year = segs.length >= 1 && /^\d+$/.test(segs[0]!) ? Number(segs[0]) : undefined;
	const month = segs.length >= 2 && /^\d+$/.test(segs[1]!) ? Number(segs[1]) : undefined;
	const validMonth = month !== undefined && month >= 1 && month <= 12;
	const yearPrefix = year !== undefined && currentYear !== undefined ? yearOf(currentYear, year) : "";

	// 4) 14 天~1 年：只记得月份
	if (daysAgo <= 365) {
		if (validMonth) return `${yearPrefix}${MONTH_NAMES[month! - 1]}`;
		return `约 ${Math.round(daysAgo / 30)} 个月前`;
	}

	// 5) 1 年以上：只记得季节
	if (validMonth) {
		return yearPrefix !== "" ? `${yearPrefix}${seasonOf(month!)}` : `${seasonOf(month!)}`;
	}
	return `约 ${Math.round(daysAgo / 365)} 年前`;
}

/** 记忆的时间标签：重大事件（salience ≥ PIVOTAL_SALIENCE）作节点不衰减；其余按天数降精度。 */
export function memoryTimeLabel(
	memory: { salience: number },
	timeView: { timeText: string; daysAgo: number; currentYear?: number },
): string {
	if (memory.salience >= PIVOTAL_SALIENCE) return timeView.timeText;
	return fuzzyTimeLabel(timeView.timeText, timeView.daysAgo, timeView.currentYear);
}
