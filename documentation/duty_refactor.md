# Implementation Plan: 4-Weekly Duty Periods

## Plan

Replace the Duty page's rolling 12-week Monday selector with a fixed, non-overlapping 4-weekly period selector, and scope the duty counter columns (`n` / `wtd`) to the selected period instead of all-time.

Frontend only. No backend, schema, engine or migration changes.

## Scope

In scope:
- `frontend/src/lib/date.ts` (+ test): duty-period boundary helpers and a period label formatter.
- `frontend/src/routes/DutyPage.tsx` (+ test): selector switches from "every upcoming Monday" to "every period start".
- `frontend/src/components/DutyGrid.tsx` (+ test): counter columns become period-scoped.
- `frontend/src/api/duty.ts` (+ test): `useDutyCounts` takes an optional date range.

Out of scope, deliberately:
- **Backend.** `GET /duty/counts` already accepts `from_date`/`to_date` and applies them inside the outer-join condition, so doctors with zero duties in the range still return `raw_count=0`. Verified in `backend/app/api/routers/duty.py`. Nothing to change.
- **`getUpcomingMondays`.** `RotaPage.tsx` still uses it for the generation start-week selector. It stays exactly as is; the new helpers sit alongside it.
- **The assignments table below the grid.** It keeps using unfiltered `useDuty()` and continues to list every assignment. This is intentional: an assignment created for a date outside every dropdown period would otherwise become invisible and undeletable. Its heading changes to "All duty assignments" so the inconsistency with the period-scoped grid above it reads as deliberate.
- **Generation.** A generated rota (arbitrary Monday, 1-4 weeks) can straddle two duty periods. That is fine and unchanged: the incomplete-duty-week warning `RotaPage` shares with `DutyPage` is computed per week, not per period.

## Design decisions

1. **Anchor**: `DUTY_PERIOD_ANCHOR = "2026-07-20"` (a Monday). The team is not currently running a 4-weekly cycle, so the phase is arbitrary and this is simply the Monday of the week the change is written. All period starts are `anchor + n * 28 days`, `n` negative for periods before the anchor. Hardcoded constant, not derived from "this week's Monday" — deriving it would shift every boundary forward a week whenever the week ticks over, which defeats the point of a fixed cycle. Changing the phase later means editing the constant and redeploying; acceptable for a single practice.

2. **Period index is computed on UTC values, not local milliseconds.** `floor((date - anchor) / 28 days)` over local `Date` objects is off by one for any period spanning a DST change (a 28-day span containing the October change is 28d1h). The index is therefore derived from `Date.UTC(...)` values, which have no DST, and the resulting start date is produced with the existing DST-safe `addDays`. This module already avoids this class of bug in `parseLocalDate`/`addDays`; do not reintroduce it here.

3. **One constant drives everything.** `DUTY_PERIOD_WEEKS = 4` is exported from `date.ts` and imported by `DutyGrid`, replacing its local `WEEK_COUNT = 4`. The grid window and the counter date range are then provably the same span.

4. **Dropdown contents**: one past period, the current period (the one containing today, not the next upcoming boundary — admins need to edit the in-progress period), and five future periods. Seven options, ~24 weeks of lookahead. Two constants, trivially changed.

5. **Why one past period**: the all-time counter is being removed, so without a backward step there is no way to see who did what last period. Accepted consequence: long-run duty fairness across periods is no longer visible anywhere in the app. Within a 28-day window the numbers are small (roughly 4-8 duties over ~10 eligible doctors), so per-period balance can look even while a systematic drift accumulates. If that later matters, the fix is more past periods in the dropdown, not restoring an all-time column.

6. **Counter range is computed inside `DutyGrid`**, not passed in as props. The grid already receives `startWeekDate` (now always a period start) and can derive `to = addDays(start, DUTY_PERIOD_WEEKS * 7 - 1)`. Fewer props, and the range cannot drift from the weeks actually rendered.

7. **Query key includes the range**, so switching periods does not serve stale cached counts.

8. **Label wording**: the selector is labelled "Duty period", not "Period" — `Period` is already the `AM`/`PM` type on this page, and the add form already has a `<label>` reading "Period".

---

## Task 3: Period selector and scoped counter columns

**A. State of the world**

Tasks 1 and 2 are complete: `date.ts` exports the period helpers, and `useDutyCounts(range?)` accepts and forwards a date range.

Remaining: the Duty page still offers 12 rolling Mondays, and `DutyGrid` still calls `useDutyCounts()` unranged with a local `WEEK_COUNT = 4`.

**B. Files and deliverables**

- `frontend/src/routes/DutyPage.tsx` — modified, full file as artifact
- `frontend/src/routes/DutyPage.test.tsx` — modified, full file as artifact
- `frontend/src/components/DutyGrid.tsx` — modified, full file as artifact
- `frontend/src/components/DutyGrid.test.tsx` — modified, full file as artifact

**C. Instructions**

`DutyPage.tsx`:
- Replace `UPCOMING_WEEK_COUNT = 12` with `PAST_PERIOD_COUNT = 1` and `FUTURE_PERIOD_COUNT = 5`.
- Replace `getUpcomingMondays(...)` with `getDutyPeriodStarts(PAST_PERIOD_COUNT, FUTURE_PERIOD_COUNT)`, still memoised, and default the selection to the *current* period — index `PAST_PERIOD_COUNT`, not index 0.
- Options render with `formatPeriodLabel`; the `<label>` text becomes "Duty period". Keep the element id `duty-week-select` unchanged so nothing else that targets it breaks, or rename it to `duty-period-select` and update the test in the same commit — do not do half of either.
- The `<DutyGrid startWeekDate={...} />` prop name and contract are unchanged; the value is now always a period start.
- Change the assignments table heading to "All duty assignments" (add one if there is currently none) so it is clear the table is not period-scoped.

`DutyGrid.tsx`:
- Delete the local `WEEK_COUNT = 4`; import `DUTY_PERIOD_WEEKS` from `@/lib/date` and use it for `weekStartDates`.
- Derive the counter range from the same values: `from = startWeekDate`, `to = addDays(startWeekDate, DUTY_PERIOD_WEEKS * 7 - 1)`, memoised on `startWeekDate`, and pass it to `useDutyCounts`.
- Nothing else changes. The `n` / `wtd` column rendering, `computeWeightedScore`, the `countsLoading` null-vs-zero distinction and the drag-and-drop behaviour are all untouched.
- Add a short comment on the range recording that the counters are deliberately period-scoped and that the all-time view was removed rather than moved.

Tests:
- `DutyPage`: assert seven options, that the default selection is the second one (the current period), and that option labels match the period-span format. The existing "12 upcoming Mondays" assertion is replaced, not adapted.
- `DutyGrid`: assert the counts request carries `from_date` equal to the passed `startWeekDate` and `to_date` equal to start + 27 days, and that a doctor with no duties in the period renders `0` rather than a dash once loaded.

---

## After implementation

`Architecture.md` line 263 describes DutyPage as "a week-at-a-time editable grid" with a rolling selector, and will need a sentence on the fixed 4-weekly period, the hardcoded anchor, and the fact that duty counters are period-scoped with no all-time view anywhere in the app.

---

## Task 1: Duty period helpers in `date.ts`

**A. State of the world**

Nothing has been implemented yet. This is the first of three tasks. `frontend/src/lib/date.ts` currently exports `parseLocalDate`, `isMonday`, `formatDate`, `formatDateTime`, `addDays`, `getUpcomingMondays`, `formatWeekLabel`, and a private `toDateKey`.

**B. Files and deliverables**

- `frontend/src/lib/date.ts` — modified, full file as artifact
- `frontend/src/lib/date.test.ts` — modified, full file as artifact (existing tests unchanged, new describe blocks added)

**C. Instructions**

Add to `date.ts`, leaving every existing export untouched (`getUpcomingMondays` is still used by `RotaPage` and must not be removed or altered):

```ts
export const DUTY_PERIOD_ANCHOR = "2026-07-20"; // a Monday
export const DUTY_PERIOD_WEEKS = 4;
```

Add a private helper that converts a `"YYYY-MM-DD"` string to a UTC epoch value via `Date.UTC(year, month - 1, day)`.

Add `getDutyPeriodStart(dateString: string): string` — returns the start date of the period containing `dateString`:
- index = `Math.floor((utc(dateString) - utc(DUTY_PERIOD_ANCHOR)) / (DUTY_PERIOD_WEEKS * 7 * 86_400_000))`
- return `addDays(DUTY_PERIOD_ANCHOR, index * DUTY_PERIOD_WEEKS * 7)`
- `Math.floor` handles dates before the anchor correctly (negative index); do not use truncating division.

Add `getDutyPeriodStarts(pastCount: number, futureCount: number, from: Date = new Date()): string[]` — the period containing `from`, plus `pastCount` before it and `futureCount` after it, ascending, all via `addDays` from the current period start.

Add `formatPeriodLabel(startDateString: string): string` — the period's inclusive span, pinned to `"en-GB"` for month names for the same reason `formatWeekLabel` is (a select list needs one unambiguous day-month-year order for every user, not a locale-dependent one). End date is `addDays(start, DUTY_PERIOD_WEEKS * 7 - 1)`. Format:
- same year: `"20 Jul - 16 Aug 2026"`
- crossing a year: `"21 Dec 2026 - 17 Jan 2027"`

Each new export gets a comment in the style of the existing ones, explaining the *why*, not the *what*. In particular the UTC arithmetic in `getDutyPeriodStart` needs a comment recording that it exists to avoid the DST off-by-one, or someone will "simplify" it back to local-time subtraction.

Tests to add:
- `getDutyPeriodStart` returns the anchor for the anchor itself, for anchor+27 days, and not for anchor+28
- anchor+28 returns anchor+28
- a date before the anchor returns anchor-28 (negative index)
- **DST regression**: with the 2026-07-20 anchor, period 3 runs 2026-10-12 to 2026-11-08 and contains the 25 October UK clock change. Assert `getDutyPeriodStart("2026-11-08") === "2026-10-12"` and `getDutyPeriodStart("2026-11-09") === "2026-11-09"`. Label this test as the DST guard so it is not deleted as redundant.
- `getDutyPeriodStarts(1, 5, new Date(2026, 7, 5))` returns 7 ascending starts, 28 days apart, with the fourth-from... (specifically: element 0 is the period before the one containing 5 Aug 2026, element 1 is the containing period)
- `formatPeriodLabel` for both the same-year and year-crossing cases

Note for whoever writes these: `getDutyPeriodStarts` takes a `Date` (matching `getUpcomingMondays`' signature), so construct fixtures with `new Date(year, monthIndex, day)` — never `new Date("2026-08-05")`, which parses as UTC midnight and can land on the previous day.


---

## Task 2: Period-scoped duty counts in `api/duty.ts`

**A. State of the world**

Task 1 is complete: `date.ts` exports `DUTY_PERIOD_ANCHOR`, `DUTY_PERIOD_WEEKS`, `getDutyPeriodStart`, `getDutyPeriodStarts` and `formatPeriodLabel`.

`useDutyCounts()` currently takes no arguments and calls `GET /duty/counts` unfiltered, with query key `["duty", "counts"]`. The backend endpoint already supports `from_date` and `to_date` query parameters; no backend work is required in this task or any other.

**B. Files and deliverables**

- `frontend/src/api/duty.ts` — modified, full file as artifact
- `frontend/src/api/duty.test.tsx` — modified, full file as artifact

**C. Instructions**

Give `useDutyCounts` an optional range argument, `{ from: string; to: string } | undefined`, both `"YYYY-MM-DD"`.

- When a range is given, request `/duty/counts?from_date=${from}&to_date=${to}`. Follow the existing convention in `api/leave.ts` and build the query string into the path directly; `apiClient.get` takes a path only.
- `dutyKeys.counts` becomes a function of the range so that switching period refetches rather than serving the previous period's numbers. Keep the unranged key shape as-is when no range is passed, so the existing `dutyKeys.all` invalidation in the create/delete mutations still covers every variant (it does — `all` is the prefix).
- The mutation `onSuccess` handlers are unchanged: they already invalidate `dutyKeys.all`.

Tests: assert the request URL carries both params when a range is supplied and neither when it does not, and that two different ranges produce two different cache entries rather than one shared one. Use the existing MSW handler pattern in `frontend/test/msw/handlers.ts`.