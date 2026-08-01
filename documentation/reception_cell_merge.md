# Implementation Plan: Visually Merging Adjacent Same-Role Slots in the Reception Grid

## Plan

A reception day is **twenty half-hour slots** (`RECEPTION_HOURS`, 8 → 17.5 — see
`documentation/architecture-reception.md`, Decision 15). A staff member on Phones all
day therefore renders twenty identical chips in twenty separately-bordered cells. The
grid is dense and hard to scan, and the repetition carries no information.

This plan removes the repetition **without merging the cells**. Every slot keeps its own
`<td>`; a slot that repeats the previous slot's `(role, note)` pair simply renders no
visible chip and drops the vertical divider between itself and its predecessor. A run
reads as one wide undivided cell carrying a single chip at its left edge.

### Why not `<td colSpan={n}>`

A merged `<td>` is one click target for up to twenty slots, and the grid's entire
interaction model — selection, highlighting, per-slot editing — is keyed on
`1 cell = 1 slot`:

- **Per-slot editing would be lost.** With one `<td>` per run there is no gesture that
  addresses a single half hour. A staff member on Phones 08:00–18:00 could not have
  10:00–10:30 changed to Lunch without deleting and rebuilding the whole run. Restoring
  it means rendering N invisible per-slot hit zones *inside* the merged cell — i.e.
  reimplementing table columns as a flex row, at which point `colSpan` has bought
  nothing.
- **Partial highlights become unexpressible.** A shift-click range can start or end
  mid-run. `colSpan` cannot highlight half a cell; per-slot `<td>`s already can.
- **The selection model would need re-deriving.** `{staffId, anchorHour, focusHour}` and
  `selectedRangeHours` are hour-keyed and were deliberately designed that way
  (`documentation/reception_range_select.md`, Decision 1).
- **73 references to `data-testid="reception-cell-${staffId}-${hour}"` across five files**
  (including both page test suites) assume one cell per slot.

Suppressing the repeat instead touches ~40 lines, changes no DOM identity, breaks no
existing test, and leaves every gesture working exactly as it does today.

**Accepted tradeoff:** the chip sits at the run's left edge, not centred across the run.
On a twenty-column grid, labels lining up at run starts arguably scans better, but it
is a real change and Task 2 checks it in a browser before this is called done.

## Scope

Frontend display only. No backend, API, data-model, query, or mutation change: slots stay
stored and edited per half hour, and the merge is computed at render time from data the
grid already has.

Applies to both `ReceptionMasterPage` (weekday template) and `ReceptionDayPage`
(generated day), which share `ReceptionGrid` unchanged.

**Out of scope:**

- `colSpan` merging in any form (see above).
- Merging absent cells (Design Decision 3 below).
- Any change to selection, shift-click range select, the popover, or the write path.
- Unifying with the clinical `RotaGrid`/`MasterRotaGrid` — Decision 12 in
  `documentation/architecture-reception.md` says these grids duplicate deliberately.
- Row-level or cross-staff merging.

## Design Decisions

**1. The merge key is `(role, note)`, both must match.** Merging on role alone would mean
either showing one slot's note for a run whose slots carry different notes, or silently
hiding user-entered text from the only view that displays it. Notes are rare, so runs
still merge nearly as often. `note` is `string | null` and the popover writes `null` for
an empty trimmed note (`ReceptionCellPopover.tsx`), so `null` and `""` should not both
occur — compare `(a.note ?? "") === (b.note ?? "")` anyway rather than relying on that.

**2. Suppression is per slot, computed against the immediately preceding slot only.** A
slot repeats if the slot before it in `RECEPTION_HOURS` order has a session with the same
merge key. No run objects, no start/length bookkeeping — the flag is all the renderer
needs, and it makes the rule trivially unit-testable.

**3. Absent cells never merge, with each other or with anything else.** Two reasons.
First, an absent cell is *data* — "not expected this slot", `pivotReception.ts` and
Decision 3 — and is a genuinely different state from a `not_working` session (Decision
13); one grey block spanning both would conflate them. Second, every absent cell owns a
`+` button with a per-slot `aria-label` (`Add session for AB 08:00-08:30`); collapsing
twenty of them into one affordance would mean a single click creating twenty sessions.
Absent cells have no chip to repeat, so they are not the problem being solved.

**4. The hidden chip uses `visibility: hidden`, not conditional rendering, and it is
applied to the content *inside* the popover trigger, never to the trigger itself.**
Removing the content outright collapses the trigger's box to zero height and the cell
stops opening its popover. Putting `invisible` on the trigger `<div>` is worse:
`visibility: hidden` also disables pointer events, so continuation cells would become
unclickable — losing exactly the per-slot editing this approach was chosen to preserve.
Hiding the content one level in keeps the trigger visible and hit-testable while
preserving the layout box, and `visibility: hidden` correctly removes the repeated label
from the accessibility tree, so a screen reader hears the role once per run.

**5. The role colour stays on the chip; the `<td>` background is not tinted.** A
full-width role tint would read as a stronger band, but the selection highlight is
`bg-accent/10` on the same element, and two same-specificity Tailwind background classes
in one `className` string resolve by stylesheet order, not attribute order. Keeping the
role colour on the chip and letting the *absence of internal dividers* carry the run
avoids that collision entirely. If Task 2's browser check finds long runs unreadable, the
documented fallback is a role tint on run cells with the selection ring (not its
background tint) as the selection cue — a follow-up decision, not part of this change.

**6. Cell identity is unchanged.** `data-testid="reception-cell-${staffId}-${hour}"` stays
one per slot, so existing tests, the selection code, and the payload composition are all
untouched. Continuation cells gain `data-run-continuation="true"` so tests can assert on
an attribute rather than a class name — the same convention `data-selected` follows.

**7. Existing tests pass unchanged, and two of them are updated anyway.** No current
assertion breaks: every chip-click target in the suites is a lone session with no
neighbour, and `getByText(...).toBeInTheDocument()` still matches `visibility: hidden`
content. But `ReceptionDayPage.test.tsx` and `ReceptionMasterPage.test.tsx` each assert
that several slots show "Phones" after a range save — under this change most of those
chips are hidden, so those assertions would pass by accident while documenting the
opposite of the new behaviour. They get tightened rather than left alone.

---

# Task 1: Run detection and chip suppression in `ReceptionGrid`

**A. State of the world.** Nothing is implemented. `ReceptionGrid.tsx` renders one `<td>`
per entry in `RECEPTION_HOURS` per staff row, each looking its session up via
`getReceptionCell`, each rendering `CellContent` (role chip + optional note) and each
carrying `border-r-2` except the last column. This task adds the run-continuation
derivation and wires it into the renderer. It touches nothing else — no selection, no
click handling, no props, no page, no backend.

**B. Files and deliverables**

| File | Action |
|---|---|
| `frontend/src/lib/receptionRuns.ts` | New — `receptionRunContinuations` |
| `frontend/src/lib/receptionRuns.test.ts` | New — unit tests for the above |
| `frontend/src/components/ReceptionGrid.tsx` | Edit — per-row flags, chip suppression, divider suppression, `data-run-continuation` |
| `frontend/src/components/ReceptionGrid.test.tsx` | Edit — rendering and per-slot-editing tests |
| `frontend/src/routes/ReceptionMasterPage.test.tsx` | Edit — tighten one existing assertion |
| `frontend/src/routes/ReceptionDayPage.test.tsx` | Edit — tighten one existing assertion |

**C. Instructions**

**C1. The derivation.** New module — deliberately not part of `pivotReception.ts`, whose
output is an unordered `(staffId, hour)` lookup map with no row ordering; run detection
needs the row in `RECEPTION_HOURS` order and is a separate concern.

```ts
// frontend/src/lib/receptionRuns.ts
import type { ReceptionCellData } from "@/lib/pivotReception";

/**
 * One flag per slot, in the order given (always RECEPTION_HOURS order):
 * true when the slot repeats the previous slot's (role, note) pair and
 * should therefore render no visible chip. Both slots must have a
 * session - an absent cell is data ("not expected this slot"), never a
 * run member, so it neither continues a run nor is continued by one.
 */
export function receptionRunContinuations<T extends ReceptionCellData>(
  rowCells: readonly (T | undefined)[],
): boolean[] {
  return rowCells.map((cell, index) => {
    const previous = index === 0 ? undefined : rowCells[index - 1];
    if (cell === undefined || previous === undefined) return false;
    return cell.role === previous.role && (cell.note ?? "") === (previous.note ?? "");
  });
}
```

Take the row as a plain array rather than the grid plus a staff id, so the tests need no
pivot fixture.

**C2. Grid wiring.** Inside the `grid.rows.map` body, above the `RECEPTION_HOURS.map`:

```ts
const rowCells = RECEPTION_HOURS.map((hour) => getReceptionCell(grid, member.id, hour));
const continuations = receptionRunContinuations(rowCells);
```

Then in the per-slot body, replace the `getReceptionCell` call with `rowCells[hourIndex]`
(same value, one lookup instead of two) and add:

```ts
const repeatsPrevious = continuations[hourIndex];
const dividerClassName =
  hourIndex === RECEPTION_HOURS.length - 1 || continuations[hourIndex + 1]
    ? ""
    : "border-r-2 border-ink/40";
```

The divider is suppressed on the *left* member of each within-run boundary, so the run's
outer edges keep their dividers and its interior loses them. The `||` short-circuits
before the out-of-range index on the last column.

Add `data-run-continuation={repeatsPrevious ? "true" : undefined}` to the `<td>`, next to
the existing `data-selected`.

Leave everything else on the `<td>` exactly as it is: `data-testid`, `onClick`, the
`interactive` gate, `selectedClassName`, `cursorClassName`, and the whole
`ReceptionCellPopover` block including `hours`/`seedSession`/`canDelete`.

**C3. Chip suppression.** `CellContent` takes a `repeated` prop and wraps its own output:

```tsx
function CellContent<T extends ReceptionCellData>({
  session,
  repeated,
}: {
  session: T;
  repeated: boolean;
}) {
  return (
    <div className={repeated ? "invisible" : undefined}>
      {/* existing chip span and note div, unchanged */}
    </div>
  );
}
```

called as `<CellContent session={session} repeated={repeatsPrevious} />`.

**Do not move `invisible` onto the trigger `<div>` that wraps `CellContent`, and do not
render `null` instead of the content** — Design Decision 4 explains why each breaks
per-slot editing. The trigger `<div>` stays exactly as it is.

The empty-cell `+` branch is untouched (Design Decision 3).

**C4. Unit tests** (`receptionRuns.test.ts`), against plain arrays of
`makeReceptionMasterSession` fixtures and `undefined`:

- an all-absent row → all `false`
- the first slot is never a continuation, even when the second matches it
- two adjacent slots with the same role and the same note → `[false, true]`
- same role, different note → `[false, false]`
- different role, same note → `[false, false]`
- `note: null` and `note: ""` on the same role count as matching
- an absent slot between two same-role slots breaks the run — neither the absent slot nor
  the one after it is a continuation
- a five-slot uniform run → `[false, true, true, true, true]`

**C5. Grid tests** (`ReceptionGrid.test.tsx`, alongside the existing `renderWithProviders`
+ `userEvent` setup). Assert visibility with `toBeVisible()` / `not.toBeVisible()`, not
`toBeInTheDocument()` — the repeated chip is still in the DOM by design:

- three adjacent slots (9, 9.5, 10) with the same role and note: the chip in
  `reception-cell-1-9` is visible, the chips in `reception-cell-1-9.5` and
  `reception-cell-1-10` are not, and both of the latter carry
  `data-run-continuation="true"` while `reception-cell-1-9` does not
- a shared note renders once — visible in the run's first slot, hidden in the rest
- a differing note breaks the run: 9 and 9.5 share a note, 10 differs → the chip in 10 is
  visible again
- a differing role breaks the run
- an absent slot at 9.5 between sessions at 9 and 10 → the chip in 10 is visible
- **the regression guard that matters:** a continuation slot still opens its own popover
  and saves only its own half hour. With a uniform run over 9/9.5/10, click the (hidden)
  chip inside `reception-cell-1-9.5` — clicking it is legitimate here, it proves the
  trigger box survives and is still wired — then `await screen.findByLabelText("Role")`,
  change the role, Save, and assert `onSave` was called with exactly one payload for
  `hour: 9.5`
- a shift-click range that starts mid-run still highlights per slot: over a uniform run
  9→10.5, click 9.5 and shift-click 10.5, then assert `data-selected="true"` on
  `reception-cell-1-9.5` and *not* on `reception-cell-1-9`

**C6. Tighten the two page assertions** (Design Decision 7), leaving the rest of both
suites untouched:

- `ReceptionMasterPage.test.tsx`, the range-save test asserting `reception-cell-1-8` and
  `reception-cell-1-10` both show "Phones": keep the `findByText` on cell 8 (it is the
  run's first slot and genuinely visible) and change the cell-10 assertion to
  `not.toBeVisible()`.
- `ReceptionDayPage.test.tsx`, the range-save test asserting cells 9, 10 and 11: same —
  cell 9 visible, cells 10 and 11 not.

**C7. Run only what changed** (per `CLAUDE.md`):

```
cd frontend && npm run test -- src/lib/receptionRuns.test.ts src/components/ReceptionGrid.test.tsx src/routes/ReceptionMasterPage.test.tsx src/routes/ReceptionDayPage.test.tsx
cd frontend && npm run typecheck
```

---

# Task 2: Browser verification and documentation

**A. State of the world.** Task 1 is complete and the reception frontend tests pass. jsdom
has no layout and no hit testing, so it cannot prove the thing this change is actually
about — that the grid reads better and that a slot in the middle of a run is still
clickable. That is what this task is for. No new behaviour, one documentation paragraph.

**B. Files and deliverables**

| File | Action |
|---|---|
| `documentation/architecture-reception.md` | Edit — one paragraph |

**C. Instructions**

**C1. Browser pass**, on both `ReceptionMasterPage` and `ReceptionDayPage`, with at least
one staff member holding a full-day uniform run and one holding several short runs:

- a long run reads as one wide undivided cell — confirm the chip at its left edge is
  enough of a label across twenty columns. **This is the one judgement call in the whole
  change**; if a twenty-slot run reads as an empty stripe, stop and take Design Decision
  5's fallback (role tint on the `<td>`, selection shown by the ring alone) as a
  follow-up rather than shipping something less readable than what it replaced
- clicking a slot in the *middle* of a long run opens that slot's popover and saves only
  that half hour, splitting the run into three visible segments
- runs break where they should: at a role change, at a note change, and either side of an
  absent slot
- absent slots are unchanged — every one still shows its own `+`
- shift-click range select still works in both directions, including ranges that start or
  end mid-run, and the highlight is still per slot
- the coverage warning triangles in the hour headers still line up with their columns
- an inactive staff row with sessions merges the same way and stays non-interactive on its
  absent slots
- the selection ring still segments a selected run into per-slot boxes — pre-existing,
  and acceptable, but confirm it does not read as broken

**C2. Documentation.** Add a paragraph to the "Domain: Reception Rota" section of
`documentation/architecture-reception.md`, after the shift-click range select paragraph,
recording only what the code will not say on its own:

- the grid renders one `<td>` per half-hour slot and always will; adjacent slots sharing a
  `(role, note)` pair are merged *visually only* — the repeat's chip is hidden and the
  divider between them dropped
- `colSpan` was considered and rejected: a merged cell is one click target for up to
  twenty slots, which destroys per-slot editing and partial range highlighting, and would
  force the hour-keyed selection model to be re-derived
- the repeat is hidden with `visibility: hidden` on the content *inside* the popover
  trigger, never on the trigger itself, because `visibility: hidden` also disables pointer
  events — a continuation slot must stay individually clickable
- absent cells deliberately never merge: an absent cell is data (Decision 3), distinct from
  a `not_working` session (Decision 13), and each one owns its own `+` affordance
- the merge key includes `note` so that no user-entered note is ever hidden by a merge
