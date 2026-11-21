---
name: Muse Agent
description: The direction for Muse Agent itself - the app you are looking at, and the artifacts it makes.
renderer: html
---

# Muse Agent

This file is the **direction** for Muse: the identity, the mood, the tokens. The
`antislop` rules are the **filter** that keeps the result from being generic.
Filter without direction leaves a sterile void, so read both: this file first,
then `antislop` for the craft rules.

## Identity

Muse is a **workbench**, not a chat window with a mascot. The person using it is
doing one of three things at once: asking, steering a run, or looking at what
the agent just changed. Every surface exists to serve one of those.

- **It is a tool, so it behaves like one.** Dense, fast, quiet. The tool shows
  its state instead of asking to be trusted.
- **The agent is the colleague, not the product.** The prompt is one column;
  the work (activity, memory, dashboards, design) lives beside it rather than
  inside the conversation.
- **Honest by construction.** No fake metrics, no invented claims, no
  placeholder numbers, no progress that is not progress. If a number is shown,
  it came from something real.

## Personality

Calm, specific, unsentimental. Muse says what happened, what it cost, and what
it did not do. It does not apologise twice, does not narrate its own virtues,
and does not greet the user like a customer service agent. Plain words, short
sentences, no exclamation marks, no emoji in the product chrome.

The voice is warmer than the interface, and deliberately so: the assistant may
be a colleague, the UI is a tool.

## Mood

Workbench at night: quiet, low-contrast chrome, one warm accent that marks the
live thing. Light mode is the same room with the curtains open - not a
different product.

## Colour (the app's own tokens)

| Role | Value | Where |
|---|---|---|
| Surface | `#fbfaf8` / `#141412` | app background, light / dark |
| Raised | `#ffffff` / `#1c1a17` | panels, cards, composer |
| Sunken | `#f2f0ec` / `#0f0e0d` | wells, code, inputs |
| Ink | `#1c1a17` / `#f2efe9` | primary text |
| Muted | `#6f6a62` / `#a49d93` | secondary text, labels |
| Hairline | `#e2ded7` / `#2a2724` | borders, dividers |
| Accent (live) | `#b4531f` / `#d97b45` | the running turn, focus ring, active state |
| Success | `#2f7a4d` | finished, healthy |
| Warning | `#a06a11` | needs attention, degraded |
| Danger | `#a52a2a` | failed, destructive |

- One accent per view. It marks the live thing and the focus ring - nothing else.
- Semantic colours are reserved for state. A green badge never means "nice".
- The `krishna` theme is a deliberate variant (temple palette, gold and indigo),
  not the house style; it exists for people who want it, and it keeps the same
  structure and the same contrast rules.

## Type

- UI text: system sans, 13 / 15 / 17 / 21 / 28 px, line-height 1.45
- Display: 28 px minimum, weight 600, letter-spacing -0.01em
- Body copy: max 68ch, never a paragraph wider than the column
- Numerals in tables and metrics: `font-variant-numeric: tabular-nums`
- Code and paths: monospace, but never as decoration

## Space and shape

- 4 px rhythm: 4 / 8 / 12 / 16 / 24 / 32 / 48
- Radius 8 px on controls, 12 px on cards, pill only for a real pill (a count,
  a status)
- 1 px hairline borders; elevation is a shadow on one layer, never two
- Controls 32 px compact, 40 px comfortable; the hit area is never under 32 px

## Behaviour

- Every interactive element has hover, active, focus-visible, disabled and
  loading states, because every one of them is reachable by keyboard
- The focus ring is 2 px accent with 2 px offset, and it is never removed
- Empty, loading, error and degraded states are designed, not improvised
- Motion is 120-220 ms ease-out; nothing animates on first paint except the
  one thing the person asked for
- The composer never traps the person: Stop answers immediately and the
  interface says the turn is stopping

## Accessibility

- 4.5:1 body contrast, 3:1 large text and non-text contrast, in every theme
- Real `<button>` and `<a>` elements, labelled inputs, one `<h1>` per view,
  landmarks for every region
- A keyboard path exists for every pointer action; nothing is hover-only
- Nothing moves, blinks or auto-scrolls without a reason and a way to stop it

## For artifacts Muse generates

Use the bundled design systems for generated work - `muse-default` for product
surfaces and internal tools, `editorial-flat` for documents, decks and
long-form. They carry their own tokens; this file carries the personality.
