'use strict';
// Verbatim extraction of visual-explainer kit/look.mjs (v0.15.0, MIT, by
// nicobailon — https://github.com/nicobailon/visual-explainer): the in-page
// check functions (serialized into the page with toString()) and the sheet
// packer. Upstream lines 9-15 and 39-249, unchanged, except this header.

const WIDTHS = [390, 1280];
const MIN_LABEL = 12;
const MIN_HEADING_GAP = 8;
// ≈1.15 megapixels, the most a model takes in before it scales an image down
const SHEET_W = 1200, SHEET_H = 960, PAD = 16, GAP = 12, LABEL = 22, MAX_SHEETS = 3;
// a font still downloading after load must not hold the render; a late font only shifts glyphs slightly
const fontsReady = () => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]);

// Runs in the page: the smallest rendered SVG label, overflow, figure and prose counts, and whether the kit's script finished.
function measure(minLabel) {
  let smallest = null;
  for (const t of document.querySelectorAll("svg text")) {
    if (!t.textContent.trim() || !t.checkVisibility({ visibilityProperty: true })) continue;
    const m = t.getScreenCTM();
    if (!m) continue;
    const px = parseFloat(getComputedStyle(t).fontSize) * Math.hypot(m.a, m.b);
    if (!smallest || px < smallest.px) smallest = { px: Math.round(px * 100) / 100, text: t.textContent.trim().slice(0, 40) };
  }
  // SVG text with no fill gets the default black, which no kit token is; it vanishes on a dark scheme. A page whose own text is black is exempt.
  const black = "rgb(0, 0, 0)";
  const unfilled = getComputedStyle(document.body).color === black ? [] : [...document.querySelectorAll("svg text")].filter((t) => t.textContent.trim() && !t.closest("defs, marker, symbol, clipPath, mask, pattern") && t.checkVisibility() && getComputedStyle(t).fill === black);
  let prose = 0;
  for (const p of document.querySelectorAll("p, li")) if (!p.closest("figure") && !p.parentElement.closest("p, li")) prose += p.textContent.trim().split(/\s+/).filter(Boolean).length;
  return {
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    smallest,
    small: smallest !== null && smallest.px < minLabel,
    unfilled: unfilled.length ? { n: unfilled.length, text: unfilled[0].textContent.trim().slice(0, 40) } : null,
    figures: document.querySelectorAll("figure").length,
    prose,
    kit: document.documentElement.dataset.veKit === "ready",
  };
}

// Runs in the page: visible text that overlaps other text or runs past its drawing, in one stepper (r) or in every drawing.
function inspect(r) {
  const figs = [...document.querySelectorAll("main figure")];
  const scope = r === null ? document : document.querySelectorAll(".ve-steps")[r];
  const short = (s) => s.trim().replace(/\s+/g, " ").slice(0, 32);
  const name = (svg) => {
    const f = svg.closest("figure"), i = figs.indexOf(f);
    const capEl = f?.querySelector("figcaption");
    const capText = capEl ? [...capEl.childNodes].filter((n) => !n.classList?.contains("fig-n")).map((n) => n.textContent).join("") : "";
    const cap = short(capText || svg.getAttribute("aria-label") || "");
    return `${i >= 0 ? `Fig ${i + 1}` : "A drawing"}${cap ? ` ("${cap}…")` : ""}`;
  };
  const found = [];
  // A text's box is its em box; the letters sit in about its middle 56%, so two stacked labels can touch boxes without touching letters.
  const ink = (t) => { const r = t.getBoundingClientRect(), d = r.height * 0.22; return { left: r.left + 1, right: r.right - 1, top: r.top + d, bottom: r.bottom - d }; };
  const area = (r) => (r.right - r.left) * (r.bottom - r.top);
  // two texts that overlap are fine when an opaque shape painted between them covers the lower one (a job card over an idle slot)
  const covered = (ta, tb) => {
    const mid = (a, b) => [(Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2, (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2];
    scrollBy(0, mid(ink(ta), ink(tb))[1] - innerHeight / 2);
    const stack = document.elementsFromPoint(...mid(ink(ta), ink(tb)));
    const ia = stack.findIndex((e) => ta.contains(e)), ib = stack.findIndex((e) => tb.contains(e));
    if (ia < 0 || ib < 0) return true;
    return stack.slice(Math.min(ia, ib) + 1, Math.max(ia, ib)).some((e) => {
      if (!(e instanceof SVGGeometryElement) || e instanceof SVGTextContentElement) return false;
      const cs = getComputedStyle(e);
      return cs.fill !== "none" && parseFloat(cs.fillOpacity) >= 0.9 && parseFloat(cs.opacity) >= 0.9;
    });
  };
  // A label a border or line runs through or touches: a visible point of a shape's outline lies in the label's ink box, or within
  // TOUCH px of its ends. A label fully inside a shape (a node's name) or clear of it never has one there. A point is not visible
  // when an opaque shape painted later covers it (an edge under a callout's disc). A label with a --bg halo (paint-order: stroke,
  // like .ve-el) is drawn to sit on what was painted before it, and a label wholly under an opaque shape painted after it is hidden.
  // A line under 1.6:1 against the page (a --border rule, a ledger, a grid) is decoration, not a crossing.
  const crossed = (svg, texts) => {
    const TOUCH = 4;
    const seen = (e) => { let o = 1; for (let n = e; n && n !== svg.parentElement; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
    const later = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    const lum = (c) => {
      const n = (c.match(/rgba?\(([^)]*)\)/)?.[1] ?? c.match(/color\(srgb ([^)]*)\)/)?.[1] ?? "").split(/[\s,/]+/).filter(Boolean).map(Number);
      if (n.length < 3 || n.some(Number.isNaN)) return null;
      const [r, g, b] = (/^rgb/.test(c) ? n.slice(0, 3).map((v) => v / 255) : n.slice(0, 3)).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const probeBg = document.createElement("i"); probeBg.style.color = "var(--bg, #fff)"; document.body.append(probeBg);
    const bg = lum(getComputedStyle(probeBg).color) ?? 1; probeBg.remove();
    const faint = (c) => { const l = lum(c); return l !== null && (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05) < 1.6; };
    const shapes = [];
    for (const e of svg.querySelectorAll("rect, circle, ellipse, line, polyline, polygon, path")) {
      if (e.closest("defs, marker, symbol, clipPath, mask, pattern, text") || !e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || seen(e) < 0.3) continue;
      // a filled path is an area even without a closing z (a datastore's body); a line, a polyline, or an unfilled open path is a line
      const cs = getComputedStyle(e), filled = cs.fill !== "none" && !(e instanceof SVGLineElement) && !(e instanceof SVGPolylineElement);
      const open = !filled && !(e instanceof SVGPathElement && /z\s*$/i.test(e.getAttribute("d") ?? "")) && !(e instanceof SVGRectElement || e instanceof SVGCircleElement || e instanceof SVGEllipseElement || e instanceof SVGPolygonElement);
      const stroked = cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0 && parseFloat(cs.strokeOpacity) >= 0.3 && !faint(cs.stroke);
      const opaque = filled && parseFloat(cs.fillOpacity) >= 0.9 && seen(e) >= 0.9;
      const edged = stroked || (filled && parseFloat(cs.fillOpacity) >= 0.5 && !faint(cs.fill));
      if (!edged && !opaque) continue;
      const m = e.getScreenCTM(), inv = m.inverse(), len = e.getTotalLength(), step = 1.5 / (Math.hypot(m.a, m.b) || 1), pts = [];
      if (edged) for (let s = 0; s <= len; s += step) { const p = e.getPointAtLength(s); pts.push(new DOMPoint(p.x, p.y).matrixTransform(m)); }
      shapes.push({ e, pts, opaque, open, inside: (p) => e.isPointInFill(new DOMPoint(p.x, p.y).matrixTransform(inv)) });
    }
    const covers = (o, p) => o.opaque && o.inside(p);
    const out = [];
    for (const { t, s } of texts) {
      // measured again: the overlap check above may have scrolled the page since texts were measured
      const b = ink(t);
      if (seen(t) < 0.3) continue;
      const cs = getComputedStyle(t), halo = cs.paintOrder.startsWith("stroke") && cs.stroke !== "none" && parseFloat(cs.strokeWidth) >= 3;
      const probe = [[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom], [(b.left + b.right) / 2, (b.top + b.bottom) / 2]].map(([x, y]) => ({ x, y }));
      if (shapes.some((o) => later(t, o.e) && probe.every((p) => covers(o, p)))) continue;
      let worst = null;
      for (const sh of shapes) {
        if (halo && !later(t, sh.e)) continue;
        for (const p of sh.pts) {
          if (p.x < b.left - TOUCH || p.x > b.right + TOUCH || p.y < b.top + 1 || p.y > b.bottom - 1) continue;
          if (shapes.some((o) => o !== sh && later(sh.e, o.e) && covers(o, p))) continue;
          const through = p.x > b.left && p.x < b.right;
          if (!worst || (through && !worst.through)) worst = { through, open: sh.open };
          if (through) break;
        }
        if (worst?.through) break;
      }
      if (worst) out.push(`"${s}": label ${worst.through ? "crossed by" : "touches"} a ${worst.open ? "line" : "border"}`);
    }
    return out;
  };
  for (const svg of scope.querySelectorAll("svg")) {
    if (svg.parentElement.closest("svg") || !svg.closest("main")) continue;
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const texts = [...svg.querySelectorAll("text")]
      .filter((t) => t.textContent.trim() && t.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      .map((t) => ({ t, s: short(t.textContent), b: ink(t) }))
      .filter(({ b }) => b.right > b.left && b.bottom > b.top);
    // a drawing with overflow: visible (the data tags) paints past its box on purpose
    if (getComputedStyle(svg).overflow !== "visible") {
      for (const { s, b } of texts) {
        if (b.left < box.left - 1 || b.right > box.right + 1 || b.top < box.top - 1 || b.bottom > box.bottom + 1) found.push({ where: name(svg), what: `"${s}" runs past the edge of its drawing` });
      }
    }
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].b, b = texts[j].b;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1 && x * y > 0.1 * Math.min(area(a), area(b)) && !covered(texts[i].t, texts[j].t)) found.push({ where: name(svg), what: `"${texts[i].s}" overlaps "${texts[j].s}"` });
    }
    // charts and Pele's Mermaid put labels on their shapes by design, and the agent cannot move them
    if (!svg.matches(".ve-bars, .ve-waffle, .ve-stack, .pele")) found.push(...crossed(svg, texts).map((what) => ({ where: name(svg), what })));
  }
  scrollTo(0, 0);
  return found;
}

// Runs in the page: an h2 closer than minGap to what follows it.
function headings(minGap) {
  const found = [];
  for (const h of document.querySelectorAll("main h2")) {
    const block = h.parentElement.matches(".sec-head") ? h.parentElement : h;
    const next = block.nextElementSibling;
    if (!next || !next.checkVisibility()) continue;
    const gap = next.getBoundingClientRect().top - h.getBoundingClientRect().bottom;
    if (gap < minGap) found.push(`the heading "${h.textContent.trim().replace(/\s+/g, " ").slice(0, 40)}" sits ${Math.max(0, Math.round(gap))} px from the ${next.tagName.toLowerCase()} below it`);
  }
  return found;
}

// Runs in the page: moves stepper r to step k (0-based) with its own controls. False when it has none.
function goStep([r, k]) {
  const root = document.querySelectorAll(".ve-steps")[r];
  const n = root.querySelectorAll(".ve-cap li").length;
  const range = root.querySelector("input[type=range]");
  if (range) { range.value = k; range.dispatchEvent(new Event("input", { bubbles: true })); return true; }
  const go = [...root.querySelectorAll("[data-go]")];
  const prev = go.find((b) => +b.dataset.go < 0), next = go.find((b) => +b.dataset.go > 0);
  if (!prev || !next) return false;
  for (let i = 0; i < n; i++) prev.click();
  for (let i = 0; i < k; i++) next.click();
  return true;
}

const pngSize = (png) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

// Lays the crops out in rows on sheets of at most SHEET_W × SHEET_H: the first screens, then each figure, then each stepper's steps
// as thumbnails. A page with more than fits on MAX_SHEETS is drawn smaller before anything is left out.
function layout(items) {
  const inner = SHEET_W - 2 * PAD, tallest = SHEET_H - 2 * PAD - LABEL;
  const pack = (figScale, stepCols) => {
    const rows = [];
    for (const it of items) {
      const scaled = it.cells.map((c) => {
        const s = it.kind === "overview" ? 0.62 : it.kind === "steps" ? (inner - GAP * (stepCols - 1)) / stepCols / c.w : figScale;
        return { ...c, s: Math.min(1, s, inner / c.w, tallest / c.h) };
      });
      // each group starts a row; its cells flow left to right
      let row = [], width = -GAP;
      for (const c of scaled) {
        const w = Math.round(c.w * c.s) + GAP;
        if (row.length && width + w > inner) { rows.push(row); row = []; width = -GAP; }
        row.push(c); width += w;
      }
      if (row.length) rows.push(row);
    }
    return rows;
  };
  let rows = [];
  for (const [figScale, stepCols] of [[0.8, 3], [0.65, 4], [0.55, 5]]) {
    rows = pack(figScale, stepCols);
    if (toSheets(rows).length <= MAX_SHEETS) break;
  }
  const sheets = toSheets(rows);
  return { sheets: sheets.slice(0, MAX_SHEETS), omitted: sheets.slice(MAX_SHEETS).flat().flat().length };
}

function toSheets(rows) {
  const sheets = [];
  let cur = [], height = 2 * PAD - GAP;
  const rowH = (row) => LABEL + Math.max(...row.map((c) => Math.round(c.h * c.s)));
  for (const row of rows) {
    const h = rowH(row) + GAP;
    if (cur.length && height + h > SHEET_H) { sheets.push(cur); cur = []; height = 2 * PAD - GAP; }
    cur.push(row); height += h;
  }
  if (cur.length) sheets.push(cur);
  return sheets;
}


module.exports = { WIDTHS, MIN_LABEL, MIN_HEADING_GAP, SHEET_W, SHEET_H, PAD, GAP, LABEL, MAX_SHEETS,
  fontsReady, measure, inspect, headings, goStep, pngSize, layout, toSheets };
