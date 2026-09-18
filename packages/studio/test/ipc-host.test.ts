// IPC 通道（main 侧）适配器单测：注册完整性、失败原子性、异常透传、推送。
// 不依赖 electron —— createIpcHost 只吃 IpcLike 窄接口（真实 electron 在 S0 收尾接线时注入）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createIpcHost, CHANNEL_NAMES, type HostHandlers } from "../src/main/transport-ipc.ts";
import type { IpcLike } from "../src/contract/index.ts";
import { createDevTransport } from "../src/dev/transport-ws.ts";

/** 假 IpcLike：记录注册表与推送。 */
function fakeIpc(): { ipc: IpcLike; handlers: Map<string, (p: unknown) => Promise<unknown>>; sent: Array<[string, unknown]> } {
	const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
	const sent: Array<[string, unknown]> = [];
	return {
		handlers,
		sent,
		ipc: {
			handle: (channel, handler) => {
				if (handlers.has(channel)) throw new Error(`重复注册 channel: ${channel}`);
				handlers.set(channel, handler);
			},
			send: (channel, payload) => void sent.push([channel, payload]),
		},
	};
}

/** 全 channel 桩处理器：把入参原样回传，便于断言搬运不改写。 */
function stubHandlers(): HostHandlers {
	const handlers = {} as Record<string, (p: unknown) => Promise<unknown>>;
	for (const name of CHANNEL_NAMES) {
		handlers[name] = async (payload) => payload;
	}
	return handlers as unknown as HostHandlers;
}

test("契约清单非空且 createIpcHost 注册了全部 channel", () => {
	assert.ok(CHANNEL_NAMES.length >= 8, "契约清单不该是空的");
	const { ipc, handlers } = fakeIpc();
	const host = createIpcHost(ipc, stubHandlers());
	assert.equal(handlers.size, CHANNEL_NAMES.length, "每个 channel 都要真的注册到 IPC 上");
	assert.deepEqual([...host.channels], [...CHANNEL_NAMES]);
	assert.ok(host.channels.includes("turn:run"));
	assert.ok(host.channels.includes("turn:abort"), "中止（缺口 1）必须在契约面上");
});

test("缺处理器 → 启动即抛错，且一个 channel 都不注册（不留半挂通道）", () => {
	const { ipc, handlers } = fakeIpc();
	const partial = stubHandlers() as unknown as Record<string, unknown>;
	delete partial["turn:abort"];
	assert.throws(() => createIpcHost(ipc, partial as unknown as HostHandlers), /未接处理器.*turn:abort/s);
	assert.equal(handlers.size, 0, "校验失败必须在注册之前——否则会留下半挂的通道");
});

test("请求走处理器原样往返；处理器抛错原样透传（不包装成看不懂的错）", async () => {
	const { ipc, handlers } = fakeIpc();
	const handlersMap = stubHandlers() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
	handlersMap["turn:run"] = async (payload) => {
		const p = payload as { input: string };
		if (p.input === "boom") throw new Error("主叙事已连续 1 次未产出正文");
		return { turnSeq: 7, echo: p.input };
	};
	createIpcHost(ipc, handlersMap as unknown as HostHandlers);

	const turnRun = handlers.get("turn:run")!;
	assert.deepEqual(await turnRun({ turnId: "t1", input: "我推门而入。" }), { turnSeq: 7, echo: "我推门而入。" });
	await assert.rejects(turnRun({ turnId: "t2", input: "boom" }), (err: unknown) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /未产出正文/);
		return true;
	});
});

test("push 打到 IpcLike.send，channel 与载荷不被改写", () => {
	const { ipc, sent } = fakeIpc();
	const host = createIpcHost(ipc, stubHandlers());
	host.push("turn:delta", { turnId: "t1", text: "夜幕低垂" });
	host.push("warning", { message: "data 落库已连续失败 3 轮" });
	assert.deepEqual(sent, [
		["turn:delta", { turnId: "t1", text: "夜幕低垂" }],
		["warning", { message: "data 落库已连续失败 3 轮" }],
	]);
});

test("开发通道是刻意未接线的壳：大声抛错，不静默假装可用", async () => {
	const dev = createDevTransport("http://127.0.0.1:5173");
	await assert.rejects(dev.request("story:list", {}), /尚未接线/);
	assert.throws(() => dev.subscribe("turn:delta", () => undefined), /尚未接线/);
});
