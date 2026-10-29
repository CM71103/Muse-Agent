# OpenViking spike (Phase 1, optional, side-by-side)

Goal: let Muse use [OpenViking](https://github.com/volcengine/OpenViking) (a context
database for agents — persistent knowledge/memory as a `viking://` filesystem) as an
MCP toolset, WITHOUT touching the built-in sqlite memory layer. Both stores run in
parallel; nothing migrates; nothing breaks if OpenViking is absent.

**Status: spike, not a dependency.** Muse works fully without this. Do not bundle
OpenViking into the portable exe.

## 1. Host setup (one-time, outside Muse)

Requires Python 3.10+ and Node 18+ on the host.

```bat
pip install openviking
openviking-server            :: serves API + Studio + MCP on http://127.0.0.1:1933
```

Create an account + user key via the Studio UI (`http://127.0.0.1:1933/studio`)
or the `ov` CLI — see OpenViking Authentication docs. Put the key in an env var:

```bat
setx MUSE_VIKING_KEY "vk-..."
```

Keep the server bound to loopback (default). Do NOT run it in `dev`/no-auth mode.

## 2. Muse config (`~/.muse-agent/config.toml`)

Muse's MCP client is stdio-only; OpenViking's MCP endpoint is Streamable HTTP,
so we bridge with `mcp-remote` (same pattern OpenViking uses for its own
agent-plugin proxies):

```toml
[mcp]
servers = ["viking"]

[mcp.server.viking]
command = "npx"
args = ["-y", "mcp-remote", "http://127.0.0.1:1933/mcp",
       "--header", "Authorization:${MUSE_VIKING_KEY}"]
env = []
timeout_s = 120
```

On agent start, muse logs `mcp server "viking" ready (N tools)`. Tools appear as
`mcp__viking__ls`, `mcp__viking__search`, `mcp__viking__write`, etc. Every call
still requires approval in the UI (MCP = ask, always).

If the server is down, muse just logs `mcp server "viking" failed to start` and
runs normally without the tools.

## 3. What changed in Muse (this spike)

- `config.example.toml` — commented-out `[mcp.server.viking]` block (above).
- `app/harness/agent.js` — `systemPrompt()` gains a `hasViking` flag; when
  `mcp__viking__*` tools are present, the system prompt tells the agent what
  they are for and to prefer viking for explicit saves (no double-storing).

No other code paths touched. MemoryLayer/agent.db untouched.

## 4. Evaluation plan

Run a few real sessions with typical tasks (remembering a preference, recalling
a project fact from an earlier session, searching past material). Check, per task:

1. Did the agent choose viking tools when appropriate? (session JSON tool calls)
2. Recall quality vs the sqlite memory layer's automatic injection.
3. Approval friction — MCP = always-ask; if it's too noisy, that's data.

Verdict gate for Phase 2 (viking as a real memory backend behind `openStore()`):
viking recall must clearly beat the current packer/scorer path. If not, remove
the config block and this spike ends here.

## 5. Phase 2 sketch (only if Phase 1 wins)

- `app/memory/adapters/vikingStore.js` implementing the store seam over the
  OpenViking REST SDK; config flag `memory.backend = "viking" | "sqlite"`.
- Loses: evidence-version machinery, row-pin embedding checks (do-not #8).
  OpenViking's L0/L1 summaries replace them — different guarantees, accept
  consciously.
- Old `agent.db` stays on disk untouched, as a readable archive.
- Portable exe: would require bundling or requiring the OpenViking server on
  the host — the main reason Phase 1 must prove value first.

## 6. Notes

- OpenViking is AGPLv3 (server); muse talks to it over MCP as a separate
  process. No muse code links it; Muse-Agent's license unaffected.
- OpenViking is Alpha (v0.3.x) — pin the version you evaluate against.
- mcp-remote may print a one-time browser OAuth-ish flow on first run in some
  versions; for pure header auth against loopback it should just connect. If it
  misbehaves, swap in OpenViking's own agent-plugins stdio proxy.
