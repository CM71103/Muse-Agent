name: Accessibility audit
description: WCAG 2.1 AA sweep of an artifact with concrete repairs.

# Accessibility audit

- Tab through in order. Every stop is visible (2 px focus ring, 2 px offset) and reachable; no traps, no orphan widgets.
- Landmarks: header/nav/main/footer, one h1, headings nested without skipping levels.
- Forms: each control labelled (label for or aria-labelledby), errors associated with aria-describedby, required marked with aria-required.
- Contrast: body 4.5:1, large text and UI parts 3:1. Include disabled text in the check but never rely on colour alone.
- Images: meaningful ones get alt, decorative ones get alt="". Charts need a text or table alternative.
- Motion: prefers-reduced-motion disables loops and parallax; autoplaying media is pausable.
- Live regions only for status that changes (role=status, aria-live=polite), never for decoration.
- Report findings as selector → problem → fix. Apply the fixes only when asked to.
