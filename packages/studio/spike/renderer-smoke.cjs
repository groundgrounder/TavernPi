// 渲染层加载冒烟：真起 Electron，加载 Vite 产物，断言 React 界面**真的挂上了**。
//
// 为什么必须有这条：源码类型检查通过、产物构建成功，都不保证 `file://` 下产物能被加载。
// 两个已知的 `file://` 陷阱恰好在类型系统之外：
//   1. ES module 的 `type="module"` 在 file:// 下受 CORS 约束（origin 是 opaque），
//      脚本会因跨源被拒——产物目录里所有文件都在盘上，但页面白屏。
//   2. CSP 的 `script-src 'self'` 在 file:// 下对「self」的判定与 http(s) 不同。
// 这两条都只在**真加载**时暴露，故判据取「DOM 里出现了 React 渲染出的节点」而非「loadFile 没抛错」。
//
// 用法：env -u ELECTRON_RUN_AS_NODE electron spike/renderer-smoke.cjs

const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

const RENDERER = join(__dirname, "..", "src", "renderer", "dist", "index.html");

async function main() {
	const win = new BrowserWindow({
		show: false,
		width: 1100,
		height: 780,
		webPreferences: {
			// 与 src/main/index.ts 的 createWindow 保持一致，否则验的不是真配置。
			preload: join(__dirname, "..", "src", "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});

	// 收集渲染进程的控制台错误与加载失败——这才是 `file://` 陷阱的现场证据。
	const consoleErrors = [];
	const loadFailures = [];
	win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
		// level 3 = error
		if (level >= 2) consoleErrors.push(`[${level}] ${message} @${sourceId}:${line}`);
	});
	win.webContents.on("did-fail-load", (_e, code, desc, url) => {
		loadFailures.push(`${code} ${desc} ${url}`);
	});

	await win.loadFile(RENDERER);
	// 给 React 一拍时间挂载（mount 是同步的，但 effect 里的 story:list 需要一次 IPC 往返）。
	await new Promise((r) => setTimeout(r, 1500));

	const probe = await win.webContents.executeJavaScript(`
		JSON.stringify({
			studioReady: globalThis.__studioReady === true,
			rootChildren: document.getElementById("root")?.children.length ?? -1,
			h1: document.querySelector("h1")?.textContent ?? null,
			hasAside: !!document.querySelector("aside"),
			buttons: [...document.querySelectorAll("button")].map(b => b.textContent.trim()),
			bodyText: (document.body.innerText || "").slice(0, 300),
		})
	`);

	console.log(
		"RENDERER_SMOKE " +
			JSON.stringify(
				{
					probe: JSON.parse(probe),
					consoleErrors,
					loadFailures,
				},
				null,
				2,
			),
	);
	win.destroy();
	app.quit();
}

app.whenReady().then(() =>
	main().catch((err) => {
		console.log("RENDERER_SMOKE " + JSON.stringify({ fatal: String(err && err.stack ? err.stack : err) }, null, 2));
		app.exit(1);
	}),
);
