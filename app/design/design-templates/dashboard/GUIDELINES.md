# Dashboard guidelines

These rules outrank your defaults for this project.

## Numbers
- Every metric shows its unit and its period (e.g. "Active users · last 30 days"). Never a bare number with no scope.
- Percentages carry the denominator somewhere visible. A change indicator says "vs. previous 30 days".
- Missing data is `-`, never `0`. Zero and no-data look identical otherwise.

## Reading
- Tabular numerals (`font-variant-numeric: tabular-nums`) so columns align digit by digit.
- Right-align numbers, left-align text. Dates in one format throughout.
- A metric row shows 2–5 metrics, not 12. If there are more, the extras belong in the table's filters.
- Chart axis labels carry units; a legend duplicates colour meaning that is already labelled.

## State
- Loading, empty and error are three different screens and all three must exist. The error screen offers retry next to the message.
- The empty state says what would appear here and how to make it appear ("No orders in the last 30 days — widen the date range").

## Scale
- Sortable columns get a visible affordance and an announced direction.
- Pagination shows "41–60 of 318", never just page numbers.
- Row actions sit in the last column, revealed on hover or focus — never hidden from keyboard users.
