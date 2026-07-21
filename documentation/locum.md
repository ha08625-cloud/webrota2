

## Plan: Add Locum doctor type

**Design decisions**

1. **Behaviourally, Locum = Trainee minus supervision.** Concretely this means: needs a D room (Pass 1/2 of phase7_9a, and Phase 4's duty-eviction D-room-only relocation), is not protected from duty-eviction (unlike AHP), is never a supervisor, never counted for supervision, never a duty candidate, never part of the "All doctors" bulk clinic-eligibility add. Every one of those behaviours already exists as an explicit allow-list or exclude-list keyed off `DoctorType.TRAINEE`/`AHP` — no new logic branches needed, just extending the right tuples.
2. **Position in display order:** I'd suggest `Partner, Salaried, Trainee, Locum, AHP` — immediately after Trainee since it shares Trainee's rules. You may prefer alphabetical-within-non-core or a different slot; this is a one-line decision (`DOCTOR_TYPE_ORDER` in `groupDoctors.ts`).
3. **The enum migration is the main risk.** `doctor_type` is a native Postgres enum. Adding a value needs `ALTER TYPE doctor_type ADD VALUE 'Locum'`, which Alembic must run in an autocommit block outside the normal transaction. Postgres has no `DROP VALUE`, so a clean `downgrade()` isn't really achievable if any doctor row already uses `'Locum'` — I'll write `downgrade()` to raise/refuse if any row uses the value, and otherwise rebuild the type without it. Flagging this now because your CI does a real upgrade/downgrade/upgrade round trip against Postgres (job 2) — I'll make sure that round trip still passes on an empty seed DB, but a genuine rollback in a populated environment with real Locum doctors will not be clean. That's an inherent Postgres-enum limitation, not something we can design around cheaply; an alternative would be switching `doctor_type` to a plain `VARCHAR` + `CHECK` constraint instead of a native enum, which would make future additions trivial and downgrades safe — worth considering now if you expect more staff-type changes later, but it's a bigger change than this ticket needs.

**Backend — Task 1: Data model**
- `backend/app/models/enums.py`: add `LOCUM = "Locum"` to `DoctorType`.
- New Alembic migration (013): `ALTER TYPE doctor_type ADD VALUE` in an autocommit block, per the pattern above.
- `backend/seed/seed_doctors.py`: add a mapping branch (optional/low priority — only matters if `setup.csv` gains a Locum row).

**Backend — Task 2: Engine changes**
- `phase7_9a.py`: lines 255 and 452, extend `(DoctorType.TRAINEE, DoctorType.AHP)` → `(DoctorType.TRAINEE, DoctorType.AHP, DoctorType.LOCUM)` so Locum gets full-day and single-session D-room resolution.
- `phase4.py`: line 286, extend the trainee-only check to include Locum so an evicted Locum is relocated within D rooms only via `find_trainee_d_room`, never C/W/SR. Line 343 (`_is_protected_occupant`) stays Partner/AHP only — Locum, like Trainee, remains evictable.
- `phase9c.py`, `phase9b.py`, `counters.py`, `seed_system_counters.py`: no changes — Locum is excluded from supervisor pool, swap pool, and counted types purely by not appearing in those tuples, same as Trainee/AHP already are.

**Frontend — Task 3**
- `frontend/src/api/types.ts`: add `"Locum"` to the `DoctorType` union.
- `frontend/src/lib/doctorSchema.ts`: add `"Locum"` to `doctorTypeEnum`.
- `frontend/src/components/DoctorFormDialog.tsx`: add `"Locum"` to `DOCTOR_TYPES`.
- `frontend/src/lib/groupDoctors.ts`: add `"Locum"` to `DOCTOR_TYPE_ORDER` and a label to `DOCTOR_TYPE_LABELS`. This one file drives grid row ordering, dropdown grouping, and pivot ordering everywhere, so it's the single highest-leverage change.
- No changes needed in `ClinicTypeFormDialog.tsx`, `DutyGrid.tsx`, or `superviseeCount.ts` — all three already scope their special-casing to explicit type lists that exclude Trainee/AHP, so Locum falls into the same excluded bucket automatically once the type exists.
- After the above, run the frontend typecheck — worth doing deliberately in case any exhaustive switch on `DoctorType` elsewhere breaks compilation and surfaces a spot I haven't found by grep.

**Testing**
- Backend: engine tests for phase4 and phase7_9a will need Locum fixtures mirroring the existing Trainee cases (eviction-to-D-only, full-day/single-session D-room passes), plus a migration round-trip test.
- Frontend: `groupDoctors_test.ts` and `doctorSchema` tests will need a Locum case added to the ordering assertions.

Open question: are Locum doctors to be eligible for clinic-type assignment at all (Phase 5), same as Trainee/AHP today? yes