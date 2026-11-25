<!-- antislop:start -->
## antislop
For UI, copy, people, mobile layout, or code comments work, read these installed skill files directly (use these paths even if a same-named global skill exists):
- Core filter, always on: `antislop`: `.agents/skills/antislop/SKILL.md`
- UI / visual: `antislop-ui`: `.agents/skills/antislop-ui/SKILL.md`
- Copy & text: `antislop-copywriting`: `.agents/skills/antislop-copywriting/SKILL.md`
- People: `antislop-human`: `.agents/skills/antislop-human/SKILL.md`
- Mobile / responsive: `antislop-layoutmobile`: `.agents/skills/antislop-layoutmobile/SKILL.md`
- Code comments: `antislop-code`: `.agents/skills/antislop-code/SKILL.md`
Before starting, follow the core's "Two Usage Modes" section in strict order: explicit session instruction first, then global preference, then ask. A session instruction always wins. For a resolved mode, say `antislop active: <mode> (session override).` or `antislop active: <mode> (global preference).` once before presenting findings or making edits, using the actual mode and source. Acknowledging the user's request without naming the source does not replace this notice.
Only an explicit choice of antislop during or after selects a session mode. A request to review, audit, or avoid file edits does not select a mode; read the global preference in that case. Another skill's mode does not select antislop's mode.
If the mode is unresolved, ask during/after and end the response; wait for the answer before any UI review, planning, or concept. For read-only tasks, put the active-mode notice only at the start of the final answer, never in progress messages. For editing tasks, announce before the first edit and omit it from the final answer.
To update antislop later: `npx antislop-ai --update`, or run `npx antislop-ai` and pick Overwrite them.
<!-- antislop:end -->

---

# Working in this repository

Muse Agent is an Electron app (main process owns persistence, renderer never
touches web storage) plus a Node harness that every entry point shares.

## Read this before touching UI or copy
`DESIGN.md` at the repo root is the **direction** (identity, tokens, mood).
The antislop rulebooks above are the **filter**. Read both before designing;
antislop replaces neither. The `antislop` core skill's "Two Usage Modes"
section decides whether the rules are applied while you work (`during`) or as
an audit afterwards (`after`) - resolve it in the order the skill states, and
say which mode is active and where it came from.

## Commands
- `npm test` - the whole suite (492+ tests, `node --test` over
  `app/harness/test`, `app/renderer/test`, `scripts/test`). No watch mode.
- `npm run build:renderer` - rebuilds the renderer bundles (bun).
- `npm run dist` - Windows installer + portable exe.
- `node scripts/verify-chat.mts` / `verify-design.mts` / `verify-settings.mts` -
  offscreen Electron visual checks; they write PNGs to `dist/*-preview/`.

## Shape of the code
- `app/main/` - Electron main: windows, IPC, the agent lifecycle, the vault.
- `app/harness/` - the agent: prompt, tools, sentinel, memory, design, research.
- `app/memory/` - the memory layer: store, adapters, embedding.
- `app/renderer/` - the UI (plain JS + CSS, bundled by `scripts/build-renderer.mts`).
- `app/design/` - the Design Studio registries: `design-systems`, `design-templates`,
  `skills`, `craft`.

## Contracts that tests pin (do not drift them silently)
- `app/harness/test/policy.test.js` - the tool registry list.
- `app/harness/test/context.test.js` - the system prompt shape and character budget.
- `app/harness/test/memory-turn-lifecycle.test.ts` - the `agent:send` argument order.
- `app/harness/test/design-panel.test.ts` - the design registry ids.
- `app/harness/test/voice.test.ts` - `voice.md` carries style metrics only, never
  quotes or topics from the user's chat history.

## Rules that are not negotiable
- Secrets live in the OS vault (`credentials.enc` via `safeStorage`), never in
  `config.toml`, never in a transcript. Never take an API key through chat.
- The renderer never reads or writes web storage.
- Every tool touches the filesystem or the network through the sentinel; an
  unknown tool fails closed.

<!-- ASTRYX:START -->
Astryx v0.7.17 · 174 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx component <Name>` to read props before using one; `astryx template <Block>` prints a block example to read for a part it lacks. Astryx names differ from other libraries: buttons, badges, tokens and tabs take their text in `label` (Text, Heading and Link take children), booleans start with `is` or `has` (`isOpen`, `isDisabled`), and every input takes `value` and `onChange`.
Changing an existing page? Keep it: skip step 2 and add components inside its sections; read a block example when it helps.
Before you deliver a build, run `astryx doctor --built <dir>`; don't deliver it if it fails.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then tokens (var(--color-*|--spacing-*|--radius-*)). No raw hex/px. No StyleX/Tailwind compiler here — don't use xstyle/utility classes directly. Some templates use StyleX and need a compiler plugin; see `astryx docs styling-overview`.
- THEMES: palettes and custom colors go through the theme, never :root overrides; so does a denser or roomier app (`editor set <name> spacing tight`), never gap and padding changes page by page. A change to one kind of part (the sidebar, its selected item, the gaps in a form) is a theme change too, not props on one page: `editor how "<ask>"` names the `set … --on <part>` line. No app yet: `astryx experimental theme preview app <dir>` makes a starter app that shows the theme. To make or change a theme (colors, fonts, corners, spacing, a look from a picture), prefer the experimental theme editor over hand-written theme files: `astryx experimental theme editor new <name> --like neutral`, then `editor set <name> <thing> <value>` or `editor how "<what you want>"`; wire it with `astryx theme add <name>`; after each change look at it with `astryx experimental theme editor show <name> --png` (takes pictures of real components) and open the PNGs it writes; a theme change is not done until you have looked at the pictures. In code, extend an imported theme to customize it; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or a token.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands and API reference
  docs authoring     build an integration package, and every field it holds
  upgrade --from <old version> --apply   run after a dependency bump
To remove this block, run `astryx init --remove-agents`, which removes it from the agent files at the project root and in the folder you run it in; from any other file it leaves, delete everything from ASTRYX:START to ASTRYX:END.
<!-- ASTRYX:END -->
