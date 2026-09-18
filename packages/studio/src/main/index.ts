// studio 主进程入口：开窗口 → 把契约 channel 注册到 IPC → 加载渲染进程。
//
// 主进程是**唯一的内核宿主**（同进程嵌入，不走 RPC）：内核实例、故事库、快照全在这里，
// 渲染进程只看得到 contract 里那几个 channel。
//
// 启动：
//   npm --workspace @tavernpi/studio run start
// 验收（S0 收尾：空壳里真跑「列故事 → 新建 → 发一轮」，并独立核对盘上 story.db）：
//   npm --workspace @tavernpi/studio run accept:s0
//
// 环境提醒：本机默认导出 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node（窗口起不来、
// --version 打印 Node 版本）。npm 脚本已带 `env -u`，手工敲命令时记得去掉该变量。

import { join } from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";
import { createIpcHost, type IpcHost } from "./transport-ipc.ts";
import type { IpcLike } from "../contract/index.ts";
import { buildHostHandlers } from "./handlers.ts";
import { StudioSession } from "./session.ts";
import { parseS0Args, runS0Acceptance } from "./s0-acceptance.ts";

/** Electron 的 ipcMain/webContents 投影成 IpcLike（契约只依赖这个窄接口，故可脱 electron 单测）。 */
function electronIpc(): IpcLike {
	return {
		handle: (channel, handler) => {
			ipcMain.handle(channel, (_event, payload: unknown) => handler(payload));
		},
		send: (channel, payload) => {
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) win.webContents.send(channel, payload);
			}
		},
	};
}

function createWindow(preloadPath: string, show: boolean): BrowserWindow {
	return new BrowserWindow({
		width: 1100,
		height: 780,
		show,
		title: "tavern studio",
		webPreferences: {
			preload: preloadPath,
			// 渲染进程拿不到 Node：唯一出口是 preload 的 contextBridge（见 src/preload.cjs）。
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
}

/** 验收模式参数（模块级：异常兜底也要知道该不该给出结构化失败并退出）。 */
const s0 = parseS0Args(process.argv);

async function main(): Promise<void> {
	await app.whenReady();

	// session 要一个推送出口，host 要一组 handler —— 两者互相需要，用「晚绑定」的引用来打破环：
	// 首次推送必然发生在窗口就绪、channel 被调用之后，那时 host 一定已赋值。
	let host: IpcHost | undefined;
	const session = new StudioSession(
		{ push: (channel, payload) => host?.push(channel, payload) },
		{ cwd: app.getPath("userData") },
	);
	host = createIpcHost(electronIpc(), buildHostHandlers(session));

	// 先注册退出钩子再开窗：反过来的话，窗口在 loadFile 期间被关掉就会漏掉事件，
	// 结果是一个没有窗口却活着的进程（只能靠杀）。
	app.on("window-all-closed", () => {
		session.dispose();
		app.quit();
	});

	const win = createWindow(join(import.meta.dirname, "../preload.cjs"), s0 === undefined);
	await win.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
		query: s0 !== undefined ? { s0: "1", storiesRoot: s0.storiesRoot } : {},
	});

	if (s0 !== undefined) {
		const code = await runS0Acceptance({ win, session, storiesRoot: s0.storiesRoot });
		session.dispose();
		app.exit(code);
		return;
	}
}

// 顶层必须自己接住异常：验收模式下若只打日志，隐藏窗口会常驻、进程永不退出——
// 调用方（人或 CI）只能一直等。故验收一律给出结构化失败并以非零码退出。
void main().catch((err: unknown) => {
	const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
	if (s0 !== undefined) {
		console.log(`S0_SHELL_RESULT ${JSON.stringify({ ok: false, error: message }, null, 2)}`);
		app.exit(1);
		return;
	}
	console.error(`STUDIO_MAIN_ERROR ${message}`);
});
