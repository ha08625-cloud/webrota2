# Reception Rota Counters — Provisional Plan

Status: provisional. Written at the end of a discussion chat; needs review and
expansion into an implementation plan before any task is handed to a coding
chat.

## Plan

Give the reception rota per-role counters and weighted (per-hour-worked)
counters, over a rolling four-week window of generated day rotas. The counters
are computed by a single shared function that the reception API calls today
and that a future front-desk-rotation generator will call as its fairness
input.

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

## Design Decisions

**1. Counters are derived at read time, not stored.** This reverses the
starting assumption of "port the clinical counter model", and the reason is
the window. A rolling four weeks cannot be maintained as a running total: a
stored counter can be incremented and decremented, but it has no way to forget
a day that ages out of the window, so it has to be rebuilt from
`reception_rota_sessions` regardless. A table would therefore be a cache of a
derived number, not a source of truth.

Nothing is lost by omitting it. The persistence a future generator needs is
the assignment history, and that is already durable —
`reception_rota_sessions` *is* the counter history. At this practice's scale
one window is roughly 4,400 rows and the aggregate is a single indexed
`GROUP BY`.

The clinical model's stored tables exist for reasons reception does not share:
the engine reads counters mid-run as a tie-break, and the values are
cumulative forever, which is what makes the `counter_snapshots` lifecycle and
the reset endpoints necessary. Reception has no draft/commit lifecycle to hang
a snapshot off — "Regenerate" is `DELETE` then `POST` — so a stored reception
counter would need correct decrements on every session delete, day delete and
cascade, with no snapshot to restore from when one was missed. Deriving the
value removes that entire class of drift bug rather than defending against it.

**2. The seam is a function, not a table.** `compute_role_counters(db,
from_date, to_date)` in `backend/app/reception_counters.py` is the single
implementation, called by the router now and by the future generator later. If
the aggregate ever does become slow, a materialised
`reception_role_counters` table can be introduced behind this function
without changing a single caller. Module placement follows the existing
convention for domain logic outside the API — `leave_charging.py`,
`doctor_window.py`, `master_template.py` sit directly under `backend/app/`;
there is no `services/` package and this plan does not create one.

**3. The window is four calendar weeks back from today, excluding the
future.** `to_date` is today; `from_date` is the Monday of the current week
minus four weeks — the four complete preceding weeks plus the current week to
date. Future-dated generated days are excluded, so generating a week ahead
does not pollute the fairness picture with assignments that have not happened.

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
role counts nor their hours. Their rows stay on the day, exactly as documented
in `architecture-reception.md` — this is a reading of the data, not a change
to it.

Because the value is computed at read time, leave entered *after* a day was
generated is picked up automatically. The discussion treated late-entered
leave as an accepted inaccuracy on the assumption of stored counters; deriving
the value dissolves the question, and no leave-router change is needed.

**5. Hours worked excludes `not_working`, and nothing else.** This matches
`ReceptionHoursPage`'s existing rule exactly, so the two hours figures on the
page cannot disagree about what "working" means. `lunch` therefore counts as
working hours, as it does today. All thirteen `ReceptionRole` values are
counted in the numerator, `not_working` included, because a count of
not-working slots is harmless to report and suppressing one role would be a
special case with no rule behind it.

**6. Zero hours is "unknown", not infinity — a deliberate divergence from
`weightedScore.ts`.** The clinical rule maps `sessions_per_week == 0` to
infinity so the engine never prefers that doctor; the value is a sort key,
and infinity is a real answer to "who is least loaded". Here zero hours worked
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

**8. The page replaces `ReceptionHoursPage` rather than sitting beside it.**
Hours worked is the weighted counter's denominator, so splitting them across
two nav entries would split one idea in two. The template-derived weekly hours
the old page showed survive as a column — that number answers a different
question ("what is Sam contracted for") from the window figure ("what did Sam
actually work"), and both are worth seeing next to the counters. The system is
not live, so the old `/reception/hours` path needs no redirect.

## Task 1: Compute module

**A.** Nothing has been built yet. This task adds the shared aggregation that
both the API and the future reception generator will call. No other task
depends on anything but this module's signature.

**B.** Files and deliverables:

- `backend/app/reception_counters.py` — new. Exports `default_counter_window`
  and `compute_role_counters`, plus whatever result dataclasses they return.
- `backend/tests/test_reception_counters.py` — new. Unit tests against a DB
  session, following the existing non-API test conventions in
  `backend/tests/`.
- Read for context: `backend/app/models/reception.py`,
  `backend/app/api/routers/reception_rota.py` (`_staff_on_leave` and
  `compute_coverage_issues` are the closest existing shape),
  `backend/app/leave_charging.py` (module-placement precedent).

**C.** Instructions:

1. `default_counter_window(today: date) -> tuple[date, date]` returns
   `(monday_of(today) - 4 weeks, today)` per Design Decision 3. Take `today` as
   a parameter rather than calling `date.today()` inside, so it is testable.
2. `compute_role_counters(db, from_date, to_date)` returns, per staff member:
   the staff row's identity fields, slot counts for all thirteen
   `ReceptionRole` values (zero-filled, so callers never default), hours
   worked, and days present. Also return `days_counted` — distinct
   `reception_rotas.date` values in range — at the top level.
3. One `GROUP BY` over `reception_rota_sessions` joined to `reception_rotas`
   for the date, with a `LEFT JOIN` to `reception_leave_entries` on
   `(staff_id, date)` and an `IS NULL` filter to drop leave days. Keep it to
   portable SQLAlchemy Core constructs — this runs on SQLite in tests and
   Postgres in production, as `path`-filter portability elsewhere in the app
   already forces.
4. Hours worked = non-`not_working` counted slots × 0.5 (Design Decision 5).
5. Include every staff member with rows in the window, active or not, so a
   recently deactivated person's history stays visible; plus every active
   staff member with no rows, zero-filled, so a new starter appears as 0
   rather than vanishing. Carry `active` through so the page can label them.
6. Tests to cover: the window helper's boundaries; leave excluded from both
   counts and hours; `not_working` counted as a role but not as hours; a staff
   member with no rows appearing zero-filled; future-dated rotas excluded;
   `days_counted` with sparse generation.

## Task 2: API endpoint

**A.** The compute module (Task 1) exists and is tested. This task exposes it
over HTTP. It adds no new mutation and touches no existing router.

**B.** Files and deliverables:

- `backend/app/api/schemas/reception.py` — add the output schemas.
- `backend/app/api/routers/reception_counters.py` — new, prefix
  `/reception/counters`, one `GET`.
- `backend/app/api/main.py` — register the router. Note it is read-only, so
  check how the existing read-only routers are included with respect to
  `require_write_access`.
- `backend/tests/test_api/test_reception_counters.py` — new.
- Read for context: `backend/app/api/routers/reception_coverage.py` (smallest
  reception router), `backend/app/api/routers/counters.py` (the clinical
  read shape).

**C.** Instructions:

1. `GET /reception/counters?from_date=&to_date=`, both optional, defaulting
   together to `default_counter_window(date.today())`. Return the resolved
   `from_date` / `to_date` in the body — the page must be able to state the
   window it is showing without recomputing the rule in the browser.
2. 422 if `from_date > to_date`. No other validation; an empty window is a
   legitimate result with `days_counted: 0`, not an error.
3. The endpoint is a thin adapter — all arithmetic stays in Task 1's module.
4. Tests: the default window; explicit overrides; the inverted-range 422; a
   date range with no generated rotas; leave exclusion visible through the
   API. Note the conftest trap documented in
   `backend/tests/test_api/conftest.py` — a test may use exactly one client
   fixture.

## Task 3: Frontend page

**A.** The endpoint (Task 2) is live. This task replaces `ReceptionHoursPage`
with `ReceptionCountersPage`, wires the nav, and adds the weighted-score
helper.

**B.** Files and deliverables:

- `frontend/src/api/types.ts` — add the wire mirrors for the new payload.
- `frontend/src/api/reception.ts` — add `useReceptionCounters(from, to)`,
  following the module's existing key conventions. The whole filter object
  goes in the query key.
- `frontend/src/lib/receptionWeightedScore.ts` + test — new, per Design
  Decisions 6 and 7.
- `frontend/src/routes/ReceptionCountersPage.tsx` + test — new.
- `frontend/src/routes/ReceptionHoursPage.tsx` and its test — delete. Move its
  `computeWeeklyHours` into the new page (or into `lib/`) so the contracted
  weekly hours column keeps working, and carry its tests across rather than
  dropping them.
- `frontend/src/App.tsx` and `App.test.tsx` — swap the nav entry and route.

**C.** Instructions:

1. Table of staff rows × role columns, with a toggle for slots / hours /
   percent of hours worked. Suppress role columns that are zero for every
   staff member — thirteen columns is unreadable when nine of them are empty.
2. Fixed columns alongside the roles: staff name, contracted weekly hours
   (template-derived, the old page's number), hours worked in window.
3. State the window and `days_counted` in the page's intro text. A user
   reading a fairness number needs to know it came from six generated days.
4. Read-only page: no write gating needed, but check the loading/error
   conventions the sibling reception pages use.
5. Mark inactive staff visibly, as the page includes them when they have
   history in the window.

## Task 4: Documentation

**A.** Tasks 1–3 are complete and merged.

**B.** `documentation/architecture-reception.md`, and the "Router surface"
table within it.

**C.** Instructions:

1. Replace the "Hours counter is a client-side derivation" section — its
   claims that reception "has no counters concept" and that no backend
   aggregation exists are both now false, and it is cited from
   `architecture.md`'s framing of the two domains.
2. Record Design Decisions 1, 3, 4 and 6 in the doc's own voice: why reception
   counters are derived where clinical ones are stored, how the window is
   anchored, how leave reads, and why zero hours is "unknown" rather than ∞.
   These are the ones a future reader will otherwise try to "fix" toward the
   clinical model.
3. Add `/reception/counters` to the router surface table.
4. Do not write plan citations or task numbers into code comments or the
   architecture docs — see the rule at the foot of `documentation/architecture.md`.
   Record the decision itself, not a pointer to this file, which is deleted
   once the work ships.

## Open questions for the review chat

1. **Is four weeks the right sample?** Nobody has looked at real reception data
   yet. A 4/8/12-week selector on the page is cheap and would let you check
   before the future generator depends on the number. Left out of the plan
   above as unrequested scope, but it is the cheapest thing here to add.
2. **Should the future generator's fairness input be role-agnostic?** This plan
   counts all thirteen roles. The motivating case — rotating front desk — needs
   one. Counting all of them is not more expensive, but it is worth confirming
   nobody expects the counter to mean something narrower.
3. **Contracted weekly hours and leave.** The template-derived column ignores
   leave entirely, by construction. Next to a leave-aware window figure that is
   arguably confusing; the column may need a tooltip or may not be worth
   keeping.
