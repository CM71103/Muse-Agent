name: Muse default
description: Neutral product surface with a warm accent; the house style for prototypes and internal tools.
renderer: html

# Muse default

Tokens to use unless the project's own DESIGN.md overrides them.

## Colour
- Surface `#fbfaf8`, raised `#ffffff`, sunken `#f2f0ec`
- Ink `#1c1a17`, muted `#6f6a62`, hairline `#e2ded7`
- Accent `#b4531f` (actions, focus, active), accent-soft `#fbeee5`
- Success `#2f7a4d`, warning `#a06a11`, danger `#a52a2a`
- Never exceed one accent per view; semantic colours are reserved for state.

## Type
- UI text: system sans stack, 13/15/17/21/28 px scale, line-height 1.45
- Display headings: 28 px minimum, weight 600, letter-spacing -0.01em
- Body copy max-width 68ch; numerals `font-variant-numeric: tabular-nums` in tables

## Space and shape
- 4 px rhythm: 4 / 8 / 12 / 16 / 24 / 32 / 48
- Radius 8 px on controls, 12 px on cards; borders 1 px hairline, no double shadows
- Controls 32 px compact, 40 px comfortable; hit area never below 32 px

## Behaviour
- Every interactive element has hover, active, focus-visible, disabled and loading states
- Focus ring 2 px accent with 2 px offset; never remove it
- Empty, loading and error states are designed, not improvised
- Motion 120–220 ms ease-out; nothing animates on first paint except the primary task

## Accessibility
- 4.5:1 body contrast, 3:1 large text and non-text contrast
- Real `<button>`/`<a>` elements, labelled inputs, one `<h1>` per page, landmarks for regions
- Keyboard path exists for every pointer action; no hover-only affordances
