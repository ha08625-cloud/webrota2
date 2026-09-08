# Plan: shared year across the Session Management tabs

## Scope

One year selector, owned by the Session Management tab strip, shared by the five
sub-tabs. Picking 2027 shows 2027 bank holidays, 2027 practice closures, 2027
extra sessions, 2027 leave and entitlement, and opens the Annual Planner at the
**current month of 2027** (September 2027 if it is September today).

In scope:

- `SessionManagementTabs.tsx` — the shared year state, the control, hiding it on
  School Holidays.
- `ClosuresPage` — bank holidays *and* the practice-closures table follow the year.
- `ExtraSessionsPage` — list filtered to the year (new; it has no year today).
- `LeavePage` — entitlement, year calendar *and* the leave table follow the year.
- `LeavePlanningPage` — lands on the shared year, writes the year back when month
  paging crosses a year boundary.
- `api/closures.ts`, `api/extraSessions.ts`, `api/leave.ts` — year params + cache keys.

Out of scope:

- **Backend.** `GET /closures`, `GET /extra-sessions` and `GET /leave` already accept
  `from_date`/`to_date`; `GET /closures/bank-holidays` and `GET /leave/entitlement`
  already take `year`. No router, schema or engine change is needed anywhere.
- **School Holidays.** Term dates straddle calendar years, so a calendar-year filter
  would cut holidays in half. The tab keeps its "Show past holidays" checkbox and
  the year control is hidden while it is showing.
- Any tab outside Session Management (Duty, Master Rota, Counters etc.).

## State of the world

Today the year is **not** a shared concept; each tab invents its own or has none:

| Tab | Year today |
|---|---|
| Annual Planner | local `{year, month}`, seeded from today |
| Individual Leave | local `calendarYear`; drives entitlement + `LeaveYearCalendar` only. The leave **table** is unfiltered |
| Extra Sessions | none at all — every entry ever, filtered only by doctor |
| Closures | local `year` **inside `BankHolidaysSection`**; the practice-closures table below it is unfiltered |
| School Holidays | none; a "show past" checkbox instead |

So "the closures tab has a year picker" is only half true — it is a *bank holidays*
year picker that happens to sit on the Closures tab. Making the year shared therefore
also means giving the three unfiltered lists a year filter, or the shared control
would visibly not apply to most of what is on screen.

## Design decisions

1. **The URL is the source of truth: `?year=2027`.** The layout reads and writes a
   `year` search param with `useSearchParams`, and the tab links carry it, so a
   pasted URL opens on the same year and back/forward work. A missing, non-numeric
   or out-of-range param reads as the current year rather than erroring.
2. **Clamp to `currentYear - 5 .. currentYear + 5`.** Cheap guard against a typo'd
   URL firing a query for year 20027 and rendering an empty everything.
3. **The control moves into the tab strip**, right-aligned, `◀ 2027 ▶` — same
   prev/next shape it has today. A per-page control that silently changed four other
   tabs would be a trap; a control that sits *above* the tabs reads as global because
   it is. Consequently the year pager is **removed** from `BankHolidaysSection` and
   from `LeaveYearCalendar` (its `onPrevYear`/`onNextYear` props go; it keeps `year`).
4. **Month lives in shared state too, but not in the URL.** Only the Annual Planner
   reads month, but if it were page-local, switching to Closures and back would throw
   away the month you were on. Keeping `{year, month}` in the provider means the
   planner returns to where you left it within a session; keeping month out of the URL
   keeps `?year=2027` on the other four tabs clean.
5. **Landing month = today's month, in the selected year.** Changing the year to 2027
   in September puts the planner on September 2027, not January 2027.
6. **The planner writes the year back.** Paging December 2027 → January 2028 sets the
   shared year to 2028, so the strip never claims a year the grid is not showing.
7. **`useSessionYear()` falls back to the current year outside the provider,** with a
   no-op setter. Every page test renders its page standalone, and this keeps them
   working without wrapping each one in a router + provider.
8. **The leave *preview* query stays unfiltered.** `LeavePage` calls `useLeave` twice:
   once for the table (year-filtered) and once for `LeaveRangePreview`'s overlap
   warning. Filtering the second would miss an overlap on a range running into the
   next year, so it passes `null` for year.
9. **Accepted consequence: a cross-year leave block splits at 31 December.** With the
   table year-filtered, `collapseLeaveEntries` sees only the in-year half of a block
   spanning New Year and renders it as ending 31 Dec; deleting it removes only that
   half. Deletion is already a bulk delete over the block's own span, so it deletes
   exactly what the row shows — honest, if not ideal. Not worth a fetch-with-buffer
   scheme for how rarely leave crosses New Year.
10. **Empty states name the year** — "No closures in 2027.", "No extra sessions in
    2027." — so an empty list reads as "not this year" rather than "nothing exists".

---

## Task 1: shared year state and the control

**A.** Nothing done yet. This task builds the shared state and the UI control, with
no page consuming it yet. After it, the strip shows a year control that changes the
URL and nothing else.

**B. Files**

- `frontend/src/components/SessionManagementTabs.tsx` (edit)
- `frontend/src/components/SessionManagementTabs.test.tsx` (new, if absent)

Deliverables: `SessionYearProvider`, `useSessionYear()`, a `SessionYearControl`
rendered in the tab strip, tab links that preserve `?year=`.

**C. Instructions**

1. Add a context exposing `{ year, month, setYear, setMonth }`. `year` is derived from
   the `year` search param via `useSearchParams`; `setYear` writes the param
   (`replace: true`, so year paging does not fill the history stack). `month` is
   plain `useState` seeded to `new Date().getMonth() + 1`.
2. `setYear` should reset `month` to today's month (decision 5). `setMonth` may set
   both year and month at once — that is how the planner writes a year boundary back
   (decision 6); it must go through `setSearchParams` for the year half.
3. Parse/clamp helper: non-numeric or outside `currentYear ± 5` → current year.
   Export it so tests can hit the boundary directly.
4. `useSessionYear()` returns the context, or `{ year: currentYear, month: currentMonth,
   setYear: noop, setMonth: noop }` when there is no provider (decision 7).
5. `SessionYearControl`: prev/next buttons plus `<span className="tabular-nums">`,
   `aria-label="Previous year"` / `"Next year"` — copy the markup from
   `BankHolidaysSection` so the look does not drift. Disable prev/next at the clamp
   bounds. Render it right-aligned in the tab strip row (`justify-between` on the
   existing flex container, tabs in a nested flex), **hidden when
   `pathname === "/clinical/school-holidays"`** (decision, School Holidays).
6. Tab `to` values must carry the current search string so switching tabs keeps the
   year — build them as `` `${tab.to}?year=${year}` `` (or `{ pathname, search }`).
   The `isActive` comparison is `pathname === tab.to` already, so it is unaffected;
   `SESSION_MANAGEMENT_PATHS` stays path-only for App.tsx's nav highlight.
7. `SessionManagementLayout` wraps `<SessionManagementTabs />` + `<Outlet />` in the
   provider.
8. Tests: default year with no param; reads `?year=2027`; a junk param falls back;
   next/prev update the param; tab links carry the year; control hidden on School
   Holidays.

## Task 2: Closures and Extra Sessions consume the year

**A.** Task 1 is done — the tab strip owns a year and puts it in the URL, and nothing
reads it yet. This task wires up the two simplest consumers.

**B. Files**

- `frontend/src/api/closures.ts`, `frontend/src/api/extraSessions.ts` (edit)
- `frontend/src/routes/ClosuresPage.tsx`, `frontend/src/routes/ExtraSessionsPage.tsx` (edit)
- their `.test.tsx` files, plus `frontend/src/api/closures.test.tsx`

**C. Instructions**

1. `useClosures(year)` → `GET /closures?from_date=${year}-01-01&to_date=${year}-12-31`,
   with `year` in `closureKeys.list(year)`. `useExtraSessions(doctorId, year)` the
   same, keeping `doctorId` in the key. Both mutations already invalidate the `all`
   key, so cross-year invalidation needs no change.
2. `ClosuresPage`: take `year` from `useSessionYear()`, drop the local `year` state
   from `BankHolidaysSection` and pass it down as a prop instead, and remove that
   section's prev/next buttons (decision 3). Keep the `min`/`max` date bounds on the
   bank-holiday date inputs — they already derive from the year.
3. The add-closure form's date input is deliberately **not** clamped to the selected
   year: a user typing a date is stating a fact, and silently rejecting it would be
   worse than the row landing in a year they are not looking at. If the created date
   falls outside the selected year, show a one-line hint under the form:
   "Added in 2026 — switch the year to see it." (Compare `addDate.slice(0, 4)` with
   the year; no new state beyond a summary string.)
4. `ExtraSessionsPage`: pass `year` into `useExtraSessions`. Same
   out-of-year hint on its add form. Empty states name the year (decision 10).
5. Tests: list requests carry the right `from_date`/`to_date`; changing the year
   refetches rather than serving the previous year's cache; the out-of-year hint
   appears; empty state names the year.

## Task 3: Individual Leave consumes the year

**A.** Tasks 1–2 are done: Closures and Extra Sessions follow the shared year.
Individual Leave still owns a private `calendarYear`.

**B. Files**

- `frontend/src/api/leave.ts`, `frontend/src/routes/LeavePage.tsx`,
  `frontend/src/components/LeaveYearCalendar.tsx` (edit) + their tests.

**C. Instructions**

1. `useLeave(doctorId, year)` where `year: number | null`; `null` means unfiltered.
   Add year to `leaveKeys.list`.
2. `LeavePage`: delete `calendarYear` state, read `year` from `useSessionYear()`.
   Table query passes the year; the `previewLeave` query passes `null` (decision 8).
   `useLeaveEntitlements(year)` takes the shared year.
3. `LeaveYearCalendar`: remove `onPrevYear`/`onNextYear` and the buttons; keep the
   `{year}` caption and the internal `date.startsWith(year)` filter (harmless now,
   and it still guards any future unfiltered caller).
4. Empty state names the year. Add a short note by the table that it shows the
   selected year only.
5. Tests: the table request carries the year range while the preview request does not;
   the calendar no longer renders year buttons; the entitlement and calendar move
   together with the shared year.

## Task 4: Annual Planner consumes the year

**A.** Tasks 1–3 are done: four tabs follow the shared year. The planner still seeds
its own `{year, month}` from today.

**B. Files**

- `frontend/src/routes/LeavePlanningPage.tsx` (edit) + `LeavePlanningPage.test.tsx`

**C. Instructions**

1. Replace the local `useState({year, month})` with `useSessionYear()`'s `{year, month}`
   and `setMonth`.
2. `handleMonthChange(delta)` calls `shiftMonth` as now, then hands the result to the
   shared `setMonth` — which updates the URL's year when the shift crosses a boundary
   (decision 6). `shiftMonth` itself stays where it is, unchanged and still unit-tested.
3. Nothing else in the page changes: `dates`, the doctor-window overlap filter, the
   entitlement year and the pending-edit map are all already derived from `{year, month}`.
4. Tests: mounting with `?year=2027` in September shows "September 2027"; paging back
   from January 2028 lands on December 2027 *and* moves the shared year; pending edits
   still survive a month change.

## Task 5: review and documentation

**A.** Tasks 1–4 are complete and the shared year is live across the four tabs.
This step is review and documentation only.

**B. Files**

- `documentation/architecture-clinical.md` (edit)
- `documentation/session_year_plan.md` (delete)

**C. Instructions**

1. In the "Frontend: Reference Pages" section, add a paragraph above the per-page
   list: the Session Management strip owns a single year in `?year=`, four of the five
   tabs read it, School Holidays deliberately does not and hides the control, and the
   planner writes the year back on a boundary-crossing month page.
2. Update the `ClosuresPage`, `LeavePage`, `LeavePlanningPage` and `ExtraSessionsPage`
   bullets where they describe year ownership — in particular `LeavePage`'s
   "`LeaveYearCalendar` owns the sole year control", which this change makes false.
3. Record decisions 8 (unfiltered preview query) and 9 (cross-year leave blocks split
   at 31 December) — both are non-obvious from the code alone.
4. Delete this plan file.
