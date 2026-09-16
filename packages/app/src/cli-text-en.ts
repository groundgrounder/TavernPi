// CLI 面向用户的文案表。
//
// 现状：**CLI 走英文**（EN）。ZH 是同一批文案的中文版，**留档给未来的 GUI**
// （tavern-studio）复用——那里的用户不是开发者，中文才是合适的默认。
//
// 纪律：两侧 key 必须一一对应。改 EN 时同步改 ZH，否则 GUI 侧会缺文案。
// 只放**面向用户**的字符串；代码注释、字段名、命令名、参数名不进这里。

/** 带插值的文案用函数；纯静态的用字符串。 */
export const EN = {
	// ---- 启动与退出 ----
	banner: (title: string, mode: string, locked: string) => `=== ${title} · ${mode}${locked} ===`,
	modeNote: (mode: string, info: string) => `mode: ${mode} (${info})`,
	modeNoteLocked: "locked, cannot switch",
	modeNoteNormal: "story stage / input validation on",
	hint: "Type an action or line of dialogue to begin. /help for commands, blank line to exit.",
	lockedBadge: " · locked",
	untitled: "untitled",
	sessionId: (id: string) => `> session: ${id}`,
	storyDir: (dir: string) => `> story dir: ${dir}`,
	toolWhitelist: (tools: string) => `tool whitelist: [${tools}] (expected empty: narrator has no DB tools)`,
	modeRestoredFromMeta: (mode: string) => `> mode: ${mode} (from story.meta.json)`,
	clockInit: (t: string, cal: string, gran: string) => `> clock: ${t} (${cal}/${gran})`,
	packsLoaded: (names: string) => `> packs loaded: ${names}`,

	// ---- 通用 ----
	unknownCommand: (cmd: string) => `Unknown command /${cmd} (see /help)`,
	usage: (text: string) => `usage: ${text}`,
	yes: "yes",
	no: "no",
	none: "none",
	unset: "unset",
	/** 列表分隔符（中文版用「、」，英文用「, 」）。 */
	listSep: ", ",

	// ---- /help ----
	helpTitle: "Commands:",
	helpGroups: [
		"  /tree [n]        Show story tree; with n, jump to entry n",
		"  /fork <n>        Fork a new story from entry n",
		"  /swipe           Regenerate the last turn",
		"  /status          Time / location / mode / NPCs",
		"  /mode [mode]     Show mode; with mode, switch",
		"  /plot <outline>  Write a plot outline (creation mode only)",
		"  /compact         Compact the session (chapter summary)",
		"  /assist <q>      Side advisor: read-only, not in the narrative",
		"",
		"  /packs           Loaded world packs",
		"  /pin <entry>     Pin an entry (injected every turn)",
		"  /unpin <entry>   Unpin",
		"  /reload          Reload world packs",
		"",
		"  /agents          Sub-agent switches",
		"  /models          Model per role",
		"  /prompt          Prompt layers",
		"  /write <file>    Write to the DB directly (changeset file)",
		"  /help            This help",
	],
	helpKeys: "Blank line to exit. Tab completes, ↑↓ history, Ctrl+C exits.",
	helpModeNote:
		"Modes: creation can take plot outlines; survival / adventure only take character actions and reject out-of-character input.",
	helpForceNote: "  Prefix /! to force-submit anyway (recorded). In adventure you only see what you have been through.",
	helpAgentNote: "Sub-agents: story / npc / data always on; stylize off unless the pack declares a style.",

	// ---- /tree ----
	treeTitle: "── story tree ──",
	treeEmpty: "(empty story, no entries yet)",
	treeSummary: "[summary]",
	treeBranchSummary: "[branch summary]",
	treeCurrent: "current",
	treeOutOfRange: (arg: string, total: number) => `index ${arg} out of range (${total} entries)`,
	treeNotFound: (arg: string) => `no entry id with prefix: ${arg}`,
	treeNavigating: (id: string, role: string) => `> navigateTree(${id}) (${role} message)`,

	// ---- /fork ----
	forkUsage: "usage: /fork <index|entryId>",
	branchedSession: (id: string, file: string) => `> createBranchedSession -> new sessionId=${id} (file ${file})`,
	forkedStoryDb: (dir: string, events: number, snaps: number) =>
		`> forkStoryDb -> new story dir ${dir} (events=${events}, snapshots=${snaps})`,
	storySwitched: (from: string, to: string) => `> story switched: ${from} -> ${to}`,

	// ---- /status ----
	statusTitle: "── status ──",
	statusLine: (time: string, pos: string, mode: string) => `time: ${time} · location: ${pos} · mode: ${mode}`,
	statusNoNpc: "No characters yet.",
	statusNpc: (name: string, id: number, status: string, loc: string) => `* ${name} #${id} (${status}) @ ${loc}`,
	statusCounts: (turns: number, events: number, snaps: number, data: number) =>
		`turns: ${turns} · events: ${events} · snapshots: ${snaps} · data: ${data}`,
	statusPacks: (dirs: string, pinned: string) => `packs: ${dirs}${pinned}`,
	statusPinnedSuffix: (pinned: string) => ` · pinned: ${pinned}`,
	statusIds: (session: string, leaf: string) => `session: ${session} · entry: ${leaf}`,
	npcTrait: (trait: string, gauge: string, weight: string) => `    trait ${trait} ${gauge} ${weight}`,
	npcRelation: (name: string, sign: string, disposition: number) => `    relation to ${name} ${sign}${disposition}`,
	npcMemory: (count: number, recent: string) => `    memory: ${count} · latest: ${recent}`,
	unlocated: "unlocated",

	// ---- /packs ----
	packsTitle: "World packs:",
	packsNone: "── no world packs (retrieval injection off) ──",
	packsEntry: (name: string, dir: string) => `  ${name}  ${dir}`,
	packsEntryLine: (count: number, types: string, code: string) => `    ${count} entries (${types}) · ${code}`,
	packsHasCode: "has code",
	packsContentOnly: "content only",
	packsStoryLine: (title: string, cal: string, gran: string) => `    ${title} (${cal} / ${gran})`,
	packsReloaded: (list: string) => `> reloaded: ${list}`,
	packsReloadEntry: (name: string, count: number) => `${name}(${count} entries)`,
	reloadNone: "> no world packs loaded",
	pinUsage: "usage: /pin <pack:type:id>",

	// ---- /agents ----
	agentsTitle: (s: string, n: string, st: string, mode: string) =>
		`sub-agents: story ${s} · npc ${n} · stylize ${st} (${mode} mode)`,
	agentsUsage: "  usage: /agents <story|npc|stylize> <on|off>",
	agentsOn: "on",
	agentsOff: "off",
	agentsApplied: (s: string, n: string, st: string) =>
		`sub-agents: story ${s} · npc ${n} · stylize ${st} (applied)`,
	agentsRejected: "! this combination is not allowed in the current mode:",
	agentsBadArg: (text: string) => `usage: ${text}`,

	// ---- /models ----
	modelsTitle: "Model per role (configured in ~/.tavernpi/settings.json under models)",
	modelsUnset: "unset · pi default",

	// ---- /prompt ----
	promptLayers: "Prompt effective layer (priority story > pack > global > builtin):",
	promptChain: (role: string, layer: string) => `${role} (effective: ${layer})`,
	promptEffectiveMark: " ← effective",
	promptMissing: "none",
	promptChars: (n: number) => `${n} chars`,
	promptQueryFailed: (role: string, msg: string) => `  ${role}: ${msg}`,
	promptCleared: (role: string) => `> cleared the story-layer override for ${role}`,
	promptSet: (role: string, chars: number, src: string) =>
		`> set the story-layer override for ${role} (${chars} chars, from ${src})`,
	promptSetHint: "  note: the story layer outranks pack/global/builtin; takes effect next turn.",
	promptBadRole: (msg: string) => `! ${msg}`,
	promptLoadUsage: "usage: /prompt <role> load <file>",
	promptUsage: "usage: /prompt | /prompt <role> | /prompt <role> load <file> | /prompt <role> clear",

	// ---- /write ----
	writeUsage: "usage: /write <changeset.json>",
	writeHint: "  Trusted write: write straight to the story DB from a changeset file (skips the model; nothing is written if validation fails).",
	writeDone: (turn: number, snap: string) => `> trusted write done: turn ${turn} · snapshot: ${snap}`,
	writeFailed: (msg: string) => `! write failed: ${msg}`,

	// ---- /mode ----
	modeCurrent: (label: string, mode: string) => `> current mode: ${label} (${mode})`,
	modeInvalid: (arg: string, options: string) => `> invalid mode: ${arg} (options: ${options})`,
	modeSwitched: (label: string) => `> switched to ${label} (persisted to story.meta.json)`,
	modeSwitchFailed: (msg: string) => `> switch failed: ${msg}`,

	// ---- /plot ----
	plotUsage: "usage: /plot <outline>",
	plotWrongMode: "! not available: /plot is creation-mode only (survival / adventure reject non-player input).",
	plotWritten: (id: number, text: string) => `> plot directive #${id} written: ${text}`,

	// ---- /swipe ----
	swipeUsage: "usage: /swipe (no args; regenerates the last player turn)",
	swipeFailed: (msg: string) => `> swipe failed: ${msg}`,

	// ---- /compact ----
	compactUsage: "usage: /compact (no args; triggers chapter-summary compaction)",
	compactDone: (summary: string) => `> compaction done: ${summary}`,
	compactReplaced: (tokens: number) => `> summary replaced ${tokens} tokens (compaction entry written to the session)`,
	compactSkipped: (msg: string) => `> compaction skipped: ${msg}`,

	// ---- /assist ----
	assistUsage: "usage: /assist <question>",
	assistTitle: "── side advisor ──",
	assistHint: "Read-only, draft only, not part of the narrative. The draft below is yours to send or discard.",
	assistFailed: (msg: string) => `> assist failed: ${msg}`,

	// ---- 每轮报告 ----
	turnHeader: (n: number) => `\n────────── turn ${n} ──────────`,
	turnEmptyNarrative: "(no prose produced this turn; see the warning above)",
	turnCollectionNone: "no hits",
	turnCollectionWarnings: (w: string) => ` · warnings: ${w}`,
	turnCollection: (hit: string, warnings: string) => `· packs: ${hit}${warnings}`,
	turnNpc: (onstage: string, off: number) => `· NPC: onstage ${onstage} · offscreen ${off}`,
	turnReview: (scene: string, conflicts: number, suspicions: number, revisions: number) =>
		`· review: ${scene} · conflicts ${conflicts} · suspicions ${suspicions} · rewrites ${revisions}`,
	turnSceneFallback: "scene card degraded",
	turnSceneOk: "scene card ok",
	turnReleasedNote: "! released after retries ran out (conflicts recorded)",
	turnStylize: (state: string, drift: string) => `· stylize: ${state}${drift}`,
	turnStylized: "stylized",
	turnStylizeKept: "kept original",
	turnDrift: (d: string) => ` · drift: ${d}`,
	turnDataOk: (events: number, newNpcs: number, time: string, dropped: string) =>
		`· data: ok · events ${events} · new NPCs ${newNpcs} · ${time}${dropped}`,
	turnTimeAdvanced: "time advanced",
	turnTimeUnchanged: "time unchanged",
	turnDropped: (n: number) => ` · dropped ${n}`,
	turnDataFailed: (attempts: number, err: string) => `! data failed (${attempts} attempts): ${err}`,
	turnSnapshot: (taken: boolean) => `· snapshot: ${taken ? "saved" : "not saved"}`,

	// ---- 快照恢复 ----
	restoreSkipped: "> restore: not run (no snapshot hook state)",
	restoreFailed: (err: string) => `> restore failed: ${err}`,
	restoreUnknown: "unknown error",
	restoreOk: (turn: number, entry: string) => `> restore ok: turn ${turn} (entry ${entry})`,
	restoreEmptyFallback: "> restore ok (empty-DB fallback)",
	restoreClock: (time: string, events: number) => `> current clock: ${time} · ${events} events`,

	// ---- 中断与退出 ----
	ctrlCGenerating: "\n> Ctrl+C received: a turn is still generating, will exit after it finishes. Press again to force quit.",
	ctrlCIdle: "\n> Ctrl+C received: exiting (press again to force quit).",
	forceExit: "\n> force exit (current operation not awaited)",
	storyDirKept: (dir: string) => `> story dir kept (not deleted): ${dir}`,
	resumeHint: (cmd: string) => `> resume with: ${cmd}`,
	navigatingBusy: "> still generating; cannot jump to an entry (wait for this turn to finish)",

	// ---- 输入被拒 ----
	inputRejected: (reason: string) => `! input rejected (input-channel check): ${reason}`,
	inputSuggestion: (s: string) => `! try instead: ${s}`,
	inputForceHint: "! to submit as-is, prefix it with /! (a warning will be recorded).",

	// ---- 交互通道 ----
	interactionConfirmPrompt: (prompt: string) => `${prompt} (y/n)> `,
	interactionBadConfirm: (answer: string) => `invalid confirmation: ${answer} (expected y/n)`,
	interactionBadChoice: "choice interaction needs payload.options (string[])",
	interactionBadIndex: (line: string, max: number) => `invalid option index: ${line} (expected 1-${max})`,
	interactionUnknownKind: (kind: string) => `unknown interaction kind: ${kind}`,
};

/** 参数校验类错误（面向开发者，CLI 与 GUI 都用得到）。 */
export const EN_ERRORS = {
	badModeArg: (options: string) => `--mode accepts only ${options}`,
	unknownArg: (arg: string) => `unknown argument: ${arg}`,
} as const;
