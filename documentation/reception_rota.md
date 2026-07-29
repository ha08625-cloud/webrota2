# Implementation Plan: Reception Rota

## Scope

A second, independent rota type for reception staff, living under the existing `/reception` shell. One day at a time, hourly divisions 8am-6pm (10 slots), one role per staff member per hour (`phones` or `other`), validated against a configurable minimum phone-coverage rule.

A weekday master template (Mon-Fri) holds the expected pattern. "Generate" for a date is a straight copy of that weekday's template rows onto the date; the resulting day grid is then directly editable, with coverage shortfalls shown live alongside it.

Nothing is shared with the clinical rota except auth, the app shell, the HTTP client, and the deployment. No doctors, rooms, clinic types, counters, leave, closures, duty, staging, or generation phases are touched or reused.

**Out of scope for v1** (confirmed): leave/absence tracking for reception staff; multi-day or week views; roles beyond `phones`/`other`; fairness counters; eligibility rules; auto-assignment; draft/commit lifecycle; a generation engine.

---

## Review of the provisional plan

The provisional plan is sound in its essentials — a separate staff table, hourly slots, absence-is-data, template-copy instead of an engine, and warnings-not-errors are all the right calls and all consistent with how the clinical side already works. Seven points needed correcting or filling in before it can be implemented. Each is carried into the Design Decisions below; they are collected here so the changes against the provisional plan are visible.

1. **"5 weekday templates" is one template with a `day` column, not five records.** Modelling it as five template rows would reproduce `master_rota_templates`' single-active-template problem (documented in Architecture.md as *not* schema-enforced, resolved by lowest-id) for no benefit. Corrected in Decision 3.

2. **The provisional plan does not say what a generated day *is*.** With no draft/commit lifecycle there is still a question the schema has to answer: how do you tell "this date has never been generated" from "this date was generated and then every row was deleted"? A thin header table answers it. Added as Decision 5.

3. **Regenerating over an edited day is undefined.** Pressing Generate twice must have a stated outcome. Added as Decision 6 (409 + explicit clear), matching how the rest of the codebase refuses to clobber.

4. **Coverage rules should be keyed `(day, hour)`, not `hour` alone.** ⚠️ **This is the one change that needs your confirmation** — see Decision 8. Monday 9am and Friday 3pm are not the same staffing problem in general practice, and adding the day dimension later costs a migration plus a UI rework. Adding it now costs one extra column and 50 seed rows instead of 10, with no change to any query or component shape.

5. **`other` carries no information.** As specified, a slot marked `other` cannot tell the admin what the person is actually doing, and the first request after go-live will be "we need to distinguish admin from meeting from training" — which under a two-value enum is a migration. A nullable free-text `note` on the slot absorbs that at near-zero cost and keeps the enum at two values, which is all the coverage rule ever needs. Added as Decision 4.

6. **The absence consequence must be stated, not discovered.** With leave out of scope, coverage validation counts anybody holding a `phones` row. A receptionist off sick still reads as covered until someone deletes their rows for that day. That is the correct v1 behaviour (deleting the row *is* the absence mechanism, exactly the clinical rota's "cell absence is data" convention) but it is a real limitation, not an oversight, and belongs in the docstring. Decision 10.

7. **Naming collision.** The clinical nav already labels the doctors page "Staff" (`App.tsx:32`). A reception page also called "Staff" in a sibling nav is confusing in support conversations. Use "Reception Staff" in the nav and `reception_staff` throughout the schema. Decision 1.

One further note, not a correction: the hour range is fixed by a check constraint, so changing the practice's opening hours later is a migration plus new coverage-rule rows. That is the right trade for v1 — the alternative (opening hours as configuration) means every read has to resolve them dynamically — but it is a real cost and is recorded in Decision 2 rather than left implicit.

---

## Design Decisions

1. **`reception_staff` is a new table, entirely independent of `doctors`.** Fields: `id`, `code` (unique), `name`, `active` (soft delete, matching `Doctor.active` — the closest analogue is a person record, so use `active`, not `is_active`). No employment window, no `sessions_per_week`, no preferred rooms, no supervision, no signature, no counters. Reception staff are never doctors, never appear on a clinical rota, and share none of the fields that exist to serve the generation engine. Referred to as "Reception Staff" everywhere user-facing.

2. **Hours are a plain integer 8-17, one column, check-constrained.** `hour = 8` means the 8-9am slot; `hour = 17` means 5-6pm. Ten slots per staff member per day. A check constraint (`ck_rms_hour` / `ck_rrs_hour`, `hour BETWEEN 8 AND 17`) mirrors `ck_mrs_week`'s precedent rather than introducing a ten-member Postgres enum, which would be a `CREATE TYPE` carrying no semantics the integer lacks and would sort by declaration order rather than naturally.

   The range lives in one place, `RECEPTION_FIRST_HOUR = 8` / `RECEPTION_LAST_HOUR = 17` in `models/reception.py`, imported by the seed, the routers, and the tests; the frontend mirrors it in `lib/receptionHours.ts`. **Changing the practice's opening hours is therefore a migration** (widening the constraint) plus inserting the new coverage-rule rows. Accepted for v1: the alternative — opening hours as configuration — forces every read path to resolve them at runtime, for a change that happens approximately never.

3. **One master template, with a `day` column — not five templates.** `reception_master_sessions` holds `(staff_id, day, hour, role)`, unique on `(staff_id, day, hour)`. There is **no template header table**: reception has no versioning requirement, no active/inactive concept, and no staging, so a header would only reproduce `master_rota_templates.is_active`'s known ambiguity (Architecture.md: not schema-enforced unique, readers must resolve deterministically) with nothing to gain. If template versioning is ever wanted, adding a header then is a straightforward additive migration.

   **Row existence is the data**, exactly as on `master_rota_sessions`: a staff member with no row for `(Tuesday, 14)` is not expected at 2pm on Tuesdays. Editing a working pattern means creating and deleting rows, not only updating them.

4. **`role` is a two-value enum plus a nullable free-text `note`.** `ReceptionRole.PHONES = "phones"` / `ReceptionRole.OTHER = "other"`, stored by value via the existing `enum_col()` helper. `phones` is the default on every write that omits it.

   The coverage rule only ever asks "is this person on phones or not", so two values is the correct modelling of the *rule*. The `note` column (nullable `String(200)`, on both the template row and the day row) carries what `other` actually means in a given slot — "post", "training", "GP meeting" — as annotation with no behaviour attached, mirroring `RotaSession.notes`. This is what stops the first post-launch request for a third role from being a schema migration. A `note` on a `phones` slot is legal and displays the same way; nothing validates the pairing.

5. **A generated day is a `reception_rotas` header plus `reception_rota_sessions` rows.** The header carries `id`, `date` (unique), `created_at` — nothing else. Sessions carry `(rota_id, staff_id, hour, role, note)`, unique on `(rota_id, staff_id, hour)`, ORM-cascade from the header (`cascade="all, delete-orphan"`, the convention everywhere in this schema).

   The header exists solely to distinguish "never generated" from "generated, then emptied" — without it, a day whose every row was deleted is indistinguishable from an untouched date, and the page cannot decide whether to offer "Generate" or "you are editing an existing day". There is no `status` column, no `committed_at`, no snapshot table: no lifecycle exists to track.

   Day rows are **self-contained snapshots**, never re-derived from the template at read time — the same principle as `RotaSession.template_type`. A template edit made after a day is generated does not change that day.

6. **Generate is a copy; regenerating 409s.** `POST /reception/rota` with a date creates the header and copies every `reception_master_sessions` row for that date's weekday, for **active staff only**, into `reception_rota_sessions`. A weekend date is a 422 (weekdays only, matching `ClosureIn`'s validator). A date that already has a header is a **409** naming the existing rota — never a silent overwrite of hand-edited rows.

   Clearing is explicit: `DELETE /reception/rota/{id}` hard-deletes the header, sessions cascade, and the date becomes generatable again. "Regenerate" in the UI is delete-then-generate behind a confirm, not a force flag — the confirm is where the user is told edits will be lost.

   Copying only active staff matches the frontend gating on the clinical side. Unlike the master rota's writers, which are deliberately permissive so undo-recreate survives a deactivation, the copy loop has no undo to protect.

7. **No engine, no phases, no `RotaConfig`.** There is no eligibility to resolve, no room to allocate, no counter to balance, and no fairness to enforce — nothing that would justify a pipeline. The copy loop is a dozen lines in the router. Nothing under `backend/app/engine/` is imported, extended, or read by any of this.

8. **Coverage rules are keyed `(day, hour)`.** ⚠️ **Changed from the provisional plan — confirm before Task 1 starts.**

   `reception_coverage_rules`: `id`, `day` (`Day` enum, reused from `models/enums.py`), `hour`, `min_phones_staff` (Integer, non-null), unique `(day, hour)`. Seeded with the provisional plan's numbers applied to every weekday: `3` for hours 9 and 10, `2` for the other eight hours — 50 rows.

   Rationale: Monday morning and Friday afternoon are not the same staffing problem, and a rule table that cannot express the difference will need a `day` column within the first month of real use. Adding it now is one column and 40 more seed rows; adding it later is a migration, a seed backfill, a UI rework of the rules page, and a re-key of every lookup. The code shape is identical either way — the lookup is a dict keyed on a tuple instead of an int.

   **If you prefer the simpler v1**, drop the `day` column and the unique becomes `(hour)`, 10 seed rows; everything else in this plan is unchanged except that the rules page renders one column instead of five. Say so and Task 1 changes accordingly.

   Editable in full via the API and a small settings page. A missing rule row for a `(day, hour)` reads as **no minimum** (no warning), not as zero-required-and-therefore-fine — same outcome, but stated so the empty-table case is defined.

9. **Validation is a read-time derivation returning warnings, and it rides along on every write.** For each hour in 8-17, count the day's sessions with `role = phones`; if that count is below the `(day, hour)` rule's `min_phones_staff`, emit a shortfall warning. Never an error, never a block, nothing persisted.

   Reuse `ValidationIssueOut` from `schemas/common.py` — it already carries `severity`/`phase`/`check`/`message` plus optional `day`; add nothing to it, set `phase = "coverage"`, `check = "phones_shortfall"`, and put the hour in the message. A new schema would be a near-duplicate for one integer.

   Every mutating endpoint on the day rota returns `{session, issues}` with the freshly recomputed issues, mirroring the clinical rota's mutate-then-revalidate contract. This is what makes the warnings live without the grid firing a second request per edit. `GET /reception/rota/{id}` returns them too, so a freshly loaded page is already correct.

10. **Absence is expressed by deleting rows, and coverage cannot know about sickness.** With leave out of scope, anyone holding a `phones` row counts as covering that hour. A receptionist who calls in sick still reads as covered until their rows are deleted from that day. This is consistent — it is the same "cell absence is data" convention Phase 2 uses on the clinical side — but it is a genuine limitation of v1 and must be stated in the model docstring and in Architecture.md, not left to be reported as a bug. Adding a reception leave table later has no effect on any decision above; it becomes an additional filter in the coverage count.

11. **Four routers under a `/reception` prefix.** `/reception/staff`, `/reception/master`, `/reception/rota`, `/reception/coverage-rules`, in four modules, matching the codebase's one-router-per-resource convention. The shared `/reception` prefix keeps the two rota types visibly separate in the OpenAPI docs and removes any ambiguity between `/doctors` and reception staff.

12. **Frontend lives entirely under `ReceptionShell`.** `App.tsx` already has the shell with a single index route and a working "Switch app" / "Log out" header. It gains a nav — Day Rota, Master Template, Reception Staff, Coverage Rules — built the same way `CLINICAL_NAV_ITEMS` is. `ReceptionPlaceholder.tsx` is deleted; its route becomes the day rota page. Nothing in `frontend/src/routes/` or `frontend/src/components/` belonging to the clinical rota is imported, extended, or generalised — the two grids have different axes (staff × hour vs doctor × day/period) and forcing a shared abstraction would make both worse.

---

## Data model summary

```
reception_staff
  id, code (String, unique, non-null), name (String, non-null),
  active (bool, non-null, default True)

reception_master_sessions
  id, staff_id FK -> reception_staff.id (non-null),
  day (Day), hour (Integer), role (ReceptionRole), note (String(200), nullable)
  unique (staff_id, day, hour)          uq_rms_slot
  check  hour BETWEEN 8 AND 17          ck_rms_hour

reception_rotas
  id, date (Date, unique, non-null), created_at (DateTime tz, non-null)

reception_rota_sessions
  id, rota_id FK -> reception_rotas.id (non-null, ORM cascade),
  staff_id FK -> reception_staff.id (non-null),
  hour (Integer), role (ReceptionRole), note (String(200), nullable)
  unique (rota_id, staff_id, hour)      uq_rrs_slot
  check  hour BETWEEN 8 AND 17          ck_rrs_hour

reception_coverage_rules
  id, day (Day), hour (Integer), min_phones_staff (Integer, non-null)
  unique (day, hour)                    uq_rcr_slot     [see Decision 8]
  check  hour BETWEEN 8 AND 17          ck_rcr_hour

enums.py
  + ReceptionRole(str, enum.Enum): PHONES = "phones", OTHER = "other"
```

`Day` is reused from `models/enums.py` — it is already Monday-Friday only, which is exactly the reception week. `Period` is not used anywhere in this feature.

---

# Task 1: Data model, migration, seed

**A. State of the world.** Nothing exists yet. The reception section is a shell (`App.tsx`'s `ReceptionShell`) with one placeholder page and no backend at all. This task creates the four tables, the new enum, and the coverage-rule seed. It touches no existing table and no existing code path.

**B. Files and deliverables.**

- `backend/app/models/enums.py` — add `ReceptionRole`.
- `backend/app/models/reception.py` — **new.** `ReceptionStaff`, `ReceptionMasterSession`, `ReceptionRota`, `ReceptionRotaSession`, `ReceptionCoverageRule`, plus the `RECEPTION_FIRST_HOUR` / `RECEPTION_LAST_HOUR` / `RECEPTION_HOURS` constants.
- `backend/app/models/__init__.py` — re-export all five models and the enum, add to `__all__`.
- `backend/alembic/versions/018_reception_rota.py` — **new.**
- `backend/seed/seed_reception_coverage.py` — **new.**
- `backend/seed/run_all.py` — register the new seeder.
- `backend/tests/test_models.py` — extend with the reception constraint tests.

**C. Instructions.**

Model file. Follow `models/master_rota.py` for style: module docstring explaining the *why* (hourly slots, row-existence-is-data, the absence limitation from Decision 10), `Mapped` / `mapped_column`, `__table_args__` tuple with named constraints, `relationship()` for navigation. `ReceptionRota.sessions` gets `cascade="all, delete-orphan"`; nothing else cascades. Use `enum_col(ReceptionRole)` and `enum_col(Day)` — never a bare `SAEnum`, for the shared-instance reason in that helper's docstring.

`RECEPTION_HOURS` is `range(RECEPTION_FIRST_HOUR, RECEPTION_LAST_HOUR + 1)`. Every other module imports it rather than writing `range(8, 18)`.

Migration. Revision `"018"`, `down_revision = "017"`. This is the first migration in the project to create a **new** Postgres enum type since the 001 baseline — every one since (011, 014, 015, 016) has reused existing types with `create_type=False`. So `reception_role` must be created explicitly with `checkfirst=True` at the top of `upgrade()`, following 001's pattern, and **dropped in `downgrade()`** — unlike 002/011, whose enum types had to survive because other tables still used them. Nothing else will reference `reception_role`, so it is this migration's to remove.

`day` on `reception_master_sessions` and `reception_coverage_rules` reuses the existing `day` type — copy the `_enum_column` helper from 015 or 016 verbatim rather than reimplementing it.

Table creation order: `reception_staff`, then `reception_master_sessions`, `reception_rotas`, `reception_rota_sessions`, `reception_coverage_rules`. `downgrade()` reverses it. All five tables start empty, so there is no backfill and no `server_default` anywhere — additive-only, the 011 pattern.

The docstring must record what the CI Postgres round-trip is proving here that it has not proved since 001: that a fresh enum type is created, dropped, and re-created cleanly.

Seed. `seed_reception_coverage.py` mirrors `seed_rooms.py`'s shape (hardcoded data, one function, no CSV). Insert one row per `(day, hour)` over `Day` × `RECEPTION_HOURS`, `min_phones_staff = 3` for hours 9 and 10, `2` otherwise. Register it in `run_all.py` after `seed_rooms`; it has no dependency on doctors or rooms, so position within the transaction does not matter beyond readability. Like every other seeder it is **not idempotent** — a rerun fails on `uq_rcr_slot` and the shared transaction rolls back, which is the existing (incidental, documented) protection.

Reception staff are **not** seeded — entered through the UI, like clinic types.

Tests. Add to `test_models.py`: the two hour check constraints reject 7 and 18; the three unique constraints reject their duplicate; deleting a `ReceptionRota` cascades its sessions; `ReceptionRole` round-trips as `"phones"` / `"other"` by value, not member name.

---

# Task 2: API — reception staff and coverage rules

**A. State of the world.** Task 1 is complete: all five tables exist and are migrated, coverage rules are seeded. Nothing is exposed over HTTP yet. This task adds the two simplest routers — plain CRUD, no cross-entity logic — and their tests.

**B. Files and deliverables.**

- `backend/app/api/schemas/reception.py` — **new.** `ReceptionStaffIn/Out/Patch`, `CoverageRuleOut`, `CoverageRulePatch`.
- `backend/app/api/schemas/__init__.py` — re-export.
- `backend/app/api/routers/reception_staff.py` — **new.**
- `backend/app/api/routers/reception_coverage.py` — **new.**
- `backend/app/api/main.py` — import and register both.
- `backend/tests/test_api/conftest.py` — add a `seeded_reception` fixture.
- `backend/tests/test_api/test_reception_staff.py` — **new.**
- `backend/tests/test_api/test_reception_coverage.py` — **new.**

**C. Instructions.**

Staff router, prefix `/reception/staff`, tag `"reception"`. `GET` (active only by default, `include_inactive: bool = False` query param — the reception staff list is the only management surface, so unlike `DoctorsPage` there must be a reactivation path), `POST` (201), `PATCH /{id}` (partial, `model_fields_set` for presence detection — the `PATCH /rota/{id}/sessions/{session_id}` pattern), `DELETE /{id}` (soft delete, sets `active=False`, 204).

`DELETE` is unconditionally a soft delete — there is no committed-rota concept to 409 against, so the doctors router's blocking logic has no analogue here. A deactivated staff member's existing day rows and template rows are **left alone**: the copy loop skips inactive staff on future generations (Decision 6), which is the whole of the effect.

Duplicate `code` is a 409 via `IntegrityError` on commit, not a pre-check — the project convention, and race-free.

Every handler takes `user: dict = Depends(get_current_user)` and `db: Session = Depends(get_db)`. There is no fail-open path anywhere in this codebase; do not invent one for reception.

Coverage router, prefix `/reception/coverage-rules`. `GET` (all rules, ordered `day, hour`) and `PATCH /{id}` (`min_phones_staff` only). Deliberately **no POST and no DELETE**: the row set is fixed by the seed at one row per `(day, hour)`, and the only meaningful edit is the number. `min_phones_staff` is validated `>= 0` by the schema; zero is legal and means "no minimum here", which is distinct from a missing row only in that a missing row cannot be edited back.

Tests. `seeded_reception` in `conftest.py` creates three active staff plus one inactive, and (since the seed script does not run in tests) the coverage rules for Monday. Cover: create, duplicate-code 409, patch, soft-delete then absent from the default list and present with `include_inactive=true`, and coverage patch round-trip.

---

# Task 3: API — master reception template

**A. State of the world.** Tasks 1-2 are complete: tables migrated, staff and coverage-rule endpoints live and tested. This task adds the weekday template's read and write surface. It does not touch the day rota, which does not exist yet.

**B. Files and deliverables.**

- `backend/app/api/schemas/reception.py` — extend with `ReceptionMasterSessionIn`, `ReceptionMasterSessionOut`, `ReceptionMasterOut`.
- `backend/app/api/routers/reception_master.py` — **new.**
- `backend/app/api/main.py` — register.
- `backend/tests/test_api/test_reception_master.py` — **new.**

**C. Instructions.**

Prefix `/reception/master`. Four endpoints:

- `GET ""` — the full flat session list joined to `staff_code` / `staff_name`, ordered `day, hour, staff_code`. One fetch for the whole template; it is at most a few hundred rows and the grid pivots client-side, exactly as `GET /master-rota/active` does.
- `POST /sessions` — create one `(staff_id, day, hour, role, note)` row, 201.
- `PATCH /sessions/{id}` — set `role` and `note`. Both always present, not a partial update: this is a **pair setter**, matching `PATCH /master-rota/templates/{tid}/sessions/{sid}`'s reasoning — undo replay is then just another PATCH with the previous pair.
- `DELETE /sessions/{id}` — hard delete, 204. No children, nothing to cascade.

There is no displacement rule to implement. The clinical template needs one because a room can be held by only one doctor; a reception hour has no such exclusive resource, so several staff on the same `(day, hour)` is the normal case, not a conflict. Do not port that logic.

`POST` pre-checks `(staff_id, day, hour)` and returns a descriptive 409 rather than letting the unique constraint raise — the same single documented exception to the catch-`IntegrityError` convention that the master rota session POST already makes, for the same reason.

Unknown `staff_id` is an explicit 404 lookup, not an FK error — on Postgres an FK violation surfaces at flush as a 500.

Like the clinical template's writers, this router is **permissive**: no active-staff check server-side. The frontend gates the add affordance to active staff; keeping the server permissive is what lets an undo recreate a row for a staff member deactivated in the meantime.

No validation runs here. Coverage warnings are a property of a dated day grid, not of the template — the template has no date, so no `(day, hour)` rule shortfall computed against it would be actionable. Do not add one.

Tests. Create/patch/delete round-trip, duplicate-slot 409, unknown-staff 404, several staff legally sharing one `(day, hour)`, and the ordering of `GET`.

---

# Task 4: API — day rota, generation and editing

**A. State of the world.** Tasks 1-3 are complete: tables, staff, coverage rules, and the weekday template are all live and tested. This is the last backend task — the day grid itself, its copy-from-template generation, its edit surface, and the coverage validation that rides on every response.

**B. Files and deliverables.**

- `backend/app/api/schemas/reception.py` — extend with `ReceptionRotaGenerateIn`, `ReceptionRotaSessionIn`, `ReceptionRotaSessionOut`, `ReceptionRotaOut`, `ReceptionSessionWriteOut`.
- `backend/app/api/routers/reception_rota.py` — **new**, including the coverage check.
- `backend/app/api/main.py` — register.
- `backend/tests/test_api/test_reception_rota.py` — **new.**

**C. Instructions.**

Prefix `/reception/rota`. Endpoints:

- `POST ""` — body `{date}`. Weekend 422 (reuse `ClosureIn`'s validator shape). Existing header for that date 409, naming it. Otherwise create the header and copy every template row for `date.weekday()` whose staff member is `active`, carrying `role` and `note` across verbatim. Returns the full `ReceptionRotaOut` including `issues`.
- `GET ""` — `?date=` returns that date's rota or 404. This is how the page decides between "Generate" and "editing an existing day".
- `GET /{id}` — the day: header, sessions joined to `staff_code` / `staff_name` ordered `hour, staff_code`, and `issues`.
- `POST /{id}/sessions` — add a staff member to an hour. 409 on a duplicate `(rota_id, staff_id, hour)`, 404 on unknown staff.
- `PATCH /{id}/sessions/{sid}` — pair setter for `role` and `note`, same contract as Task 3's.
- `DELETE /{id}/sessions/{sid}` — remove a staff member from an hour, 204. **This is the absence mechanism** (Decision 10) — say so in the docstring.
- `DELETE /{id}` — delete the whole day, sessions cascade, 204. Backs the UI's regenerate-behind-a-confirm.

Every mutating endpoint except the two 204s returns `{session, issues}` with issues recomputed after the mutation, in the same transaction. `DELETE /{id}/sessions/{sid}` returns 204 with no body, matching the codebase's DELETE convention — the frontend refetches the day after a delete rather than splicing, which is one request on an infrequent action.

Coverage check. A single module-level function in this router:

```
def compute_coverage_issues(db, rota) -> list[ValidationIssueOut]
```

Load the `(day, hour) -> min_phones_staff` map once per call for the rota's weekday, count `phones` sessions per hour off the already-loaded session rows (do not re-query per hour), and emit one issue per hour where `count < minimum`. `severity="warning"`, `phase="coverage"`, `check="phones_shortfall"`, `day` set, message naming the hour, the count, and the requirement — e.g. `"09:00-10:00: 2 staff on phones, 3 required"`. A `(day, hour)` with no rule row emits nothing (Decision 8). Hours are formatted for humans in the message only; the wire format never carries a formatted hour string.

There is no `severity="error"` path anywhere in this feature. Nothing here can block.

Tests. Generate from a template and assert the copied rows match, including `note`; inactive staff are not copied; weekend 422; duplicate-date 409; the coverage warning appears at the right hour and disappears once a staff member is added to it; a `(day, hour)` with no rule row produces no warning; delete-the-day then regenerate succeeds; each edit response carries recomputed issues.

---

# Task 5: Frontend API layer and reception nav

**A. State of the world.** The backend is complete and tested — four routers under `/reception`, all endpoints live. The frontend still shows `ReceptionPlaceholder` under a shell with no nav. This task adds the typed client layer and the navigation the following three page tasks hang off. It ships no new page.

**B. Files and deliverables.**

- `frontend/src/api/types.ts` — add `ReceptionStaff`, `ReceptionRole`, `ReceptionMasterSession`, `ReceptionRotaSession`, `ReceptionRota`, `ReceptionCoverageRule` and their `*In` shapes.
- `frontend/src/api/reception.ts` — **new.** All TanStack Query hooks for the four routers.
- `frontend/src/lib/receptionHours.ts` — **new.** `RECEPTION_HOURS`, `formatHour(h)`.
- `frontend/src/App.tsx` — `RECEPTION_NAV_ITEMS`, nav rendering in `ReceptionShell`, four routes.
- `frontend/src/routes/ReceptionPlaceholder.tsx` — **delete.**
- `frontend/src/api/reception.test.tsx`, `frontend/src/lib/receptionHours.test.ts` — **new.**
- `frontend/src/test/msw/handlers.ts`, `frontend/src/test/fixtures/reception.ts` — handlers and fixtures for the new endpoints.

**C. Instructions.**

Types mirror the wire shape **exactly** — no client-side renaming, `Out` suffixes dropped, enums mirrored by value (`"phones"`, not `"PHONES"`). This is the documented convention and the documented cost: these drift silently until `tsc` catches them.

Hooks follow `api/closures.ts`: a `receptionKeys` object with hierarchical keys, `useQuery` for reads, `useMutation` invalidating the resource's key root for writes. Reference data (staff, coverage rules) invalidates and refetches — cheap. The day rota and the master template are grids and should **splice the mutation response into the cache** rather than refetch, following the clinical rota's approach; the `{session, issues}` response shape exists precisely so the splice can update both the cell and the warnings without a second round-trip.

`formatHour(8)` returns `"08:00-09:00"`. It is the single formatter — no component builds an hour label inline.

Nav: build `RECEPTION_NAV_ITEMS` exactly as `CLINICAL_NAV_ITEMS` is built (`{to, label, end}`, paths absolute under `/reception`), and render it in `ReceptionShell` with the same `NavLink` markup as `ClinicalShell`. Keep the existing header — the shell's "Switch app" and "Log out" already work and `useHandleLogout` is already lifted out for exactly this. Labels: "Day Rota" (index), "Master Template", "Reception Staff", "Coverage Rules".

Routes point at the four pages built in Tasks 6-8; stub each as a one-line component in this task so the nav is navigable, and replace them in place.

Delete `ReceptionPlaceholder.tsx`. Do not leave it unreferenced.

---

# Task 6: Reception Staff and Coverage Rules pages

**A. State of the world.** Backend complete; the frontend API layer, hour helpers, and reception nav are in place, with the four routes pointing at stubs. This task fills in the two simple reference pages. The two grid pages follow.

**B. Files and deliverables.**

- `frontend/src/routes/ReceptionStaffPage.tsx` + test — **new.**
- `frontend/src/routes/ReceptionCoveragePage.tsx` + test — **new.**
- `frontend/src/components/ReceptionStaffFormDialog.tsx` + test — **new.**
- `frontend/src/lib/receptionStaffSchema.ts` — **new.** Zod schema.
- `frontend/src/App.tsx` — swap the two stubs for the real pages.

**C. Instructions.**

Staff page: a table (code, name, status, actions) plus the form dialog, following `DoctorsPage` + `DoctorFormDialog` — but simpler, since there are no preferred rooms, no drag-ordering, and no employment window. Unlike `DoctorsPage`, show inactive staff flagged `(inactive)` with a reactivate button, the `UsersPage` convention: this page is the only management surface for reception staff, and a deactivation with no UI path back would need an API call to undo.

Zod validates form state, and `mapValidationErrors` maps a server 422 back onto fields — both already exist, reuse them. The duplicate-code 409 surfaces as a form-level error on the code field, since that is the field it names.

Coverage page: a 5 × 10 table, weekdays as columns, hours as rows, each cell a small number input firing `PATCH /reception/coverage-rules/{id}` on blur (not on keystroke). No add, no delete — the row set is fixed. A short paragraph above the table explaining what the number means: the minimum staff on `phones` for that hour before the day rota warns.

*(If Decision 8 is settled the other way and rules are keyed on `hour` alone, this becomes a single-column table of 10 rows and nothing else changes.)*

Tests use the MSW handlers from Task 5. Cover: the list renders, create succeeds, a duplicate-code 409 shows on the field, deactivate then reactivate, and a coverage edit fires exactly one PATCH on blur.

---

# Task 7: Master Reception Rota page

**A. State of the world.** Backend complete; API layer, nav, and the two reference pages are done. This task builds the weekday template grid — the same grid shape the day rota will use in Task 8, so the pivot helper and cell component built here are reused there.

**B. Files and deliverables.**

- `frontend/src/lib/pivotReception.ts` + test — **new.**
- `frontend/src/components/ReceptionGrid.tsx` + test — **new.**
- `frontend/src/components/ReceptionCellPopover.tsx` + test — **new.**
- `frontend/src/routes/ReceptionMasterPage.tsx` + test — **new.**
- `frontend/src/App.tsx` — swap the stub.

**C. Instructions.**

`pivotReception.ts` turns the flat session list into `staff × hour` cells for one day, following `pivotMasterRota.ts`'s shape: a pure function, fully unit-tested, no React. It must handle the "no row" case as a distinct, first-class state — an empty cell means "not expected this hour", not "expected but unassigned". That distinction is the whole of Decision 3 and the grid must render the two differently if the day rota ever needs to distinguish them.

`ReceptionGrid` renders one day: staff as rows, the ten hours as columns, `formatHour` for the headers. Take the cell data and the callbacks as props and hold **no server state** — this is what lets Task 8 reuse it unchanged against day-rota data. Coverage warnings are a prop too (absent on this page, present on the day page), rendered as a per-column marker.

`ReceptionCellPopover` is the edit affordance: set role (`phones` / `other`), edit the note, remove the row. Follow `MasterCellEditPopover` for positioning and dismissal behaviour. Adding a staff member to an hour is a separate affordance on an empty cell, since it is a POST, not a PATCH.

The page adds a Mon-Fri day selector above the grid and wires the callbacks to the Task 5 mutations. Do not build a five-day-at-once view — it is 5 × 10 × N cells and unreadable, and the day selector is one click.

Reuse nothing from `MasterRotaGrid`/`RotaGrid` beyond reading them for style. The axes differ (staff × hour vs doctor × day/period), and generalising either to serve both would make both harder to read. This is deliberate duplication; note it in the component docstring so a later reader does not "fix" it.

---

# Task 8: Day Rota page

**A. State of the world.** Everything else is complete — backend, API layer, nav, reference pages, and the `ReceptionGrid` / `ReceptionCellPopover` / `pivotReception` trio built for the master template in Task 7. This is the last implementation task: the dated day grid with live coverage warnings.

**B. Files and deliverables.**

- `frontend/src/components/ReceptionCoveragePanel.tsx` + test — **new.**
- `frontend/src/routes/ReceptionDayPage.tsx` + test — **new.**
- `frontend/src/App.tsx` — swap the index stub.

**C. Instructions.**

The page is a date picker (weekdays only) plus one of two states, decided by `GET /reception/rota?date=`:

- **404** — no rota for that date: show a "Generate from template" button firing `POST /reception/rota`.
- **200** — render `ReceptionGrid` against the day's sessions, with the coverage panel alongside and a "Regenerate" action behind a confirm that states plainly that all edits to this day will be lost (`DELETE /{id}` then `POST ""`).

`ReceptionCoveragePanel` lists the `issues` from the current response — hour, current count, requirement — following `IssuesPanel`'s presentation. Every mutation response carries recomputed issues, so splice them into the cache alongside the session and the panel updates with the cell, no refetch. This is the point of Decision 9's response shape; do not add a separate coverage fetch.

Warnings must read as warnings. Nothing here blocks a save, and the panel should not use error styling or wording that suggests it does.

Tests: the generate path from an empty date, the edit path splicing both cell and warnings from one response, the regenerate confirm firing delete-then-post in order, and a shortfall clearing when a staff member is added to the short hour.

---

# Task 9: Architecture documentation

**A. State of the world.** The feature is complete and merged. `documentation/architecture.md` still describes a single rota type and a reception placeholder. This task brings it current. No code changes.

**B. Files and deliverables.**

- `documentation/architecture.md` — a new "Domain: Reception Rota" section, plus targeted edits to existing sections.
- `documentation/reception_rota.md` — move to `documentation/completed/`.

**C. Instructions.**

Per CLAUDE.md, do not duplicate what the code already says. Record only what reading the code will not tell you:

- Why reception staff are a separate table from doctors, and that nothing is shared but auth, shell, client, and deployment.
- The hour model, and that widening opening hours is a migration (Decision 2).
- That the template is one record with a `day` column and deliberately has no header/versioning, unlike `master_rota_templates` (Decision 3).
- Why `reception_rotas` has a header row despite having no lifecycle (Decision 5) and why regenerate 409s rather than overwriting (Decision 6).
- The coverage rule's key and that a missing row means no minimum (Decision 8).
- **Decision 10's limitation, stated plainly**: coverage counts anyone holding a `phones` row, so absence is invisible until the row is deleted.
- That the two grids duplicate rather than share, deliberately (Decision 12).

Also update in place: the "Tables (29)" count and heading; `App.tsx`'s route count in the Application Shell section (already noted there as having been wrong once — get it right rather than incrementing the stale number); the Router surface table with four new rows; and the Migrations list with an `018` entry, noting it is the first post-001 migration to create and drop its own enum type.

The two `[UNRESOLVED]` markers in the Migrations list (009/010 and 012-014) are pre-existing gaps unrelated to this work. Leave them; do not fold them into this task.
