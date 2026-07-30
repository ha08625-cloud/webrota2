# Implementation Plan: Shift-Click Range Select on the Reception Grid

## Scope

Shift-click range selection **within a single staff member's row** on the reception grid (`ReceptionGrid.tsx`): click one hour cell, shift-click another in the same row, edit once, and apply that role/note to every hour in between. Both `ReceptionMasterPage` (weekday template) and `ReceptionDayPage` (generated day) get it, since both consume `ReceptionGrid` unchanged.

Out of scope: drag-to-paint, cross-row/multi-staff selection, keyboard-driven range selection, undo/redo, and any change to the data model — each hour remains its own row. This is a UI batching convenience over the existing per-hour endpoints; **no backend change at all**.

## Design Decisions

1. **Selection is `{ staffId, anchorHour, focusHour }` in `ReceptionGrid` local state.** Plain click sets anchor = focus = clicked hour (today's behaviour, a range of one). Shift-click on the *same* `staffId` moves focus only. Shift-click on a different row is treated as a plain click, starting a fresh single-cell selection there. No cross-staff ranges: the data is scoped per staff member anyway, and a cross-row range would need a second, unrelated set of create/patch decisions per row.

2. **One save applies one `(role, note)` uniformly across the range**, overwriting filled hours and creating rows for empty ones — the same upsert-per-hour semantics a single-cell save has today, just looped. This matches the driving use case ("mark X as not working all afternoon").

3. **The loop lives in the page, not the popover, and not the grid.** The three layers already have clean responsibilities and range select must not blur them:
   - **Popover** knows nothing about hours or sessions. It emits one `(role, note)`, exactly as today, plus presentational awareness of how many hours it is editing.
   - **Grid** owns selection and *composes* the work: it has `grid.cells`, so it is the only layer that can say which hours in the range are creates and which are patches. It hands the page a ready-made ordered payload array.
   - **Page** owns the mutations, so it owns the loop, the sequencing, and the error aggregation.
   The popover cannot iterate mutations — it has neither the pivot nor the mutation hooks — and the create/patch split is real: `useCreateReceptionMasterSession` takes `{staffId, day, hour}` while `useUpdateReceptionMasterSession` takes `{sessionId}`.

4. **Writes are sequential (`await` in a `for` loop), never `Promise.all`.** On the day page every write response carries a **freshly recomputed full `issues` list**, and `applyReceptionSessionWrite` (`api/reception.ts`) overwrites `issues` wholesale. Fired concurrently, whichever response lands last wins — and that may not be the one computed against the final state, leaving the coverage panel and the column warnings silently wrong until the next refetch. Sequencing removes the ordering hazard and gives clean partial-failure collection. Ten sequential round-trips at worst is nothing, and `handleGenerateWeek` (`ReceptionDayPage.tsx:62`) is already this exact shape — follow it.

5. **No batch endpoint.** A range is at most ten hours. N calls reuse endpoints that already exist, already validate, and already recompute coverage; a batch endpoint would be new backend surface, new schemas, new tests, and a second write path to keep in step with the single-cell one, for a saving of nine HTTP round-trips on an internal tool.

6. **Single-cell and range share one code path.** `onSave`/`onDelete` change from singular to array-valued for *all* saves; a single-cell edit is simply a range of one. Two paths would mean two chances to diverge. Consequence: the pages move from `.mutate()` + `onError` to `await mutateAsync()` in a loop, and the loading flag becomes a page-owned boolean (Decision 11).

7. **Selection clears on successful save/delete, on a plain click, and on Escape — never on popover close.** Closing on close breaks range extension: click A → shift-click C → shift-click E closes C's popover, and if close cleared the selection, E would start over as a fresh anchor. On a *failed* save the selection survives so the user can retry without re-selecting.

8. **Day/date change resets the selection via a `key` prop.** `ReceptionGrid` is not remounted when the master page switches `activeDay`, nor when the day page switches `activeDate` (`ReceptionDayTab` has no `key` either) — only the `sessions` prop changes. Without a reset a stale selection would apply to a different day's data. `key={activeDay}` / `key={date}` on the `ReceptionGrid` element is the whole fix, and it also resets any local grid state added later.

9. **On an inactive staff row, the range covers only hours that already have a session.** Absent cells on an inactive row deliberately render no add affordance (`ReceptionGrid.tsx:125`) — a leaver gets no new rows — and the backend is permissive on purpose (`create_master_session`'s docstring: *"no active-staff check here. The frontend gates the add affordance"*). A range save must not walk around the gate the grid itself puts up. Skipped hours are not highlighted, because the highlight means "this will be written".

10. **The popover form is seeded from the focus cell's session, else the anchor's, else the `("phones", "")` defaults**, and **Remove is offered when *any* cell in the range has a session**, deleting only those. The existing `session !== null` gate is therefore no longer sufficient to drive the Remove button — the grid passes an explicit `canDelete`.

11. **`saving` becomes a page-owned `savingRange` boolean held true for the whole batch.** Deriving it from shared `isPending` flags would flicker between the sequential calls, and mid-batch re-enabling of the form is worse than useless.

12. **N deletes over a range cause N refetches of the day rota, and that is accepted.** `useDeleteReceptionRotaSession` invalidates `rotaByDate` on each success. Deleting a range is an infrequent action over at most ten rows; a delete-specific "invalidate once at the end" variant is not worth a second cache-write path (Decision 6's reasoning again).

13. **Mouse only.** No keyboard range selection in v1, matching how the feature is actually used (a mouse gesture on a wide grid). Every cell remains individually reachable and editable exactly as today, so nothing that was keyboard-accessible stops being so.

## Component contracts after this change

```ts
// ReceptionGrid.tsx — payload type unchanged, props now array-valued
export interface ReceptionSavePayload<T extends ReceptionCellData> {
  staffId: number;
  hour: number;
  session: T | null;   // null => create this hour, non-null => patch it
  role: ReceptionRole;
  note: string | null;
}

interface ReceptionGridProps<T extends ReceptionCellData> {
  // ...staff, sessions, issues unchanged
  /** Ascending by hour. Resolves true only if every write succeeded. */
  onSave: (payloads: ReceptionSavePayload<T>[]) => Promise<boolean>;
  /** Only cells in range that actually have a session. Resolves true if all succeeded. */
  onDelete: (sessions: T[]) => Promise<boolean>;
  saving: boolean;
}

// ReceptionCellPopover.tsx — two new presentational props
interface ReceptionCellPopoverProps<T extends ReceptionCellData> {
  session: T | null;    // seeds role/note only; no longer gates Remove
  hourCount?: number;   // default 1
  canDelete?: boolean;  // default false; grid computes it
  // ...children, onSave, onDelete, saving unchanged
}
```

The `Promise<boolean>` return is what lets the grid honour Decision 7 — clear on success, keep on failure — without the grid knowing anything about mutations.

---

# Task 1: Selection state and interaction in `ReceptionGrid`

**A. State of the world.** Nothing is implemented yet. Every cell is currently its own `Popover.Trigger` with no shared selection state (`ReceptionGrid.tsx:106-140`), and each `ReceptionCellPopover` owns its own `open` state. This task adds selection, highlighting and the range→payload composition, and changes the grid's prop signatures. It does **not** touch the pages' mutations — wire `onSave`/`onDelete` in the pages to satisfy the new types minimally (an `async` wrapper returning `true`) and leave the real loop to Task 2.

**B. Files and deliverables**

| File | Action |
|---|---|
| `frontend/src/components/ReceptionGrid.tsx` | Edit — selection state, click handling, highlight, payload composition, new prop signatures |
| `frontend/src/components/ReceptionGrid.test.tsx` | Edit — selection behaviour tests |
| `frontend/src/routes/ReceptionMasterPage.tsx` | Edit — adapt handler signatures, add `key={activeDay}` |
| `frontend/src/routes/ReceptionDayPage.tsx` | Edit — adapt handler signatures, add `key={date}` |

**C. Instructions**

**C0. Prove the interaction before building on it (do this first, ~20 minutes).** Click-to-select and click-to-open-popover are the same gesture here: a plain click already opens that cell's popover, so a shift-click on cell B always happens *while popover A is open*. Radix's dismissable layer closes A on the outside pointerdown, and because `Popover` is non-modal by default it should not swallow the click — so B should receive it and open with the range. Verify that assumption with a throwaway `console.log` on a `<td>` `onClick` before writing anything else.

If a single shift-click does **not** reach cell B, do not improvise: switch to the planned fallback and note it in the PR. The fallback is to lift popover open state into the grid — hold `openCell: { staffId, hour } | null`, pass `open`/`onOpenChange` down to each `ReceptionCellPopover`, and set `openCell` to the focus cell in the same handler that updates the selection, moving that handler to `onPointerDownCapture` so it runs ahead of Radix's dismiss logic. Everything else in this plan is unaffected.

**C1. Selection state and handler.**

```ts
interface ReceptionSelection {
  staffId: number;
  anchorHour: number;
  focusHour: number;
}
const [selection, setSelection] = useState<ReceptionSelection | null>(null);

function handleCellClick(staffId: number, hour: number, shiftKey: boolean) {
  setSelection((prev) =>
    shiftKey && prev !== null && prev.staffId === staffId
      ? { ...prev, focusHour: hour }
      : { staffId, anchorHour: hour, focusHour: hour },
  );
}
```

Attach it on the `<td>` — `onClick={(e) => handleCellClick(member.id, hour, e.shiftKey)}` — so it covers both the filled-cell `<div>` and the empty-cell `+` button by bubbling. Guard it on the cell being interactive (`session !== null || member.active`), so a non-interactive cell on an inactive row (which renders `null` today) never becomes selectable.

**C2. Derive the range.** Write a module-level helper, exported for direct unit testing:

```ts
export function selectedRangeHours(
  selection: ReceptionSelection | null,
  staffId: number,
): number[]  // [] when the selection is on another row or absent
```

It returns the `RECEPTION_HOURS` entries between `min(anchorHour, focusHour)` and `max(...)` inclusive, ascending — always derive from `RECEPTION_HOURS`, never from arithmetic on the integers, so the range stays correct if the hour list ever changes. In the grid, filter that list per Decision 9: on an inactive row keep only hours where `getReceptionCell` returns a session.

**C3. Highlight.** A cell is highlighted when it is in the (post-filter) range. Add `data-selected="true"` to those `<td>`s and assert on that attribute in tests rather than on class names. Styling: `bg-accent/10 ring-1 ring-inset ring-accent` on the highlighted `<td>`, plus `cursor-pointer` on every interactive cell so the row reads as clickable. Keep the existing border classes intact — the grid's `border-r-2`/`border-b` dividers carry the column structure.

**C4. Wire the popover.** For each interactive cell, compute `hours` = the filtered range if this cell is the focus cell of a multi-hour selection, else `[hour]`. Pass to `ReceptionCellPopover`:
- `session` — the seed, per Decision 10: focus cell's session `??` anchor cell's session `??` `null`.
- `hourCount={hours.length}`
- `canDelete` — `hours.some((h) => getReceptionCell(grid, member.id, h) !== undefined)`
- `onSave={(role, note) => handleSave(member.id, hours, role, note)}`
- `onDelete={() => handleDelete(member.id, hours)}`

**C5. Compose payloads and honour the clear rules.**

```ts
async function handleSave(staffId: number, hours: number[], role: ReceptionRole, note: string | null) {
  const payloads = hours.map((hour) => ({
    staffId, hour, session: getReceptionCell(grid, staffId, hour) ?? null, role, note,
  }));
  if (await onSave(payloads)) setSelection(null);
}
```

`handleDelete` is the same shape, filtering to hours that have a session and calling `onDelete(sessions)`. Do **not** clear on popover close (Decision 7). Add a document-level `keydown` listener in a `useEffect`, active only while `selection !== null`, clearing on Escape — Radix consumes Escape to close an open popover, but the selection must also clear when the popover is already shut.

**C6. Page adaptation (minimal, this task).** Change both pages' `handleSave`/`handleDelete` to take arrays and return `Promise<boolean>` — for now, loop with the existing `.mutate()` calls and `return true`; Task 2 replaces the bodies. Add `key={activeDay}` to `ReceptionGrid` in `ReceptionMasterPage` and `key={date}` in `ReceptionDayPage` (Decision 8).

**C7. Tests** (`ReceptionGrid.test.tsx`, alongside the existing `userEvent` + `renderWithProviders` setup; shift-click is `await user.keyboard("{Shift>}")`, then `await user.click(cell)`, then `await user.keyboard("{/Shift}")`):
- direct unit tests of `selectedRangeHours` — forward range, backward range (focus before anchor), single cell, other row
- shift-click in the same row highlights every cell between the two, endpoints included
- shift-click on a *different* row leaves only the newly clicked cell selected
- a plain click after a range collapses the selection back to one cell
- saving a 3-hour range calls `onSave` once with three payloads, ascending by hour, `session` populated for filled hours and `null` for empty ones
- on an inactive staff row, a range spanning an empty hour omits that hour from both the highlight and the payloads
- when `onSave` resolves `false`, the highlight survives; when it resolves `true`, it clears
- regression: a single-cell save on an empty cell still produces exactly one payload with `session: null`

---

# Task 2: Batched save and delete in the pages, and popover polish

**A. State of the world.** Task 1 is complete: the grid owns selection, highlights the range, and calls `onSave`/`onDelete` with arrays, but both pages still fire the old fire-and-forget mutations one at a time and always report success. This task makes the writes sequential, aggregates partial failures, adds the page-owned loading flag, and gives the popover its range affordances. No backend change.

**B. Files and deliverables**

| File | Action |
|---|---|
| `frontend/src/routes/ReceptionMasterPage.tsx` | Edit — sequential `mutateAsync` loop, failure aggregation, `savingRange` |
| `frontend/src/routes/ReceptionDayPage.tsx` | Edit — same, inside `ReceptionDayTab` |
| `frontend/src/components/ReceptionCellPopover.tsx` | Edit — `hourCount`, `canDelete` |
| `frontend/src/components/ReceptionCellPopover.test.tsx` | Edit — new props |
| `frontend/src/routes/ReceptionMasterPage.test.tsx` | Edit — mixed create/patch range test |
| `frontend/src/routes/ReceptionDayPage.test.tsx` | Edit — range save test |

**C. Instructions**

**C1. Master page.** Replace `handleSave` with a sequential loop, modelled on `handleGenerateWeek` (`ReceptionDayPage.tsx:62`):

```ts
const [savingRange, setSavingRange] = useState(false);

async function handleSave(payloads: ReceptionSavePayload<ReceptionMasterSession>[]): Promise<boolean> {
  setError(null);
  setSavingRange(true);
  const failures: string[] = [];
  for (const { staffId, hour, session, role, note } of payloads) {
    try {
      if (session) {
        await updateSession.mutateAsync({ sessionId: session.session_id, role, note });
      } else {
        await createSession.mutateAsync({ staffId, day: activeDay, hour, role, note });
      }
    } catch (err) {
      failures.push(`${formatHour(hour)}: ${apiErrorMessage(err as ApiError, "failed")}`);
    }
  }
  setSavingRange(false);
  if (failures.length > 0) setError(`Could not save every hour: ${failures.join("; ")}`);
  return failures.length === 0;
}
```

Keep going after a failure rather than aborting — a mid-range 409 on one hour should not silently drop the remaining eight. `handleDelete` is the same shape over `deleteSession.mutateAsync(session.session_id)`, reporting `Could not remove every hour: ...`. Pass `saving={savingRange}` (it now covers every mutation this page makes). Import `formatHour` from `lib/receptionHours`.

**C2. Day page (`ReceptionDayTab`).** Identical shape, with the rota-scoped payloads (`{ rotaId: rota.rota_id, date, ... }`) and the existing `if (!rota) return` guard — return `false` from that guard, since nothing was written. `saving` becomes `savingRange || generateRota.isPending || deleteRota.isPending`. Sequencing matters here specifically (Decision 4): the last response's `issues` must be the one computed against the final state.

**C3. Popover.** Add `hourCount = 1` and `canDelete = false`. When `hourCount > 1`, render a heading above the Role field — `Editing {hourCount} hours` in `text-xs font-medium text-ink/70`, matching the existing label styling — so the user cannot mistake a range save for a single-cell one. Gate the Remove button on `canDelete && onDelete` instead of `session !== null && onDelete`. The reset-on-open behaviour and everything else stay as they are; `session` still seeds role/note and nothing more. Update its docstring: the popover edits *a selection*, which is usually one cell.

**C4. Tests.**
- Popover: the heading appears only when `hourCount > 1`; `canDelete` alone drives Remove (in particular, Remove renders with `session: null` when `canDelete` is true).
- **Master page — the case this feature actually breaks on:** a 3-hour range over one filled and two empty hours issues exactly one `PATCH` and two `POST`s, with the POST bodies carrying the right `hour` values and the active day. Assert the request bodies via `server.use` capture, as the existing "the add affordance POSTs to the master endpoint with the active day" test does.
- Master page: when one write in the range 500s, the others still fire and the error banner names the failing hour.
- Day page: a range save over a generated day fires one request per hour and the grid shows every hour updated afterwards.
- Confirm the existing single-cell page tests still pass untouched — they exercise the same endpoints through the new code path, and are the regression net for Decision 6.

---

# Task 3: Verification, discoverability, and documentation

**A. State of the world.** Tasks 1 and 2 are complete and the unit/component suites pass. This task is the manual pass and the two small user-facing/documentation additions; no new behaviour.

**B. Files and deliverables**

| File | Action |
|---|---|
| `frontend/src/routes/ReceptionMasterPage.tsx` | Edit — one clause of helper text |
| `frontend/src/routes/ReceptionDayPage.tsx` | Edit — same |
| `documentation/architecture-reception.md` | Edit — one paragraph |

**C. Instructions**

**C1. Discoverability.** Both pages already carry an intro line (`<p className="mt-2 max-w-2xl text-sm text-ink/70">`). Append one clause to each: *"Shift-click a second hour in the same row to apply one role to the whole range."* That is the whole affordance — no tooltip, no help popover, nothing new to style.

**C2. Manual pass**, on both pages:
- range in both directions (left-to-right and right-to-left)
- range spanning filled and empty hours together — check the grid afterwards, not just the absence of an error
- extending twice without saving (click A, shift-click C, shift-click E) — the range must grow, not reset (Decision 7)
- shift-click on another staff row → new single selection, old highlight gone
- Escape clears the highlight; clicking a single cell after a range collapses it
- switching weekday tab / date tab clears the selection (Decision 8)
- an inactive staff row: the range skips hours with no session and creates nothing there (Decision 9)
- Remove over a range deletes only the hours that had sessions
- on the day page, the coverage panel and the column warning triangles are correct **immediately after** a range save, not only after a manual refresh — this is what Decision 4 exists to protect
- the single-cell edit and delete flows are unchanged throughout

**C3. Documentation.** Add a short paragraph to the "Domain: Reception Rota" section of `documentation/architecture-reception.md`, after the "two grids duplicate rather than share" paragraph, recording what the code will not say on its own: that range select is a UI-only batching convenience over the unchanged per-hour endpoints; that writes are deliberately sequential because each day-rota write response carries a full recomputed `issues` list that the cache overwrites wholesale; and that a range on an inactive staff row deliberately writes only hours that already have rows, since the server is permissive by design and the grid is the gate.
