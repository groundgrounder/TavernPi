// 代码包 fixture（M6-P4a 卡包代码挂载）：主叙事 session 挂载本 extension → 注册 roll_check 工具。
// 只读工具，不写库（§6.0 禁的是 DB 工具）；经 additionalExtensionPaths 委托 pi loader 加载（jiti import）。
// 工具在 M6-P4a 验收只断言「注册与白名单正确」，不硬断言真实模型是否调用。

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function createExtension(api: ExtensionAPI): void {
	api.registerTool(
		defineTool({
			name: "roll_check",
			label: "检定",
			description: "执行一次 d20 检定（只读，不写库）。供主叙事在关键时刻做判定参考。",
			parameters: Type.Object(
				{ attribute: Type.String({ description: "检定的属性/技能名（如 敏捷/洞察）" }) },
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params) => {
				const roll = Math.floor(Math.random() * 20) + 1;
				return {
					content: [{ type: "text", text: `d20 检定（${params.attribute}）：${roll}` }],
					details: { attribute: params.attribute, roll },
				};
			},
		}),
	);
}
