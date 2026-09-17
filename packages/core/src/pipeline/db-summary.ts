// DB 摘要渲染（读取渲染由 harness 负责）：把故事 DB 的权威事实渲染成紧凑确定性文本，
// 供 before_agent_start 注入主叙事系统提示（{{db_summary}}）与 data subagent 的 userPrompt。
//
// 内容：当前故事时间、玩家位置与「焦点切片」（路径 + 同层 + 下级——按地理层级组织，
// agent 按叙事粒度选择地图层级）、NPC 表（位置走路径 + 特征前 5 + salience 最高 3 条记忆）、
// 近期事件 N 条、world_state（排除 player_location 保留键）、active phase。
// 地点渲染统一走 db/location-path.ts（路径/切片的唯一实现；此前本模块与 tools.ts 各复制一份）。

import type { StoryDb } from "../db/story-db.ts";
import {
	buildLocationPath,
	describeSpatialRelation,
	renderLocationOverview,
	renderLocationPath,
	renderLocationSlice,
} from "../db/location-path.ts";
import { memoryTimeLabel } from "../db/time-fuzzy.ts";
import { PLAYER_LOCATION_KEY, renderMemoryText } from "../db/types.ts";
import { PLAYER_NPC_ID_KEY } from "../db/view.ts";

/** 渲染故事 DB 权威摘要。recentEvents 控制近期事件条数（默认 10）。 */
export function renderDbSummary(storyDb: StoryDb, opts: { recentEvents?: number } = {}): string {
	const reader = storyDb.reader;
	const recentEvents = opts.recentEvents ?? 10;
	const lines: string[] = [];

	const clock = reader.getClock();
	lines.push(
		`当前故事时间: ${clock ? `${clock.current_time}（历法 ${clock.calendar}，粒度 ${clock.granularity}）` : "(未初始化)"}`,
	);

	// 地点：焦点切片（焦点 = 玩家位置）——路径 + 同层邻居 + 下一层。
	// 叙事焦点在哪一层，地图就取哪一层（agent 按叙事粒度选择地图层级）。
	const locations = reader.listLocations();
	const playerPath = reader.getPlayerLocationPath();
	if (playerPath !== undefined) {
		const focusId = playerPath[playerPath.length - 1]!.id;
		lines.push(...renderLocationSlice(locations, focusId, { mark: "← 你在这里", pathLabel: "玩家位置" }));
	} else {
		lines.push("玩家位置: (玩家尚未定位)");
		const overview = renderLocationOverview(locations);
		if (overview.length > 0) {
			lines.push("世界地图:", ...overview);
		}
	}

	const npcs = reader.listNpcs();
	if (npcs.length > 0) {
		// 玩家锚定行（player_npc_id 指向的 npcs 行）就是玩家角色本身，不给「与你…」关系描述。
		const playerAnchor = reader.listWorldState().find((w) => w.key === PLAYER_NPC_ID_KEY);
		const playerNpcId =
			playerAnchor !== undefined && /^\d+$/.test(playerAnchor.value) ? Number(playerAnchor.value) : null;
		// 记忆时间精度衰减的「当前」基准 = 最新已记录轮（readonly；span_days 累加见 reader.memoryTimeView）
		const currentTurn = reader.latestTurnSeq();

		lines.push("NPC:");
		for (const npc of npcs) {
			const composite = reader.getNpc(npc.id);
			const traitsText = composite.traits.slice(0, 5).map((t) => `${t.trait}=${t.weight}`).join(", ") || "(无)";
			const memoriesText =
				composite.memories
					.slice(0, 3)
					.map((m) => {
						const timeView = reader.memoryTimeView(m, currentTurn);
						return renderMemoryText(m, timeView === undefined ? undefined : memoryTimeLabel(m, timeView));
					})
					.join("；") || "(无)";
			const npcPath = npc.current_location === null ? undefined : buildLocationPath(locations, npc.current_location);
			let locText = "位置 (未定位)";
			if (npcPath !== undefined) {
				locText = `位置 ${renderLocationPath(npcPath)}`;
				// 相对玩家的空间关系：层级判据（LCA）给「同在「X」/不同地图」；坐标可算时补「相距约 N 步 · X 方」。
				// 嵌套上下位（npc 位置是玩家路径的前缀，或反之）本身在路径里已表达，不重复「同在」；
				// 但距离方位是路径答不了的，照给。
				if (playerPath !== undefined && npc.id !== playerNpcId) {
					const relation = describeSpatialRelation(playerPath, npcPath);
					const parts: string[] = [];
					if (relation.kind === "same" || relation.kind === "cousin" || relation.kind === "unrelated") {
						parts.push(relation.text);
					}
					if (relation.distance !== null) {
						parts.push(`相距约 ${relation.distance.steps} 步 · ${relation.distance.bearing}方`);
					}
					if (parts.length > 0) locText += `（与你${parts.join("，")}）`;
				}
			}
			lines.push(`#${npc.id} ${npc.name}（status: ${npc.status}，${locText}）`);
			lines.push(`  特征[${traitsText}]`);
			lines.push(`  记忆[${memoriesText}]`);
		}
	}

	const events = reader.listEvents();
	if (events.length > 0) {
		lines.push(`近期事件（最近 ${recentEvents} 条）:`);
		for (const e of events.slice(-recentEvents)) {
			// 事件与时间耦合：有 story_time 则显式给出（主叙事的时间线锚点）
			const timeTag = e.story_time !== null && e.story_time.trim() !== "" ? `[${e.story_time}] ` : "";
			lines.push(`- ${timeTag}turn${e.turn_seq} ${e.summary}`);
		}
	}

	// 排除内核保留键 player_location：玩家位置已单独呈现，重复呈现会让模型误以为
	// 可写 world_state.player_location（实际只能经 location_moves，见 changeset 校验）。
	const worldState = reader.listWorldState().filter((w) => w.key !== PLAYER_LOCATION_KEY);
	if (worldState.length > 0) {
		lines.push("世界状态:");
		for (const w of worldState) {
			lines.push(`- ${w.key} = ${w.value}`);
		}
	}

	const activePhases = reader.listPhases().filter((p) => p.ended_turn === null);
	if (activePhases.length > 0) {
		lines.push("当前阶段:");
		for (const p of activePhases) {
			lines.push(`- ${p.name}${p.goals ? `：${p.goals}` : ""}`);
		}
	}

	return lines.join("\n");
}
