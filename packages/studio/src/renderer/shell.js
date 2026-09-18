// S0 收尾的最小壳（刻意不做框架与构建）：故事列表 → 新建/打开 → 输入 → 流式 → 中止。
//
// 它不是 S1 的 UI，只用来证明「渲染进程 → preload → IPC → main → 内核 → SQLite」这条链路通，
// 并给 Phobos 一个能点的手感。S1 会把这里换成 React + Vite，本文件的验收钩子（__s0Result）
// 保留为回归手段。
//
// 两条数据纪律（与内核一致）：
//   1. 流式增量只作「生成中」临时展示；轮末必须用 turn:done 的终稿覆写（stylize 会润色、
//      story 可能打回重写，草稿与终稿可以不同）。
//   2. 阅读流的正文事实源是 story.db 的 turn_log，不是 session 转录——S1 的阅读流从 DB 取，
//      这里只是临时把终稿画在气泡里。

(function () {
	const transport = globalThis.createIpcTransport();
	const query = new URLSearchParams(location.search);
	const acceptMode = query.get("s0") === "1";
	const storiesRoot = query.get("storiesRoot") ?? undefined;

	const el = (id) => {
		const node = document.getElementById(id);
		if (node === null) throw new Error(`DOM 缺元素: ${id}`);
		return node;
	};
	const log = (text, cls) => {
		const line = document.createElement("div");
		line.className = `line ${cls ?? ""}`;
		line.textContent = text;
		el("log").append(line);
		el("log").scrollTop = el("log").scrollHeight;
	};

	/** 当轮 turnId：中止按钮与流式增量都靠它定位。 */
	let currentTurnId = undefined;
	let streamingNode = undefined;

	// ---- 推送订阅（渲染进程唯一的入向通道）----
	transport.subscribe("turn:delta", (p) => {
		if (p.turnId !== currentTurnId) return;
		if (streamingNode === undefined) {
			streamingNode = document.createElement("div");
			streamingNode.className = "turn streaming";
			el("story").append(streamingNode);
		}
		streamingNode.textContent += p.text;
		el("story").scrollTop = el("story").scrollHeight;
	});
	transport.subscribe("event:pipeline", (p) => {
		el("phase").textContent = `阶段 ${p.role} · ${p.durationMs}ms`;
	});
	transport.subscribe("turn:done", (p) => {
		accept.doneEvents++;
		// 终稿覆写：丢弃流式草稿（它可能被 stylize/打回改过）
		if (streamingNode !== undefined) {
			streamingNode.classList.remove("streaming");
			streamingNode.textContent = p.ok ? p.narrativeText : "（本轮已中止，未落库）";
			streamingNode = undefined;
		}
		el("phase").textContent = "";
	});
	transport.subscribe("warning", (p) => log(`告警：${p.message}`, "warn"));
	transport.subscribe("story:changed", (p) => {
		el("session").textContent = p.sessionId;
	});

	// ---- 命令 ----
	async function refreshStories() {
		const stories = await transport.request("story:list", storiesRoot !== undefined ? { storiesRoot } : {});
		const list = el("stories");
		list.textContent = "";
		if (stories.length === 0) {
			list.append("（没有故事，点「新建故事」）");
		}
		for (const story of stories) {
			const btn = document.createElement("button");
			const suffix = story.sessionFile === undefined ? "（无会话文件）" : "";
			btn.textContent = `${story.title ?? "未命名"} · ${story.mode} · ${story.sessionId.slice(0, 8)}${suffix}`;
			btn.onclick = () => void openStory(story);
			list.append(btn);
		}
		el("count").textContent = String(stories.length);
		return stories;
	}

	/** 续写已有故事：会话文件路径由 story:list 给出（内核从 <root>/sessions 索引）。 */
	async function openStory(story) {
		if (story.sessionFile === undefined) {
			log(`这个故事还没跑过任何轮次，没有会话文件可续写：${story.sessionId}`, "warn");
			return undefined;
		}
		el("story").textContent = "";
		try {
			const opened = await transport.request("story:open", {
				...(storiesRoot !== undefined ? { storiesRoot } : {}),
				sessionFile: story.sessionFile,
			});
			log(`已打开 ${opened.sessionId}（模式 ${opened.mode}）`, "ok");
			return opened;
		} catch (err) {
			log(`打开失败：${err instanceof Error ? err.message : String(err)}`, "err");
			return undefined;
		}
	}

	async function createStory() {
		el("story").textContent = "";
		const created = await transport.request("story:create", storiesRoot !== undefined ? { storiesRoot } : {});
		log(`新故事 ${created.sessionId}（模式 ${created.mode}）`, "ok");
		await refreshStories();
		return created;
	}

	async function send() {
		const input = el("input").value.trim();
		if (input === "" || currentTurnId !== undefined) return;
		currentTurnId = `turn-${Date.now()}`;
		el("send").disabled = true;
		el("abort").disabled = false;
		const user = document.createElement("div");
		user.className = "turn user";
		user.textContent = input;
		el("story").append(user);
		el("input").value = "";
		try {
			const result = await transport.request("turn:run", { turnId: currentTurnId, input });
			log(`第 ${result.turnSeq} 轮完成 · ${result.narrativeText.length} 字 · 快照 ${result.snapshotTaken ? "已拍" : "未拍"}`, "ok");
		} catch (err) {
			log(`本轮失败：${err instanceof Error ? err.message : String(err)}`, "err");
		} finally {
			currentTurnId = undefined;
			el("send").disabled = false;
			el("abort").disabled = true;
		}
	}

	async function abortTurn() {
		if (currentTurnId === undefined) return;
		try {
			await transport.request("turn:abort", { turnId: currentTurnId });
			log("已请求中止（本轮零落库）", "warn");
		} catch (err) {
			log(`中止失败：${err instanceof Error ? err.message : String(err)}`, "err");
		}
	}

	// ---- S0 验收钩子（?s0=1 时由主进程驱动；结果放 globalThis.__s0Result）----
	const accept = {
		doneEvents: 0,
		async run() {
			const started = Date.now();
			const deltas = { n: 0, chars: 0 };
			const pipelineRoles = new Set();
			const warnings = [];
			transport.subscribe("turn:delta", (p) => {
				deltas.n++;
				deltas.chars += p.text.length;
			});
			transport.subscribe("event:pipeline", (p) => pipelineRoles.add(p.role));
			transport.subscribe("warning", (p) => warnings.push(p.message));

			const storiesBefore = (await refreshStories()).length;
			const created = await createStory();
			const turnId = `s0-${Date.now()}`;
			currentTurnId = turnId;
			const input = "我推门而入，环顾四周。";
			const result = await transport.request("turn:run", { turnId, input });
			currentTurnId = undefined;

			// 续写路径也过一遍（不花模型调用）：list 给出的会话文件必须能直接喂给 story:open。
			const after = await refreshStories();
			const listed = after.find((s) => s.sessionId === created.sessionId);
			const reopened =
				listed !== undefined && listed.sessionFile !== undefined
					? await transport.request("story:open", { sessionFile: listed.sessionFile, ...(storiesRoot !== undefined ? { storiesRoot } : {}) })
					: undefined;

			return {
				ok: true,
				storiesBefore,
				sessionId: created.sessionId,
				mode: created.mode,
				turnSeq: result.turnSeq,
				narrativeChars: result.narrativeText.length,
				narrativeText: result.narrativeText,
				snapshotTaken: result.snapshotTaken,
				deltas: deltas.n,
				deltaChars: deltas.chars,
				pipelineRoles: [...pipelineRoles],
				doneEvents: this.doneEvents,
				listedSessionFile: listed !== undefined && listed.sessionFile !== undefined,
				reopenedSessionId: reopened !== undefined ? reopened.sessionId : "",
				reopenedMode: reopened !== undefined ? reopened.mode : "",
				warnings,
				elapsedMs: Date.now() - started,
			};
		},
	};

	el("create").onclick = () => void createStory();
	el("send").onclick = () => void send();
	el("abort").onclick = () => void abortTurn();
	el("input").addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
	});

	void refreshStories();

	globalThis.__studioReady = true;
	if (acceptMode) {
		accept
			.run()
			.then((report) => {
				globalThis.__s0Result = report;
			})
			.catch((err) => {
				globalThis.__s0Result = {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
					storiesBefore: 0,
					sessionId: "",
					mode: "",
					turnSeq: -1,
					narrativeChars: 0,
					narrativeText: "",
					snapshotTaken: false,
					deltas: 0,
					deltaChars: 0,
					pipelineRoles: [],
					doneEvents: accept.doneEvents,
					listedSessionFile: false,
					reopenedSessionId: "",
					reopenedMode: "",
					warnings: [],
					elapsedMs: 0,
				};
			});
	}
})();
