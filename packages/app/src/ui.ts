// 终端展示层：主题色板 + 宽度感知排版原语 + 生成期活动行。
//
// 三条纪律：
// 1. **不引第三方依赖**——ANSI 转义与显示宽度自己写（仓库既有风格本就自写 minimal wcwidth）。
// 2. **非 TTY 一律退化**——非 TTY / NO_COLOR / TERM=dumb 时无色、无活动行，
//    管道与快照输出因此始终是干净的纯文本，可 diff。
// 3. **本模块是 app 层唯一的 stdout 出口**——活动行靠 `\r` 原地重绘，
//    任何绕过它的写（哪怕一行 console.log）都会把提示行撕裂。要输出就经 ui。
//
// 排版口径：标题顶格；字段/阶段行缩进 2；细节（警示、冲突清单）缩进 6。
// 宽度一律按显示宽算（CJK 记 2 列），中文列表因此不会错位。

const CSI = "\x1b[";
const RESET = `${CSI}0m`;

/** 主题色板：只用最基础的 SGR（30–37 / 90）与属性，任何终端都能退化成无色。 */
const SGR = {
	accent: `${CSI}36m`,
	dim: `${CSI}90m`,
	bold: `${CSI}1m`,
	ok: `${CSI}32m`,
	warn: `${CSI}33m`,
	err: `${CSI}31m`,
} as const;

export type Tone = keyof typeof SGR;

/** 状态字形。除 `warn` 外均为单列宽字符，不破坏列对齐。 */
export const GLYPH = {
	ok: "✓",
	warn: "!",
	err: "✗",
	ask: "?",
	info: "·",
	mark: "▸",
	dot: "•",
} as const;

/** 细节行的语气：ok/warn/err/ask 用字形 + 强调色，info 只给暗色圆点。 */
export type DetailKind = "ok" | "warn" | "err" | "ask" | "info";

/** 各语气的字形与配色（info 的文字不上色——它常是长路径与数值，上色反而难读）。 */
const DETAIL_GLYPH: Record<DetailKind, string> = {
	ok: GLYPH.ok,
	warn: GLYPH.warn,
	err: GLYPH.err,
	ask: GLYPH.ask,
	info: GLYPH.dot,
};

const DETAIL_TONE: Record<DetailKind, Tone> = {
	ok: "ok",
	warn: "warn",
	err: "err",
	ask: "accent",
	info: "dim",
};

/** 活动行旋转帧（Braille 系，单列宽）。 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ANSI_RE = /\x1b\[[0-9;]*m/gu;

// ---------------------------------------------------------------------------
// 显示宽度（自写最小 wcwidth：CJK/全角按 2 列，控制字符 0，其余 1）
// ---------------------------------------------------------------------------

/** 单个字符的显示宽度。 */
export function charWidth(ch: string): number {
	const code = ch.codePointAt(0)!;
	if (code === 0) return 0;
	if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
	// East Asian Wide / Fullwidth 区间：按 2 列排版，保证中文列表对齐。
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xa960 && code <= 0xa97f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x2fffd) ||
		(code >= 0x30000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** 文本的显示宽度（忽略 ANSI 转义序列，故着色后仍可对齐）。 */
export function displayWidth(text: string): number {
	let w = 0;
	for (const ch of text.replace(ANSI_RE, "")) w += charWidth(ch);
	return w;
}

/** 按显示宽截断到 max：超出部分以省略号收尾；按码点走，绝不切断多字节字符。 */
export function truncateByWidth(text: string, max: number): string {
	if (max <= 0) return "";
	if (displayWidth(text) <= max) return text;
	let w = 0;
	let out = "";
	for (const ch of text) {
		const cw = charWidth(ch);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/** 取文本**末尾**截断到 max 列（省略号在左），用于跟随式预览——读者只关心最新几个字。 */
export function tailByWidth(text: string, max: number): string {
	if (max <= 0) return "";
	if (displayWidth(text) <= max) return text;
	let w = 0;
	let out = "";
	const chars = [...text];
	for (let i = chars.length - 1; i >= 0; i--) {
		const ch = chars[i]!;
		const cw = charWidth(ch);
		if (w + cw > max - 1) break;
		out = ch + out;
		w += cw;
	}
	return `…${out}`;
}

/** 右侧补空格到指定显示宽（已超宽则原样返回，不截断）。 */
export function padToWidth(text: string, width: number): string {
	const gap = width - displayWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** 抹掉 ANSI 转义（快照/断言用）。 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/** 时长文案：`8s` / `1m14s` / `1h02m`。 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	if (m < 60) return `${m}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------------
// 活动行（生成期单行原地重绘）
// ---------------------------------------------------------------------------

interface ActivityDeps {
	out: NodeJS.WriteStream;
	width: number;
	enabled: boolean;
	paint: (tone: Tone, text: string) => string;
}

/** 生成期的一行反馈：旋转帧 + 已用时长 + 阶段（thinking/writing）+ 文本尾巴预览。
 *
 *  预览是**临时**的：它取自主叙事 session 的流式增量，可能随后被重写/重试丢弃，
 *  所以永远画在这一行上、绝不进正式输出（正式正文只从 TurnResult.narrativeText 打一次）。
 *  这也顺带把「模型只在思考不落笔」这类病灶摆到明面上——阶段词会长时间停在 thinking。 */
export class ActivityLine {
	private readonly deps: ActivityDeps;
	private readonly enabled: boolean;
	private timer: NodeJS.Timeout | undefined;
	private active = false;
	private paused = false;
	private drawn = false;
	private frame = 0;
	private startedAt = 0;
	private phase = "thinking";
	private buffer = "";

	constructor(deps: ActivityDeps) {
		this.deps = deps;
		this.enabled = deps.enabled;
	}

	start(phase: string): void {
		if (!this.enabled) return;
		this.active = true;
		this.paused = false;
		this.phase = phase;
		this.buffer = "";
		this.startedAt = Date.now();
		this.frame = 0;
		// unref：活动行不该把进程吊着不退出。
		this.timer = setInterval(() => {
			this.render();
		}, 110);
		this.timer.unref?.();
		this.render();
	}

	stop(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (!this.active) return;
		this.clearLine();
		this.active = false;
	}

	/** 暂停重绘（让出这一行给交互提示等），随时可恢复。 */
	pause(): void {
		if (!this.active) return;
		this.paused = true;
		this.clearLine();
	}

	resume(): void {
		if (!this.active) return;
		this.paused = false;
		this.render();
	}

	/** 换阶段并清空预览（新一轮 prompt / 重试都是新稿）。 */
	setPhase(phase: string, reset: boolean): void {
		if (!this.active) return;
		this.phase = phase;
		if (reset) this.buffer = "";
	}

	append(delta: string): void {
		if (!this.active) return;
		// 只留尾巴：预览只要最新几十个字，缓冲上限防止长轮次无限膨胀。
		this.buffer = (this.buffer + delta).replace(/\s+/gu, " ").slice(-600);
	}

	/** 擦掉当前行（任何正式输出前必须先调）。 */
	clearLine(): void {
		if (!this.enabled || !this.drawn) return;
		this.deps.out.write(`\r${CSI}2K`);
		this.drawn = false;
	}

	private render(): void {
		if (!this.active || this.paused) return;
		const paint = this.deps.paint;
		const { out, width } = this.deps;
		const frame = FRAMES[this.frame++ % FRAMES.length]!;
		const head = `${paint("accent", frame)} ${paint("dim", formatElapsed(Date.now() - this.startedAt))} ${paint("dim", GLYPH.info)} ${paint("dim", this.phase)}`;
		const tail = this.buffer.trim();
		// 尾巴取最新的一部分；留给它的宽度不足就干脆不显示，绝不换行（换行会毁掉原地重绘）。
		const avail = width - displayWidth(head) - 4;
		const body = avail >= 16 ? tailByWidth(tail, avail) : "";
		const text = body === "" ? head : `${head}  ${paint("dim", body)}`;
		out.write(`\r${CSI}2K${text}`);
		this.drawn = true;
	}
}

// ---------------------------------------------------------------------------
// Ui
// ---------------------------------------------------------------------------

/** 颜色/动画自动判定：非 TTY、NO_COLOR、TERM=dumb 均退化。 */
function detectColor(out: NodeJS.WriteStream): boolean {
	const noColor = process.env.NO_COLOR;
	if (noColor !== undefined && noColor !== "") return false;
	if (process.env.FORCE_COLOR === "1") return true;
	if (process.env.TERM === "dumb") return false;
	return out.isTTY === true;
}

export interface UiOptions {
	/** 排版宽度（缺省取终端列数，非 TTY 时 80）。 */
	width?: number;
	/** 是否着色。 */
	color?: boolean;
	/** 是否画活动行（缺省 = 着色且是 TTY）。 */
	animate?: boolean;
	out?: NodeJS.WriteStream;
}

/**
 * 排版与输出。**写**只有三个出口：`line` / `lines` / `prompt`；
 * 其余（heading/fields/stage/detail/着色）都是返回字符串的纯函数，供视图组合。
 */
export class Ui {
	readonly width: number;
	readonly color: boolean;
	readonly animate: boolean;
	private readonly out: NodeJS.WriteStream;
	/** 生成期活动行；未处于生成期时是惰性的。 */
	readonly activity: ActivityLine;

	constructor(opts: UiOptions = {}) {
		const out = opts.out ?? process.stdout;
		this.out = out;
		const columns = (out as { columns?: number }).columns;
		this.width = opts.width ?? (typeof columns === "number" && columns > 0 ? columns : 80);
		this.color = opts.color ?? detectColor(out);
		this.animate = opts.animate ?? (this.color && out.isTTY === true);
		this.activity = new ActivityLine({
			out,
			width: this.width,
			enabled: this.animate,
			paint: (tone, text) => this.paint(tone, text),
		});
	}

	// ---- 着色 ----

	paint(tone: Tone, text: string): string {
		return this.color ? `${SGR[tone]}${text}${RESET}` : text;
	}

	// ---- 写（活动行在此收口）----

	line(text = ""): void {
		this.activity.clearLine();
		this.out.write(`${text}\n`);
	}

	/** 一次写完一整块（视图返回的字符串数组），活动行只擦一次。 */
	lines(lines: readonly string[]): void {
		this.activity.clearLine();
		this.out.write(`${lines.join("\n")}\n`);
	}

	/** 写提示符（不换行）：暂停活动行，把这一行让给输入。 */
	prompt(text: string): void {
		this.activity.pause();
		this.out.write(text);
	}

	/** 系统告警（内核 onWarning、设置/pack 加载告警）：缩进 2 + 黄色字形，走活动行同一出口。 */
	warn(text: string): void {
		this.line(this.note(text, "warn"));
	}

	// ---- 排版原语（返回字符串，不写）----

	/** 小节标题：粗体标题 + 到右边缘的暗色细线。 */
	heading(title: string): string {
		// 细线留 1 列空位（width - title - 2 而非 - 1）：写满整行宽时部分终端会自动折行，
		// 多出一个空行，把后面的内容顶乱。
		const rule = Math.max(0, this.width - displayWidth(title) - 2);
		return `${this.paint("bold", title)} ${this.paint("dim", "─".repeat(rule))}`;
	}

	/** 字段块：`  label   value`，标签暗色并按最宽标签对齐（显示宽）。 */
	fields(rows: ReadonlyArray<readonly [string, string]>): string[] {
		const labelWidth = rows.reduce((max, [label]) => Math.max(max, displayWidth(label)), 0);
		return rows.map(
			([label, value]) =>
				`  ${this.paint("dim", padToWidth(label, labelWidth))}  ${value}`,
		);
	}

	/** 阶段行：`  ✓ story   3.4s  facts`——字形着色、名字对齐、其余平铺。 */
	stages(
		rows: ReadonlyArray<{ glyph: string; tone: Tone; label: string; time?: string; facts: string }>,
	): string[] {
		const labelWidth = rows.reduce((max, r) => Math.max(max, displayWidth(r.label)), 0);
		const timeWidth = rows.reduce((max, r) => Math.max(max, displayWidth(r.time ?? "")), 0);
		return rows.map((r) => {
			const parts = [
				"  ",
				this.paint(r.tone, r.glyph),
				" ",
				padToWidth(r.label, labelWidth),
			];
			if (timeWidth > 0) parts.push("  ", this.paint("dim", padToWidth(r.time ?? "", timeWidth)));
			if (r.facts !== "") parts.push("  ", r.facts);
			return parts.join("");
		});
	}

	/** 顶层反馈行（命令结果、警示）：缩进 2，带字形。 */
	note(text: string, kind: DetailKind = "info"): string {
		return `  ${this.paint(DETAIL_TONE[kind], DETAIL_GLYPH[kind])} ${kind === "info" ? text : this.paint(DETAIL_TONE[kind], text)}`;
	}

	/** 细节行（挂在某个阶段/字段下的补充）：缩进 6，带字形。 */
	detail(text: string, kind: DetailKind = "warn"): string {
		return `      ${this.paint(DETAIL_TONE[kind], DETAIL_GLYPH[kind])} ${kind === "info" ? text : this.paint(DETAIL_TONE[kind], text)}`;
	}

	/** 缩进正文行（列表项等）：缩进 2 + 暗色项目符号。 */
	bullet(text: string): string {
		return `  ${this.paint("dim", GLYPH.dot)} ${text}`;
	}

	/** 深一级缩进行（NPC 分卡等）。 */
	sub(text: string): string {
		return `    ${text}`;
	}
}
