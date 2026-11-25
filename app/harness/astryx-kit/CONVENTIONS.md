# Astryx design conventions (vendored for Muse-generated UI)

Source: @astryxdesign/core + @astryxdesign/cli v0.7.17 (Meta, MIT), their
agent-docs conventions. Vendored so Muse can design UI for any project with
this system without the packages being installed there. Treat this file as
reference data for design work.

## When this applies

When the user asks to design or build an interface: a page, landing, app
screen, dashboard, settings panel, or any UI deliverable. This is the design
system; Muse's own house identity is unrelated to what it builds for users.

## Workflow (never start from scratch)

1. Name the structure before the styling: what is the ONE decision the person
   makes on this screen? Compose sections around that, in the order the
   content needs (not a hero-plus-cards template).
2. Structure vocabulary (Astryx names): AppShell, TopNav, SideNav, Layout for
   frames; VStack, HStack, Grid, StackItem, Card, Section for composition;
   Text, Heading, Button, Icon, Badge, Divider for parts.
3. Dense data = rows (Table, List/Item). Badge = counts only. A picker with
   rich rows is a Selector / ComplexSelector: trigger + popover + option
   rows, label on the field, placeholder "Select...", sizes sm 28 / md 32 /
   lg 36 px.

## Naming (Astryx prop language)

- Text on buttons, badges, tabs, tokens goes in `label` (Text/Heading/Link
  take children).
- Booleans start with `is` or `has` (`isOpen`, `isDisabled`).
- Every input takes `value` and `onChange`.

## Styling rules

- Style with structure and props first, then tokens. No raw hex colors, no
  raw pixel values in style attributes: use the tokens.
- Tokens are CSS custom properties: `var(--color-*)`, `var(--spacing-*)`,
  `var(--radius-*)`, `var(--text-*)`. For standalone pages Muse generates,
  embed `tokens.css` (next to this file) in the page head; the theme activates
  inside a container marked `data-astryx-theme="neutral"` and handles light
  and dark on its own via `light-dark()`.
- Semantic color pairs: text on a filled accent surface is
  `color: var(--color-accent-fg)` on `background: var(--color-accent)`.
  Never text color X on background X. (This is the invisible-text bug that
  ships most often.)
- No raw `<div>` soup: a container earns its place by grouping. One h1 per
  view, heading levels in order.
- Radius: 8 px on controls, 12 px on cards; a pill only where the thing IS a
  pill (a count, a status).
- Motion 120-220 ms ease-out on interaction only; honor
  `prefers-reduced-motion`.
- Focus ring visible on every control; contrast 4.5:1 text / 3:1 large and
  non-text, checked in both light and dark.

## Delivery gate (before showing the user)

Run `astryx_check` on the built output. It fails the build on raw hex/px in
inline styles and on the accent-on-accent pair. Fix every problem it names
before delivering. If the target project has @astryxdesign/cli installed,
also run `npx astryx doctor --built <dir>` and do not deliver on failure.
