// pi 钩子薄适配层（快照恢复挂载点，设计前提 #1/#2）。
// 分工：
//   session_before_tree（支持 cancel）：定位目标 entry 祖先链 + 校验快照存在性，
//     找不到快照 → 空库兜底（仅限无历史的新故事，见下）或判失败。此阶段不 cancel，
//     只做准备与校验，把「待恢复快照」存入带外状态。
//   session_tree（handler 异常会被 pi 吞掉）：执行原子恢复；失败**不能依赖异常传播**，
//     结果显式写入 state.lastRestoreResult，失败时重开旧库回容器（防死句柄楔死），
//     并保持失败标志置位供上层 UI 警示。
//
// 空库兜底（pending.kind === "empty"）会删库重建，故必须重放卡包迁移（getExtraMigrations）——
// 否则包内 `<包名>_*` 表与 seed 行永久缺失。迁移在删库**之前**取：取包失败即中止本次恢复，
// 旧库分毫未动（响亮失败，不静默降级为「只有内核表的故事」）。

import type { ExtensionContext, SessionBeforeTreeEvent, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import type { Migration } from "../db/migrate.ts";
import { openStoryDb, type StoryDb } from "../db/story-db.ts";
import { resetToEmptyStoryDb, restoreSnapshot } from "./restore.ts";
import type { SnapshotsDb } from "./snapshots-db.ts";

/** 带外待恢复状态：一次导航准备阶段的产物。 */
export type PendingRestore =
	| { kind: "snapshot"; dump: Uint8Array; turnSeq: number; sessionEntryId: string }
	| { kind: "empty" }
	/** 判为失败（如祖先链无快照但故事已有历史——外部损伤场景），tree 阶段不触碰库。 */
	| { kind: "failed"; error: string };

export interface SnapshotRestoreResult {
	ok: boolean;
	error?: string;
	restoredTurnSeq?: number;
	restoredEntryId?: string;
}

export interface SnapshotHookState {
	/** 最近一次导航的恢复结果（session_tree 执行后更新）。 */
	lastRestoreResult: SnapshotRestoreResult | undefined;
	/** 空库兜底等 warning 记录（保留最近 WARNINGS_LIMIT 条）。 */
	warnings: string[];
}

const WARNINGS_LIMIT = 50;

export interface SnapshotHooksOptions {
	snapshotsDb: SnapshotsDb;
	/** 当前 story db（恢复后会被替换）。 */
	getStoryDb: () => StoryDb;
	/** 恢复后回写新 StoryDb 实例（恢复 = 重开新实例，见 restore.ts 取舍说明）。 */
	setStoryDb: (storyDb: StoryDb) => void;
	/** 目标 entry 的祖先链（近→远，含自身）；编排层从 pi entries 沿 parentId 构建。 */
	getEntryAncestors: (entryId: string) => string[];
	onWarning?: (message: string) => void;
	/** 恢复执行器（默认 restoreSnapshot / resetToEmptyStoryDb）。测试与编排可注入。 */
	restoreImpl?: (storyDb: StoryDb, pending: PendingRestore) => StoryDb;
	/**
	 * 空库兜底时要重放的额外迁移（卡包 `<包名>_schema` / `<包名>_seed`）。
	 * 空库兜底删掉 story.db，`schema_migrations` 随之消失——不传则包内表与 seed 行永久缺失
	 * （编排层 runtime 从卡包缓存现取；不接卡包的库消费者须自担此缺口）。
	 * 用 getter 而非数组：恢复发生在导航时刻，包可能已被热更新/修复。
	 * 抛错 = 本次恢复判失败，**旧库未被触碰**（取值先于删库）。
	 */
	getExtraMigrations?: () => Migration[];
}

export interface SnapshotHooks {
	state: SnapshotHookState;
	sessionBeforeTree: (event: SessionBeforeTreeEvent, ctx: ExtensionContext) => void;
	sessionTree: (event: SessionTreeEvent, ctx: ExtensionContext) => void;
}

export function createSnapshotHooks(options: SnapshotHooksOptions): SnapshotHooks {
	const state: SnapshotHookState = { lastRestoreResult: undefined, warnings: [] };
	const restoreImpl: (storyDb: StoryDb, pending: PendingRestore) => StoryDb =
		options.restoreImpl ?? ((storyDb, pending) => defaultRestoreImpl(storyDb, pending, options));
	let pending: PendingRestore | undefined;

	function pushWarning(message: string): void {
		state.warnings.push(message);
		if (state.warnings.length > WARNINGS_LIMIT) {
			state.warnings = state.warnings.slice(-WARNINGS_LIMIT);
		}
		options.onWarning?.(message);
	}

	const sessionBeforeTree = (event: SessionBeforeTreeEvent): void => {
		// 入口先清 pending：防本 handler 抛错（被 pi 吞掉）后 session_tree 消费上一次遗留的
		// stale pending（双故障窗口）。
		pending = undefined;

		const targetId = event.preparation.targetId;
		const ancestors = options.getEntryAncestors(targetId);
		const nearest = options.snapshotsDb.findNearestSnapshot(ancestors);
		if (nearest) {
			pending = {
				kind: "snapshot",
				dump: nearest.dump,
				turnSeq: nearest.turn_seq,
				sessionEntryId: nearest.session_entry_id,
			};
			return;
		}

		// 祖先链无快照。区分三种语义（M1-P2 gate m3 + M2 修订）：
		// - 快照库非空但本链无快照（如导航到首个 user 条目 u1，链上只有 [u1, root]）：
		//   正常「重做开头」语义——空库兜底 = 故事初始态（reconciliation 裁决）；
		// - 故事已有历史（turn_log 非空）且 snapshots.db 全空：再分两种——
		//   · data_status 存在 status=ok 的轮（有成功落库轮却无任何快照）= 外部损伤，拒绝静默擦空库；
		//   · data_status 全 failed/空（M2 合法态：data 失败轮不拍快照）= 放行空库兜底。
		const turnLogCount = options.getStoryDb().reader.getTurnLog().length;
		const snapshotCount = options.snapshotsDb.listSnapshots().length;
		if (turnLogCount > 0 && snapshotCount === 0) {
			const dataStatus = options.getStoryDb().reader.listDataStatus();
			const hasOkTurn = dataStatus.some((r) => r.status === "ok");
			if (hasOkTurn) {
				const message = `祖先链无快照但 turn_log 非空且 snapshots.db 为空（turn_log ${turnLogCount} 轮，data_status 存在 ok 轮）——疑似外部损伤，拒绝空库兜底，保持当前库不动`;
				pending = { kind: "failed", error: message };
				pushWarning(message);
				return;
			}
			// 全 failed/无 data 记录：M2 合法态（data 失败轮不拍快照），落到空库兜底。
		}
		pending = { kind: "empty" };
		const failedPending = options.getStoryDb().reader.listDataStatus().filter((r) => r.status === "failed").length;
		const message =
			failedPending > 0
				? `未找到 entry ${targetId} 祖先链上的快照，本次导航恢复走空库兜底（data_status 有 ${failedPending} 轮 failed，属合法态）`
				: `未找到 entry ${targetId} 祖先链上的快照，本次导航恢复走空库兜底`;
		pushWarning(message);
	};

	const sessionTree = (): void => {
		const currentPending = pending;
		pending = undefined; // 一次性消费
		if (!currentPending) {
			state.lastRestoreResult = {
				ok: false,
				error: "session_tree 触发时无待恢复快照（session_before_tree 未先执行、抛错或已消费）",
			};
			return;
		}
		if (currentPending.kind === "failed") {
			// 判失败的 pending：不触碰库，只记录
			state.lastRestoreResult = { ok: false, error: currentPending.error };
			return;
		}
		try {
			const current = options.getStoryDb();
			const restored = restoreImpl(current, currentPending);
			options.setStoryDb(restored);
			state.lastRestoreResult =
				currentPending.kind === "snapshot"
					? {
							ok: true,
							restoredTurnSeq: currentPending.turnSeq,
							restoredEntryId: currentPending.sessionEntryId,
						}
					: { ok: true };
		} catch (error) {
			// 为什么 try/catch 内自吞并落状态：session_tree handler 异常会被 pi 的 emit()
			// 吞掉（实证），异常传播不可靠。恢复失败必须显式写入
			// lastRestoreResult 供上层 UI 警示；rename 前旧库文件未被触碰。
			const message = error instanceof Error ? error.message : String(error);
			state.lastRestoreResult = { ok: false, error: message };
			// 死句柄回退（M1 条件项）：restoreSnapshot / resetToEmptyStoryDb 消费（关闭）了传入句柄
			// ——失败后必须用 openStoryDb 重开旧库并回容器，否则 reader/writer 再调即抛
			// database is not open，系统楔死。重开若也失败，错误并入 lastRestoreResult。
			// 但「失败」未必意味着句柄已死：getExtraMigrations 取包失败发生在删库之前，句柄仍可用
			// （见 defaultRestoreImpl）——此时据实留用，不另开一条连接。
			try {
				const current = options.getStoryDb();
				if (!isStoryDbOpen(current)) {
					const revived = openStoryDb(current.path);
					options.setStoryDb(revived);
				}
			} catch (reviveError) {
				const reviveMessage = reviveError instanceof Error ? reviveError.message : String(reviveError);
				state.lastRestoreResult = { ok: false, error: `${message}；且重开旧库失败: ${reviveMessage}` };
			}
		}
	};

	return { state, sessionBeforeTree, sessionTree };
}

/** 句柄是否仍可用（轻探一条语句）。恢复执行器有「消费传入句柄」的契约，但前置步骤失败时
 *  （如 getExtraMigrations 取包失败）句柄分毫未动——据此避免多开一条无用连接。 */
function isStoryDbOpen(storyDb: StoryDb): boolean {
	try {
		storyDb.rawDb.prepare("SELECT 1").get();
		return true;
	} catch {
		return false;
	}
}

function defaultRestoreImpl(storyDb: StoryDb, pending: PendingRestore, options: SnapshotHooksOptions): StoryDb {
	if (pending.kind === "snapshot") {
		return restoreSnapshot(storyDb, pending.dump);
	}
	// 顺序要紧：先取卡包迁移（可能抛）再进 resetToEmptyStoryDb（第一步就删库）。
	// 反过来的话，取包失败时库已被删——「响亮失败」就成了「响亮地丢数据」。
	const extraMigrations = options.getExtraMigrations?.() ?? [];
	return resetToEmptyStoryDb(storyDb, extraMigrations);
}
