// pipeline 事件流骨架（各 subagent 的输入/输出/耗时/成本观测；M2 起承诺面）。
// 事件是结构化留痕（独立于叙事文本）：每行一个 JSON 对象（JSONL），
// record 同步 appendFileSync + 同步通知 listeners。
//
// 容错纪律：
// - listener 抛错：捕获并忽略（不炸 pipeline）。
// - 文件写失败：不抛；仅首次告警去重（避免吞掉静默埋雷，又不打断 pipeline）。
//   告警走 onWarning（缺省 console.warn）——记录发生在轮中，裸写 stderr 会撕裂 CLI 活动行。
// - inputChars/outputChars 只记规模不记全文，控制日志体积。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SubagentUsage } from "../subagent/runtime.ts";
import { emitWarning, type WarnSink } from "../warn.ts";

/**
 * 事件阶段（缺口 6）。原事件只有「结束」一种——都是阶段跑完才 record，于是 studio 无法回答
 * 「现在跑到哪了」：一轮最长可到 200 秒、跨 6 个阶段，这段时间界面只能干等或猜。
 *
 * - `start`：阶段开始，只有 ts/turnSeq/role（**没有** ok/durationMs——那时还不知道成败）。
 * - `end`：阶段结束，字段与历史事件完全一致（`phase` 由 `end` 缺省填充，见 PipelineEvent）。
 *
 * 成对由 `stage()` 保证：正常返回、抛错、中止三条路径都会落 `end`，故调用侧永远能靠
 * 「start 之后必有 end」算出运行态。**不要求**消费者自己去配对——见 `summarizePipeline`。
 */
export type PipelineEventPhase = "start" | "end";

export interface PipelineEvent {
	/** ISO 时间戳。 */
	ts: string;
	/** 归属轮次；带外角色（assist*）无轮次归属，用 -1 哨兵。 */
	turnSeq: number;
	/** 角色标识（narrator/data/…）。 */
	role: string;
	/**
	 * 阶段（缺口 6）。**历史事件没有这个字段**——读旧 JSONL 时按 `end` 处理（`phase ?? "end"`），
	 * 故向后兼容，不需要迁移旧日志。
	 */
	phase?: PipelineEventPhase;
	/** 结束事件才有：本阶段是否成功。start 事件不写（那时还不知道）。 */
	ok?: boolean;
	durationMs?: number;
	/** 重试序号（1 基）。 */
	attempt?: number;
	usage?: SubagentUsage;
	/** 输入规模观测（不记全文）。 */
	inputChars?: number;
	outputChars?: number;
	error?: string;
}

export type PipelineEventListener = (e: PipelineEvent) => void;

export interface PipelineEventLog {
	record(e: PipelineEvent): void;
	/**
	 * 跑一个阶段并落成对事件（缺口 6）：先 `phase:"start"`，再在 fn 返回/抛出时落
	 * `phase:"end"`（带 ok 与 durationMs）。
	 *
	 * **成功与失败走同一个出口**——`end` 在 `finally` 里落，抛错原样透传。故消费者只需
	 * 「start 之后必有 end」，不必自己处理「抛了就永远等不到结束」的情形。
	 *
	 * `endFields` 是**函数**不是对象：调用侧要在阶段跑完才知道耗时/用量/输出规模，
	 * 传对象就得先跑再拼，等于把 start 也推迟到跑完——那就退回缺口 6 的老样子了。
	 */
	stage<T>(
		role: string,
		turnSeq: number,
		fn: () => Promise<T> | T,
		endFields?: (result: T | undefined, error: unknown) => Partial<PipelineEvent>,
	): Promise<T>;
	/** 订阅；返回退订函数。 */
	on(l: PipelineEventListener): () => void;
	/** JSONL 文件路径（未提供时为纯内存模式）。 */
	readonly filePath?: string;
}

/**
 * @param filePath JSONL 落盘路径；缺省 = 纯内存模式（不写文件、不会触发写失败告警）。
 * @param onWarning 写失败告警出口（缺省 console.warn；CLI 传入以收口到活动行）。
 */
export function createPipelineEventLog(filePath?: string, onWarning?: WarnSink): PipelineEventLog {
	const listeners = new Set<PipelineEventListener>();
	let warnedWriteError = false;
	const log: PipelineEventLog = {
		filePath,
		record(e: PipelineEvent): void {
			if (filePath !== undefined) {
				try {
					mkdirSync(dirname(filePath), { recursive: true });
					appendFileSync(filePath, `${JSON.stringify(e)}\n`);
				} catch (err) {
					// 写失败吞掉但首次告警（去重），不抛——事件流是观测设施，不能炸 pipeline。
					if (!warnedWriteError) {
						warnedWriteError = true;
						emitWarning(
							onWarning,
							`[pipeline-events] 写入事件日志失败（仅首次告警）: ${filePath}: ${(err as Error).message}`,
						);
					}
				}
			}
			for (const listener of listeners) {
				try {
					listener(e);
				} catch {
					// listener 抛错捕获并忽略——通知是尽力而为。
				}
			}
		},
		async stage<T>(
			role: string,
			turnSeq: number,
			fn: () => Promise<T> | T,
			endFields?: (result: T | undefined, error: unknown) => Partial<PipelineEvent>,
		): Promise<T> {
			const startedAt = Date.now();
			log.record({ ts: new Date(startedAt).toISOString(), turnSeq, role, phase: "start" });
			let result: T | undefined;
			let error: unknown;
			try {
				result = await fn();
				return result;
			} catch (err) {
				error = err;
			} finally {
				// end 在 finally 里落：成功 / 抛错 / 中止三条路径都会留下结束事件。
				// 若让调用侧各自记得 record，迟早漏掉某条路径——那条路径上的阶段就永远「在跑」。
				//
				// endFields 与 record 都包在 try 里：**观测设施不得成为故障源**。
				// 若 endFields 抛错穿透 finally，它会顶掉 fn 的真实结果/异常（成功变失败，或
				// 原始错误被换成 endFields 的错误）——那等于观测代码改写了被观测行为。
				let extra: Partial<PipelineEvent> = {};
				try {
					extra = endFields?.(result, error) ?? {};
				} catch {
					// endFields 抛错只作废它自己提供的字段，end 仍落在下面（ok/durationMs 不受影响）。
				}
				try {
					log.record({
						ts: new Date().toISOString(),
						turnSeq,
						role,
						phase: "end",
						ok: error === undefined,
						durationMs: Date.now() - startedAt,
						...(error !== undefined
							? { error: error instanceof Error ? error.message : String(error) }
							: {}),
						...extra,
					});
				} catch {
					// record 自身已容错（写失败告警去重、listener 抛错忽略），理论上到不了这里。
					// 留着是纵深防御：finally 里再抛会整个顶掉 fn 的结果。
				}
			}
			throw error;
		},
		on(listener: PipelineEventListener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return log;
}

/** 某角色在某轮次的运行态（缺口 6 的消费侧表示）。 */
export interface PipelineStageState {
	role: string;
	turnSeq: number;
	/** `running` = 见过 start 没见过对应 end（studio 据此显示「进行中」）。 */
	status: "running" | "done";
	/** running 时是 start 的时刻；done 时是 end 的时刻。 */
	startedAt: string;
	/** 已跑时长（running：至今；done：本阶段耗时）。 */
	elapsedMs: number;
	/** done 才有：成败。 */
	ok?: boolean;
	error?: string;
}

/**
 * 从事件流算出**当前运行态**（缺口 6 的消费侧）：按 role 归并 start/end，输出「谁在跑、跑了多久」。
 *
 * 配对规则：同 role 的 start 之后遇到 end 即算完成（后一个 start 会覆盖前一个未闭合的——
 * 重试场景下前一次 start 可能没有 end，例如进程被杀；宁可显示最新的那次，也不要卡在陈旧的 start）。
 * 历史事件（无 phase）按 end 处理，故旧日志不会凭空冒出「运行中」。
 *
 * 纯函数，不读盘：调用侧把 `events` 传进来（CLI 可传内存事件，studio 可传读出的 JSONL）。
 */
export function summarizePipeline(events: readonly PipelineEvent[]): PipelineStageState[] {
	const byRole = new Map<string, PipelineStageState>();
	const now = Date.now();
	for (const e of events) {
		const phase = e.phase ?? "end";
		if (phase === "start") {
			byRole.set(e.role, {
				role: e.role,
				turnSeq: e.turnSeq,
				status: "running",
				startedAt: e.ts,
				elapsedMs: now - Date.parse(e.ts),
			});
			continue;
		}
		const prev = byRole.get(e.role);
		// 只闭合「同一轮次」的 start：上一轮的遗留 start 不该被本轮的 end 收掉（否则会谎报完成）。
		if (prev !== undefined && prev.status === "running" && prev.turnSeq === e.turnSeq) {
			byRole.set(e.role, {
				...prev,
				status: "done",
				startedAt: e.ts,
				elapsedMs: e.durationMs ?? Date.now() - Date.parse(prev.startedAt),
				ok: e.ok ?? true,
				...(e.error !== undefined ? { error: e.error } : {}),
			});
		}
	}
	return [...byRole.values()];
}

