# astryx-kit

Vendored reference + tokens so Muse can design UI with the Astryx design
system in any project, without that project installing anything.

| File | From | License |
|---|---|---|
| `CONVENTIONS.md` | Distilled from `@astryxdesign/cli@0.7.17` agent docs (`astryx init` output) and `astryx component ComplexSelector` | MIT (astryx docs text, adapted) |
| `tokens.css` | `@astryxdesign/theme-neutral@0.7.17` `dist/theme.css`, byte-identical copy | MIT (Meta) |

Source repo: https://github.com/meta/astryx

Notes:
- `tokens.css` is generated upstream (`astryx theme build`); do not hand-edit.
  Replace wholesale on upgrade (`npm view @astryxdesign/theme-neutral version`).
- The tokens activate only inside a container marked
  `data-astryx-theme="neutral"` (upstream `@scope`), so embedding the file in
  a generated page is safe: the rest of the page is untouched.
- Upstream components (Button, Selector, ...) are React and are NOT vendored
  here; Muse applies the system's structure, tokens and rules to generated
  HTML. Component-accurate behavior (focus restore, changeAction flows) is
  Muse's to implement where it matters.
