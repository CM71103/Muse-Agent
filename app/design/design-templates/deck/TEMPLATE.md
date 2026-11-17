name: Deck
description: Keyboard-driven slide deck in one HTML file, with overview grid and presenter progress.
renderer: html
files: index.html

# Deck

`index.html` holds 6–12 `<section class="slide">` panels. Arrow keys / space advance, `Home`/`End` jump, `O` toggles an overview grid, a progress bar shows position, and each slide carries a `data-title`.

One idea per slide, headline ≤ 8 words, no paragraph under a chart, and `prefers-reduced-motion` disables slide transitions. Export-friendly: `@media print` renders one slide per page.
