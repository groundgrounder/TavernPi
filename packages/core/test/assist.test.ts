// 带外顾问 assist 单测：工具集按模式装配（冒险无 list_directives、视图过滤——无关 NPC get_npc 不可）、
// rebuild 后历史清零（sessionFactory 计数断言新建）、提示词角色名按模式解析、工具白名单无写工具、越集 get_npc 不可见。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import { createDbView } from "../src/db/view.ts";
import { createAssistAdvisor, createAssistTools } from "../src/assist.ts";
import { loadPrompt } from "../src/prompts/loader.ts";
import type { StoryMode } from "../src/mode.ts";

/** seed：王城（player 在此）、市集（远郊 NPC）。同城 NPC 相关、市集 NPC 不相关。 */
function seedAdventureStory(story: StoryDb): { relatedId: number; unrelatedId: number; wangChengId: number; marketId: number } {
	const wangCheng = story.writer.insertLocation({ name: "王城" });
	const market = story.writer.insertLocation({ name: "市集" });
	story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: wangCheng.id });
	const related = story.writer.insertNpc({ name: "同城者" });
	story.writer.moveSubject({ turnSeq: 2, subject: `npc:${related.id}`, toLocationId: wangCheng.id });
	story.writer.insertNpcMemory({ npcId: related.id, turnSeq: 2, kind: "观察", content: "同城者的私密记忆", salience: 0.9 });
	const unrelated = story.writer.insertNpc({ name: "远郊者" });
	story.writer.moveSubject({ turnSeq: 3, subject: `npc:${unrelated.id}`, toLocationId: market.id });
	story.writer.insertNpcMemory({ npcId: unrelated.id, turnSeq: 3, kind: "秘密", content: "远郊者的绝密信息", salience: 0.9 });
	return { relatedId: related.id, unrelatedId: unrelated.id, wangChengId: wangCheng.id, marketId: market.id };
}

async function getToolText(tool: ToolDefinition, args: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("t1", args as never, undefined, undefined, {} as never);
	return result.content
		.map((c) => (typeof c === "string" ? c : ((c as { text?: string }).text ?? "")))
		.filter((c) => c !== "")
		.join("\n");
}

test("createAssistTools：冒险模式无 list_directives 且视图过滤相关/无关 NPC（get_npc 不可见）", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const ids = seedAdventureStory(story);
		const adventureView = createDbView(story.reader, "user-related");
		const tools = createAssistTools(() => adventureView, { allowDirectives: false });
		assert.ok(!tools.some((t) => t.name === "list_directives"), "冒险模式无 list_directives（directives 是作者意图）");
		// list_npcs 只返回相关 NPC
		const listTool = tools.find((t) => t.name === "list_npcs")!;
		const listText = await getToolText(listTool, {});
		assert.ok(listText.includes("同城者"), "list_npcs 含相关 NPC");
		assert.ok(!listText.includes("远郊者"), "list_npcs 不含无关 NPC（冒险视图过滤生效）");
		// 无关 NPC get_npc → 不可见（不抛错）
		const getNpcTool = tools.find((t) => t.name === "get_npc")!;
		const hiddenText = await getToolText(getNpcTool, { npc_id: ids.unrelatedId });
		assert.ok(hiddenText.includes("不可见"), `无关 NPC get_npc 返回不可见: ${hiddenText}`);
		// 相关 NPC get_npc → 可见
		const visibleText = await getToolText(getNpcTool, { npc_id: ids.relatedId });
		assert.ok(visibleText.includes("同城者") && visibleText.includes("同城者的私密记忆"), "相关 NPC get_npc 可见");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("assist 跨轮新鲜视图：相关 NPC 离场后不可见；新 NPC 到场后可见（view 工厂现建）", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const ids = seedAdventureStory(story);
		// view 工厂每次现建 createDbView（对应 assist 跨轮存续会话的工具行为）
		const viewFactory = () => createDbView(story.reader, "user-related");
		const tools = createAssistTools(viewFactory, { allowDirectives: false });
		const getNpcTool = tools.find((t) => t.name === "get_npc")!;
		// 初始：同城者可见、远郊者不可见
		assert.ok((await getToolText(getNpcTool, { npc_id: ids.relatedId })).includes("同城者"), "初始同城者可见");
		assert.ok((await getToolText(getNpcTool, { npc_id: ids.unrelatedId })).includes("不可见"), "初始远郊者不可见");
		// 同城者移出玩家地点（市集）→ 跨轮会话中不可见（若视图冻结则仍可见）
		story.writer.moveSubject({ turnSeq: 10, subject: `npc:${ids.relatedId}`, toLocationId: ids.marketId });
		assert.ok((await getToolText(getNpcTool, { npc_id: ids.relatedId })).includes("不可见"), "同城者离场后 get_npc 不可见（跨轮新鲜）");
		// 远郊者移到玩家地点（王城）→ 变为可见
		story.writer.moveSubject({ turnSeq: 11, subject: `npc:${ids.unrelatedId}`, toLocationId: ids.wangChengId });
		assert.ok((await getToolText(getNpcTool, { npc_id: ids.unrelatedId })).includes("远郊者"), "远郊者到场后可见（跨轮新鲜）");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("createAssistTools：创造/生存模式有 list_directives（作者顾问要看大纲意图）", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		seedAdventureStory(story);
		story.writer.insertDirective({ turnSeq: 1, content: "主角必须在黎明前离开王城", status: "active" });
		const noneView = createDbView(story.reader, "none");
		const tools = createAssistTools(() => noneView, { allowDirectives: true });
		assert.ok(tools.some((t) => t.name === "list_directives"), "创造/生存模式有 list_directives");
		const dTool = tools.find((t) => t.name === "list_directives")!;
		const text = await getToolText(dTool, {});
		assert.ok(text.includes("主角必须在黎明前离开王城"), "list_directives 返回 active 大纲指令");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("assist 工具集：只读——无写工具（写/推进/移动/插入/更新名）", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const view = createDbView(story.reader, "none");
		const tools = createAssistTools(() => view, { allowDirectives: true });
		assert.ok(tools.length > 0);
		assert.ok(
			!tools.some((t) => /write|advance|move|insert|update/i.test(t.name)),
			"assist 工具白名单无写工具（只读契约）",
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// AssistAdvisor：rebuild 后历史清零（sessionFactory 计数断言新建）+ 提示词角色名按模式解析
// ---------------------------------------------------------------------------

interface StubSession {
	session: AgentSession;
}

function makeStubSessionFactory(counter: { n: number }): (o: CreateAgentSessionOptions) => Promise<StubSession> {
	return async (o) => {
		counter.n++;
		const messages: Array<{ role: string; content: unknown }> = [];
		const session = {
			isStreaming: false,
			state: { messages },
			async prompt(message: string): Promise<void> {
				messages.push({ role: "user", content: [{ type: "text", text: message }] });
				messages.push({ role: "assistant", content: [{ type: "text", text: `assist 桩建议（会话#${counter.n}）：${message}` }] });
			},
			dispose(): void {},
			getActiveToolNames(): string[] {
				return o.tools ?? [];
			},
		} as unknown as AgentSession;
		return { session };
	};
}

test("AssistAdvisor：chat 跨轮存续；rebuild 后历史清零（sessionFactory 计数断言新建）", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const counter = { n: 0 };
		const advisor = createAssistAdvisor({
			storyDb: story,
			mode: "creation",
			cwd: dir,
			sessionFactory: makeStubSessionFactory(counter),
		});
		try {
			// 首次 chat → 创建会话（count=1）
			const r1 = await advisor.chat("第一轮咨询");
			assert.equal(counter.n, 1, "首次 chat 创建会话");
			assert.ok(r1.includes("会话#1"), "会话#1 响应");
			// 同会话续聊 → 不新建（count 仍 1）
			const r2 = await advisor.chat("第二轮追问");
			assert.equal(counter.n, 1, "续聊不新建会话（跨轮存续）");
			assert.ok(r2.includes("会话#1"), "仍为会话#1");
			// rebuild → 丢弃会话；再 chat → 新建（count=2，历史清零）
			await advisor.rebuild();
			const r3 = await advisor.chat("重建后咨询");
			assert.equal(counter.n, 2, "rebuild 后 chat 新建会话");
			assert.ok(r3.includes("会话#2"), "会话#2 响应（旧历史清零）");
		} finally {
			advisor.dispose();
			story.close();
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("AssistAdvisor：dispose 级联——dispose 掉 inMemory 会话资源", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const disposed: number[] = [];
		let n = 0;
		const sessionFactory = async (o: CreateAgentSessionOptions) => {
			n++;
			const tag = n;
			const messages: Array<{ role: string; content: unknown }> = [];
			return {
				session: {
					isStreaming: false,
					state: { messages },
					async prompt(message: string): Promise<void> {
						messages.push({ role: "user", content: [{ type: "text", text: message }] });
						messages.push({ role: "assistant", content: [{ type: "text", text: `桩#${tag}` }] });
					},
					dispose(): void {
						disposed.push(tag);
					},
					getActiveToolNames(): string[] {
						return o.tools ?? [];
					},
				} as unknown as AgentSession,
			};
		};
		const advisor = createAssistAdvisor({ storyDb: story, mode: "creation", cwd: dir, sessionFactory });
		try {
			await advisor.chat("x"); // 会话#1
			assert.equal(n, 1);
			advisor.dispose(); // 级联 dispose 会话#1
			assert.equal(disposed.length, 1);
			assert.equal(disposed[0], 1, "dispose 掉会话#1");
			// dispose 后再 chat → 新建会话#2
			await advisor.chat("y");
			assert.equal(n, 2);
		} finally {
			advisor.dispose();
			story.close();
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("assist 提示词角色名按模式解析（creation/survival/adventure 均可加载）", async () => {
	const roles: Array<[StoryMode, string]> = [
		["creation", "作者顾问"],
		["survival", "玩家副驾"],
		["adventure", "信息边界"],
	];
	for (const [mode, needle] of roles) {
		const loaded = loadPrompt(`assist_${mode}`);
		assert.ok(loaded.content.trim().length > 0, `assist_${mode} 提示词非空`);
		assert.ok(loaded.content.includes(needle), `assist_${mode} 含模式特征「${needle}」`);
	}
});
