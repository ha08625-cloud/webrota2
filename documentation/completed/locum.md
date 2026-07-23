# Plan: Add Locum doctor type

## Scope

Add a fifth `DoctorType` value, `Locum`, behaving as Trainee-minus-supervision.

In scope:
- `DoctorType` enum (Python + Postgres native type + TypeScript union + zod schema).
- Alembic migration 013.
- Two engine call sites (phase7_9a, phase4) that currently key off `(TRAINEE, AHP)` / `TRAINEE`.
- Frontend type unions, form dropdown, and display ordering.
- Seed CSV mapping.
- Tests mirroring the existing Trainee cases.

Out of scope / deliberately unchanged:
- Phase 9B swap pool, Phase 9C supervisor pool, Phase 9C supervisable-trainee test, counters router `_COUNTED_TYPES`, `seed_system_counters`. All are explicit allow-lists of `(PARTNER, SALARIED)` or `TRAINEE` only; Locum is excluded by not appearing in them, exactly as Trainee/AHP already are. No code change, no test change.
- `superviseeCount.ts`, `DutyGrid.tsx`, `ClinicTypeFormDialog.tsx` "All doctors" bulk-add. Same reasoning: each scopes its special-casing to an explicit list that Locum does not join.
- Converting `doctor_type` from a native Postgres enum to `VARCHAR + CHECK`. Considered and rejected for this ticket: with an idempotent `ADD VALUE IF NOT EXISTS` the cost of a future enum addition is a three-line migration, which does not justify a type change across every doctor-referencing table now.

## Design decisions

1. **Locum = Trainee minus supervision.** Needs a D room (phase7_9a Passes 1 and 2, and phase4's duty-eviction D-room-only relocation); is never a supervisor; is never counted as requiring supervision; is never a duty candidate; is not part of the frontend "All doctors" bulk clinic-eligibility add; is eligible for clinic-type assignment in Phase 5 on the same footing as Trainee/AHP (this is data-driven per clinic type and needs no code).

2. **Display order: `Partner, Salaried, Trainee, Locum, AHP`.** Immediately after Trainee, since it shares Trainee's rules. Set in `DOCTOR_TYPE_ORDER` in `groupDoctors.ts`, which is the single source of truth for grid row ordering, dropdown grouping, and pivot ordering.

3. **Eviction behaviour in Phase 4 — two paths, both inherited from Trainee with no code change.**
   - `_is_protected_occupant` (line 343) protects Partner and AHP only. Locum, like Trainee and Salaried, is evictable. No change.
   - The fallback sweep (line 239) selects only `SALARIED` occupants as victims. Locum, like Trainee, is therefore **never a sweep victim**. No change. This is a deliberate decision, not an omission: a Locum in a D room is treated as needing that D room, the same as a Trainee.

   The only Phase 4 change is line 286, so that an evicted Locum is relocated within D rooms only.

4. **Migration 013 uses `ADD VALUE IF NOT EXISTS` and a no-op downgrade.** `001_initial_schema.py` creates the Postgres enum types from the *live* Python enums (`_create_enum_types()` iterating `_ALL_ENUMS`). Once `LOCUM` is in `enums.py`, a fresh `alembic upgrade head` creates `doctor_type` already containing `'Locum'`, so a plain `ADD VALUE` would fail on any fresh database — including CI job 2. `IF NOT EXISTS` makes 013 correct on both a fresh DB and the deployed Railway DB.

   No autocommit block is required: `ALTER TYPE ... ADD VALUE` has been transaction-safe since Postgres 12 (CI uses `postgres:16`), and the migration never *uses* the new value in the same transaction.

   `downgrade()` is a deliberate no-op. Postgres has no `DROP VALUE`; rebuilding the type without `'Locum'` would leave it differing from what 001 creates on a fresh DB, and 001's own `_drop_enum_types()` drops it wholesale anyway. With `IF NOT EXISTS` on the way back up, the CI upgrade/downgrade/upgrade round trip passes.

   Consequence to be aware of: on a fresh database 013 is effectively a no-op, and it exists for the already-deployed Railway database and for the audit trail. Keeping it is the chosen approach.

5. **Enum sort position is irrelevant.** `ADD VALUE` appends to the end of the Postgres enum's sort order. No query anywhere orders by `doctor_type` (all doctor ordering is `ORDER BY Doctor.code`, with type grouping applied in the frontend), so the mismatch between Postgres order and display order has no effect.

---

## Task 1: Data model changes

### A. State of the world

Adding a fifth `DoctorType` value, `Locum`, behaving as Trainee-minus-supervision. Nothing has been implemented yet. This task covers the Python enum, the Postgres migration, and the seed CSV mapping. The engine and frontend are separate tasks and depend on this one.

### B. Files and deliverables

| File | Deliverable |
|---|---|
| `backend/app/models/enums.py` | `LOCUM = "Locum"` added to `DoctorType`, positioned after `TRAINEE` |
| `backend/alembic/versions/013_doctor_type_locum.py` | New migration, idempotent upgrade, no-op downgrade |
| `backend/seed/seed_doctors.py` | `"locum"` branch in `_map_doctor_type` |
| `backend/tests/test_models.py` | Assertion that `DoctorType` contains `Locum` with value `"Locum"` |

### C. Instructions

1. In `enums.py`, add `LOCUM = "Locum"` to `DoctorType`, between `TRAINEE` and `AHP`. Member order here affects nothing functional (the frontend owns display order) but keeps the declaration consistent with the display convention.

2. Create `backend/alembic/versions/013_doctor_type_locum.py`:
   - `revision = "013"`, `down_revision = "012"`.
   - `upgrade()`: return early if `op.get_bind().dialect.name != "postgresql"` (SQLite renders the enum as `VARCHAR + CHECK` generated at `create_all` time from the Python enum, so it needs nothing). On Postgres, `op.execute("ALTER TYPE doctor_type ADD VALUE IF NOT EXISTS 'Locum'")`.
   - `downgrade()`: `pass`.
   - Module docstring must explain both non-obvious points: (a) why `IF NOT EXISTS` is mandatory rather than defensive — 001 creates the type from the live Python enum, so on a fresh DB the value is already present before 013 runs; (b) why `downgrade()` is a no-op — Postgres has no `DROP VALUE`, and rebuilding the type would diverge from what 001 produces. Follow the docstring style of migration 012.
   - Do not import `DoctorType` to build the value string; hardcode `'Locum'`. A migration must describe one fixed historical step, not track whatever the enum happens to contain later.

3. In `seed_doctors.py`, add `if t == "locum": return DoctorType.LOCUM` to `_map_doctor_type`. The function raises `ValueError` on an unknown string, so without this a `setup.csv` containing a Locum row is a hard seed failure.

4. Verify locally: `alembic upgrade head`, `alembic downgrade 012`, `alembic upgrade head` against Postgres. CI job 2 does the same round trip.

---

## Task 2: Engine changes

### A. State of the world

Adding a fifth `DoctorType` value, `Locum`, behaving as Trainee-minus-supervision. Task 1 is complete: `DoctorType.LOCUM` exists in `backend/app/models/enums.py`, migration 013 is written, and the seed mapping is updated. This task makes the engine treat Locum like a Trainee for room resolution.

### B. Files and deliverables

| File | Deliverable |
|---|---|
| `backend/app/engine/phases/phase7_9a.py` | Lines 255 and 452: `(TRAINEE, AHP)` extended to include `LOCUM` |
| `backend/app/engine/phases/phase4.py` | Line 286: evicted-Locum relocation routed to D-rooms-only; comment at the fallback sweep updated |
| `backend/app/engine/room_relocation.py` | `find_trainee_d_room` renamed and docstrings de-Trainee-fied |
| `backend/tests/test_engine/factories.py` | Locum doctor factory support if the existing helper hardcodes a type |
| `backend/tests/test_engine/test_phase7_9a.py` | Locum cases mirroring the Trainee full-day and single-session cases |
| `backend/tests/test_engine/test_phase4.py` | Locum eviction case: relocated to a D room only, never C/W/SR; and a case confirming a Locum is not a fallback-sweep victim |

### C. Instructions

1. `phase7_9a.py`, `_full_day_candidates` (line 255) and `_single_session_candidates` (line 452): extend `(DoctorType.TRAINEE, DoctorType.AHP)` to `(DoctorType.TRAINEE, DoctorType.AHP, DoctorType.LOCUM)`. Consider hoisting this to a module-level `_D_ROOM_TYPES` constant next to the existing `_DISPLACEABLE_TYPES`, so the two sites cannot drift.

2. `phase4.py` line 286: change `evictee.doctor_type == DoctorType.TRAINEE` to `evictee.doctor_type in (DoctorType.TRAINEE, DoctorType.LOCUM)` so an evicted Locum goes through the D-room-only search.

3. `phase4.py` lines 239 and 343: **no code change.** Update the comment above the fallback sweep, which currently reads "Trainees are never sweep victims (Design Decision 12c)", to state that Trainees and Locums are never sweep victims — the sweep selects Salaried occupants only, so this is already true and only the comment is stale.

4. `room_relocation.py`: rename `find_trainee_d_room` to `find_d_room_only` and update the two call sites (phase4). Update the docstrings at lines 12 and 62 which say "Trainee" where they now mean "Trainee or Locum". No behaviour change.

5. Tests: mirror the existing Trainee assertions rather than inventing new scenarios. The two behaviours worth asserting explicitly, because they are inherited silently rather than coded, are (a) a Locum evicted by a duty doctor never lands in a C/W/SR room even when one is free, and (b) a Locum sitting in a D room is not selected by the Phase 4 fallback sweep.

6. Confirm by inspection that no other engine file needs touching: `phase9b._SWAPPABLE_TYPES`, `phase9c._SUPERVISOR_TYPES`, and `phase9c`'s trainee check (line 99) are all allow-lists Locum correctly does not join.

---

## Task 3: Frontend changes

### A. State of the world

Adding a fifth `DoctorType` value, `Locum`, behaving as Trainee-minus-supervision. Tasks 1 and 2 are complete: the backend enum, migration, and engine room-resolution changes are done. This task adds the type to the frontend so it can be selected, validated, and displayed in the right position.

### B. Files and deliverables

| File | Deliverable |
|---|---|
| `frontend/src/api/types.ts` | `"Locum"` added to the `DoctorType` union (line 233) |
| `frontend/src/lib/doctorSchema.ts` | `"Locum"` added to `doctorTypeEnum` (line 5) |
| `frontend/src/components/DoctorFormDialog.tsx` | `"Locum"` added to `DOCTOR_TYPES` (line 22) |
| `frontend/src/lib/groupDoctors.ts` | `"Locum"` in `DOCTOR_TYPE_ORDER` after `"Trainee"`, plus a `DOCTOR_TYPE_LABELS` entry |
| `frontend/src/lib/groupDoctors.test.ts` | Ordering and label assertions extended with a Locum doctor |
| `frontend/test/fixtures/reference.ts` | Locum doctor fixture if the ordering tests need one |

### C. Instructions

1. Add `"Locum"` to the union in `types.ts` and to the zod enum in `doctorSchema.ts`. These two must stay in step; the zod enum is what rejects a bad value at form-submit time.

2. `DoctorFormDialog.tsx`: add `"Locum"` to `DOCTOR_TYPES` in the display order agreed in Design Decision 2 (after `"Trainee"`).

3. `groupDoctors.ts`: add `"Locum"` to `DOCTOR_TYPE_ORDER` between `"Trainee"` and `"AHP"`, and `Locum: "Locums"` to `DOCTOR_TYPE_LABELS`. `DOCTOR_TYPE_LABELS` is typed `Record<DoctorType, string>`, so omitting it is a compile error — that is the intended safety net.

4. Existing `groupDoctors.test.ts` assertions will still pass unchanged, because `groupDoctorsByType` filters out types with no doctors in the input list. Add a Locum doctor to the fixtures in the ordering and label tests anyway, so the new position is actually asserted rather than merely unbroken.

5. No change needed in `ClinicTypeFormDialog.tsx`, `DutyGrid.tsx`, `superviseeCount.ts`, `pivot.ts`, `pivotMasterRota.ts`, `exportRota.ts`. Each either scopes to an explicit `Partner`/`Salaried`/`Trainee` list or routes ordering through `groupDoctors.ts`. Note that `ClinicTypeFormDialog` will now render an "All Locums" per-group bulk-add option; this is correct and matches how Trainees and AHPs behave, while the separate "All doctors" action stays Partner/Salaried only.

6. Run `npm run typecheck` before the test run. It is the cheapest way to surface any exhaustive mapping over `DoctorType` not found by grep.

---

## Documentation

To be updated after Task 3 (by the user, per the project's documentation ownership):

- `Architecture.md`: remove the `docs/domain-model.md` row from the Document Index — that document was abandoned and no longer exists.
- `docs/phase-pipeline.md`: Phase 4 and Phases 7–9A references to "Trainee/AHP" become "Trainee/Locum/AHP" for D-room demand, and the Phase 4 eviction note should record that Locum, like Trainee, is evictable but never a fallback-sweep victim.

## Commit messages

- Task 1: `Add Locum to DoctorType enum` / migration 013 uses `ADD VALUE IF NOT EXISTS` because 001 builds the Postgres type from the live Python enum / `downgrade()` is a documented no-op, Postgres has no `DROP VALUE`.
- Task 2: `Treat Locum as Trainee for room resolution` / phase7_9a Passes 1 and 2 and phase4 D-room-only relocation extended to Locum / `find_trainee_d_room` renamed to `find_d_room_only`.
- Task 3: `Add Locum to frontend doctor type` / union, zod schema, form dropdown, and display order between Trainee and AHP.
