# Handoff: muse-viking fork (context for a fresh Claude Code session)

You are picking up mid-task. Prior session (Claude desktop) completed analysis and a
small spike; the big fork is planned but NOT started. Read this fully before acting.

## Project state

- Repo: `D:\OpenSourceProg\Test\REA\muse-agent` (v0.1.3, MIT, Electron + Node harness
  + Python hands sidecar). Tests should be 94/94 green — RUN THEM FIRST, a spike change
  is uncommitted and unverified.
- Uncommitted changes (verify then commit):
  - `config.example.toml` — commented `[mcp.server.viking]` block (mcp-remote bridge).
  - `app/harness/agent.js` — `systemPrompt()` has new 6th param `hasViking` (default
    false); guidance line when `mcp__viking__*` tools present; `run()` call site updated.
  - `docs/openviking-spike.md` — Phase 1 spike doc. READ THIS.
- LLM config in `~/.muse-agent/config.toml` + OS vault. NEVER echo the API key.

## What OpenViking is

volcengine/OpenViking — "context database for AI agents": persistent knowledge/memory
as a `viking://` virtual filesystem with L0/L1/L2 summary tiers, scoped semantic search,
session-commit memory extraction. Review verdict: production-grade, but AGPLv3 server
(Alpha v0.3.x), heavy deps, Python server on host. MCP endpoint is Streamable HTTP at
`http://127.0.0.1:1933/mcp`, auth = self-minted user/admin key from Studio
(`http://127.0.0.1:1933/studio`). Docs: docs.openviking.ai.

## The task: fork → `muse-viking`, rewire memory onto OpenViking

Create `D:\OpenSourceProg\Test\REA\muse-viking` as a folder copy (not a branch), then:

1. Copy repo minus `node_modules`, `dist`, `.git`, `python/__pycache__`.
2. Rename for collision-free side-by-side runtime: productName `Muse Viking`,
   appId `cn.muse.viking`, data dir `~/.muse-viking` (search for `.muse-agent` path
   construction), portable artifact `MuseViking-${version}-portable.exe`.
   Fresh `git init`.
3. Memory rewiring — the `app/memory/` layer is a facade (`layer.js`, "the ONLY
   surface the host touches") over `openStore()` (`adapters/store.js`, full Store
   class: memories/turns/grades/usage/deletions/audit/project tables, sqlite WAL,
   owner-lock via `.owner` dir + pid check):
   - New `adapters/vikingStore.js` implementing the SAME Store method surface over
     OpenViking REST: memories as Markdown under `viking://user/<id>/memories/`,
     per-project resource namespaces. Same signatures so `layer.js` never knows.
   - `openStore()` dispatches on `cfg.memory.backend`: `"sqlite"` (default, existing
     code byte-identical) vs `"viking"`.
   - `layer.js` requestContext: for viking backend, retrieval = viking scoped search;
     skip the local embeddings/posterior/scorer path for viking rows.
   - Session-end `extract()` output ALSO written via vikingStore (readable Markdown).
     Grades, usage caps, audit stay in local sqlite — muse policy, not viking's.
   - `healthMetrics()` reports viking reachability; server down = disclosed degrade
     (no silent injection).
   - Do NOT touch: sentinel, permission modes, MCP client, subagents, bridge,
     renderer, hands.
4. Tests: sqlite path must pass the existing suite UNCHANGED (regression gate).
   Viking path: new fixture tests with a mocked viking REST server, no Python needed.

## Rules that carry over

- Original repo stays frozen — all experiments in muse-viking only.
- agent.db semantics on the sqlite path are sacred (do-not #8: never silently change
  recall semantics; row-pin embedding checks, evidence-version lineage).
- Key in config/vault is never echoed, never committed.
- Portable exe rebuild pipeline is documented in prior session notes; not needed
  until eval works from source.

## Suggested order

1. `npm test` in muse-agent → commit spike if green.
2. Fork copy + renames → verify `npm start` runs with data dir `~/.muse-viking`.
3. `vikingStore.js` + backend flag + dispatch (sqlite tests still green).
4. Viking retrieval path in `layer.js` + health degrade.
5. Mock-server viking tests.
6. Manual eval with a real local OpenViking server (`pip install openviking`,
   `openviking-server`, key from Studio).
