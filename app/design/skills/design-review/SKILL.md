name: Design review
description: Structured critique pass over a design artifact before it is called done.

# Design review

Run against the artifact entry file and the active design system.

1. **Contract** — does `.od/artifact.json` exist, and does its `entry` open? Preview it before judging.
2. **Fidelity to the system** — colour, type scale, spacing rhythm and radius taken from DESIGN.md, not invented. List every deviation.
3. **States** — empty, loading, error, disabled, focus-visible, hover, long-content. Name the missing ones.
4. **Hierarchy** — can you tell the single primary action within 2 seconds? If two elements compete, say which to demote.
5. **Accessibility** — contrast 4.5:1 body / 3:1 large, labels on inputs, heading order, keyboard path, meaningful alt text, `:focus` visible.
6. **Content** — no placeholders, no lorem ipsum, no fake precision ("98.7%") without a source.
7. **Performance** — inline size, blocking scripts, layout-shifting images.

Output: `Blocking`, `Should fix`, `Polish` — three short lists, each item naming the file and the exact selector or line. Never rewrite the artifact while reviewing it; hand the list back.
