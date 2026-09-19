// 提示词分层加载器 + 分层管理 API（「各层读写与覆盖链查询」）。
// 四层覆盖：内置 < 全局 < 卡包 < 故事级；高层覆盖低层，出错/为空回退到下一层。
//
// 层级目录（各层可选，未提供的层整体跳过，内置层必存在）：
//   builtin  packages/core/prompts/<role>.md        —— 模块自带（narrator.md 等）
//   global   ~/.tavernpi/prompts/<role>.md          —— 玩家偏好
//   pack     <packDir>/prompts/<role>.md            —— 卡作者文风/填表语义（多包：后包覆盖先包）
//   story    <storyDir>/prompts/<role>.md           —— 故事内调整
//
// 回退规则：高层文件读取失败（非 ENOENT）或内容为空 → 记 warning 并回退到下一层；
// 文件不存在（ENOENT）→ 静默回退（未提供覆盖属正常，不产生 warning）。
// 占位符语法（M2 定案）：`{{标识符}}`，标识符 = [A-Za-z][A-Za-z0-9_]*，两侧允许空白。
// 未在 values 中提供的占位符原样保留并记入 unknownPlaceholders（去重，保首现顺序）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PromptLayer = "builtin" | "global" | "pack" | "story";

export interface PromptLayerDirs {
	/** 全局层目录（缺省 ~/.tavernpi/prompts）。未提供则跳过该层。 */
	globalDir?: string;
	/** 卡包根目录数组（提示词位于 <packDir>/prompts/；按 story.meta.json packs 顺序，后包覆盖先包）。未提供则跳过该层。 */
	packDirs?: string[];
	/** 故事根目录（提示词位于 <storyDir>/prompts/）。未提供则跳过该层。 */
	storyDir?: string;
}

export interface LoadedPrompt {
	role: string;
	content: string;
	layer: PromptLayer;
	path: string;
	/** 回退链上遇到的空文件/读取失败说明 + 卡包覆盖说明（命中层以上的故障；文件缺失不在此列）。 */
	warnings: string[];
}

/** 内置提示词目录：本文件位于 src/prompts/，内置层即仓库级 packages/core/prompts/。 */
export function builtinPromptsDir(): string {
	return resolve(import.meta.dirname, "../../prompts");
}

/** 默认全局提示词目录 ~/.tavernpi/prompts。 */
export function defaultGlobalPromptsDir(): string {
	return join(homedir(), ".tavernpi", "prompts");
}

const ROLE_RE = /^[a-z][a-z0-9_]*$/;
const PROMPT_EXT = ".md";

/** role 白名单校验（防路径穿越：只允许小写字母开头的标识符；供 setStoryPromptOverride 等复用）。 */
export function assertValidRole(role: string): void {
	if (!ROLE_RE.test(role)) {
		throw new Error(`非法提示词角色名: ${JSON.stringify(role)}（仅允许 [a-z][a-z0-9_]*）`);
	}
}

type LayerProbe =
	| { status: "ok"; path: string; content: string }
	| { status: "missing"; path: string }
	| { status: "empty"; path: string }
	| { status: "error"; path: string; message: string };

/** 探测单层：读 <dir>/<role>.md。ENOENT=未提供覆盖；空/其他错误分别标记。 */
function probeLayer(dir: string, role: string): LayerProbe {
	const path = join(dir, `${role}${PROMPT_EXT}`);
	try {
		const content = readFileSync(path, "utf-8");
		if (content.trim() === "") {
			return { status: "empty", path };
		}
		return { status: "ok", path, content };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "missing", path };
		}
		return { status: "error", path, message: (err as Error).message };
	}
}

/** 探测多个目录（卡包多包）：从后往前（后包覆盖先包），首个命中即生效；被覆盖的较早包记 warning。 */
function probeLayerDirs(dirs: string[], role: string, layer: PromptLayer, warnings: string[]): { status: "ok"; path: string; content: string } | undefined {
	for (let i = dirs.length - 1; i >= 0; i--) {
		const probe = probeLayer(dirs[i]!, role);
		if (probe.status === "ok") {
			// 更早的包（优先级更低）也命中 → 被后包覆盖
			for (let j = 0; j < i; j++) {
				const earlier = probeLayer(dirs[j]!, role);
				if (earlier.status === "ok") {
					warnings.push(`${layer} 层提示词 ${role} 被后包覆盖: ${earlier.path} ← ${probe.path}`);
				}
			}
			return probe;
		}
		if (probe.status === "empty") {
			warnings.push(`${layer} 层提示词为空，回退到下一层: ${probe.path}`);
		} else if (probe.status === "error") {
			warnings.push(`${layer} 层提示词读取失败，回退到下一层: ${probe.path}: ${probe.message}`);
		}
	}
	return undefined;
}

/** 探测单个目录（story/global/builtin）。 */
function probeLayerDir(dir: string, role: string, layer: PromptLayer, warnings: string[]): { status: "ok"; path: string; content: string } | undefined {
	const probe = probeLayer(dir, role);
	if (probe.status === "ok") return probe;
	if (probe.status === "empty") {
		warnings.push(`${layer} 层提示词为空，回退到下一层: ${probe.path}`);
	} else if (probe.status === "error") {
		warnings.push(`${layer} 层提示词读取失败，回退到下一层: ${probe.path}: ${probe.message}`);
	}
	return undefined;
}

/**
 * 按 story > pack（后包覆盖先包）> global > builtin 顺序加载提示词：首个非空可读层生效。
 * 未命中任何层（内置层缺失）→ 抛错。
 */
export function loadPrompt(role: string, dirs: PromptLayerDirs = {}): LoadedPrompt {
	assertValidRole(role);
	const warnings: string[] = [];

	const packPromptDirs = (dirs.packDirs ?? []).map((p) => join(p, "prompts"));
	const storyDir = dirs.storyDir !== undefined ? join(dirs.storyDir, "prompts") : undefined;

	// 层目录语义：builtin/global 目录即提示词目录；pack/story 是包/故事根目录，提示词位于 <root>/prompts/ 子目录。
	const storyHit = storyDir !== undefined ? probeLayerDir(storyDir, role, "story", warnings) : undefined;
	if (storyHit) return { role, content: storyHit.content, layer: "story", path: storyHit.path, warnings };
	const packHit = packPromptDirs.length > 0 ? probeLayerDirs(packPromptDirs, role, "pack", warnings) : undefined;
	if (packHit) return { role, content: packHit.content, layer: "pack", path: packHit.path, warnings };
	const globalHit = dirs.globalDir !== undefined ? probeLayerDir(dirs.globalDir, role, "global", warnings) : undefined;
	if (globalHit) return { role, content: globalHit.content, layer: "global", path: globalHit.path, warnings };
	const builtinHit = probeLayerDir(builtinPromptsDir(), role, "builtin", warnings);
	if (builtinHit) return { role, content: builtinHit.content, layer: "builtin", path: builtinHit.path, warnings };
	throw new Error(`提示词 ${JSON.stringify(role)} 未命中任何层（内置层缺失）`);
}

// ---------------------------------------------------------------------------
// 分层管理 API（「各层读写与覆盖链查询」）
// ---------------------------------------------------------------------------

/** 单层状态（供覆盖链查询）。pack 层聚合多包候选。 */
export interface PromptChainLayerInfo {
	layer: PromptLayer;
	/** 该层候选路径（pack 为多包目录拼接；不存在层为空数组）。 */
	paths: string[];
	/** 该层是否存在该 role 提示词（pack 层任一生效候选命中即 true）。 */
	exists: boolean;
	/** 生效候选内容长度（-1 表示不存在）。 */
	contentLength: number;
	/** 该层是否为生效层（覆盖链命中处）。 */
	effective: boolean;
}

export interface PromptChainInfo {
	role: string;
	/** 四层，按优先级从高到低（story > pack > global > builtin）。 */
	layers: PromptChainLayerInfo[];
	/** 生效层（覆盖链命中层）。 */
	effectiveLayer: PromptLayer;
}

/** 覆盖链查询：返回四层各自状态（路径/是否存在/内容长度/是否生效层）+ 生效层标记。 */
export function resolvePromptChain(dirs: PromptLayerDirs, role: string): PromptChainInfo {
	assertValidRole(role);
	const packPromptDirs = (dirs.packDirs ?? []).map((p) => join(p, "prompts"));
	const storyPromptDir = dirs.storyDir !== undefined ? join(dirs.storyDir, "prompts") : undefined;

	const layerSpec: Array<{ layer: PromptLayer; dirs: string[] }> = [
		{ layer: "story", dirs: storyPromptDir !== undefined ? [storyPromptDir] : [] },
		{ layer: "pack", dirs: packPromptDirs },
		{ layer: "global", dirs: dirs.globalDir !== undefined ? [dirs.globalDir] : [] },
		{ layer: "builtin", dirs: [builtinPromptsDir()] },
	];

	let effectiveLayer: PromptLayer | undefined;
	const layers: PromptChainLayerInfo[] = [];
	for (const { layer, dirs } of layerSpec) {
		const paths = dirs.filter((d) => d.length > 0).map((d) => join(d, `${role}${PROMPT_EXT}`));
		// pack 层：从后往前找生效候选（后包覆盖先包）
		let winner: string | undefined;
		if (layer === "pack") {
			for (let i = paths.length - 1; i >= 0; i--) {
				const probe = probeLayer(dirs[i]!, role);
				if (probe.status === "ok") {
					winner = paths[i]!;
					break;
				}
				if (probe.status === "missing") continue;
				// empty/error：非候选，继续往前找可用的
			}
		} else {
			for (const d of dirs) {
				const probe = probeLayer(d, role);
				if (probe.status === "ok") {
					winner = join(d, `${role}${PROMPT_EXT}`);
					break;
				}
			}
		}
		const exists = winner !== undefined;
		const effective = exists && effectiveLayer === undefined;
		if (effective) effectiveLayer = layer;
		const contentLength = winner !== undefined ? readFileSync(winner, "utf-8").length : -1;
		layers.push({ layer, paths: paths.length > 0 ? paths : [], exists, contentLength, effective });
	}

	return { role, layers, effectiveLayer: effectiveLayer ?? "builtin" };
}

/** 写/覆盖 story 层提示词覆盖：写 <storyDir>/prompts/<role>.md。 */
export function setStoryPromptOverride(storyDir: string, role: string, content: string): void {
	assertValidRole(role);
	const promptsDir = join(storyDir, "prompts");
	mkdirSync(promptsDir, { recursive: true });
	writeFileSync(join(promptsDir, `${role}${PROMPT_EXT}`), content);
}

/** 删 story 层提示词覆盖：删 <storyDir>/prompts/<role>.md；不存在则 no-op。 */
export function clearStoryPromptOverride(storyDir: string, role: string): void {
	assertValidRole(role);
	rmSync(join(storyDir, "prompts", `${role}${PROMPT_EXT}`), { force: true });
}

/**
 * 写/覆盖 global 层提示词：写 <globalDir>/<role>.md（缺口 5）。
 *
 * **为什么 global 层能写、pack 层不能**：global 是「本机作者的全局偏好」，作者对自己机器上的
 * 文件有完全的处置权；pack 是**别人分发的产物**——在这里改写等于偷偷改了分发内容，下次更新
 * 卡包就冲突，故 pack 层只读（想改请到包目录里改，见 loadPrompt 的回退链）。
 *
 * `globalDir` 缺省 `defaultGlobalPromptsDir()`（~/.tavernpi/prompts）。显式传入是为了让测试与
 * 「多份全局配置」的场景可控（与 `loadPrompt` 的 `dirs.globalDir` 同一语义）。
 *
 * 目录不存在会建；父级是普通文件之类的失败**原样抛**——写提示词是作者主动行为，
 * 静默失败会让作者以为改好了、实际下轮还是旧提示词。
 */
export function setGlobalPromptOverride(role: string, content: string, globalDir?: string): string {
	assertValidRole(role);
	const dir = globalDir ?? defaultGlobalPromptsDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${role}${PROMPT_EXT}`);
	writeFileSync(path, content);
	return path;
}

/**
 * 删 global 层提示词：删 <globalDir>/<role>.md；不存在则 no-op。
 *
 * 「删掉 → 回退到下一层」与 clearStoryPromptOverride 同规，但**后果更响**：
 * global 通常直接盖住 builtin，删掉后角色行为会明显变化。返回值告诉调用侧
 * 「到底删掉了没有」，因为它无法从 no-op 里区分「本来就没有」。
 */
export function clearGlobalPromptOverride(role: string, globalDir?: string): boolean {
	assertValidRole(role);
	const path = join(globalDir ?? defaultGlobalPromptsDir(), `${role}${PROMPT_EXT}`);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

export interface PlaceholderRender {
	text: string;
	/** 模板中存在但 values 未提供的占位符名（去重，保首现顺序）。 */
	unknownPlaceholders: string[];
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** 占位符注入：values 里有的替换（回调返回的字面量不解释 $ 序列）；没有的原样保留并去重记名。 */
export function renderPlaceholders(template: string, values: Record<string, string>): PlaceholderRender {
	const unknownPlaceholders: string[] = [];
	const text = template.replace(PLACEHOLDER_RE, (match, name: string) => {
		const value = values[name];
		if (value !== undefined) {
			return value;
		}
		if (!unknownPlaceholders.includes(name)) {
			unknownPlaceholders.push(name);
		}
		return match; // 原样保留（含原始空白）
	});
	return { text, unknownPlaceholders };
}
