# Plan

## Scope

Add a per-doctor supervision preference (none / less / normal / more) that
multiplies the weighted `SUPERVISION` counter score used by Phase 9C when
picking a supervisor from the fallback pool, and expose it as an editable
field on the Doctors page and in the Edit Doctor dialog.

Boundaries (confirmed):
- Only affects fallback **pool** selection in Phase 9C
  (`raw_count / sessions_per_week * multiplier`).
- The SR-room-occupant fast path (`_assign_sr_priority`) is deliberately
  preference-blind. A doctor set to "none" who happens to occupy the SR
  room that session is still auto-assigned with no comparison to anyone
  else. This only changes if Phase 9C's fast path is revisited later — not
  in scope here.
- A "none"-preference doctor can still be selected from the pool itself if
  they are the sole eligible doctor that session (`_pool_selection_reason`'s
  "only eligible doctor" branch has no competitor to lose to). The
  multiplier deprioritises, it does not exclude, and this is by design —
  supervision must still happen even if the only available doctor dislikes
  it.
- `ROOM_MOVE` scoring (Phases 7-9A) is untouched. `weighted_system_score`
  gains an optional parameter with a default that preserves current
  behaviour for every existing caller.
- No change to how the `SUPERVISION` counter itself increments — the
  multiplier only affects who gets picked, not what gets counted.
- Counters page: SUPERVISION rows keep showing the plain unweighted-by-
  preference score (raw/spw), same shared component as ROOM_MOVE. Decided,
  not open.

## Design Decisions

1. **New enum `SupervisionPreference`** (`backend/app/models/enums.py`):
   members `NONE`, `LESS`, `NORMAL`, `MORE`; values `"none"`, `"less"`,
   `"normal"`, `"more"` — lowercase, consistent with the more recently
   added enums (`SystemCounterType`, `RotaStatus`), not a strict rule, just
   picking one convention and moving on.
2. **Multiplier table**, hardcoded constant (not user-editable):
   `{NONE: 1_000_000, LESS: 1.5, NORMAL: 1.0, MORE: 0.66}`. Lives in
   `phase9c.py`, the only consumer. `NONE` uses a large finite multiplier
   rather than `math.inf` deliberately — it must still preserve relative
   ordering between multiple "none"-preference doctors when they're the
   only candidates left, whereas `math.inf` would collapse them all to an
   alphabetical tiebreak regardless of their actual supervision history.
3. **`Doctor.supervision_preference`** column: `enum_col(SupervisionPreference)`,
   `nullable=False`, `default=SupervisionPreference.NORMAL` at the ORM
   level, `server_default` at the DB level (existing rows need a value at
   add-column time — same reasoning as migration 003's `is_supervising`).
   Defaulting to `normal` (1x) means every existing doctor is unaffected
   until someone deliberately changes it.
4. **`CounterState.weighted_system_score`** gains an optional
   `multiplier: float = 1.0` parameter, applied only in the non-`spw==0`
   branch (`spw == 0` still short-circuits to `math.inf` regardless of
   multiplier — an undefined score stays undefined). ROOM_MOVE callers in
   `phase7_9a.py` pass nothing. Phase 9C passes
   `_PREFERENCE_MULTIPLIERS[doctor.supervision_preference]`.
5. **Migration** creates a genuinely new Postgres enum type (the first
   add-column migration to do so since 001 — 002 and 011 both reuse
   existing enum types via `create_type=False` and don't cover this case).
   Must follow 001's pattern precisely: explicit
   `postgresql.ENUM(...).create(bind, checkfirst=True)` in `upgrade()`
   before `add_column`, matching `.drop(bind, checkfirst=True)` in
   `downgrade()` after `drop_column` — not just `create_type=False` on the
   column, which alone would never emit `CREATE TYPE` at all.

## Task 2: Engine changes

**A.** State of the world: the data model and API schemas from Task 1 are
in place; doctors can now be created/edited with a
`supervision_preference`, but the engine ignores it completely. Phase 9C's
pool selection in `run_phase9c` and `_pool_selection_reason` currently sort
and compare purely on `weighted_system_score(..., SystemCounterType.SUPERVISION, spw)`
with no multiplier.

**B.** Files:
- `backend/app/engine/datatypes.py` — extend `weighted_system_score`.
- `backend/app/engine/phases/phase9c.py` — add the multiplier table, thread
  it through pool sort and `_pool_selection_reason`.
- `docs/phase-pipeline.md` — update the Phase 9C section once the above
  lands.

**C.** Instructions:
- In `datatypes.py`, change the signature to
  `weighted_system_score(self, doctor_id, counter_type, spw, multiplier=1.0)`.
  Keep the `spw == 0` branch returning `math.inf` unconditionally (ignore
  `multiplier` there). Otherwise return `(raw / spw) * multiplier`. Do not
  touch `weighted_clinic_score` — this is system-counter-only.
- In `phase9c.py`, add
  `_PREFERENCE_MULTIPLIERS = {SupervisionPreference.NONE: 1_000_000, SupervisionPreference.LESS: 1.5, SupervisionPreference.NORMAL: 1.0, SupervisionPreference.MORE: 0.66}`
  near the existing module-level constants (`_SUPERVISOR_TYPES`, etc.), and
  import `SupervisionPreference` from `...models.enums`.
- In the pool `.sort()` call inside `run_phase9c`, look up each slot's
  doctor's `supervision_preference` and pass the corresponding multiplier
  into `weighted_system_score`. Same change in `_pool_selection_reason`'s
  two `weighted_system_score` calls (`score_a`, `score_b`), so the log
  message and the actual selection can never disagree.
- Update `_pool_selection_reason`'s message: when the multiplier materially
  changed which doctor won (i.e., the raw unweighted order would have
  picked someone else), say so explicitly — e.g. append
  "(preference-adjusted)" to the existing "lowest weighted supervision
  score X vs Y" string. Exact wording is an implementation-time call;
  don't over-engineer this, one clause is enough for the generation log to
  be honest about what happened.
- Leave `_assign_sr_priority` untouched — confirmed out of scope.
- Update `docs/phase-pipeline.md`'s Phase 9C section to mention the
  preference multiplier and both "not literally never" caveats from the
  Scope section above, so the doc doesn't overstate what "none" does.

## Task 3: Frontend

**A.** State of the world: Tasks 1-2 are complete. The API accepts and
returns `supervision_preference` on doctors, and the engine respects it.
Nothing in the frontend knows this field exists yet.

**B.** Files:
- `frontend/src/api/types.ts` — add the union type and field.
- `frontend/src/lib/doctorSchema.ts` — zod field, default, payload mapping.
- `frontend/src/components/DoctorFormDialog.tsx` — dropdown select.
- `frontend/src/routes/DoctorsPage.tsx` — new column, inline dropdown.

**C.** Instructions:
- Add `export type SupervisionPreference = "none" | "less" | "normal" | "more";`
  to `types.ts` and add `supervision_preference: SupervisionPreference` to
  the `Doctor` type, matching how `doctor_type` is already declared there.
- In `doctorSchema.ts`, add the zod enum field with default `"normal"`,
  and confirm the schema-to-payload mapping function includes it — check
  this file directly during implementation rather than assuming its shape
  from this plan, since it wasn't reviewed line-by-line for this task.
- In `DoctorFormDialog.tsx`, add a labelled select (None / Less / Normal /
  More) next to the existing `doctor_type`/`sessions_per_week` fields,
  following that file's existing field pattern.
- In `DoctorsPage.tsx`, add a "Supervision" column with an inline dropdown
  using the same PATCH-on-change pattern as the `sessions_per_week`
  stepper (see `updateDoctor.mutate({ id: doctor.id, payload: {...} })`
  around line 45) — no confirmation dialog needed, this is a low-stakes
  field.
- Optional, not blocking: consider whether `backend/seed/seed_doctors.py`
  should seed a mix of preferences rather than leaving every seeded doctor
  on the default, purely so the new UI has something to look at on first
  deploy. Decide during implementation; skip if it adds friction.

## Task 4: Tests

**A.** State of the world: Tasks 1-3 are complete and the feature is fully
wired end to end. This task only adds coverage; no new behaviour.

**B.** Files:
- `backend/tests/test_engine/test_datatypes.py` (or equivalent) —
  multiplier parameter on `weighted_system_score`.
- `backend/tests/test_engine/test_phase9c.py` — pool selection respects
  preference; SR fast path still ignores it; a lone eligible "none"
  doctor is still selected (documents Design Decision caveat, not a bug);
  a default `normal` doctor behaves identically to pre-change behaviour
  (regression guard).
- Postgres migration round trip — already covered by the existing CI job;
  confirm migration 012 passes upgrade/downgrade/upgrade, no new test file
  needed.
- Frontend — `DoctorFormDialog_test.tsx`, `DoctorsPage_test.tsx` (or
  equivalent) for the new field/column, following existing test patterns
  in those files.

**C.** Instructions:
- Datatypes test: assert `spw == 0` still returns `math.inf` even when a
  non-default multiplier is passed (the short-circuit must ignore it).
- Phase 9C tests: construct a session with 2+ eligible pool candidates
  where preference order would flip the raw-score order, and assert the
  lower-preference-adjusted-score doctor wins. Separately, construct a
  session with exactly one eligible "none"-preference doctor and assert
  they are still assigned (not skipped, not a warning).
- Keep new tests additive — do not modify existing Phase 9C tests unless
  a default-`normal` doctor's behaviour has genuinely changed (it
  shouldn't have).

  
## Task 1: Data model and migration

**A.** State of the world: no supervision preference exists anywhere in the
system today. `Doctor` has `code`, `doctor_type`, `sessions_per_week`,
`active` only. Nothing has been built yet for this feature.

**B.** Files:
- `backend/app/models/enums.py` — add `SupervisionPreference`.
- `backend/app/models/doctor.py` — add the column.
- `backend/alembic/versions/012_doctor_supervision_preference.py` — new
  migration.
- `backend/app/api/schemas/doctor.py` — add `supervision_preference` to
  `DoctorIn`, `DoctorPatch`, `DoctorOut`.

**C.** Instructions:
- Add `SupervisionPreference(str, enum.Enum)` with members/values as in
  Design Decision 1, placed near `DoctorType` for discoverability.
- Add the column to `Doctor` per Design Decision 3, importing
  `SupervisionPreference` alongside the existing `DoctorType`/`RoomType`
  import.
- Write migration `012`, revision chain `012` <- `011`:
  - `upgrade()`: create the `supervision_preference` Postgres enum type
    explicitly (checkfirst=True) if dialect is postgresql, then
    `op.add_column("doctors", ...)` with `nullable=False,
    server_default="normal"` using a column type built the same way as
    001/002's `_enum`/`_enum_column` helpers (`create_type=False` on the
    column itself, since the type was just created separately above).
  - `downgrade()`: `op.drop_column("doctors", "supervision_preference")`,
    then explicitly drop the enum type (checkfirst=True) if postgresql —
    safe here because no other table will reference this type.
  - Docstring should state plainly this is additive, no backfill needed
    beyond the server_default, and that this is the first fresh-enum-type
    add-column migration since 001 (for the next person reading it).
- Update the three doctor schemas with
  `supervision_preference: SupervisionPreference = SupervisionPreference.NORMAL`
  on `DoctorIn`/`DoctorOut`, and `SupervisionPreference | None = None` on
  `DoctorPatch`, matching the existing field style in that file exactly.
- Do not touch `backend_app_api_routers_doctors.py` — confirmed in Task 3
  that the router is a generic `model_dump(exclude_unset=True)` /
  `setattr` pass-through and needs no changes for a new schema field.