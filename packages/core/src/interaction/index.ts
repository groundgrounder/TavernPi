// 轮中交互通道模块导出。

export {
	InteractionBroker,
	InteractionUnavailableError,
	InteractionValidationError,
	InteractionTimeoutError,
} from "./broker.ts";
export type { InteractionHandler, InteractionRequest } from "./broker.ts";
export { judgeCombat } from "./combat.ts";
export type {
	CombatDifficulty,
	CombatJudgement,
	CombatJudgementInput,
	CombatOutcome,
} from "./combat.ts";
