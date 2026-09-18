// 模型配置（~/.tavernpi/settings.json 里 models.narrator/story/npc/data/stylize/chapter_summary/assist
// 各自指定 provider/model id 与可选 thinking 等级）。
//
// 读写两条路径的纪律不同，刻意如此：
//   loadSettings —— fail-open：读不懂就当没配（subagent 回退 pi 默认模型），只发 warning，绝不抛错。
//   saveSettings —— fail-closed 且绝不覆盖读不懂的内容：校验不通过不写任何文件；
//                   目标文件存在但解析不了就报错退出，让用户先处理（宁可写不进去，不可静默毁掉手写配置）。
// thinking 等级取值来自 pi（pi-agent-core 的 ThinkingLevel）；此处硬编码一份运行时判据并用类型约束
// 钉住——pi 改动取值集合时这里会编译失败，而不是运行期静默丢弃。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

/** 思考等级（等价 pi-agent-core 的 ThinkingLevel；见文件头说明）。 */
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

/** 合法思考等级全集（运行时判据）。类型标注保证与 pi 的联合类型同步。 */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** thinking 等级判据（settings 读写共用）。 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ModelRef {
	provider: string;
	id: string;
	/** 思考等级。narrator 直接消费（主叙事 createAgentSession 的 thinkingLevel）；
	 *  其余角色当前不消费——写了会保留并告警（见 loadSettings），不静默无效。 */
	thinking?: ThinkingLevel;
}

export interface TavernModels {
	narrator?: ModelRef;
	data?: ModelRef;
	story?: ModelRef;
	npc?: ModelRef;
	stylize?: ModelRef;
	chapter_summary?: ModelRef;
	assist?: ModelRef;
}

export interface TavernSettings {
	models: TavernModels;
}

/** 默认设置文件路径 ~/.tavernpi/settings.json。 */
export function defaultSettingsPath(): string {
	return join(homedir(), ".tavernpi", "settings.json");
}

const MODEL_ROLES = ["narrator", "data", "story", "npc", "stylize", "chapter_summary", "assist"] as const;

/** thinking 唯一被消费的角色（其余角色的该字段保留但暂不影响运行）。 */
const THINKING_CONSUMER_ROLE = "narrator";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelRefShape(value: unknown): value is { provider: string; id: string } {
	if (!isPlainObject(value)) return false;
	return (
		typeof value["provider"] === "string" &&
		value["provider"].length > 0 &&
		typeof value["id"] === "string" &&
		value["id"].length > 0
	);
}

/**
 * 读取模型设置。缺文件返回空配置无 warning；解析/形态错误 → warning + 空配置（fail-open，
 * 配置缺失时 subagent 走 pi 默认模型解析，见 runtime.ts）。
 */
export function loadSettings(path: string = defaultSettingsPath()): { settings: TavernSettings; warnings: string[] } {
	const warnings: string[] = [];
	const models: TavernModels = {};

	if (!existsSync(path)) {
		return { settings: { models }, warnings };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		warnings.push(`settings.json 解析失败，使用空配置: ${path}: ${(err as Error).message}`);
		return { settings: { models }, warnings };
	}

	if (!isPlainObject(parsed)) {
		warnings.push(`settings.json 根节点不是对象，使用空配置: ${path}`);
		return { settings: { models }, warnings };
	}

	const modelsValue = parsed["models"];
	if (modelsValue !== undefined) {
		if (!isPlainObject(modelsValue)) {
			warnings.push(`settings.json 的 models 不是对象，已忽略: ${path}`);
		} else {
			for (const role of MODEL_ROLES) {
				const value = modelsValue[role];
				if (value === undefined) continue;
				if (!isModelRefShape(value)) {
					warnings.push(`settings.json 的 models.${role} 形态非法，已忽略: ${JSON.stringify(value)}`);
					continue;
				}
				const ref: ModelRef = { provider: value.provider, id: value.id };
				const thinking = (value as Record<string, unknown>)["thinking"];
				if (thinking !== undefined) {
					if (!isThinkingLevel(thinking)) {
						warnings.push(
							`settings.json 的 models.${role}.thinking 非法，已忽略该字段: ${JSON.stringify(thinking)}（应为 ${THINKING_LEVELS.join("|")}）`,
						);
					} else {
						ref.thinking = thinking;
						if (role !== THINKING_CONSUMER_ROLE) {
							warnings.push(
								`settings.json 的 models.${role}.thinking 当前不会被消费（只有 ${THINKING_CONSUMER_ROLE} 生效）——该值已保留，但不会影响运行`,
							);
						}
					}
				}
				models[role] = ref;
			}
		}
	}

	return { settings: { models }, warnings };
}

/**
 * 写模型设置（读—改—写闭环的写口；编辑器/配置界面的唯一落盘路径）。
 *
 * 语义：
 * - **合并写**：只覆盖 models 下本次给出的角色；文件里本模块不认识的顶层键与未知角色原样保留。
 * - **整角色替换**：某角色给出的对象整体落盘（含 thinking 其清空语义）——传什么存什么，不与旧值叠加。
 * - **校验先行**：任一角色字段非法 → 抛错且不写任何文件（列全部问题）。
 * - **绝不覆盖读不懂的文件**：目标存在但不是合法 JSON 对象 → 抛错（先让用户处理，不静默毁配置）。
 * - **原子替换**：写同目录临时文件后 rename，写一半被打断不会留下半个坏文件。
 */
export function saveSettings(settings: TavernSettings, path: string = defaultSettingsPath()): void {
	// 形态先行：本函数经 IPC / JS 调用时会收到任意值（TS 类型在运行期不存在）。不挡的话
	// `{}.models[role]` 是 TypeError、`{models: 5}` 会被静默当成「无变更」写回——两种都不该发生。
	// 校验走别名读取，避免把后面的类型收窄成 Record<string, unknown>（那样 models[role] 就没类型了）。
	const shape: unknown = settings;
	if (
		!isPlainObject(shape) ||
		!isPlainObject((shape as Record<string, unknown>)["models"])
	) {
		throw new Error(
			`settings 写入被拒（未写任何文件）：形态非法，应为 { models: { <角色>: { provider, id, thinking? } } }，收到 ${JSON.stringify(settings)}`,
		);
	}
	const problems: string[] = [];
	for (const role of MODEL_ROLES) {
		const ref = settings.models[role];
		if (ref === undefined) continue;
		if (typeof ref.provider !== "string" || ref.provider.length === 0) {
			problems.push(`models.${role}.provider 必须是非空字符串`);
		}
		if (typeof ref.id !== "string" || ref.id.length === 0) {
			problems.push(`models.${role}.id 必须是非空字符串`);
		}
		if (ref.thinking !== undefined && !isThinkingLevel(ref.thinking)) {
			problems.push(
				`models.${role}.thinking 非法: ${JSON.stringify(ref.thinking)}（应为 ${THINKING_LEVELS.join("|")}）`,
			);
		}
	}
	if (problems.length > 0) {
		throw new Error(`settings 写入被拒（未写任何文件）：\n- ${problems.join("\n- ")}`);
	}

	const existing = readExistingSettingsObject(path);
	const existingModels = isPlainObject(existing["models"]) ? existing["models"] : {};
	const mergedModels: Record<string, unknown> = { ...existingModels };
	for (const role of MODEL_ROLES) {
		const ref = settings.models[role];
		if (ref !== undefined) mergedModels[role] = ref;
	}
	writeJsonAtomic(path, { ...existing, models: mergedModels });
}

/** 读现存的 settings JSON 对象；不存在或空文件 → {}；存在但读不懂 → 抛错（不覆盖）。 */
function readExistingSettingsObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf-8");
	if (raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`settings 写入被拒：${path} 已存在但不是合法 JSON（${(err as Error).message}）——请先修好或移走该文件，本次不覆盖。`,
		);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`settings 写入被拒：${path} 的根节点不是对象——请先处理该文件，本次不覆盖。`);
	}
	return parsed;
}

/** 原子写 JSON（临时文件 + rename 同目录替换）。 */
function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}
