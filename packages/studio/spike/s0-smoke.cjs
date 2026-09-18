// S0 可行性冒烟：Electron 主进程内同进程嵌入 @tavernpi/core（内核 TS 源码直发）。
//
// 验证四件事：
//   1) 主进程内能否直接 import 内核的 .ts 入口（Node 类型剥离）
//   2) node:sqlite 在 Electron 内置 Node 里是否可用（内核故事库依赖）
//   3) 能否用内核 API 读一个真实故事库（turn_log / 时钟 / 事件）
//   4) Chromium 渲染管线是否可用（隐藏窗口，不打扰桌面）
//
// 运行（需先在任意目录装好 electron 并把本文件放在该目录同级或改路径）：
//   export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
//   npm i electron
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron s0-smoke.cjs
//
// 用法：CORE_ENTRY / STORIES_ROOT / SESSION_ID 可用环境变量覆盖。

const { app, BrowserWindow } = require("electron");

const CORE_ENTRY = process.env.CORE_ENTRY ?? "/home/doona/ProjectsG/tavernpi/packages/core/src/index.ts";
const STORIES_ROOT = process.env.STORIES_ROOT ?? "/home/doona/.tavernpi/stories";
const SESSION_ID = process.env.SESSION_ID ?? "";

/** 内核侧检查：直载 + 真实数据。 */
async function checkKernel() {
	const out = {};
	try {
		out.sqlite = typeof require("node:sqlite").DatabaseSync === "function" ? "ok" : "missing";
	} catch (e) {
		out.sqlite = `FAIL: ${e.message}`;
	}
	try {
		const core = await import(CORE_ENTRY);
		out.coreVersion = core.CORE_VERSION;
		out.exportCount = Object.keys(core).length;
		if (SESSION_ID !== "") {
			const dbPath = core.storyDbPath(STORIES_ROOT, SESSION_ID);
			const db = core.openStoryDb(dbPath);
			const turnLog = db.reader.getTurnLog();
			out.turnLogRows = turnLog.length;
			const last = turnLog[turnLog.length - 1];
			out.lastTurn = last
				? {
						turn_seq: last.turn_seq,
						user_input: String(last.user_input).slice(0, 30),
						narrativeChars: String(last.narrative_text ?? "").length,
					}
				: null;
			out.clock = db.reader.getClock() ?? null;
			out.events = db.reader.listEvents().length;
			db.close();
		}
	} catch (e) {
		out.coreError = String(e.stack ?? e.message);
	}
	return out;
}

/** 渲染侧检查：隐藏窗口里跑一次真实 HTML + JS。 */
async function checkRenderer() {
	const win = new BrowserWindow({
		show: false,
		width: 900,
		height: 600,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	await win.loadURL(
		"data:text/html," +
			encodeURIComponent(
				'<h1 id="t">tavern studio</h1><script>document.title="smoke-ok"</script>',
			),
	);
	const result = {
		dom: await win.webContents.executeJavaScript('document.getElementById("t").textContent'),
		title: win.webContents.getTitle(),
		webgl: await win.webContents.executeJavaScript(
			'(()=>{const c=document.createElement("canvas");return !!(c.getContext("webgl2")||c.getContext("webgl"))})()',
		),
		gpuCompositing: app.getGPUFeatureStatus().gpu_compositing ?? "n/a",
	};
	win.destroy();
	return result;
}

app.whenReady().then(async () => {
	const out = {
		versions: {
			electron: process.versions.electron,
			node: process.versions.node,
			chrome: process.versions.chrome,
		},
		platform: process.platform,
	};
	out.kernel = await checkKernel();
	try {
		out.renderer = await checkRenderer();
	} catch (e) {
		out.renderer = { error: String(e.stack ?? e.message) };
	}
	console.log("S0_SMOKE " + JSON.stringify(out, null, 2));
	app.quit();
});
