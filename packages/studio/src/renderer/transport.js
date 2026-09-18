// 渲染进程的通道实现（生产 = preload/IPC）。与 main 侧共用同一份 channel 契约
// （src/contract/channels.ts）——本文件不重定义任何 channel 名，只做搬运。
//
// 为什么是**经典脚本**而不是 ESM/TS：file:// 下 Chromium 不允许 type="module"，而 S0 壳刻意不引构建。
// S1 引入 Vite 后，这里会换成 TS 版本（channel 名与载荷类型由编译器保证），到时本文件删除。
// 边界纪律仍然适用：本目录不得**值导入**内核（见 test/boundary.test.ts）。

(function () {
	function createIpcTransport(bridge) {
		const b = bridge ?? globalThis.tavern;
		if (b === undefined) {
			throw new Error("tavern bridge 未注入：preload 未加载（浏览器里调试请改用开发通道）");
		}
		return {
			request: (channel, payload) => b.request(channel, payload),
			subscribe: (channel, listener) => b.subscribe(channel, listener),
		};
	}
	globalThis.createIpcTransport = createIpcTransport;
})();
