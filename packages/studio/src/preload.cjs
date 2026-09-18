// preload：渲染进程访问 main 的唯一出口（contextBridge 白名单）。
//
// 刻意**不**暴露 ipcRenderer 本体——那等于把「任意 channel 的发送与监听权」交给页面。
// channel 名的白名单不在这里另抄一份：它由 main 侧的注册表保证（createIpcHost 只注册契约里的
// channel，且少一个就启动即失败）——白名单即注册表，抄第二份必然漂移。
//
// 本文件是 CJS：sandbox: true 的渲染进程里 preload 不支持 ESM，且 .cjs 不经过类型剥离。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tavern", {
	request: (channel, payload) => ipcRenderer.invoke(channel, payload),
	subscribe: (channel, listener) => {
		const wrapped = (_event, payload) => listener(payload);
		ipcRenderer.on(channel, wrapped);
		return () => ipcRenderer.removeListener(channel, wrapped);
	},
});
