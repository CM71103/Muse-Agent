# Muse Agent

A personal AI agent that runs entirely on your machine. Three layers, modeled on the architecture of nanoMuse Desktop (see `../nanomuse-desktop-analysis.md`):

1. **Electron shell** — chat window, approval dialogs, settings chips. Thin.
2. **Agent harness (Node)** — OpenAI-compatible LLM loop with tools: `shell`, `read_file`, `write_file`, `list_dir`, `web_fetch`, `hands`. Every call passes the **Sentinel** gate first.
3. **Hands sidecar (Python)** — screenshot / mouse / keyboard on `127.0.0.1:8788`, bearer-token auth, started on demand, off by default.

No cloud relay, no telemetry, no account. Your LLM key stays in an environment variable.

## Quick start

Requirements: Node 18+, Python 3.10+ (only if you enable hands), an OpenAI-compatible API key.

```
cd muse-agent
npm install            # installs electron
# pick your endpoint in config (defaults to DeepSeek), then:
set MUSE_LLM_API_KEY=sk-...      # Windows (or export on macOS/Linux)
npm start
```

The app creates `~/.muse-agent/config.toml` from `config.example.toml` on first run. Edit presets for OpenAI / OpenRouter / Ollama / LM Studio are inside that file.

Headless (no window):

```
node app/harness/cli.js "list the files in this directory and summarize what you find"
# approvals: interactive y/N prompt; or --yes to auto-approve (dangerous)
# after a turn: /good or /bad grades it for memory (when memory enabled)
```

Hands sidecar (only when enabling hands in the header chip):

```
cd python
pip install -r requirements.txt
# sidecar starts automatically when first hands action fires; manual start:
python -m muse_hands.server --port 8788
```

## Build a desktop installer (Windows)

```
cd muse-agent
npm install                 # electron + electron-builder
npm run dist                # NSIS installer + portable exe -> dist/
```

Outputs in `dist/`: `Muse Agent Setup 0.1.0.exe` (installer, desktop + start-menu shortcuts) and `MuseAgent-0.1.0-portable.exe` (single-file, no install). `npm run dist:dir` builds an unpacked folder only (fastest, good for testing).

What packaging does:

- `config.toml` ships inside the app as `resources/template.toml`; on first run it seeds `%USERPROFILE%\.muse-agent\config.toml` (your endpoint + key baked in at build time — rebuild if you change it).
- `python/` ships as `resources/python/`; the hands sidecar runs from there when enabled.
- Sessions persist in `%USERPROFILE%\.muse-agent\sessions\` across restarts.
- No code signing configured — SmartScreen warns on first run. Click "More info → Run anyway".

## The Sentinel

Every tool call goes through, in order:

1. **Deny rules** — glob patterns (`*rm -rf*`, `*format *`, …) matched against the whole rendered call. Match = instant deny, model never sees it run.
2. **Always-ask tools** — `shell` (and `hands`, which is itself off unless enabled) prompt you in the UI. Timeout (default 1 h) = deny.
3. **Taint-lite egress** — after the agent reads a file under your home directory, `web_fetch` is limited to the allowlist in config (duckduckgo.com, wikipedia.org, github.com, pypi.org by default).

Keep `sentinel.mode = "ask"`. `mode = "auto"` removes approval prompts; only deny rules remain.

## Security notes — read before enabling anything

**On Windows, approved shell commands run unsandboxed with your user permissions.** There is no bubblewrap equivalent in v0.1 (nanoMuse has the same limitation: its bubblewrap sandbox is Linux-only). Treat an approval like handing someone your keyboard for one command.

Hands gives the model screenshots of your screen and the ability to move your mouse and type. It is off by default; when on, every action still asks. Don't enable it while you have passwords, banking, or anything sensitive visible.

The sidecar binds `127.0.0.1` only and requires a bearer token generated once into `~/.muse-agent/hands_token` (mode 600). Nothing off-host can reach it.

No code signing (hobby project) — Windows SmartScreen will warn if you package the app.

## Memory (adaptive, Phase 0)

Optional per-project memory, OFF by default. Turn on in config:

```
[memory]
enabled = true
budget_tokens = 1200       # fixed per-turn allowance (spec §4.3 clamp)
score_cutoff = 0.20
project_id_strategy = "auto"   # Git root -> opaque project id
embed_model = "text-embedding-3-small"
embed_dims = 1536
```

What it does, Phase 0 baseline:

- Ingests your messages and tool results (idempotent by event id), classifies provenance (`user`/`tool`/`imported`/`unknown`) and trust tier.
- Instruction-shaped content from non-user provenance is **quarantined** until you review it in the app; your own words are never quarantined.
- Before each turn it embeds the query, scores active rows `sim * (mu + 0.5*sigma)`, and packs the best under a hard token budget. May clamp to zero tokens — normal, not an error.
- Retrieved memories ride as a delimited, labeled **data block** on the system prompt — never instructions, never tool authority.
- Cite with `[c1]`, `[c2]`… in replies; the app tracks what was actually sent vs. cited.
- After each turn: `/good` records a positive grade for the turn, `/bad` records a negative one. Silence records nothing. One immutable grade per turn. Baseline records grades without applying them (adaptive ranking comes later).
- Deletion is logical removal only — no promises of secure erasure. Storage: `~/.muse-agent/memory/memory.json` (JSON, no native deps).

In the app: memory chip in the header shows project/rows health; the memory panel lists rows with status + provenance, with delete and quarantine-review actions.

## Layout

```
muse-agent/
  app/main/index.js        Electron main: window, IPC, approval plumbing
  app/main/preload.js      contextBridge surface (window.muse)
  app/renderer/            single-file chat UI
  app/memory/              adaptive memory layer (R-49 host contract)
    layer.js                 MemoryLayer facade: requestContext/ack/complete/grade
    core/                    posterior, packer, scorer, citations
    adapters/                JSON store, tokenizer, embeddings client
  app/harness/
    config.js              TOML loader + defaults
    llm.js                 OpenAI-compatible chat client (no SDK)
    agent.js               the loop: LLM -> tool_calls -> Sentinel -> execute
    sentinel.js            deny rules, always-ask, taint egress gate
    tools.js               shell / fs / web_fetch / hands tools
    hands_client.js        sidecar client, auto-start, health wait
    cli.js                 headless runner
  python/muse_hands/
    server.py              aiohttp sidecar (stdlib fallback), token auth
    actions.py             pyautogui/mss primitives
  config.example.toml      full annotated config
```

## Differences from nanoMuse (deliberate)

- No cloud account/relay, no device-hub, no plugin marketplace — local-only v1.
- No phone control, no push, no bundled skills. Those are nanoMuse's China-market surface; this is the generic core.
- Same approval-first posture: always-ask shell, deny rules out of the box, taint-tracked egress, off-by-default hands.

MIT licensed. Use responsibly: it can do anything you approve.
