# Reception Rota Counters — Implementation Plan

Status: implementation plan. Supersedes the provisional plan written at the
end of the discussion chat (see git history for that version). Reviewed
against the code; the corrections that review produced are listed first, then
the plan proper, then the tasks to hand to individual coding chats.

## Review of the provisional plan

The provisional plan's core call — derive at read time, no stored counter
table — survives review. `reception_rota_sessions` really is the assignment
history, the aggregate really is small, and a stored rolling-window total
really would have to be rebuilt from the sessions anyway. Nothing below
reopens that.

Six corrections, one of which is a genuine defect in the arithmetic:

**C1 — the weighted score as specified can exceed 100%, and does so for
`not_working`.** Design Decision 7 defines the score as
`role_hours / total_hours_worked`, while Design Decision 5 defines
`total_hours_worked` as *excluding* `not_working` slots. Those two rules
together are inconsistent for the one role that is excluded from the
denominator but included in the numerator: a staff member with 2 `phones`
slots and 10 `not_working` slots has 1.0 hours worked and 5.0 `not_working`
hours, i.e. a "proportion" of 500%. Every other role is fine, because every
other role's hours are inside the denominator.

Resolution: keep `not_working` in the slot counts (a count of not-working
slots is a real fact and worth showing), and give it **no** weighted score —
render `—`. "What proportion of Sam's working time was spent not working" is
not a question with an answer, and inventing one would be worse than an empty
cell. This is a display rule, not an aggregation rule: the compute module
returns raw slot counts for all thirteen roles and the hours-worked figure,
and the frontend declines to divide for that one role. Stated as Design
Decision 7a below.

**C2 — the window is 4–5 weeks long, not four.** `from_date = monday_of(today)
- 4 weeks` with `to_date = today` spans 29 days on a Monday and 33 on a
Friday. The provisional plan's prose calls this "four calendar weeks back",
which undersells it. The behaviour is right — the current week's assignments
should count — but the number of days in the window moves through the week,
so a staff member's absolute slot counts drift upward Monday to Friday and
reset. This is harmless for the thing the counters are *for* (comparing staff
against each other inside one window, where everyone shares the same window)
and would be misleading only if someone read a single row's counts as a stable
metric over time. `days_counted` on the response is what makes that legible,
which is why it is being returned. Keep the rule; fix the prose.

**C3 — "a single indexed `GROUP BY`" is true, but not for the reason
implied.** The relevant indexes exist and this ticket needs no migration:
`uq_reception_rotas_date` serves the date-range filter, `uq_rrs_slot`
(`rota_id, staff_id, hour`) is `rota_id`-leading so the sessions join is
indexed, and `uq_rle_slot` (`staff_id, date`) serves the leave anti-join. The
`GROUP BY staff_id` itself is not index-served — it is a hash or sort over the
window's rows. At ~4,400 rows that is irrelevant. Recording it so nobody later
"discovers" a missing index and adds one for a query that does not want it.

**C4 — `lunch` counting as working hours is inherited, not decided.** Design
Decision 5 keeps `ReceptionHoursPage`'s existing rule, which counts a `lunch`
slot as working time. That was never a deliberate choice about lunch; it is
what "everything except `not_working`" happens to do. It matters more here
than it did there, because hours worked is now a denominator: counting lunch
inflates it and dilutes every role's proportion by a few percent for everyone.
Keeping it is still the right call — two hours figures on the same page that
disagree about what "working" means would be worse than a uniform few
percent — but it is now a decision rather than an inheritance, and the one
place to change it if the user disagrees is the role-exclusion set in
`compute_role_counters`. Flagged for the user; the plan proceeds on "keep".

**C5 — `days_present` must exclude leave days too.** Design Decision 4
excludes leave from "both numerator and denominator" but the provisional
plan's per-staff `days_present` field is neither. It has to follow the same
rule, or a page showing "18 days present, 0 hours worked" for someone on leave
all month becomes possible. Same `IS NULL` filter, same query — just stating
it so the coding chat does not treat `days_present` as a separate count over
unfiltered rows.

**C6 — the provisional plan contains one task, and the ticket needs five.**
Task 1 (the compute module) was written out; the endpoint, the frontend
client, the page swap, and the docs update were scoped but never broken down.
They are Tasks 2–5 below. Task 4 in particular carries work the provisional
plan did not mention at all: deleting `ReceptionHoursPage.tsx` and
`ReceptionHoursPage.test.tsx`, and editing the route and nav entry in
`App.tsx` — replacing a page is three files, not one.

## Plan

Give the reception rota per-role counters and weighted (per-hour-worked)
counters, over a rolling four-week-plus-current-week window of generated day
rotas. The counters are computed by a single shared function that the
reception API calls today and that a future front-desk-rotation generator will
call as its fairness input.

## Scope

**In scope**

- A compute module, `backend/app/reception_counters.py`, exposing the window
  helper and the aggregation. This is the seam the future generator uses.
- One read-only endpoint, `GET /reception/counters`, returning per-staff role
  slot counts, hours worked in the window, and the window's own bounds.
- A `ReceptionCountersPage` at `/reception/counters`, replacing the current
  `ReceptionHoursPage` and its nav entry. It keeps today's template-derived
  weekly hours as a column, so nothing that page showed is lost.
- Backend and frontend tests; architecture doc updates.

**Out of scope**

- Any generation or auto-assignment of reception roles. This ticket builds the
  fairness input; the rotation logic that consumes it is a later ticket.
- Any change to reception generation, editing, coverage rules, or leave.
  Nothing in this plan writes to an existing table.
- Clinical counters. Nothing in `clinic_counters` / `system_counters` /
  `counter_snapshots`, the engine, or `CountersPage` is touched.
- Any migration. No schema change, no new index — see C3.

## Design Decisions

**1. Counters are derived at read time, not stored.** This reverses the
starting assumption of "port the clinical counter model", and the reason is
the window. A rolling window cannot be maintained as a running total: a stored
counter can be incremented and decremented, but it has no way to forget a day
that ages out of the window, so it has to be rebuilt from
`reception_rota_sessions` regardless. A table would therefore be a cache of a
derived number, not a source of truth.

Nothing is lost by omitting it. The persistence a future generator needs is
the assignment history, and that is already durable —
`reception_rota_sessions` *is* the counter history. At this practice's scale
one window is roughly 4,400 rows and the aggregate is a single `GROUP BY`.

The clinical model's stored tables exist for reasons reception does not share:
the engine reads counters mid-run as a tie-break, and the values are
cumulative forever, which is what makes the `counter_snapshots` lifecycle and
the reset endpoints necessary. Reception has no draft/commit lifecycle to hang
a snapshot off — "Regenerate" is `DELETE` then `POST` — so a stored reception
counter would need correct decrements on every session delete, day delete and
cascade, with no snapshot to restore from when one was missed. Deriving the
value removes that entire class of drift bug rather than defending against it.

One consequence to be aware of rather than to fix: deleting a generated day
deletes that day's contribution to the counters, because the sessions are the
history. That is the correct reading — a regenerated day's old assignments did
not happen — but it does mean the counters move when someone regenerates a
past day.

**2. The seam is a function, not a table.** `compute_role_counters(db,
from_date, to_date)` in `backend/app/reception_counters.py` is the single
implementation, called by the router now and by the future generator later. If
the aggregate ever does become slow, a materialised `reception_role_counters`
table can be introduced behind this function without changing a single caller.
Module placement follows the existing convention for domain logic outside the
API — `leave_charging.py`, `doctor_window.py`, `master_template.py` sit
directly under `backend/app/`; there is no `services/` package and this plan
does not create one.

**3. The window is the four complete preceding weeks plus the current week to
date.** `to_date` is today; `from_date` is the Monday of the current week
minus four weeks. Future-dated generated days are excluded, so generating a
week ahead does not pollute the fairness picture with assignments that have
not happened.

The window is therefore 29–33 days long depending on the weekday it is
computed on (C2), and today's own rota counts even though the day is not over.
Both are accepted: every staff member is measured over the same window, which
is what a fairness comparison needs, and `days_counted` is returned so the
figure is interpretable rather than mysterious.

The rule lives in one helper, `default_counter_window(today)`, so it is
testable in isolation and has exactly one definition. The endpoint accepts
`from_date` / `to_date` overrides that default to it, which keeps the API
useful for ad-hoc questions without a second code path computing the numbers.

A window with sparse generation simply contributes fewer days rather than
reaching further back. `days_counted` is returned so the number is
interpretable — four weeks with six generated days is a fact the page should
show, not hide.

**4. Leave is excluded from both numerator and denominator.** A staff member's
rows on a date they have a `ReceptionLeaveEntry` count toward neither their
role counts nor their hours nor their `days_present` (C5). Their rows stay on
the day, exactly as documented in `architecture-reception.md` — this is a
reading of the data, not a change to it.

Because the value is computed at read time, leave entered *after* a day was
generated is picked up automatically. The discussion treated late-entered
leave as an accepted inaccuracy on the assumption of stored counters; deriving
the value dissolves the question, and no leave-router change is needed.

**5. Hours worked excludes `not_working`, and nothing else.** This matches
`ReceptionHoursPage`'s existing rule exactly, so the two hours figures on the
page cannot disagree about what "working" means. `lunch` therefore counts as
working hours, as it does today — now a deliberate choice with a known cost
(C4), changeable in exactly one place: the exclusion set in
`compute_role_counters`. All thirteen `ReceptionRole` values are counted in
the slot-count numerator, `not_working` included, because a count of
not-working slots is harmless to report and suppressing one role would be a
special case with no rule behind it.

**6. Zero hours is "unknown", not infinity — a deliberate divergence from
`weightedScore.ts`.** The clinical rule maps `sessions_per_week == 0` to
infinity so the engine never prefers that doctor; the value is a sort key, and
infinity is a real answer to "who is least loaded". Here zero hours worked
means the numerator is zero too, nothing is being ordered yet, and a staff
member who worked no days in the window has genuinely no data. Rendering that
as ∞ would claim a fairness fact that does not exist. The new
`receptionWeightedScore.ts` is a sibling of `weightedScore.ts`, not a reuse of
it, and its docstring should say so and say why.

**7. The weighted score is a proportion of time, not a scaled ratio.**
`role_hours / total_hours_worked`, where `role_hours = role_slots × 0.5`. This
reads directly as "31% of Sam's working time was on phones". It needs none of
`weightedScore.ts`'s cosmetic ×10, which exists there only to make a unitless
engine tie-break score readable.

**7a. `not_working` has a slot count but no weighted score.** Its hours are in
the numerator's reach but excluded from the denominator by Design Decision 5,
so the ratio is not a proportion of anything and can exceed 100% (C1). The
frontend renders `—` for that one cell. The compute module knows nothing about
this — it returns counts and hours, and the display rule lives with the
display.

**8. The page replaces `ReceptionHoursPage` rather than sitting beside it.**
Hours worked is the weighted counter's denominator, so splitting them across
two nav entries would split one idea in two. The template-derived weekly hours
the old page showed survive as a column — that number answers a different
question ("what is Sam contracted for") from the window figure ("what did Sam
actually work"), and both are worth seeing next to the counters. The system is
not live, so the old `/reception/hours` path needs no redirect.

**9. Thirteen role columns are too many to read raw, so the table has one
mode switch.** A staff × role grid with thirteen role columns plus four
identity/hours columns does not fit a laptop screen legibly. The page renders
one table with a Slots / % of time toggle above it, changing what the role
cells contain, rather than seventeen columns of two numbers each or two
separate tables. Both modes read from the same fetched payload — the toggle is
local component state, not a refetch, and no query parameter encodes it.

## Task 1: Compute module

**A.** Nothing has been built yet. This task adds the shared aggregation that
both the API and the future reception generator will call. Tasks 2–5 depend on
this module's signature and on nothing else in it.

**B.** Files and deliverables:

- `backend/app/reception_counters.py` — new. Exports `default_counter_window`
  and `compute_role_counters`, plus whatever result dataclasses they return.
- `backend/tests/test_reception_counters.py` — new. Unit tests against a DB
  session, following the existing non-API test conventions in
  `backend/tests/` (see `backend/tests/conftest.py` for the `db_session`-style
  fixtures; this is not an API test, so it does not live under
  `tests/test_api/`).
- Read for context: `backend/app/models/reception.py`,
  `backend/app/api/routers/reception_rota.py` (`_staff_on_leave` and
  `compute_coverage_issues` are the closest existing shape),
  `backend/app/leave_charging.py` (module-placement precedent).

**C.** Instructions:

1. `default_counter_window(today: date) -> tuple[date, date]` returns
   `(monday_of(today) - 4 weeks, today)` per Design Decision 3. Take `today` as
   a parameter rather than calling `date.today()` inside, so it is testable.
2. `compute_role_counters(db, from_date, to_date)` returns, per staff member:
   the staff row's identity fields (`id`, `code`, `name`, `active`), slot
   counts for all thirteen `ReceptionRole` values (zero-filled, so callers
   never default), `hours_worked`, and `days_present`. Also return
   `days_counted` — distinct `reception_rotas.date` values in range — at the
   top level. Return a dataclass pair (a result object holding the window
   bounds, `days_counted`, and an ordered list of per-staff rows), not a bare
   tuple; the router and the future generator both want names.
3. One `GROUP BY` over `reception_rota_sessions` joined to `reception_rotas`
   for the date, with a `LEFT JOIN` to `reception_leave_entries` on
   `(staff_id, date)` and an `IS NULL` filter to drop leave days. Keep it to
   portable SQLAlchemy Core constructs — this runs on SQLite in tests and
   Postgres in production, as `path`-filter portability elsewhere in the app
   already forces. Group by `(staff_id, role)` and pivot in Python; do not
   emit thirteen conditional aggregate expressions.
4. Hours worked = non-`not_working` counted slots × 0.5 (Design Decision 5).
   Put the excluded-role set in a module-level constant with a comment
   pointing at Design Decision 5, since it is the single knob if lunch is ever
   reclassified (C4).
5. `days_present` is the count of distinct in-window dates on which that staff
   member has at least one session row *after* the leave filter (C5) — not a
   separate unfiltered count.
6. Include every staff member with rows in the window, active or not, so a
   recently deactivated person's history stays visible; plus every active
   staff member with no rows, zero-filled, so a new starter appears as 0 rather
   than vanishing. Carry `active` through so the page can label them. Order the
   rows by staff name so the router does not have to.
7. Do not apply the `not_working` display rule from Design Decision 7a here —
   this module returns counts and hours only, and computes no ratios at all.
8. Tests to cover: the window helper's boundaries (including that it is
   computed from the Monday, so the span differs by weekday); leave excluded
   from counts, hours *and* `days_present`; `not_working` counted as a role but
   not as hours; a staff member with no rows appearing zero-filled; an inactive
   staff member with rows still appearing; future-dated rotas excluded;
   `days_counted` with sparse generation.

## Task 2: Endpoint

**A.** Task 1 is complete: `backend/app/reception_counters.py` exposes
`default_counter_window` and `compute_role_counters`. This task exposes it over
HTTP. It adds no logic of its own — any arithmetic that appears in this task is
a sign something belongs in Task 1's module instead.

**B.** Files and deliverables:

- `backend/app/api/schemas/reception.py` — edit. Add
  `ReceptionCounterRowOut` and `ReceptionCountersOut`.
- `backend/app/api/schemas/__init__.py` — edit. Re-export both, following the
  existing pattern in that file.
- `backend/app/api/routers/reception_rota.py` — edit, *or* a new
  `backend/app/api/routers/reception_counters.py` if you prefer the router
  boundary to match the URL prefix. Prefer the new router file: the existing
  one is prefixed `/reception/rota` and this endpoint is `/reception/counters`,
  so reusing it would mean a second `APIRouter` in one module. If you add a
  file, register it in `backend/app/api/main.py` alongside the other reception
  routers.
- `backend/tests/test_api/test_reception_counters.py` — new. API-level tests,
  conventions per `backend/tests/test_api/test_reception_rota.py` and its
  `conftest.py` (`client`, `seeded_reception`, `MONDAY`).

**C.** Instructions:

1. `GET /reception/counters` with optional `from_date` / `to_date` query
   params, both `datetime.date`. When either is omitted, fill it from
   `default_counter_window(datetime.date.today())`. Auth is
   `Depends(get_current_user)`, same as every other reception route; there is
   no access-level gate on reception endpoints today and this ticket does not
   add one.
2. 422 if `from_date > to_date`. Nothing else validates — a range covering
   dates with no rotas is a legitimate question and answers `days_counted: 0`.
3. `ReceptionCountersOut` carries `from_date`, `to_date`, `days_counted`, and
   `staff: list[ReceptionCounterRowOut]`. Each row carries `staff_id`,
   `staff_code`, `staff_name`, `active`, `hours_worked` (float),
   `days_present` (int), and `role_slots` as a `dict[str, int]` keyed by the
   `ReceptionRole` values, zero-filled for all thirteen. A dict, not thirteen
   named fields: adding a fourteenth role has already happened once (migration
   `004`) and must not require a schema edit, a frontend type edit and a
   migration to appear on this page.
4. The router body is: resolve the window, call `compute_role_counters`, map
   the dataclasses onto the schemas. No filtering, no sorting, no arithmetic.
5. Tests to cover: the default window when no params are passed (freeze or
   inject "today" rather than asserting against the real clock — see how other
   date-dependent tests in the suite handle this); explicit `from_date` /
   `to_date` honoured; `from_date > to_date` 422; unauthenticated 401 (there is
   an existing authorization test pattern in
   `backend/tests/test_api/test_authorization.py`); a full-shape response
   asserting all thirteen role keys present and zero-filled; leave excluded end
   to end.

## Task 3: Frontend types, client and weighted score

**A.** Tasks 1 and 2 are complete: `GET /reception/counters` is live and
returns `{from_date, to_date, days_counted, staff: [...]}`. This task adds the
typed client and the display-only score helper. It renders nothing — Task 4
consumes what this task exports.

**B.** Files and deliverables:

- `frontend/src/api/types.ts` — edit. Add `ReceptionCounterRow` and
  `ReceptionCounters`, mirroring the schemas from Task 2. `role_slots` is
  `Record<ReceptionRole, number>`.
- `frontend/src/api/reception.ts` — edit. Add a `countersAll` /
  `counters(from, to)` pair to `receptionKeys` (flat, as that object's
  docstring requires) and a `useReceptionCounters(from?, to?)` query hook.
- `frontend/src/lib/receptionWeightedScore.ts` — new.
- `frontend/src/lib/receptionWeightedScore.test.ts` — new.
- Read for context: `frontend/src/lib/weightedScore.ts` (the sibling this
  deliberately diverges from), `frontend/src/lib/receptionRoles.ts`
  (`RECEPTION_ROLE_ORDER` / `RECEPTION_ROLE_LABELS`, which Task 4 will need).

**C.** Instructions:

1. `useReceptionCounters` takes optional `from`/`to` ISO date strings and omits
   the query params entirely when they are absent, so the server's default
   window is what applies. Do not compute a default window in the frontend —
   that would be a second definition of Design Decision 3.
2. `receptionWeightedScore.ts` exports a compute function returning a
   discriminated union in the same shape family as `weightedScore.ts`
   (`{kind: "value", value} | {kind: "unknown"}`) and a formatter. There is no
   `infinite` case — Design Decision 6 is the whole reason this file exists
   rather than reusing its sibling, and the docstring must say so and say why.
3. The score is `(roleSlots * 0.5) / hoursWorked` (Design Decision 7). Zero
   `hoursWorked` is `unknown`. The `not_working` role is `unknown` too
   (Design Decision 7a) — put that rule in this module, not in the page, so it
   is unit-tested rather than eyeballed in JSX.
4. The formatter renders a percentage to one decimal place (`"31.2%"`) and
   `"—"` for `unknown`.
5. Tests to cover: a normal proportion; zero hours worked; the `not_working`
   role returning `unknown` even with non-zero hours; the formatter for both
   kinds.

## Task 4: Counters page, replacing the hours page

**A.** Tasks 1–3 are complete: the endpoint is live and
`useReceptionCounters` / `receptionWeightedScore` are available. This task
builds the page and removes the page it replaces. It is the only task that
deletes anything.

**B.** Files and deliverables:

- `frontend/src/routes/ReceptionCountersPage.tsx` — new.
- `frontend/src/routes/ReceptionCountersPage.test.tsx` — new.
- `frontend/src/routes/ReceptionHoursPage.tsx` — **delete**.
- `frontend/src/routes/ReceptionHoursPage.test.tsx` — **delete**.
- `frontend/src/App.tsx` — edit. Swap the import, the
  `<Route path="hours" …>` entry (to `path="counters"`), and the
  `RECEPTION_NAV_ITEMS` entry (`/reception/hours` → `/reception/counters`,
  label `Hours` → `Counters`).
- Read for context: `frontend/src/routes/CountersPage.tsx` (the clinical
  counters table, closest existing shape — but note it is not being reused; see
  the Scope section), the deleted `ReceptionHoursPage.tsx` in git history for
  the weekly-hours derivation being carried over.

**C.** Instructions:

1. The page fetches `useReceptionCounters()` with no arguments (server default
   window), plus `useReceptionStaff()` and `useReceptionMasterSessions()` for
   the template-derived weekly hours column. Carry `computeWeeklyHours` over
   from the deleted page unchanged, docstring included — it is still the only
   definition of that derivation.
2. Columns: Staff, Hours/week (template-derived, the old page's number),
   Hours worked (window), Days present, then one column per role in
   `RECEPTION_ROLE_ORDER`, labelled from `RECEPTION_ROLE_LABELS`.
3. A Slots / % of time toggle above the table switches what the role cells
   render (Design Decision 9): raw slot counts, or
   `formatReceptionWeightedScore(...)`. Local `useState`, no refetch, no query
   param.
4. Show the window above the table — "4 weeks to 17 Aug 2026 · 18 days
   generated" or similar, from `from_date` / `to_date` / `days_counted`. This
   is the whole reason `days_counted` is on the wire (Design Decision 3);
   a page that hides it makes a sparsely generated window silently
   indistinguishable from a quiet one.
5. Inactive staff with history in the window are included (Design Decision 3's
   companion rule in Task 1 step 6) — label the row rather than filtering it,
   since a blank-labelled inactive row would read as a data error.
6. Loading and error states follow the deleted page's pattern; three queries
   now, so combine the flags as it did with two.
7. Tests to cover: the table renders a row per staff member with the expected
   hours and slot counts from a mocked payload; the toggle switches the cells
   to percentages; `not_working` renders `—` in percentage mode; the window
   summary line renders `days_counted`; loading and error states. Follow the
   MSW/mock conventions used by the neighbouring route tests.
8. Grep for `ReceptionHoursPage` and `/reception/hours` after the swap and
   confirm nothing else references either.

## Task 5: Documentation

**A.** Tasks 1–4 are complete: the feature works end to end. This task records
the reasoning that the code will not tell a future reader on its own.

**B.** Files and deliverables:

- `documentation/architecture-reception.md` — edit.
- Read for context: that file's existing "Hours counter is a client-side
  derivation, not a backend endpoint" paragraph, which this ticket makes false.

**C.** Instructions:

1. Replace the "Hours counter is a client-side derivation" paragraph. It
   currently argues *against* backend aggregation for reception, and that
   argument no longer holds — the window figure cannot be derived from the
   template, and the future generator needs the same numbers server-side. Say
   what changed and why, rather than deleting the old reasoning silently.
2. Add a paragraph covering: why the counters are derived rather than stored
   (Design Decision 1, including the regenerate-moves-the-counters
   consequence), the window rule and its 29–33 day span (Design Decision 3),
   leave exclusion (Design Decision 4), and the `not_working` display rule
   (Design Decision 7a) — that last one is exactly the kind of "why is there an
   em dash in this cell" question the file exists to answer.
3. Add `/reception/counters` to the Router surface table.
4. Do not restate the query's shape or the module's function signatures —
   per `CLAUDE.md`, the code is where a reader looks for that.

## Open question for the user

`lunch` counts as working hours (C4, Design Decision 5). Inherited from the
existing hours page rather than chosen, and it now dilutes every role's
percentage by however much of the day is lunch. The plan keeps it, for
consistency with the Hours/week column sitting next to it. If it should be
excluded instead, that is a one-line change to the exclusion set in Task 1
step 4, plus the wording of the two columns' explanatory text — worth deciding
before Task 1 is handed out, but not a blocker.
