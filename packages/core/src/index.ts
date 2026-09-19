// tavernpi-core 对外导出收敛（API 承诺面的源头）。
// M1-P1：故事 DB 层；M1-P2：快照管理器（★承重机制）；M2-P1：提示词分层/subagent 运行时/
// pipeline 事件流/模型配置最小形态；M2-P2：data subagent + StoryRuntime 编排器；
// M3-P2：npc subagent 阶段接入 StoryRuntime；M4-P2：story 阶段 + stylize 接入；
// M5：卡包系统；M6-P1：模式内核；M6-P2：章节摘要 compaction+/swipe；M6-P3：assist 带外顾问；
// M6-P4a：受信任写入/提示词分层管理/卡包代码挂载/多包提示词合并（承诺面定型）。
//
// 按分组（导出注释）：故事生命周期 / 带模式过滤的 DB 查询（DbView）/ 受信任写入 /
// 提示词分层管理 / agent 模型配置（settings）/ 模式管理（mode/setMode/MODE_PRESETS）/
// pipeline 事件流 / 轮中交互通道 / assist。
//
// 收窄原则（M6 后复核）：本文件只导出「外部消费者要用的能力」与「跨包共享的契约类型」。
// 阶段内部实现不在此列——各 subagent 的 runner（run*）、渲染器（render*）、提交 schema
// （*ZodSchema / *_JSON_SCHEMA / *_OUTPUT_TOOL_NAME）、阶段配置类型（*StageOptions 等）、
// 内核 schema 常量（CORE_*_SQL / CORE_MIGRATIONS）一律留在 src/ 内，core 自己走相对路径引用。
// 判据：新增导出前先看它是否服务于 studio 一类的外部消费者；「内部自用」不是理由。
// 收窄是单向便宜的——加回来不影响兼容，删掉才要版本化，所以宁可窄。

export const CORE_VERSION = "0.6.0";

// 中止桥（缺口 1：runTurn 的 AbortSignal → pi session.abort；中止 = 未完成轮、零落库）
export { runWithAbort, TurnAbortedError, type AbortBridge } from "./abort.ts";

// 故事目录与打开
export {
	defaultStoriesRoot,
	openStoryDb,
	storyDbPath,
	StoryDb,
	type StoryDb as StoryDbHandle,
} from "./db/story-db.ts";

// migration 框架（CORE_MIGRATIONS / hasMigration 属内核内部，不外承诺）
export { migrate, type Migration } from "./db/migrate.ts";

// 读写层
export { DbReader, type NpcComposite } from "./db/reader.ts";
export { DbWriter } from "./db/writer.ts";

// db 工具集（pi ToolDefinition）
export { createDbTools, type DbToolsOptions } from "./db/tools.ts";

// DB 视图过滤（冒险模式「与 user 相关」v0 规则）+ 通用只读查询的视图语义
export {
	buildNpcCardRefIndex,
	createDbView,
	DbView,
	isNpcCardVisible,
	PLAYER_NPC_ID_KEY,
	resolveRelatedNpcSet,
	TableNotVisibleError,
	type RelatedNpcSet,
} from "./db/view.ts";

// 通用只读查询（受限：表清单 + 分页读。只生成 SELECT；表名/列名过真实 metadata 校验）
export {
	listTableInfos,
	readTablePage,
	tableColumns,
	TABLE_QUERY_DEFAULT_LIMIT,
	TABLE_QUERY_MAX_LIMIT,
	TABLE_QUERY_MAX_SCAN,
	type TableInfo,
	type TablePage,
	type TableQuery,
	type TableRows,
} from "./db/query.ts";

// 内核保留表清单（单一事实源：表由 db 层建，故清单住在 db 层；pack 层转发同名导出）
export { KERNEL_TABLE_WHITELIST } from "./db/kernel-tables.ts";

// 位置路径（位置读取侧的统一表示与渲染；CLI / studio 的位置展示复用）
export {
	buildLocationPath,
	describeSpatialRelation,
	locationPointOf,
	renderLocationLevels,
	renderLocationNode,
	renderLocationOverview,
	renderLocationPath,
	renderLocationPoint,
	renderLocationSlice,
	type LocationPath,
	type LocationPathNode,
	type LocationPoint,
	type LocationSliceOptions,
	type SpatialRelation,
} from "./db/location-path.ts";

// 时间精度衰减（记忆的拟人化渲染：距今越久越模糊，重大事件作节点不衰减）
export {
	fuzzyTimeLabel,
	memoryTimeLabel,
	parseTimeYear,
	PIVOTAL_SALIENCE,
} from "./db/time-fuzzy.ts";

// 行类型与常量
export {
	DEFAULT_STORY_CLOCK,
	MEMORY_SOURCE_LABELS,
	MEMORY_SOURCES,
	PLAYER_LOCATION_KEY,
	parseLocationId,
	renderMemoryText,
	type DataStatusRow,
	type DirectiveRow,
	type EventRow,
	type LocationLogRow,
	type LocationRow,
	type MemorySource,
	type NpcMemoryRow,
	type NpcRelationRow,
	type NpcRow,
	type NpcTraitRow,
	type PhaseRow,
	type StoryClock,
	type TimeLogRow,
	type TurnLogRow,
	type WorldStateRow,
} from "./db/types.ts";

// 快照管理器（★）
export {
	openSnapshotsDb,
	snapshotsDbPath,
	takeSnapshot,
	SnapshotsDb,
	type SnapshotRecord,
} from "./snapshot/snapshots-db.ts";
export { removeWalFiles, resetToEmptyStoryDb, restoreSnapshot } from "./snapshot/restore.ts";
export { buildAncestorChain, type EntryLike } from "./snapshot/ancestors.ts";
export {
	createSnapshotHooks,
	type PendingRestore,
	type SnapshotHooks,
	type SnapshotHooksOptions,
	type SnapshotHookState,
	type SnapshotRestoreResult,
} from "./snapshot/hooks.ts";
export { forkStoryDb, type ForkResult } from "./snapshot/fork.ts";

// 轮中交互通道
export {
	InteractionBroker,
	InteractionUnavailableError,
	InteractionValidationError,
	InteractionTimeoutError,
	judgeCombat,
} from "./interaction/index.ts";
export type {
	CombatDifficulty,
	CombatJudgement,
	CombatJudgementInput,
	CombatOutcome,
	InteractionHandler,
	InteractionRequest,
} from "./interaction/index.ts";

// 提示词分层加载器 + 分层管理 API（「各层读写与覆盖链查询」）
export {
	assertValidRole,
	builtinPromptsDir,
	clearGlobalPromptOverride,
	clearStoryPromptOverride,
	defaultGlobalPromptsDir,
	loadPrompt,
	renderPlaceholders,
	resolvePromptChain,
	setGlobalPromptOverride,
	setStoryPromptOverride,
	type LoadedPrompt,
	type PlaceholderRender,
	type PromptChainInfo,
	type PromptChainLayerInfo,
	type PromptLayer,
	type PromptLayerDirs,
} from "./prompts/loader.ts";

// subagent 运行时（runSubagent 是外部注入桩执行器的入口，属对外能力；
// SubagentOutputTool 是内部输出工具协议，不外承诺）
export {
	runSubagent,
	SubagentOutputError,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
} from "./subagent/runtime.ts";

// pipeline 事件流（承诺面 M2 起；缺口 6 起带 start/end 阶段与消费侧归并）
export {
	createPipelineEventLog,
	summarizePipeline,
	type PipelineEvent,
	type PipelineEventLog,
	type PipelineEventListener,
	type PipelineEventPhase,
	type PipelineStageState,
} from "./pipeline/events.ts";

// 模型配置（读 fail-open / 写 fail-closed；thinking 等级的运行时判据与类型）
export {
	defaultSettingsPath,
	isThinkingLevel,
	loadSettings,
	saveSettings,
	THINKING_LEVELS,
	type ModelRef,
	type TavernModels,
	type TavernSettings,
	type ThinkingLevel,
} from "./settings.ts";

// data subagent 变更集（受信任写入的载荷契约；提交侧 zod/json-schema 属内部）
export {
	applyChangeset,
	filterConflictingItems,
	validateChangesetSemantics,
	type ApplySummary,
	type Changeset,
	type ChangesetProblem,
} from "./pipeline/changeset.ts";

// story 阶段：对外保留场景卡契约、语义校验入口、场景分析入口与确定性兜底卡；
// 其余（子 runner / 提交 schema / 场景卡渲染器 / 阶段配置类型）属内核内部。
export {
	buildFallbackSceneCard,
	runSceneAnalysis,
	validateSceneCard,
	type SceneCard,
} from "./pipeline/story-stage.ts";

// stylize：对外保留零事实漂移抽查（外部 UI 自查用）；阶段 runner 与提交 schema 属内部。
export { stylizeFactCheck } from "./pipeline/stylize-stage.ts";

// 带外顾问（会话式、只读、草稿制、无开关；冒险视图走 user-related 过滤）
export {
	createAssistAdvisor,
	createAssistTools,
	type AssistAdvisor,
	type AssistAdvisorOptions,
	type AssistMode,
	type AssistToolOptions,
} from "./assist.ts";

// StoryRuntime 编排器（API 面）——受信任写入 / 轮中交互 broker / 提示词分层管理 均在此暴露
export {
	computeNextTurnSeq,
	applyModeSwitch,
	computeInputValidityAction,
	createStoryRuntime,
	findUserEntryOnBranch,
	getInteractionBroker,
	InputRejectedError,
	resolveStoryMode,
	assertAgentsShape,
	type NpcStageRuntimeOptions,
	type RuntimePrompts,
	type StoryAgents as RuntimeStoryAgents,
	type StoryRuntime,
	type StoryRuntimeOptions,
	type StoryStageRuntimeOptions,
	type StoryState,
	type StylizeRuntimeOptions,
	type TurnResult,
} from "./pipeline/runtime.ts";

// 卡包系统（世界包：加载 / 匹配注入 / seed / mtime 缓存热更新；M5 定稿）
// KERNEL_TABLE_WHITELIST 的事实源在 db 层，故从 ./db/kernel-tables.ts 导出（见下）。
export { loadPack, loadPacks } from "./pack/loader.ts";
export { PackCache } from "./pack/cache.ts";
export {
	buildCollectionInjection,
	type CollectionInjectionOptions,
	type CollectionInjectionResult,
} from "./pack/matcher.ts";
export { packMigrations } from "./pack/seed.ts";
export {
	PackLoadError,
	ENTRY_ID_RE,
	ENTRY_POSITIONS,
	ENTRY_TYPES,
	PACK_NAME_RE,
	type CollectionEntry,
	type EntryPosition,
	type EntryType,
	type PackIssue,
	type StoryMeta,
	type WorldPack,
} from "./pack/types.ts";

// 故事创建（M5：createStory——卡包校验 → SQL+seed 迁移 → story.yaml 消费 → 开场白首轮 → story.meta.json）
// + story.meta.json 辅助（--resume / 模式解析 / fork 继承共用）+ 故事枚举（listStories：故事选择器）
// + 缺口 7/10：开关与钉的持久化/复原（meta 的读写都归本模块）
export {
	createStory,
	inheritStoryMeta,
	listStories,
	persistAgents,
	persistPacks,
	persistPinned,
	readStoryMeta,
	resolveAgentsFromMeta,
	resolvePackDirsFromMeta,
	writeStoryMeta,
	type CreateStoryOptions,
	type CreateStoryResult,
	type StoryAgentsMeta,
	type StoryMetaFile,
	type StorySummary,
} from "./story.ts";

// 故事会话装配（缺口 8：openStory / rebuildRuntime / forkFrom——引擎装配知识收口，CLI 与 studio 共用）
export {
	forkFrom,
	openStory,
	rebuildRuntime,
	resolveStylizeEnabled,
	// 缺口 7：改开关并生效（校验 + 落盘 + 重建，收敛到一处，调用侧不必自己记得要重建）
	setAgents,
	// 缺口 10 余项：改卡包列表并生效（同一条纪律：加载校验 + 落盘 + 重建）
	setPacks,
	type ForkInfo,
	type OpenedStory,
	type OpenStoryOptions,
	type PackInjection,
	type StoryAgents,
	type StoryAssembly,
} from "./assembly.ts";

// 内核级模式预设（★信任边界：三模式声明式预设——subagent 启用集合 / 切换规则 / 锁定）
export {
	MODE_PRESETS,
	assertCanSwitchMode,
	canSwitchMode,
	isStoryMode,
	validateSubagentSwitches,
	type ModePreset,
	type StoryMode,
	type SubagentSwitchFlags,
} from "./mode.ts";
