// Vite 配置（studio 渲染层）。
//
// 三条约束决定了这份配置的形状：
//   1. **产物落在 src/renderer/dist/**：main 进程用 loadFile 加载本地文件，不能用 dev server
//      （交付形态无 HTTP 服务）。故 base 用相对路径 "./"，否则 file:// 下资源全 404。
//   2. **构建目标对齐 Electron 的 Chromium**（Electron 44 = Chromium 152），不需要向下兼容；
//      写成现代 target 才不会把 async/await 降级成 regenerator。
//   3. **契约层是跨进程共享源码**，故不在 Vite 的依赖优化里，直接当普通 TS 源码一起打——
//      只有 renderer 真正 import 到的部分才会进包，`import type` 会被完全抹掉（边界纪律的机器体现）。

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	// 产物给 file:// 加载，必须相对路径。
	base: "./",
	root: "src/renderer",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		// Electron 44 = Chromium 152：不受旧浏览器约束。
		target: "chrome152",
		// 单页应用，不需要代码分割；合成一个 chunk 让 file:// 加载只需一次请求。
		rollupOptions: {
			output: { codeSplitting: false },
		},
	},
	// 开发期（npm run dev:renderer）用 Vite 自带服务器 + HMR，但注意：
	// 渲染进程只与 main 说话（preload 注入的 window.tavern）。浏览器里没有 preload，
	// 故 dev 模式必须配合 S1 剩余项「开发通道」（src/dev/transport-ws.ts）。
	server: { port: 5273, strictPort: true },
});
