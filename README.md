<div align="center">

**English** · [中文](README.zh-CN.md)

</div>

# tavernpi

**A story engine whose memory is a database.**

A writer inputs a character's actions and dialogue; tavernpi writes the following narrative and records everything that happened: who was present, who said what, how much time passed, where the character went, and which relationships changed.

Most LLM writing tools keep their memory in the chat log. tavernpi extracts facts from the narrative text after every turn and writes them into SQLite. **The chat log is a draft; the database is the truth.** Any node can therefore be rewound, replayed, or branched from, and a wrong turn does not force a restart.

Current version: **v0.1.0**.

---

## What tavernpi solves

Writing long-form stories with an LLM usually runs into three problems:

1. **Amnesia**: by turn 50 the model has forgotten where the protagonist lives or who they fell out with. The context window cannot hold it all, and cramming more in dilutes what is already there.
2. **Drift**: a setting the model invents on the spot ("your sister actually died long ago") has no mechanism to stop it, and the world gradually departs from what was established.
3. **No way back**: once a turning point is written badly, the chat log offers no undo. The only options are deleting and starting over, or living with it.

How tavernpi responds:

| Problem | Response |
|---|---|
| Amnesia | Long-term memory lives in SQLite. Each turn recalls only the relevant facts into context; the full history need not be carried |
| Drift | A dedicated subagent **extracts** facts from the narrative text and writes them to the database; the narrative model cannot change settings directly, and what it writes becomes fact only after validation |
| No way back | A database snapshot is taken at the end of every turn. Rewind, reroll, and branch all restore from snapshots, so world state moves with them |

---

## How a turn happens

A single line of input triggers a pipeline rather than a single model call:

```
input
  ↓
① Scene analysis    read what happened this turn and which settings to recall
  ↓
② World injection   pull relevant people, places, and events from the database, alongside pack settings
  ↓
③ NPC rehearsal     characters present each project their reaction (in parallel); absent ones simulate what they are doing elsewhere
  ↓
④ Narration         write this turn's prose
  ↓
⑤ Stylize (optional)  change style only; touch no facts
  ↓
⑥ Fact extraction   pull state changes out of the prose and write them to the database ← the only place that can write
  ↓
⑦ Snapshot          archive the database state at the end of the turn
```

A few key design points:

- **The narrative model has no database write access.** Its tool list is empty, so the only way to change the world is through prose, and that prose becomes durable only after the independent extraction in step ⑥.
- **Step ⑥ is the sole writer.** A failed extraction skips the snapshot and the unrecorded content is reconciled on the next turn, so there is no silent inconsistency where prose was written but the world did not record it.
- **Snapshots are bound to the end of the turn**, so rewinding to turn N restores exactly the state at the end of turn N, and redoing that turn does not record its events twice.

---

## Three play modes

One engine, three stances. Modes are **enforced at the kernel level**, not by UI toggles, so bypassing the interface grants no extra access.

| | **Creation** | **Survival** | **Adventure** |
|---|---|---|---|
| Stance | Novel writing assistance | Immersive roleplay | Immersive roleplay + fog of information |
| Input | Character actions + **plot outline directives** | Character actions/dialogue only | As survival, and stricter |
| World visibility | Fully transparent | Fully transparent | **Limited to what the character has experienced** |
| Engine | story/npc/stylize can be disabled | Only stylize can be disabled | All forced on |
| Mode switch | ↔ Survival, anytime | ↔ Creation, anytime | **Chosen at creation, then locked** |

Adventure mode's database query layer filters by relevance to the character: unrelated events never enter the context, and characters never encountered do not appear in query results. This fog of information is implemented in the query layer, so it does not rely on prompts to constrain model output.

---

## Getting started

Prerequisites: Node.js ≥ 24, `npm install`, and a model key configured in pi's `auth.json`.

```bash
# Start a new story
npm run cli

# With a world pack and survival mode
npm run cli -- --pack ./my_world --mode survival

# Continue an existing story (the CLI prints this command on exit)
npm run cli -- --resume <session file path>
```

CLI flags: `--pack <dir>` (repeatable) · `--mode creation|survival|adventure` · `--style <style>` · `--root <dir>` (story data directory, default `~/.tavernpi`).

Once inside, **enter a character's action or dialogue and press Return to produce a turn**. An empty line exits.

### Commands

| Command | Purpose |
|---|---|
| `/tree` `/tree <n>` | View the story tree / jump to entry n (world state is restored with it) |
| `/fork <n>` | Branch a new storyline from entry n |
| `/swipe` | Reroll the last turn (the old draft stays on the tree) |
| `/status` | Status panel: time, location, mode, characters present |
| `/mode [mode]` | View / switch mode |
| `/plot <outline>` | Write a plot outline to steer later turns (creation mode only) |
| `/compact` | Generate a chapter summary and compress the session |
| `/assist <question>` | Side-channel advisor: ask a question without affecting the story |
| `/packs` `/packs add\|remove` | View / mount and unmount world packs |
| `/pin` `/unpin` `/reload` | Pin an entry (injected every turn) / unpin / reload packs |
| `/agents` `/models` `/prompt` | Subagent toggles / per-role models / prompt layers |
| `/write <file>` | Write to the database directly via a changeset file |
| `/! <input>` | Force-submit an input that was rejected (recorded) |
| `/help` | Full help |

> In survival and adventure modes, input must be something the character can do. Inputs that force the plot forward (such as "I order the guard to open the gate") are rejected; the `/!` prefix force-submits them and the engine records the override.

---

## World packs

**A world pack is the complete setting for one work.** It is an ordinary directory, pure content, zero code:

```
my_world/
├── package.json        # package name doubles as the namespace prefix
├── story.yaml          # title, calendar, opening, default style
├── collection/         # setting entries: one file per entry, filename is the entry id
│   ├── characters/     #   characters (protagonists and NPCs share one shape)
│   ├── locations/      #   places (optional hierarchy and coordinates, used for maps and distance reasoning)
│   ├── objects/        #   key items
│   ├── factions/       #   factions and organizations
│   └── plot/           #   plotlines
├── prompts/            # optional: override any subagent's prompt
└── db/
    ├── schema.sql      # custom tables
    └── seed.sql        # seed data
```

**SQL is a first-class authoring interface.** A table for "affinity" can be created directly, with no need to wait for engine support:

```sql
CREATE TABLE IF NOT EXISTS my_world_char_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  npc_ref TEXT NOT NULL,
  favor INTEGER NOT NULL DEFAULT 0,  -- favor: -100~100, typically 0 on first meeting
  turn_seq INTEGER NOT NULL
);
```

Field comments serve as the extraction stage's instructions. State changes produced by each subsequent turn are written into this table automatically.

Toolchain:

```bash
node packages/tools/src/cli.ts init ./my_world     # generate a skeleton
node packages/tools/src/cli.ts check ./my_world    # full validation + SQL trial run on an in-memory database
node packages/tools/src/cli.ts templates           # built-in SQL templates (character status / inventory / quest progress)
```

`check` executes the schema and data against a clean in-memory database and verifies idempotency, catching SQL errors, broken references, and missing table prefixes **before the story begins**. A single typo in a pack does not ruin a long story.

Pack author documentation: `packages/tools/README.md`. Complete example: `packages/app/acceptance/fixtures/shouling/`.

---

## Repository layout

```
packages/
├── core/     @tavernpi/core — the engine kernel
│             turn pipeline · database layer · snapshots · subagent system · prompt layering
│             pack loading · mode presets · view filtering · session assembly
├── app/      CLI (npm run cli) · acceptance scripts · exploratory verification artifacts
├── tools/    @tavernpi/tools — pack validation / skeleton / template CLI
└── studio/   @tavernpi/studio — GUI shell (Electron, embedding the kernel in-process)
              S0 skeleton works; UI starts at S1
```

**The kernel/shell boundary is a hard constraint**: all story engine logic (pipeline, subagents, snapshots, validation, modes) lives in `core/`. The interface layer only presents; it implements no engine logic. Bypassing modes from the UI is architecturally impossible because filtering and validation sit in the query layer. This boundary is pinned down by automated tests that scan the source, making it a machine-checked criterion.

The kernel can be embedded in-process as a library: `@tavernpi/core` (CORE_VERSION 0.1.0). The narrowing principle for the public API is documented in the header comment of `packages/core/src/index.ts`.

---

## Development

```bash
npm test              # full-repo unit tests (node --test)
npm run typecheck     # type checking (core / app / tools / studio)
npm run accept     # end-to-end acceptance (real LLM, requires auth.json)
```

For studio development, environment caveats, and acceptance evidence, see `packages/studio/README.md` and its `docs/`.

---

## License

**GPL-3.0-or-later** — full text in [`LICENSE`](LICENSE).

```
Copyright (C) 2026 groundgrounder
This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of
the License, or (at your option) any later version. This program is distributed in the hope that
it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE. See `LICENSE` for details.
```

Note: `@tavernpi/core` is meant for in-process embedding. Distributing a work that embeds it (e.g. a GUI shell shipped as a binary) requires that work to be GPLv3-compatible.
