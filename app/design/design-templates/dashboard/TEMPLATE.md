name: Dashboard
description: Dense data surface with filters, a metric row, a table with sorting and an empty/error state.
renderer: html
files: index.html, dashboard.js

# Dashboard

`index.html` renders a header with filters (date range, search, one multi-select), a metric row, a primary chart, then a sortable table with sticky header, tabular numerals, pagination and row actions.

All controls have real behaviour against in-page sample data: filtering narrows the table, sorting reorders it, an empty result shows a designed empty state, and a failed load shows an error state with retry. Sample data must look plausible, not decorative.
