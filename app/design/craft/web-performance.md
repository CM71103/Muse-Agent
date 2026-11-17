id: web-performance
name: Web performance craft
description: Budget rules for artifacts that run in a browser.

# Performance

- Single-file artifacts stay under 200 KB of HTML+CSS+JS; no CDN frameworks for static pages.
- No render-blocking third-party scripts. Inline critical CSS; defer the rest.
- Images: `width`/`height` set to avoid layout shift; SVG for graphics, `loading="lazy"` below the fold.
- Fonts: system stack unless a webfont earns its 100 ms; `font-display: swap` with a metrics-matched fallback.
- Animation on `transform`/`opacity` only; never `top`, `left`, `width`, `height` per frame.
- Scroll handlers `passive`, resize handlers debounced, observers instead of polling.
- Interaction under 100 ms, first contentful paint under 1.5 s on a warm local server.
- Measure before claiming: no "optimized for performance" without a number behind it.
