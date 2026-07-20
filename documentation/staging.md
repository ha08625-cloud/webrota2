# Plan: Editable Staging Step Between Master Rota and Generation

## Problem

During school holidays, staff often need one-off changes to their working pattern (covering an extra session, dropping a session) that do not reflect a permanent change to their master rota. Today the only way to apply this is to edit the master rota template directly, generate, then remember to edit it back.

## Goal

Insert an editable step between "pick a date range" and "run the generation phases": copy the active template's rows for that date range into a run-scoped editable surface, let the user make one-off changes there, then run the existing Phase 0-12 pipeline unchanged against the edited copy. The master rota template is never touched.

# Scope

**In scope**

- New tables `rota_stagings` (header) and `rota_staging_sessions`, migration 011
- Engine: `load_context()` staging branch; `get_active_staging()` helper; `find_overlapping_committed_rota` moved into the engine as a shared lock helper
- New router `/api/v1/staging`: create (copy from active template), get active, session PATCH/POST/DELETE (mirroring the master rota edit contract), abandon, complete
- `/rota/generate` gains a 409 when an active staging exists
- Frontend: `/staging` route with an editable grid (clone of `MasterRotaGrid` with real dates, closed-day greying, on-leave badges), Complete and Abandon actions; `RotaPage`'s generate form becomes "start staging"
- Tests at every layer, including the lock-interaction and Phase-0-failure-retry paths

**Out of scope / unaffected**

- `GeneratedRota`/`RotaSession` model, draft/commit/scrap/rollback/archive lifecycle
- Phases 0-12 -- no phase code changes; the staging branch lives entirely in `context.py`
- The master rota template, its endpoints, and its frontend
- Post-generation editing (`set-role`, `set-room`, swaps, session PATCH)
- Undo on the staging grid (v1 recovery path is abandon-and-restart; the master grid's undo pattern can be cloned later if session-level undo proves necessary)
- The `POST /rota/generate` endpoint is retained unchanged apart from the new lock (used by tests; the frontend simply stops calling it)

# Design Decisions

1. **Separate tables, not a `GeneratedRota` status.** `RotaSession` edit endpoints and Phase 12 assume roles/clinics are already assigned; a pre-Phase-4 grid has neither, so a `STAGED` status would force a status branch into every consumer. A separate pair of tables keeps the existing draft/committed lifecycle untouched.

2. **Explicit lifecycle header (`rota_stagings`), not "config with no rota".** The provisional plan's signal -- a `RotaConfig` with no linked `GeneratedRota` -- is ambiguous today: `scrap_rota()` and `force_delete_rota()` delete the `GeneratedRota` but never the `RotaConfig`, so orphaned configs already exist in any used environment, and scrapping a staging-born draft would recreate the "no rota" state and falsely re-activate staging. Instead: `rota_stagings` carries `completed_at` (nullable timestamp, matching the `committed_at`/`archived_at` convention). Null means active; set means completed. "Active staging exists" is a direct query, immune to whatever later happens to the `GeneratedRota`.

3. **Abandon hard-deletes; complete retains.** `DELETE /staging/{staging_id}` (only while active) deletes the header, its sessions (ORM cascade), and the `RotaConfig` -- nothing else references any of them at that point. `complete` sets `completed_at` and keeps the rows as a record of the edited pattern for that run. This is a snapshot of the final edited state, not a diff -- answering "what changed" requires comparing against the template, which may itself have been edited since. Accepted: retention is cheap and a snapshot is still useful.

4. **`template_start_week` is normalised to 1 on staging configs.** Phases 0 and 2 map generation week to template week via `template_week(gen_week, config.template_start_week)` before looking up `context.template_sessions`. Staging rows are keyed by generation week, so the config the pipeline runs against must have `template_start_week = 1`, where `template_week()` is the identity. The staging create payload still accepts `template_start_week` (1-4, default 1, same shape as `GenerateRotaIn`); it is applied once, at copy time, to select which template weeks to copy, then discarded. The original value is not stored -- the frontend hardcodes 1 today anyway (`RotaPage` comment: product decision to hide it).

5. **`source_template_id` on the header.** Phase 0 aborts when `context.active_template is None`. The staging branch loads the template by this stored id (`db.get`, ignoring `is_active`), so deactivating or adding templates between staging create and complete cannot brick an in-progress staging. Templates have no delete endpoint, so the row is stable; if it is somehow gone (direct DB surgery), the branch returns None and Phase 0 errors, which is acceptable.

6. **Context branch triggers on "a `RotaStaging` row exists for this config", active or completed.** `load_context()` is also called by `rebuild_rota_grid()` for edit endpoints on the generated rota, after the staging is completed. Staged sessions are the correct `template_sessions` source for a staging-born rota in both uses, so the branch does not check `completed_at`. (In practice this only affects the legacy null-`template_type` fallback, which staging-born rotas never hit, but conditioning on `completed_at` would be strictly less correct for zero benefit.)

7. **Locks.** Staging create requires: no active draft, no active staging, no committed-rota overlap, and exactly one active template (the engine's strict rule, not the GET's lowest-id resolution -- staging is a generation precursor). `/rota/generate` additionally 409s while an active staging exists. `complete` re-runs the draft check (a `rollback_commit` can create a draft while staging is in progress -- direct generate is blocked, rollback is not) and the overlap check (the create-time check is fail-fast; complete-time is authoritative). All three helpers (`get_active_draft`, new `get_active_staging`, `find_overlapping_committed_rota` moved from `routers/rota.py`) live together in `engine/generate.py`.

8. **Phase 0 failure at complete keeps everything.** The staging rows and config were committed by earlier requests; a failed complete raises 422 without committing, rolling back only the failed run's own writes. The user fixes the offending staged edit and clicks complete again. No special handling needed -- this falls out of the existing transaction model. (Deliberate divergence from direct generate, where the config is created and discarded inside the single failed request.)

9. **Edit endpoints mirror the master rota contract verbatim.** Pair setter `(session_type, room_id)`, same-slot room displacement including the `PRE_ASSIGNED` -> `REQUIRES_ROOM` demotion of a displaced roomless pre-assigned, permissive verbatim writer (no eligibility checks), `MasterSessionPairIn` validator reused by subclassing. One addition: session create 422s when `week > config.num_weeks` (the schema's 1-4 bound is necessary but not sufficient for a 1- or 2-week staging).

10. **Real dates enable two things the master grid cannot show.** `is_on_leave` per staged session (derived at read time from `leave_entries`, mirroring `routers/rota.py._leave_lookup`) -- the entire use case is holiday cover, so leave is exactly what the editor needs to see. Closed dates grey the day headers, sourced from live `PracticeClosure` rows in the range (no snapshot exists yet -- generation at complete time will read live closures, so live is correct here). Rows falling on closed dates are still copied and editable; Phase 2's closed-date skip remains the single closure authority, and the greying is display-only.

11. **Router prefix `/staging`, not `/rota/staging`.** `GET /rota/{rota_id}` takes an int path parameter; `/rota/staging` would depend on router registration order to avoid being captured by it. A separate prefix removes the fragility.

12. **Frontend: single `/staging` route, no id in the path.** At most one staging is active globally, so the page loads `GET /staging/active`; complete/abandon use the `staging_id` from that payload. `RotaPage`'s form becomes "Start staging" (create then navigate to `/staging`); an active staging renders a "Staging in progress -- resume" banner parallel to the existing draft banner. `StagingGrid` is a copy of `MasterRotaGrid` adapted to the staging hooks -- deliberately a clone, not an abstraction of the master grid, to avoid destabilising the existing component and its tests. The duplication is accepted.

---

# Task 3: Staging router -- create, read, edit, abandon

**A.** State of the world: Tasks 1-2 are complete -- models exist, `load_context()` is staging-aware, and `get_active_draft` / `get_active_staging` / `find_overlapping_committed_rota` are all importable from `backend.app.engine.generate`. This task adds the staging CRUD surface. The `complete` endpoint is Task 4.

**B.** Files:

- New: `backend/app/api/schemas/staging.py`
- Edit: `backend/app/api/schemas/__init__.py` (exports)
- New: `backend/app/api/routers/staging.py`
- Edit: `backend/app/api/main.py` (add `staging` to the router registration tuple)
- New: `backend/tests/test_api/test_staging.py`
- Reference: `backend/app/api/routers/master_rota.py` (the contract being mirrored -- read closely), `backend/app/api/schemas/master_rota.py` (`MasterSessionPairIn`), `backend/app/api/routers/rota.py` (`_leave_lookup` pattern, `generate_rota`'s check ordering), `backend/app/engine/week_map.py` (`template_week`, `build_week_dates`), `backend/tests/test_api/conftest.py`, `backend/tests/test_api/test_session_assign.py` or the master rota tests for style

Deliverables: schemas, router registered under `/api/v1/staging`, comprehensive API tests.

**C.** Instructions:

Schemas (`schemas/staging.py`):

- `StagingCreateIn`: `start_date: datetime.date`, `num_weeks: int` (validate in {1, 2, 4}), `template_start_week: int = Field(default=1, ge=1, le=4)`. Same field names as `GenerateRotaIn` deliberately.
- `StagingSessionOut`: `session_id, doctor_id, doctor_code, doctor_type, week, day, period, session_type, room_id, room_code, is_on_leave: bool`. (`MasterRotaSessionOut` plus `is_on_leave`.)
- `StagingOut`: `staging_id, config_id, start_date, num_weeks, created_at, completed_at, closed_dates: list[datetime.date], sessions: list[StagingSessionOut]`. Document that `closed_dates` is live `PracticeClosure` data in the range, not a snapshot (none exists yet).
- `StagingSessionPatchIn(MasterSessionPairIn)` and `StagingSessionCreateIn(MasterSessionPairIn)` with `doctor_id, week (ge=1, le=4), day, period` -- import and subclass `MasterSessionPairIn` from `schemas/master_rota.py` so the room/type pair validation cannot drift.
- `StagingSessionWriteOut`: `session, displaced_session: StagingSessionOut | None` (the `MasterSessionWriteOut` shape).

Router (`routers/staging.py`, prefix `/staging`, all endpoints requiring `get_current_user`):

Helper `_staging_or_404(db, staging_id)`; helper `_require_active(staging)` raising 409 when `completed_at` is not None ("staging is completed; ..."); a `_session_outs`-style serialiser joining doctor/room codes and deriving `is_on_leave` (build `week_dates` via `build_week_dates(config.start_date, config.num_weeks)`, leave keys via a copy of `routers/rota.py._leave_lookup`'s query); a `_find_room_holder` scoped to `(staging_id, week, day, period, room_id)` copied from the master rota router's, including its `.first()` rationale and optional `exclude_id`.

- `POST /staging` (201, returns `StagingOut`). Checks in order, each a 409 with a clear message: `get_active_draft` is None; `get_active_staging` is None; `find_overlapping_committed_rota` returns None (reuse `generate_rota`'s message format); exactly one `MasterRotaTemplate` with `is_active` is True (zero or multiple both 409 -- the engine's strict rule, message naming the count). Then: create `RotaConfig(start_date, num_weeks, template_start_week=1)` -- the literal 1 is Design Decision 4; add a comment pointing at it. Create `RotaStaging(config_id=..., source_template_id=template.id)`. Copy: for `gen_week` in 1..num_weeks, `tw = template_week(gen_week, payload.template_start_week)`, and for every `MasterRotaSession` of the template with `week == tw`, create a `RotaStagingSession` with `week=gen_week` and the same `(doctor_id, day, period, session_type, room_id)`. Copy rows regardless of closures (Design Decision 10). Flush, commit, return the full `StagingOut`.
- `GET /staging/active` (returns `StagingOut`, 404 when none active). Selects via the `completed_at IS NULL` query, loads config and sessions, serialises.
- `PATCH /staging/{staging_id}/sessions/{session_id}` (returns `StagingSessionWriteOut`). 404s for unknown staging / session-not-in-staging; `_require_active`; then mirror `master_rota.patch_session` exactly: validate room exists when non-null, displacement with the `PRE_ASSIGNED -> REQUIRES_ROOM` demotion, verbatim pair write, flush, commit.
- `POST /staging/{staging_id}/sessions` (201, `StagingSessionWriteOut`). Mirror `master_rota.create_session`: doctor-exists 404, duplicate-slot 409, displacement before insert. Additionally 422 when `payload.week > config.num_weeks` ("week {n} is outside this staging's {num_weeks}-week range").
- `DELETE /staging/{staging_id}/sessions/{session_id}` (204). Mirror `master_rota.delete_session`; `_require_active`.
- `DELETE /staging/{staging_id}` (204, abandon). `_require_active` (a completed staging is a retained record; 409). Delete the staging first (ORM cascades the sessions), then `db.delete` its `RotaConfig` -- explicit order, and safe because an active staging by construction has no `GeneratedRota` (the only creation path is `complete`, which marks completion in the same transaction). Commit.

Register in `main.py` by adding `staging` to the import and the registration tuple.

Tests (`test_api/test_staging.py`), using the standard `client` fixture. Cover at minimum: create copies the right rows for `template_start_week=1` and for `template_start_week=3` with `num_weeks=2` (assert the week-3 and week-4 template rows landed as staging weeks 1 and 2, and the persisted config has `template_start_week == 1`); create 409s on zero active templates and on two; create 409s when a draft exists; second create 409s while one staging is active; committed-overlap 409; `GET /staging/active` 404s when none and returns sessions with `is_on_leave` true for a doctor with a matching `LeaveEntry` and `closed_dates` reflecting a `PracticeClosure` in range; PATCH displacement clears the holder's room and demotes a displaced `PRE_ASSIGNED`; PATCH/POST/DELETE all 409 on a completed staging (set `completed_at` directly in the test); session POST 422s for week 2 on a 1-week staging and 409s on a duplicate slot; abandon deletes staging, sessions, and config, and a fresh create then succeeds.

---

# Task 4: Complete endpoint and generate lock

**A.** State of the world: Tasks 1-3 are complete -- the staging CRUD surface works end to end and `/api/v1/staging` is registered. This task adds `POST /staging/{staging_id}/complete`, adds the staging lock to `/rota/generate`, and tests the lifecycle interactions between the two workflows.

**B.** Files:

- Edit: `backend/app/api/routers/staging.py`
- Edit: `backend/app/api/routers/rota.py`
- Edit: `backend/tests/test_api/test_staging.py`
- Edit: `backend/tests/test_api/test_rota.py` (the generate-lock test)
- Reference: `backend/app/api/routers/rota.py`'s `generate_rota` (the shape being reproduced), `backend/app/engine/generate.py` (`generate`, `get_active_draft`, `get_active_staging`, `find_overlapping_committed_rota`, `rollback_commit`), `backend/tests/test_api/test_lifecycle.py` (style for lifecycle tests)

Deliverables: working complete endpoint returning `GenerateRotaOut`, the generate lock, lifecycle tests green.

**C.** Instructions:

`POST /staging/{staging_id}/complete` (response model `GenerateRotaOut`, imported from the rota schemas):

1. `_staging_or_404`, `_require_active`.
2. 409 if `get_active_draft(db)` is not None -- message should mention that a rolled-back commit counts ("a draft rota exists; commit or scrap it before completing staging"). This check is not redundant with create-time: `rollback_commit` can produce a draft while staging is in progress.
3. 409 if `find_overlapping_committed_rota(db, config.start_date, config.num_weeks)` finds one -- authoritative re-check; reuse the same message format.
4. `result = generate(db, staging.config_id)`. On `result.status == "failed"`: raise the same 422-with-issues shape as `generate_rota`, without committing -- the rollback discards only this run's writes; the staging rows and config, committed by earlier requests, survive (Design Decision 8). Add a comment stating this is deliberate divergence from `generate_rota`'s discard-on-failure.
5. On success: `staging.completed_at = now (UTC)`, `db.commit()`, return `GenerateRotaOut(rota_id=result.rota_id, status=DRAFT, issues=...)`. The completion flag and the rota land in one transaction, so no state exists where a rota was generated but the staging still reads active.

In `routers/rota.py::generate_rota`, after the existing draft check: 409 if `get_active_staging(db)` is not None ("a staging session is in progress; complete or abandon it first"). Update the module docstring's lifecycle rules list.

Tests:

- Happy path: create staging, edit a session, complete; assert a draft `GeneratedRota` exists whose sessions reflect the edit, `completed_at` is set, staging rows still exist, and `GET /staging/active` now 404s.
- Phase 0 retry path (the key end-to-end test): create a staging; PATCH a staged slot that carries a pre-planned `DutyAssignment` to `no_surgery`; complete -> 422 `duty_on_incompatible_slot`; assert staging and config survive and `GET /staging/active` still returns it; PATCH the slot back; complete -> success.
- Locks: `/rota/generate` 409s while a staging is active; complete 409s when a draft exists (create a committed rota, start staging for a non-overlapping range, `rollback-commit` the committed rota, attempt complete); complete 409s on a completed staging (idempotence guard); overlap re-check at complete time (commit a rota overlapping the staging's range via direct model setup after the staging was created, then complete -> 409).
- Post-complete lifecycle sanity: scrap the staging-born draft; assert `GET /staging/active` still 404s (completed staging does not resurrect -- the regression the `completed_at` design exists to prevent) and a fresh `/rota/generate` or staging create succeeds.

---

# Task 5: Frontend API layer

**A.** State of the world: the backend (Tasks 1-4) is complete: `/api/v1/staging` supports create / get-active / session PATCH-POST-DELETE / abandon / complete. This task adds the typed client and TanStack Query hooks; the UI is Task 6.

**B.** Files:

- New: `frontend/src/api/staging.ts`
- New: `frontend/src/api/staging.test.tsx`
- Edit: `frontend/src/api/types.ts` (staging types)
- Edit: `frontend/test/msw/handlers.ts` (default staging handlers)
- Reference: `frontend/src/api/masterRota.ts` (the pattern to mirror, including cache splicing), `frontend/src/api/rota.ts` (`GenerateRotaOut` handling), `frontend/src/api/client.ts`, `frontend/src/test/renderWithProviders.tsx`

Deliverables: hooks with cache-splice updates, MSW-based tests.

**C.** Instructions:

Types in `types.ts`: `StagingSession` (the `MasterRotaSession` shape plus `is_on_leave: boolean`), `Staging` (`staging_id, config_id, start_date, num_weeks, created_at, completed_at, closed_dates: string[], sessions: StagingSession[]`), `CreateStagingIn` (`start_date, num_weeks, template_start_week`), and the write-out shape `{ session, displaced_session }`.

`staging.ts`, mirroring `masterRota.ts`'s structure: a `stagingKeys` object with a single `active` key; `useActiveStaging()` -- `GET /staging/active`, and a 404 must resolve to `null` rather than an error (check how `client.ts` surfaces status; catch and return null on 404 so `RotaPage` can branch on it without error states); `useCreateStaging()` (POST, on success set the `active` cache to the returned payload); `useUpdateStagingSession` / `useCreateStagingSession` / `useDeleteStagingSession` (splice/append/remove within the cached `Staging.sessions` array by `session_id`, copying `spliceMasterSessions`' approach -- note the container differs: sessions nest inside the `Staging` object, so the splice rebuilds `{ ...staging, sessions }`); `useAbandonStaging()` (DELETE, on success set the `active` cache to null); `useCompleteStaging()` (POST complete, returns the `GenerateRotaOut` shape -- on success set the `active` staging cache to null and invalidate the rota list key so `RotaPage` picks up the new draft).

Tests: MSW handlers per endpoint; assert the 404-as-null behaviour of `useActiveStaging`; assert each mutation splices the cache correctly (mirror `masterRota`'s test structure); assert complete clears the active cache. Add passing default handlers to `frontend/test/msw/handlers.ts` following its conventions.

---

# Task 6: Frontend staging page and RotaPage wiring

**A.** State of the world: Tasks 1-5 are complete -- the backend works and `frontend/src/api/staging.ts` provides all hooks. This task builds the editing UI and reroutes the generate flow through it.

**B.** Files:

- New: `frontend/src/components/StagingGrid.tsx` (+ test)
- New: `frontend/src/routes/StagingPage.tsx` (+ test)
- New: `frontend/src/components/GenerateErrorMessage.tsx` (extracted from `RotaPage`)
- Edit: `frontend/src/routes/RotaPage.tsx` (+ test updates)
- Edit: `frontend/src/App.tsx` (add the `/staging` route and nav entry) -- **NOT in the project files; request before starting**
- Reference: `frontend/src/components/MasterRotaGrid.tsx` (the clone source), `frontend/src/components/MasterCellEditPopover.tsx` -- **NOT in the project files; request before starting**, `frontend/src/lib/pivotMasterRota.ts`, `frontend/src/lib/weekDates.ts`, `frontend/src/components/RotaGrid.tsx` (closed-day header treatment to copy), `frontend/src/routes/MasterRotaPage.tsx`, `frontend/src/api/staging.ts`

Deliverables: working `/staging` route; `RotaPage` starts/resumes staging instead of direct generation; tests.

**C.** Instructions:

`StagingGrid.tsx`: copy `MasterRotaGrid.tsx` and adapt. Swap the three master mutation hooks for the staging ones (prop `stagingId` replaces `templateId`). Reuse `pivotMasterRota` unchanged if its input shape allows (`StagingSession` is a superset of `MasterRotaSession`); week tabs come from the pivot and will naturally span 1..num_weeks. Reuse `MasterCellEditPopover` if its props are hook-agnostic (it appears to receive pick callbacks; verify against the file once provided) -- clone it only if it calls master hooks internally. Three additions: day headers show the calendar date via `weekDates.ts` from `staging.start_date`, greyed/labelled when the date is in `staging.closed_dates` (copy `RotaGrid`'s header treatment); cells whose session has `is_on_leave` get a small amber "Leave" badge (informational only -- the popover stays available, matching the permissive-writer philosophy; the user may be staging cover for that exact leave); no undo plumbing (drop the `onMutationApplied` entry-building, keep a simple success/error toast via the `Toast` component if `MasterRotaPage` uses one, else plain messages).

`StagingPage.tsx`: loads `useActiveStaging()`. Null -> message plus link back to `/rota`. Otherwise: header with the date range ("Staging for {start_date}, {num_weeks} week(s)") and an explanatory line ("changes here apply to this rota only; the master rota is unchanged"); the grid; two actions -- "Complete and generate" (on success navigate to `/rota/{rota_id}`; on 422 render `GenerateErrorMessage`) and "Abandon" (`window.confirm`, matching the commit/scrap pattern; on success navigate to `/rota`).

`GenerateErrorMessage`: move the component (and the `FastApiValidationError` narrowing it depends on) from `RotaPage.tsx` into `frontend/src/components/GenerateErrorMessage.tsx` unchanged; import it back into `RotaPage` and into `StagingPage`.

`RotaPage.tsx`: the form's submit switches from `useGenerateRota` to `useCreateStaging` (payload shape is identical; keep `template_start_week: 1` and its existing comment), navigating to `/staging` on success; button text "Start staging". Rendering precedence in the top slot: active draft banner (unchanged) > active staging banner ("Staging in progress -- started {date}, {n} week(s)" with a "Resume staging" link to `/staging`, styled like the draft banner) > the form. The `DutyStatusList` / `ClinicStatusList` pre-flight panels stay on the form. Update `RotaPage.test.tsx` accordingly (form submission now hits the staging create handler; new banner state).

`App.tsx`: add the `/staging` route and, if the nav lists routes, a nav entry. (File to be provided.)

Tests: `StagingGrid` -- renders sessions, closed-day header greyed, leave badge shown, a cell pick fires the staging PATCH hook (mirror `MasterRotaGrid.test.tsx`'s approach); `StagingPage` -- null state, complete success navigates, complete 422 renders issues, abandon confirm-then-navigate; `RotaPage` -- start-staging submission and the resume banner.

---

# Documentation follow-up (after implementation)

Architecture.md: new "Staging" subsection under the rota lifecycle (the two tables, the `completed_at` lifecycle, the `template_start_week=1` invariant and why, the lock triangle between staging/draft/generate, the context branch); table count 21 -> 23; migration list gains 011; outstanding-tasks note that staging has no undo. Phase-pipeline.md is unaffected (no phase changes).

# Task 1: Data model and migration

**A.** State of the world: nothing for this feature exists yet. This task creates the two staging tables. The latest migration is `backend/alembic/versions/010_users_sessions.py`.

**B.** Files:

- New: `backend/app/models/staging.py`
- Edit: `backend/app/models/__init__.py` (export `RotaStaging`, `RotaStagingSession`)
- New: `backend/alembic/versions/011_rota_staging.py`
- Edit: `backend/tests/test_models.py` (model-level tests)
- Reference (read, do not edit): `backend/app/models/master_rota.py` (the shape being mirrored), `backend/app/models/rota.py` (`RotaConfig`), `backend/app/models/enums.py` (`enum_col`, `_snake`), `backend/alembic/versions/002_rota_session_template_type.py` (the enum-reuse pattern), `backend/alembic/versions/010_users_sessions.py` (current head)

Deliverables: both models, the migration, passing model tests.

**C.** Instructions:

`RotaStaging` (`rota_stagings`): `id` PK; `config_id` FK `rota_configs.id`, non-null, unique (one staging per config); `source_template_id` FK `master_rota_templates.id`, non-null; `created_at` timezone-aware datetime, non-null, default now-UTC (copy `RotaConfig.created_at`'s lambda pattern); `completed_at` timezone-aware datetime, nullable, no default. Relationship `sessions` to `RotaStagingSession` with `cascade="all, delete-orphan"` and `back_populates`, matching `MasterRotaTemplate.sessions`. No relationship from `RotaConfig` to `RotaStaging` is needed.

`RotaStagingSession` (`rota_staging_sessions`): `id` PK; `staging_id` FK `rota_stagings.id`, non-null; `doctor_id` FK `doctors.id`, non-null; `week` Integer, non-null, `CheckConstraint("week BETWEEN 1 AND 4", name="ck_rss_week")`; `day` / `period` / `session_type` enum columns via `enum_col(Day)` / `enum_col(Period)` / `enum_col(MasterSessionType)`; `room_id` FK `rooms.id`, nullable; `UniqueConstraint("staging_id", "doctor_id", "week", "day", "period", name="uq_rss_slot")`. Mirror `MasterRotaSession`'s relationships (`staging` back-populating, plus plain `doctor` and `room`).

Migration 011: revision `"011"`, down_revision `"010"`. Two `op.create_table` calls, `rota_stagings` first. The three enum columns must reuse the existing Postgres types (`day`, `period`, `master_session_type`) -- copy migration 002's helper pattern exactly: on Postgres, `postgresql.ENUM(PyEnum, name=_snake(PyEnum.__name__), create_type=False, values_callable=...)`; on SQLite, plain `sa.Enum`. `downgrade()` drops `rota_staging_sessions` then `rota_stagings` and must NOT drop any enum type (other tables depend on all three -- same warning as 002's docstring). Docstring should note: additive only, no backfill, tables start empty.

Tests in `backend/tests/test_models.py`, following its existing style: create a staging with sessions and assert round-trip; assert `uq_rss_slot` rejects a duplicate slot; assert deleting the staging cascades its sessions; assert `config_id` uniqueness rejects a second staging on the same config. Note the conftest enables SQLite FK enforcement, so FK assertions are real.

---

# Task 2: Engine changes

**A.** State of the world: Task 1 is complete -- `RotaStaging` / `RotaStagingSession` exist and are exported from `backend/app/models/__init__.py`. This task makes the engine read a staging copy when one exists and centralises the lock helpers. No phase files change.

**B.** Files:

- Edit: `backend/app/engine/context.py`
- Edit: `backend/app/engine/generate.py` (new `get_active_staging`; receive `find_overlapping_committed_rota`)
- Edit: `backend/app/api/routers/rota.py` (delete its private `_find_overlapping_committed_rota`, import the engine version; no behaviour change in this task)
- Edit: `backend/tests/test_context.py`
- Edit: `backend/tests/test_engine/test_generate.py`
- Reference: `backend/app/engine/week_map.py` (`template_week`), `backend/app/engine/phases/phase0.py` and `phase2.py` (the lookups being satisfied), `backend/tests/test_engine/factories.py`, `backend/tests/test_engine/conftest.py`

Deliverables: staging-aware `load_context()`, the two helpers in `generate.py`, router import swap, passing tests.

**C.** Instructions:

In `context.py`, replace the `active_template, template_sessions = _load_active_template(db)` line in `load_context()` with a call to a new `_load_staging_or_template(db, config)`:

- Query `RotaStaging` where `config_id == config.id` (`.scalars().first()`; uniqueness makes at most one).
- If found: `template = db.get(MasterRotaTemplate, staging.source_template_id)` (may be None if the template row was removed by direct DB surgery -- return it as-is and let Phase 0's existing `active_template is None` error fire). Build `template_sessions` from the staging's session rows keyed `(doctor_id, week, day, period) -> (session_type, room_id)` -- identical dict shape to the template path. Do not check `completed_at` (Design Decision 6).
- If not found: fall through to the existing `_load_active_template(db)` unchanged.

Add a docstring note on the new helper: staging rows are keyed by generation week and staging configs always persist `template_start_week = 1` (enforced by the staging router, Task 3), so `template_week()` is the identity and the phases' week mapping is a no-op -- this invariant is what lets the phases run unchanged.

In `generate.py`, next to `get_active_draft`:

- `get_active_staging(db) -> RotaStaging | None`: `select(RotaStaging).where(RotaStaging.completed_at.is_(None))`, ordered by id, `.first()` (defensive determinism, matching `get_active_draft`'s style).
- Move `_find_overlapping_committed_rota` from `routers/rota.py` verbatim, renamed `find_overlapping_committed_rota` (public), docstring intact. Update `routers/rota.py` to import and call it; delete the private copy.

Tests. In `test_context.py`: with a staging present for the config, `load_context()` returns the staged sessions (not the template's) and `active_template` resolves via `source_template_id` even when the source template's `is_active` is False; without a staging, behaviour is unchanged. In `test_engine/test_generate.py`: a full `generate()` run over a staging config (config with `template_start_week=1`, staging rows differing from the template) produces `RotaSession` rows reflecting the staged pattern, proving the pipeline consumes the copy end to end.