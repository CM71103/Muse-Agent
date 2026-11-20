# Vendored: visual-explainer

Everything in `kit/`, `plan/` and `references/` is vendored, byte-for-byte,
from **visual-explainer** by Nico Bailon — https://github.com/nicobailon/visual-explainer
— under the MIT license (see `LICENSE` in this directory).

Upstream version: v0.15.0 (snapshot of `main`, 2026-07-18).

Muse Agent's own integration code lives beside this directory:

- `../visual-tools.ts` — the agent-facing `visual_kit_docs` / `visual_render` tools
- `../visual-look.ts` — harness side of the browser QA capture
- `../../main/visual-look-service.js` — Electron side: hidden window, page
  checks, contact sheets (checks adapted from `kit/look.mjs`, MIT)

`kit/look.mjs` is vendored but unused at runtime: Muse captures pages with the
Electron host service instead of playwright-core (`visual-look-service.js`
carries the same in-page checks and sheet layout).

When updating, replace `kit/`, `plan/`, `references/` wholesale from a new
upstream release and re-check that `kit/render.mjs` imports still resolve
(`./html.mjs`, `./flow.mjs`, `./machine.mjs`, `./ask.mjs`, `./tags.mjs`,
`./vendor/pele.mjs`, `../plan/render.mjs`).