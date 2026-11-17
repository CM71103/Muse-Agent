id: design-quality
name: Design quality bar
description: Universal craft rules that apply to every artifact, whatever the design system.

# Craft

- Ship a working thing, not a mockup. Buttons do something; forms validate; links resolve.
- Real content only. No lorem ipsum, no "Jane Doe", no fake metrics that imply a dataset.
- Every state exists: empty, loading, error, partial, success. Say what happened and what to do next.
- Alignment is deliberate. Nothing is nudged by one pixel to fake balance; use the grid.
- Density matches the task: dashboards tight, marketing generous. Never both in one view.
- Truncation is designed (ellipsis with a title or expansion), never clipped mid-word.
- Long strings, zero, negative numbers, RTL text and 3-digit counts must not break the layout.
- One primary action per view. Secondary actions visually subordinate to it.
- Icons need labels or tooltips; colour alone never carries meaning.
- Numbers, dates and currency formatted for the reader's locale and aligned in columns.
- Responsive at 1440, 1024, 768 and 375 px before calling it done.
- Delete unused styles and dead markup that a screenshot can't tell apart from live UI.
