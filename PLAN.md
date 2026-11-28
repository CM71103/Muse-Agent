# Muse Agent — Instrument Panel

## Goal and users

Muse Agent is a desktop coding agent for developers who hand it a shell and a
project folder. The Instrument Panel direction makes the app read like audit
software rather than a chat toy: every run states its model, its permissions,
what it is waiting on and what it touched. Working means a person opens Muse,
sees the system status at a glance, starts a run from the launch screen and can
read the run back in the Activity ledger.

## Scope

In scope for Phase 1:
- The Instrument Panel visual system: paper canvas, ink chrome, one blue signal,
  hairline rules, ledger typography, 8px radius, light-only palette.
- A system-status strip under the menubar bound to live state (run state, model,
  permission mode, approvals waiting, memory, project).
- The launch screen as a signed brief: eyebrow, headline, lead, idea rows.
- The Activity panel as a run ledger with recorded timestamps, token and tool
  counters, and empty/error states.
- The appearance picker entry, with Instrument as the new default.

Out of scope for now: per-command exit codes, the memory diff view, an
approval-gate redesign, boards/pages restyling, export formats. Instrument dark
and dense variants landed in Phase 4.

## Architecture

- Electron main owns persistence (`appearance.json`), the renderer never touches
  web storage.
- The renderer is plain JS + CSS bundled by `scripts/build-renderer.mts`; Phase 1
  adds one stylesheet (`app/renderer/instrument-panel.css`) and edits
  `index.html` / `renderer.js`, so no framework is introduced.
- Tokens are CSS variables on `body[data-theme="instrument"]`, following the
  existing theme contract: a theme overrides token values only.
- Live values come from existing IPC: `getConfig`, `memoryStatus`, the approval
  events and the agent event stream. No new backend, no fixtures.
- Deployment is unchanged: Windows installer via GitHub Actions.

Secrets: none needed on top of the existing Vault-stored model key.

## Risks and assumptions

- Other themes must keep working; every new rule is scoped to the instrument
  theme or uses tokens, so switching themes does not leak the new look.
- The status strip must degrade when IPC is unavailable (`Connection
  unavailable`), since the renderer also runs in a plain browser for checks.
- Assumed: Instrument Panel is the default only for new installs; an existing
  `appearance.json` choice is never overwritten.
- Assumed: "official" means quieter chrome and legible state, not more
  decoration; motion stays under 240 ms and honours reduced motion.

## Phase 1: Instrument Panel shell and run ledger

Goal: the app opens as a signed workspace with live system state and a readable
run ledger.

- [x] Instrument Panel tokens land in `app/renderer/instrument-panel.css`.
- [x] Status strip renders run state, model, permissions, approvals, memory, project from real IPC.
- [x] Launch screen carries the eyebrow, headline and lead from the direction.
- [x] Activity panel records timed ledger rows with counters and an empty state.
- [x] Appearance picker offers Instrument and it is the default.

Acceptance: open the app, see the light instrument shell with a status strip
reading live values; start from the launch screen; run a message and find it
recorded with a time in the Activity ledger; switch to Krishna and back without
losing the app's other themes.

## Phase 2: Approval gate as a signed record

Goal: the approval card states the exact command, its scope and its exit
conditions before anything runs, in the ledger typography.

- [x] `app/harness/approval-record.js`: canonical request digest (SHA-256),
      scope classification (project / outside / device / network / MCP / model)
      and exit conditions; per-install HMAC-SHA256 key at
      `<config>/approval-signing.key` (32 bytes, mode 0600).
- [x] Main signs each gate, sends the record to the card, and appends a signed
      receipt to the session JSONL for allow, deny, timeout, mode change and
      sandbox stop (`decidedBy` names which).
- [x] Approval card shows scope, on-allow, on-deny and unanswered lines plus the
      request digest and key fingerprint; the transcript keeps an “Inspect
      record” receipt note after the decision.
- [x] `approval:inspect` IPC re-checks the stored receipt against the install
      key and reports `valid|NOT valid` with scope and decision time.
- [x] Tests: digest stability, scope rules, exit wording, HMAC tamper detection,
      ledger round-trip and on-disk edit detection.

Acceptance: with a gate pending, the card names what the request reaches and
what allow/deny/silence do, and shows the record digest; after deciding, the
transcript note opens the receipt, and editing the stored decision makes the
check report the signature as invalid.

## Phase 3: Run detail with what it touched

Goal: each ledger row opens a detail pane listing files read and written,
tokens and the final status for that run.

- [x] `app/harness/run-log.js`: per-run touched files from `read_file` /
      `write_file` (project-relative inside, absolute outside, cap 200),
      checkpoint hashes merged in, and one run record assembled from the same
      facts that close the receipt and ride the `done` event.
- [x] `agent.js` notes the path inside `executeToolCall`; `agent-run.ts` writes
      `request`, usage, turns, duration, tool errors, outcome and files into the
      `run_accepted` / `run_finished` receipts for complete, max_turns,
      cancelled and error runs.
- [x] `runs:list` replays the session receipts into runs (newest first, a
      dangling accept is `interrupted`, never silently complete); `runs:detail`
      hashes each written file now and reports `unchanged` / `changed` / `gone`
      against the hash the checkpoint left.
- [x] Activity panel: `#wb-runs` rows (time, request, status pill, file count)
      open to a detail pane — status, duration, steps, Read, Written with
      on-disk state, tokens and tool errors; button + `aria-expanded`, Escape
      closes; event notes stay below as their own list.
- [x] Tests: touched-path rules and cap, checkpoint hash merge, run record,
      receipt replay (pairing and interruption), real run writing both file
      tools, cancelled run, and the renderer pane's open/close, state upgrade
      and live row.

Acceptance: send a message that reads one file and writes another; the row
appears in Activity with its request and `done`; opening it lists the read and
written path, marks the written file unchanged, the token counts and the final
status. Editing that file afterwards and reopening the row says `changed since
this run`. Restarting the app keeps the rows, read from the session receipts.

## Phase 4: Instrument dark and dense variants

Goal: a dark instrument palette and a roomier/tighter spacing pair, both through
the theme file, so long sessions read well at night.

- [x] Night palette: `body[data-theme="instrument-night"]` swaps the paper
      canvas for ink, keeps one blue signal at a lighter step (`#8fb0ff`), and
      carries the full token set (surfaces, rails, glass, shadows, charts, code)
      so no panel falls back to light values.
- [x] Dense variant: `body[data-theme^="instrument"][data-density="dense"]`
      tightens the strip, cells, idea rows, activity log and empty padding
      through `--ins-*` tokens; the log stops at an 11px floor and the log pane
      grows instead of the type shrinking.
- [x] Picker: Appearance offers Instrument Night inside the Instrument family and
      Row density (Comfortable / Tight) only for Instrument; the pair persists in
      `appearance.json` through `appearance:get` / `appearance:set`, is restored
      on launch, and toggling it no longer writes a row into the chat transcript.
- [x] Phone and tablet: the strip answers to its own width — optional cells drop
      below 860px, Permissions below 460px, so at 360px it shows the model and
      what is waiting with no sideways scroll or cut cell; the settings palette
      row wraps instead of clipping.
- [x] Tests and visual check: `instrument-theme.test.js` pins both palettes'
      token sets, WCAG AA contrast, the density ordering and the persistence
      regexes; `scripts/verify-instrument.mts` drives the real Electron window
      through both palettes and densities at 1280 / 768 / 360 and asserts
      contrast, strip fit, no page overflow and no console errors; renderer
      tests pin that appearance, density and permission-mode changes leave the
      chat space unmarked.

Acceptance: switching Appearance to Instrument Night turns the workspace dark
and it is still dark after relaunching; Row density Tight packs the strip and
the activity log without shrinking text below reading size; at a 360px window
the strip shows the model and any waiting approval without a sideways scroll.
