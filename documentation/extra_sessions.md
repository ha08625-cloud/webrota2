# Implementation Plan: Planned Extra Sessions

## Plan

Add a way to pre-plan "extra sessions" per doctor/date/period, mirroring how leave is
planned. When a staging run is created for a date range, any planned extra session that
lands on a non-working or admin slot is baked into the staged row as a working session
instead of being copied verbatim from the template. The admin sees it in the staging grid,
tagged with a badge, and can still edit it before generating.

## Scope

**In scope**
- New `ExtraSessionEntry` table plus a minimal CRUD API (list, create, delete).
- Override applied once, at `POST /staging` creation time, inside the existing template
  copy loop.
- `is_extra_session` on `StagingSessionOut`, derived at read time.
- A new frontend page at `/extra-sessions` and a badge in `StagingGrid`.
- Leave-conflict handling in both directions.

**Out of scope**
- The direct `POST /rota/generate` path (test-only; the frontend calls `/staging`).
  Extra sessions will not apply there.
- Any change to counters, fairness logic, or the Phase 0-12 pipeline.
- Retroactively touching an already-generated draft or committed rota. Leave has
  `_release_draft_rooms` for this; extra sessions do not need it because staging always
  precedes generation.
- Bulk create or bulk delete over a date range (see Design Decision 10).

---

## Design Decisions

**1. New table, structurally identical to `LeaveEntry`.**
`extra_session_entries` with `doctor_id`, `date`, `period`, unique on the triple. Not
seeded. Same shape as `backend/app/models/leave.py` so the two read identically.

**2. Override happens once, at staging creation.**
Inside `create_staging`'s copy loop only. No change to `load_context`, Phase 2, Phase 5,
or the direct-generate path. The engine never learns what an extra session is; it only
ever sees an ordinary staged row.

**3. Weekday-only.**
`POST /extra-sessions` 422s on a Saturday or Sunday date. The rota grid is Mon-Fri
(`phase2._DAYS`), so a weekend entry could never apply and silently accepting one would be
a trap. This is stricter than leave's single-create endpoint, which accepts weekend rows;
that asymmetry is deliberate, because leave has a legitimate "record the absence anyway"
reading and an extra session does not.

**4. `Admin time` with a room overrides to `Pre-assigned`, preserving the room.**
`Requires room` with a non-null `room_id` is an invalid pair
(`schemas/master_rota.py:_ROOM_FORBIDDEN`), so `Pre-assigned` is the correct encoding for
"working this session, in this room". Verified against the pipeline:
- `phase2.py:28` — `_PRE_OCCUPYING_TYPES` is `{PRE_ASSIGNED, ADMIN_TIME}`, so the room is
  claimed at grid-build time either way. No change to room contention.
- `phase5.py:27` — `_EXCLUDED_TEMPLATE_TYPES` is `{NO_SURGERY, ADMIN_TIME}`.
  `PRE_ASSIGNED` is not excluded, so the slot is eligible for clinic assignment and the
  clinic counter increments as for any ordinary session.
- `phase7_9a.py` — only acts on `REQUIRES_ROOM` slots, so a `Pre-assigned` extra session
  is skipped there.
- `phase12.py:220` — exempts only `NO_SURGERY`/`ADMIN_TIME` from the missing-room warning.
  A `Pre-assigned` slot holds a room so raises nothing; an unallocated `Requires room`
  extra session correctly warns.

**5. No template row at all creates a new staged row.**
`phase2.py:50` explicitly handles a doctor with no template row for a slot ("nothing to
schedule; no slot is created"). The seeded template writes a row for every
doctor/week/day/period, but the master rota editor supports DELETE and row existence is
itself the data. The archetypal extra session is a part-timer working a day they do not
normally work, so this case must create a new `RotaStagingSession` with
`session_type=REQUIRES_ROOM`, not silently no-op.

**6. Leave wins, enforced in three independent layers.**
- API: `POST /extra-sessions` 409s when a `LeaveEntry` exists for the same
  doctor/date/period. The rule lives in the server so the UI only has to surface the
  message.
- Copy loop: the override is skipped for any slot where leave exists at staging-create
  time. This covers the ordering case the API check cannot (extra session added first,
  leave added afterwards).
- Engine: `phase2.py:63` sets `is_on_leave` from the live `leave_set` regardless of
  `template_type`, and `phase5.py:160` / `phase7_9a.py` skip on-leave slots. Even a stray
  `Requires room` row on a leave slot allocates nothing. The worst outcome of a missed
  conflict is a confusing-looking cell, never a wrong rota.

**7. Leave creation is never blocked by a planned extra session.**
Leave is the more authoritative fact. `POST /leave/bulk` reports how many planned extra
sessions its range superseded, so the frontend can warn; it does not refuse and does not
auto-delete them. `POST /leave` (single) is left untouched — the frontend does not call
it (`LeavePage.tsx` uses only `useBulkCreateLeave`, `useBulkDeleteLeave`, `useDeleteLeave`,
`useLeave`), so changing its response shape would be churn for no user-visible benefit.

**8. `is_extra_session` is derived, and means "a planned extra session exists".**
Same lookup-by-date pattern as `is_on_leave`, not a stored column. Its precise semantics
are *"an `ExtraSessionEntry` exists for this doctor/date/period"* — not *"this staged row
was produced by the override"*. Those diverge whenever the override did not fire: the
template row was already `Pre-assigned` or `Requires room`, leave blocked it, the entry was
added after staging started, or the admin edited the cell back. The badge is therefore
labelled **"Extra planned"**, not "Extra session".

**9. Changes to extra sessions do not affect a staging already in progress.**
The override runs once at create time. The `/extra-sessions` page shows a banner while an
active staging exists, stating plainly that changes will not affect it. Accepted rather
than solved: the workflow is plan-then-stage, and a re-apply mechanism would need to
distinguish admin edits from untouched cells, which is not worth the complexity.

**10. No bulk endpoints.**
Leave's `POST /leave/bulk` means "every weekday in the range", which for extra sessions
would mean an extra session every day for a fortnight — never the intent. The half-day
edge machinery in `expandLeaveRange` (first day PM-only, last day AM-only) is also
meaningless here. Single date plus period covers the real workflow.

**11. No counter logic anywhere.**
An extra session becomes an ordinary `Requires room` or `Pre-assigned` slot, so existing
Phase 5 counter increments apply with zero special-casing.

**12. WFH overrides to `Requires room`. FLAGGED FOR CONFIRMATION.**
A planned extra session on a WFH slot pulls the doctor into the building. This is the one
row of the override table a user could find surprising, and it is a widening of the
original scope (which triggered on `No surgery` and `Admin time` only). If it should
instead be left untouched, the change is removing one enum value from `_OVERRIDABLE_TYPES`
in Task 2 — nothing else in this plan depends on it.

---

## Override table

Applied per staged slot at `POST /staging` creation time.

| Template row for the slot | Staged as | Room |
|---|---|---|
| `No surgery` | `Requires room` | null |
| `Admin time`, no room | `Requires room` | null |
| `Admin time` with a room | `Pre-assigned` | preserved |
| `WFH` (see Decision 12) | `Requires room` | null (WFH never carries one) |
| No row at all | `Requires room` (new row created) | null |
| `Requires room` or `Pre-assigned` | untouched | untouched |
| Leave exists for the slot | untouched (override skipped) | untouched |

---

# Task 1: Data model and CRUD API

## A. State of the world

Nothing has been built yet. This task adds the `ExtraSessionEntry` table, its migration,
schemas, and a minimal `/extra-sessions` router, plus the one-way conflict reporting on
bulk leave creation. No staging or frontend code is touched.

## B. Files and deliverables

**New**
- `backend/app/models/extra_session.py` — `ExtraSessionEntry`
- `backend/alembic/versions/014_extra_session_entries.py` — create table
- `backend/app/api/schemas/extra_session.py` — `ExtraSessionIn`, `ExtraSessionOut`
- `backend/app/api/routers/extra_sessions.py` — list, create, delete
- `backend/tests/test_api/test_extra_sessions.py`

**Edited**
- `backend/app/models/__init__.py` — import and `__all__`
- `backend/app/api/schemas/__init__.py` — import and `__all__`
- `backend/app/api/main.py` — add `extra_sessions` to the import tuple and the
  `include_router` loop on line 51
- `backend/app/api/schemas/leave.py` — `LeaveBulkOut` gains
  `superseded_extra_sessions: list[ExtraSessionOut]`
- `backend/app/api/routers/leave.py` — populate that field in `create_leave_bulk`
- `backend/tests/test_api/test_leave_duty.py` — cover the supersede reporting

## C. Instructions

**Model.** Copy `backend/app/models/leave.py` verbatim, renaming the class to
`ExtraSessionEntry`, `__tablename__` to `extra_session_entries`, and the unique constraint
to `uq_extra_session_slot`. Same three columns, same `enum_col(Period)`, same
`ForeignKey("doctors.id")`. Export from `models/__init__.py` alongside `LeaveEntry`.

**Migration.** Revision `014`, `down_revision = "013"`. Plain `op.create_table` mirroring
how `leave_entries` is created in `001_initial_schema.py`, including the named unique
constraint. No new enum type is introduced — `Period` already exists — so nothing needs to
touch `_create_enum_types()`. `downgrade()` is a real `op.drop_table`.

**Schemas.** `ExtraSessionIn` (`doctor_id`, `date`, `period`) and
`ExtraSessionOut(ExtraSessionIn)` adding `id`, with
`model_config = {"from_attributes": True}` — identical to `LeaveIn`/`LeaveOut`. No
validators on the model; the weekday and leave-conflict rules need the request context and
the DB respectively, so both live in the router.

**Router.** `prefix="/extra-sessions"`, `tags=["extra-sessions"]`, every endpoint taking
`user: dict = Depends(get_current_user)` like every other router.

- `GET ""` — optional `doctor_id`, `from_date`, `to_date` query params, ordered by
  `date, doctor_id`. Copy `list_leave` exactly.
- `POST ""` — 201. In order:
  1. 404 if the doctor does not exist.
  2. 422 if `payload.date.weekday() > 4`, message naming the date and that extra sessions
     are weekdays only (Decision 3).
  3. 409 if a `LeaveEntry` exists for `(doctor_id, date, period)`, message:
     `"Dr X is on leave on <date> <period>; remove the leave first"` (Decision 6).
  4. Insert, catching `IntegrityError` as a 409 duplicate, exactly as `create_leave` does.
- `DELETE "/{entry_id}"` — 204, 404 if absent. Copy `delete_leave`.

Do **not** port `_release_draft_rooms`, `_expand_periods`, `_date_range`, or either bulk
endpoint.

**Leave supersede reporting.** In `create_leave_bulk`, after the candidate list is built
and before the commit, query `ExtraSessionEntry` for the same `doctor_id` where
`(date, period)` is in `candidates`. Return the matching rows as
`superseded_extra_sessions` on `LeaveBulkOut`. Do not delete them and do not fail the
request (Decision 7). Query over the whole candidate set including duplicates, matching
how `_release_draft_rooms` is deliberately called for duplicates too.

**Tests.** `backend/tests/test_api/test_extra_sessions.py` covering: create and list
round-trip; 404 unknown doctor; 422 weekend date; 409 duplicate; 409 when leave exists;
delete 204 then 404; the `doctor_id`/`from_date`/`to_date` filters. Add one test to
`test_leave_duty.py` asserting `superseded_extra_sessions` is populated when bulk leave
covers a planned extra session, and that the extra session row still exists afterwards.

---

# Task 2: Staging integration

## A. State of the world

Task 1 is complete: `ExtraSessionEntry`, its migration, schemas, `/extra-sessions` router,
and the bulk-leave supersede reporting all exist. This task makes `POST /staging` apply the
override table, and exposes `is_extra_session` on staged session reads. No frontend code is
touched.

## B. Files and deliverables

**Edited**
- `backend/app/api/routers/staging.py` — `_extra_session_lookup` helper, override in
  `create_staging`'s copy loop, `is_extra_session` in `_session_outs`
- `backend/app/api/schemas/staging.py` — `StagingSessionOut` gains `is_extra_session: bool`
- `backend/tests/test_api/test_staging.py` — override coverage

## C. Instructions

**Lookup helper.** Add `_extra_session_lookup(db, config)` immediately below the existing
`_leave_lookup` (line 80), identical in shape — same date-range bounds, returning
`{(doctor_id, date, period)}`.

**`_session_outs`.** Call the new helper alongside `leave = _leave_lookup(...)` and set
`is_extra_session` with the same `session_date is not None and (...) in extra` expression
already used for `is_on_leave`. This is the single serialisation path for every staging
endpoint, so PATCH, POST and GET all pick it up for free.

**`create_staging` copy loop** (currently lines 279-292). Before the loop, build:
- `extra = _extra_session_lookup(db, config)` and `leave = _leave_lookup(db, config)`
- `week_dates = build_week_dates(config.start_date, config.num_weeks)` (already imported)
- a `{(doctor_id, week, day, period)}` set of the template rows about to be copied, keyed
  by *generation* week, so the missing-row case (Decision 5) can be detected afterwards

Define at module level:

```python
_OVERRIDABLE_TYPES = frozenset({
    MasterSessionType.NO_SURGERY,
    MasterSessionType.ADMIN_TIME,
    MasterSessionType.WFH,   # Decision 12 -- remove this line to leave WFH untouched
})
```

Inside the loop, for each template row, resolve `session_date = week_dates[(gen_week,
row.day)]` and apply:

1. If `(row.doctor_id, session_date, row.period)` is not in `extra`, copy verbatim as now.
2. If it is in `extra` **and** also in `leave`, copy verbatim as now (Decision 6, skip).
3. If it is in `extra` and `row.session_type not in _OVERRIDABLE_TYPES`, copy verbatim.
4. If `row.session_type == ADMIN_TIME` and `row.room_id is not None`, write
   `session_type=PRE_ASSIGNED`, `room_id=row.room_id`.
5. Otherwise write `session_type=REQUIRES_ROOM`, `room_id=None`.

After the template loop, iterate the extra-session entries whose date falls inside the
range and whose `(doctor_id, gen_week, day, period)` has no row in the set built above.
For each, create a new `RotaStagingSession` with `session_type=REQUIRES_ROOM`,
`room_id=None` (Decision 5). Skip any that are also in `leave`. Map date back to
`(gen_week, day)` using `build_date_to_genslot(week_dates)` from `engine.week_map` — the
same helper `leave.py:_release_draft_rooms` uses; a date outside the range or on a weekend
simply will not be in the map. Note the closure interaction: closed dates are still copied
here, exactly as ordinary template rows are (Design Decision 10 of the staging plan) —
Phase 2's closed-date skip remains the single closure authority.

Update the router module docstring to record that the copy loop is no longer a pure copy.

**Tests.** Add to `test_staging.py`, one per override-table row: `No surgery` becomes
`Requires room`; roomless `Admin time` becomes `Requires room`; `Admin time` with a room
becomes `Pre-assigned` with the room preserved; `WFH` becomes `Requires room`; a missing
template row produces a new `Requires room` session; `Pre-assigned` and `Requires room` are
untouched; an extra session on a leave slot leaves the row untouched. Plus: an extra
session outside the staging's date range does not appear; `is_extra_session` is true on the
GET and survives a PATCH that edits the cell back to `No surgery` (Decision 8, and it is
worth an explicit test because it looks wrong at a glance).

---

# Task 3: Frontend

## A. State of the world

Tasks 1 and 2 are complete: the `/extra-sessions` API exists, `POST /staging` applies the
override table, and `StagingSessionOut` carries `is_extra_session`. This task adds the page,
the API hooks, the staging badge, and the supersede warning on the leave page.

## B. Files and deliverables

**New**
- `frontend/src/api/extraSessions.ts`
- `frontend/src/routes/ExtraSessionsPage.tsx`
- `frontend/src/routes/ExtraSessionsPage.test.tsx`

**Edited**
- `frontend/src/api/types.ts` — `ExtraSessionEntry`, `ExtraSessionIn`;
  `is_extra_session: boolean` on `StagingSession`; `superseded_extra_sessions` on
  `LeaveBulkOut`
- `frontend/src/App.tsx` — nav entry and route (line 27 and line 92 patterns)
- `frontend/src/components/StagingGrid.tsx` — badge
- `frontend/src/components/StagingGrid.test.tsx` — badge coverage
- `frontend/src/routes/LeavePage.tsx` — supersede warning in the bulk-add summary
- `frontend/src/test/fixtures/staging.ts` — `is_extra_session: false` on the fixture
- `frontend/test/msw/handlers.ts` — `/extra-sessions` handlers

## C. Instructions

**API hooks.** `extraSessions.ts` follows `api/leave.ts` exactly: an `extraSessionKeys`
object, `useExtraSessions(doctorId)`, `useCreateExtraSession()`, `useDeleteExtraSession()`.
Invalidate `extraSessionKeys.all` on both mutations. Do **not** invalidate `rotaKeys` —
unlike leave, an extra session never mutates a draft, so there is nothing for an open rota
view to refetch.

**Page.** A new standalone page, deliberately not a mode on `LeavePage` (which is already
484 lines and carries its own `add`/`remove` mode, the range preview, and three half-day
edge selects, none of which apply here). Structure:

- Heading and a short line of explanatory text: an extra session marks a doctor as working
  a session they would not normally work, and is applied when a staging is started.
- **Banner when `useActiveStaging()` returns a staging** (Decision 9): a neutral
  informational box, not an error, saying changes made here will not affect the staging
  already in progress. `RotaPage.tsx` shows the existing `useActiveStaging` usage pattern.
- Add form: doctor select (active doctors only, grouped with `groupDoctorsByType`, matching
  `LeavePage`'s add-mode select), a single date input, a period select (AM / PM), and a
  submit button. No range, no half-day edges.
- Client-side weekday guard before submitting, so the server's 422 is never the first line
  of defence — the same reasoning as `MAX_RANGE_DAYS` in `LeavePage.tsx:23`.
- Error rendering via the existing `errorDetail` helper pattern, so the 409 leave-conflict
  message from Task 1 surfaces verbatim.
- Table of existing entries filtered by an "all doctors" select (read against *all*
  doctors including inactive, matching `LeavePage`'s filter reasoning), each row with a
  delete button. Use `formatDateWithDay` from `lib/date`.

**Staging badge.** In `StagingGrid.tsx`, immediately after the existing `is_on_leave` badge
(line 227), add a sibling for `is_extra_session` reading **"Extra planned"** in a distinct
colour from the amber leave badge — sky or indigo. Both can appear on the same cell (leave
plus a stale planned extra session), which is intentional and is what makes the conflict
visible. Update the component docstring (lines 36-38) to describe the second badge and its
derived semantics.

**Leave supersede warning.** In `LeavePage.tsx`'s bulk-add success handling, when
`superseded_extra_sessions` is non-empty append a line to `formSummary` naming the count
and dates, worded as a warning rather than an error — the leave was created successfully
(Decision 7). Nothing is deleted; the user decides whether to remove the extra sessions.

**Tests.** `ExtraSessionsPage.test.tsx`: renders the list; creates an entry; renders the
409 leave-conflict detail as an error message; blocks a weekend date client-side without
calling the API; shows the banner when an active staging exists and hides it when
`/staging/active` 404s; deletes an entry. `StagingGrid.test.tsx`: badge renders when
`is_extra_session` is true, and both badges render together when the session is also on
leave. Add MSW handlers for `GET`/`POST /extra-sessions` and `DELETE
/extra-sessions/:id`, plus `is_extra_session: false` on the staging fixture so existing
tests keep compiling.