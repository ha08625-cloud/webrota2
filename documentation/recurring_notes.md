# Implementation Plan: Recurring Notes

## Scope

A new "Recurring Notes" tab, independent of the Master Rota template, where a note ("Partners meeting") is defined against a day, a period, a set of template weeks (1-4), and an explicit list of doctors. At generation, any matching doctor/week/day/period combination gets that text stamped into `RotaSession.notes` as a starting value. It remains editable and clearable on the draft grid exactly as today.

Out of scope: any effect on availability, eligibility, room assignment or duty. A recurring note is annotation only.

## Design Decisions

1. **Standalone entity, not a `MasterRotaSession` field.** `recurring_notes` plus two child tables (doctors, template weeks). A note recurs by day-of-week across every generation run; a template cell is the wrong recurrence unit, and no single template cell can represent "several doctors, one note".

2. **Annotation only — deliberately no effect on availability.** Phase 4 will still apply duty and Phase 5 will still assign a clinic to a doctor whose slot carries a note. This is confirmed intended behaviour: a partners meeting occupies the tail of a session, not the session. Blocking a session entirely is done through the master template (`ADMIN_TIME` / `NO_SURGERY`) as it is today.

3. **Doctor scope is an explicit, editable list, not role-based.** Ticked doctors, not "all Partners". A new partner requires a manual tick. Accepted trade-off for v1.

4. **Week scope is an explicit set of template weeks 1-4, at least one required.** Every week = all four ticked (the UI default). Fortnightly = `{1,3}` or `{2,4}`. Four-weekly = one week. Anchoring on *template* week rather than generation week means a fortnightly note lands on the same real-world fortnight as the master rota's own cycle, whatever week a run starts on. There is deliberately no "null means every week" shorthand — an explicit set keeps the engine lookup branchless and the UI unambiguous.

5. **Staging runs need a stored template-week anchor.** `rota_stagings` does not currently record which template week the copy started from: `routers/staging.py` applies `payload.template_start_week` at copy time and then persists `template_start_week=1` on the config, so `template_week()` is the identity for a staged run. Without a fix, a note scoped to template weeks `{1,3}` would fire on staging *generation* weeks 1 and 3, which may be template weeks 3 and 1 in reality — a fortnightly note landing on the wrong fortnight during holiday cover. Migration 015 therefore adds `rota_stagings.source_template_start_week` (non-null, server default 1), set at staging create, and `context.py` uses it as the effective start week when resolving note weeks for a staged run. This can be cut by treating the value as always 1, at the cost of that offset.

6. **Applied once, at generation time, inside Phase 2's grid build.** `SessionSlot.notes` already exists, is written through by `_write_to_db` (`generate.py:121`), and is set by no phase today — verified. No new phase, no `SessionSlot` change. `GenerationContext` gains one pre-resolved field.

7. **Stamped as a default only, never re-applied.** `grid_utils.rebuild_rota_grid()` reads `notes` from the persisted row (`grid_utils.py:123`) and never re-derives it, so editing or clearing a note behaves exactly as it does today and a cleared note is not restored. Scrap-and-regenerate re-stamps fresh, like everything else in the pipeline.

8. **Stamped regardless of leave.** Leave can be entered after generation, and a stamped note is never re-evaluated, so suppressing on leave would make behaviour depend on whether leave was booked before or after the run. `exportRota.ts` already treats notes as the one thing a leave cell does not suppress, which is consistent with stamping.

9. **No uniqueness rule. Overlapping notes concatenate.** Reversed from the provisional plan. Enforcing one note per doctor per (day, period) would need a cross-table check on every write, a 409 naming a note the user then has to find, and an answer to the partial-collision case (nine doctors fine, the tenth clashing). Instead: all matching notes for a slot are sorted by note id ascending and joined with a newline. Duplicates are visible and self-correcting rather than an error.

10. **No template row means no note, silently.** Phase 2 creates no `SessionSlot` where the doctor has no template entry, and none on a closed date. A part-time doctor with no Tuesday PM row gets no note and no warning. Accepted; documented in the model docstring and in Architecture.md.

11. **No staging-specific phase code.** Staged rotas run the same Phase 2 grid build, so notes apply identically. Decision 5's anchor lookup lives in `context.py`, which Architecture.md already documents as the only staging-aware code in the engine.

12. **Inactive doctors.** Phase 2 iterates `context.doctors` (active only), so an association to a deactivated doctor is a silent no-op. Writes reject inactive doctor ids (422); an existing note whose doctor is later deactivated simply stops applying and is left alone.

## Data model summary

```
recurring_notes
  id, text (String(200), non-null), day (Day), period (Period),
  is_active (bool, non-null, default True)

recurring_note_doctors
  id, note_id FK -> recurring_notes.id (cascade), doctor_id FK -> doctors.id
  unique (note_id, doctor_id)

recurring_note_weeks
  id, note_id FK -> recurring_notes.id (cascade), template_week Integer
  unique (note_id, template_week), check template_week BETWEEN 1 AND 4

rota_stagings
  + source_template_start_week Integer, non-null, server_default 1
```

Naming note: the codebase already carries three conventions for this flag (`Doctor.active`, `ClinicType.is_enabled`, `MasterRotaTemplate.is_active`). Use `is_active`, matching `MasterRotaTemplate` as the closest analogue — a config record toggled on and off. Do not guess a fourth.

---

# Task 1: Data model and migration

**A. State of the world.** Nothing of this feature exists yet. This task creates the three new tables, the one new column on `rota_stagings`, and migration 015. Migration head is confirmed at `014`. The system is not live, so no data preservation is required.

**B. Files and deliverables**

| File | Action |
|---|---|
| `backend/app/models/recurring_note.py` | New — `RecurringNote`, `RecurringNoteDoctor`, `RecurringNoteWeek` |
| `backend/app/models/staging.py` | Edit — add `source_template_start_week` |
| `backend/app/models/__init__.py` | Edit — import and `__all__` entries for the three new classes |
| `backend/alembic/versions/015_recurring_notes.py` | New |
| `backend/tests/test_models.py` | Edit — construction and cascade tests |

**C. Instructions**

1. `recurring_note.py`, following `closure.py` and `clinic_type.py` for style. Module docstring must record Decisions 2, 9 and 10 — that the note has no effect on availability, that overlapping notes concatenate rather than collide, and that a doctor with no template row for the slot silently gets nothing.
   - `RecurringNote`: `text: Mapped[str] = mapped_column(String(200), nullable=False)`, `day` and `period` via `enum_col(...)`, `is_active: Mapped[bool]` non-null default `True`.
   - Two relationships with `cascade="all, delete-orphan"`, mirroring `ClinicType.schedules`.
   - `RecurringNoteWeek` carries `CheckConstraint("template_week BETWEEN 1 AND 4", name="ck_rnw_week")` and `UniqueConstraint("note_id", "template_week", name="uq_rnw_note_week")`. `RecurringNoteDoctor` carries `UniqueConstraint("note_id", "doctor_id", name="uq_rnd_note_doctor")`.
   - `doctor_id` is a plain FK to `doctors.id` with no `ondelete` — doctors are soft-deleted only, matching every other doctor FK in the schema.
2. `staging.py`: add `source_template_start_week: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")`. Extend the module docstring to say what it is for: the staged config always persists `template_start_week=1`, so this column is the only surviving record of the real template-week anchor, and recurring-note week resolution depends on it.
3. `models/__init__.py`: add the import line and three `__all__` entries. This is not optional — Alembic autogenerate and `from ..models import ...` both depend on it.
4. Migration 015: copy the `_enum_column` helper from 014 verbatim for the `day` and `period` columns (both types already exist on Postgres from 001; `create_type=False`). `revision = "015"`, `down_revision = "014"`. `upgrade()` creates the three tables in parent-then-child order and adds the `rota_stagings` column. `downgrade()` drops the column and the three tables in reverse order; no enum type is dropped, since `day` and `period` are shared with tables that survive.
5. Tests in `test_models.py`: create a note with two doctors and two weeks; assert deleting the note cascades both child sets; assert the week check constraint rejects 0 and 5. Note that FK and check enforcement only happens under the test engines' `PRAGMA foreign_keys=ON`.

---

# Task 2: API layer

**A. State of the world.** Task 1 is complete: the three tables and the `rota_stagings` column exist and are migrated. This task adds the schemas, the CRUD router, its registration, and API tests. It does not touch the engine.

**B. Files and deliverables**

| File | Action |
|---|---|
| `backend/app/api/schemas/recurring_note.py` | New |
| `backend/app/api/schemas/__init__.py` | Edit — re-export |
| `backend/app/api/routers/recurring_notes.py` | New |
| `backend/app/api/main.py` | Edit — import and both registration lists |
| `backend/tests/test_api/test_recurring_notes.py` | New |

**C. Instructions**

1. Schemas — `RecurringNoteIn`, `RecurringNoteOut`. `In` carries `text`, `day`, `period`, `is_active`, `doctor_ids: list[int]`, `template_weeks: list[int]`. Pydantic validators:
   - `text` stripped, `min_length=1` after stripping, `max_length=200`.
   - `doctor_ids` non-empty, deduplicated (reject duplicates rather than silently collapsing).
   - `template_weeks` non-empty, every value in `{1,2,3,4}`, no duplicates.
   - No weekday validation is needed: `Day` has only Monday-Friday members.
   `Out` returns the same fields plus `id`, with `doctor_ids` and `template_weeks` sorted ascending so the frontend and its tests get a stable shape.
2. Router, `prefix="/recurring-notes"`, mirroring `closures.py` for structure and `clinic_types.py` for the nested-write pattern. Every handler takes `db: Session = Depends(get_db)` and `user: dict = Depends(get_current_user)`.
   - `GET ""` — all notes, active and inactive, with children eager-loaded via `selectinload`. **Order in Python, not SQL**: the enums are stored by value, so `ORDER BY day` gives alphabetical ("Friday" first), not weekday order. Sort by `(DAY_ORDER[note.day], period, note.id)` using `DAY_ORDER` from `engine/week_map.py`, which `context.py` already imports for the same reason.
   - `POST ""` → 201. `PUT /{note_id}` → replace-children wholesale, the same contract as `PUT /clinic-types/{id}`. `DELETE /{note_id}` → 204, children cascade.
   - Doctor validation on both writes: every id must exist and be `active=True`, else 422 with a plain-string detail naming the offending ids. This is a DB-backed check in the router, not a Pydantic validator, for the same reason `duty.py`'s closed-date check is.
   - There is no 409 path. Overlapping notes are legal by Decision 9.
3. `main.py`: add `recurring_notes` to both the `from .routers import (...)` block and the `for module in (...)` tuple. Missing the second is the usual failure here and produces a silent 404.
4. API tests: create/list/update/delete round trip; the Python-side ordering (assert a Friday note sorts after a Monday note, which alphabetical ordering would get wrong); 422 on empty text, empty `doctor_ids`, empty `template_weeks`, a week of 5, a duplicate doctor id, and an inactive doctor id; replace-children on `PUT` (a note updated from three doctors to one ends with exactly one association row); and that two overlapping notes both persist without error.

---

# Task 3: Engine

**A. State of the world.** Tasks 1 and 2 are complete: the tables exist and are writable through the API. This task makes generation consume them. It depends on Task 1 only, so it can run in parallel with Task 2 if convenient.

**B. Files and deliverables**

| File | Action |
|---|---|
| `backend/app/engine/datatypes.py` | Edit — one new `GenerationContext` field |
| `backend/app/engine/context.py` | Edit — loader plus the effective-start-week helper |
| `backend/app/engine/phases/phase2.py` | Edit — stamp `slot.notes` |
| `backend/tests/test_engine/factories.py` | Edit — `make_recurring_note` |
| `backend/tests/test_engine/test_recurring_notes.py` | New — there is no `test_phase2.py` to extend |

**C. Instructions**

1. `datatypes.py`: add to `GenerationContext`, after `duty_map`:
   ```python
   # Pre-resolved recurring-note text per grid slot, keyed by *generation*
   # week -- the template-week mapping and the multi-note concatenation are
   # both done in load_context(), so Phase 2 is a single dict lookup.
   # Absent key means no note; the value is never an empty string.
   recurring_notes_by_slot: dict[tuple[int, int, Day, Period], str]
   ```
   Key order is `(doctor_id, gen_week, day, period)`, matching `RotaGrid`'s own slot key order. `GenerationContext` has no field defaults and is constructed in exactly one place (`context.py:100`), so no other call site breaks.
2. `context.py`:
   - Add `_effective_template_start_week(db, config) -> int`: returns `staging.source_template_start_week` if a `RotaStaging` row exists for `config.id`, otherwise `config.template_start_week`. This deliberately re-queries `rota_stagings` rather than threading a third return value out of `_load_staging_or_template()` — one extra query on a single-row table, in exchange for keeping the template loader's signature and docstring untouched. Its docstring must explain the staged-config `template_start_week=1` reason (Decision 5).
   - Add `_load_recurring_notes(db, config, start_week) -> dict[...]`: select active notes with both child collections eager-loaded; for each generation week `1..config.num_weeks`, compute `tw = template_week(gen_week, start_week)`; for each note whose week set contains `tw`, for each of its doctor ids, append `note.text` to a list under `(doctor_id, gen_week, note.day, note.period)`. Notes must be iterated in ascending `id` order so concatenation is deterministic. Finally join each list with `"\n"`. Do not filter by doctor active status here — Phase 2 only iterates active doctors, so an inactive doctor's entries are dead keys and cost nothing.
   - Wire both into `load_context()` and the `GenerationContext(...)` construction.
3. `phase2.py`: inside `_build_grid`, pass to the `SessionSlot(...)` constructor:
   ```python
   notes=context.recurring_notes_by_slot.get((doctor.id, gen_week, day, period)),
   ```
   Nothing else changes. It sits after the closed-date `continue`, so a closed date correctly produces no slot and therefore no note. Extend the module docstring by one sentence.
4. `factories.py`: `make_recurring_note(session, text="Partners meeting", day=Day.TUESDAY, period=Period.PM, doctor_ids=(), template_weeks=(1,2,3,4), is_active=True)`, adding and flushing parent then children, following `make_clinic_type`'s handling of its child iterables.
5. `test_recurring_notes.py`, using the existing engine test fixtures:
   - Note stamped onto the matching slot only; adjacent day/period slots have `notes is None`.
   - Week scoping: a note on `{1,3}` with `template_start_week=1` and a 4-week run appears in generation weeks 1 and 3 only; with `template_start_week=2` it appears in generation weeks 2 and 4.
   - Two overlapping notes concatenate newline-separated in ascending id order.
   - `is_active=False` stamps nothing.
   - A doctor on leave for that slot still gets the note (Decision 8).
   - A doctor with no template row for the slot gets no slot and no note (Decision 10).
   - A staged run resolves weeks against `source_template_start_week`, not the staged config's `template_start_week=1` (Decision 5).
   - End to end through `generate()`: the note reaches the persisted `RotaSession.notes`, and a subsequent `rebuild_rota_grid()` returns it unchanged rather than re-deriving it.
6. `routers/staging.py` must set `source_template_start_week=payload.template_start_week` on the `RotaStaging` row it creates (around line 297-305, alongside the existing `template_start_week=1` on the config). Small enough to fold into this task rather than reopening Task 2; add a staging API test asserting the stored value.

---

# Task 4: Frontend

**A. State of the world.** Backend is complete: `/api/v1/recurring-notes` is live with GET/POST/PUT/DELETE, and generation stamps notes. This task adds the API hooks, the page, and its route and nav entry. No backend change.

**B. Files and deliverables**

| File | Action |
|---|---|
| `frontend/src/api/types.ts` | Edit — `RecurringNote`, `RecurringNoteIn` |
| `frontend/src/api/recurringNotes.ts` | New |
| `frontend/src/api/recurringNotes.test.tsx` | New |
| `frontend/src/routes/RecurringNotesPage.tsx` | New |
| `frontend/src/routes/RecurringNotesPage.test.tsx` | New |
| `frontend/src/App.tsx` | Edit — `<Route>` and nav entry in the clinical shell |
| `frontend/test/msw/handlers.ts` | Edit — handlers for the four endpoints |
| `frontend/test/fixtures/reference.ts` | Edit — sample notes |

**C. Instructions**

1. Types: `RecurringNote` = `{ id; text; day: Day; period: Period; is_active: boolean; doctor_ids: number[]; template_weeks: number[] }`; `RecurringNoteIn` is the same without `id`.
2. `recurringNotes.ts` follows `closures.ts` exactly — a `recurringNoteKeys` object, `useRecurringNotes`, `useCreateRecurringNote`, `useUpdateRecurringNote`, `useDeleteRecurringNote`, each invalidating `recurringNoteKeys.all` on success.
3. `RecurringNotesPage.tsx`: a list plus a create/edit dialog, following `ClosuresPage.tsx` for page shape and `ClinicTypeFormDialog.tsx` for a dialog with multi-select children. Dialog fields: text (200 char limit, shown), day, period, doctor multi-select (**active doctors only** — the backend 422s on inactive ids), template weeks 1-4 as four checkboxes defaulting to all ticked, and an active toggle. The list should render the doctor set by code and the week set compactly ("Weeks 1, 3" / "Every week" when all four).
4. The list must be sorted client-side by weekday order then period; do not rely on array order from the API beyond what the backend guarantees.
5. Nav and route go in the **clinical** shell in `App.tsx`, next to `closures`, path `recurring-notes`. Both the `<Route>` and the nav link are needed.
6. Tests mirroring `ClosuresPage.test.tsx`: renders the list, opens the dialog, creates a note with two doctors and two weeks and asserts the POST body, edits an existing note and asserts the PUT body carries the full replacement child sets, deletes with confirmation, and disables save on empty text or zero ticked weeks.

---

# Task 5: Documentation

**A. State of the world.** Tasks 1-4 are complete and the feature works end to end. This task updates the architecture record only.

**B. Files and deliverables**

`Architecture.md` — edit.

**C. Instructions**

1. Tables heading: 26 becomes 29.
2. The Data Layer intro currently says "eight Alembic migrations" — this was already stale before this feature; correct it to fifteen.
3. New paragraph under Generation inputs describing `recurring_notes` and its two child tables, carrying Decisions 2, 4, 9 and 10 — annotation only with no effect on availability, template-week anchoring, concatenation instead of a uniqueness rule, and no note where there is no template row.
4. Staging table paragraph: document `source_template_start_week` and why it exists (Decision 5).
5. Phase 2 bullet: add that it stamps `slot.notes` from `context.recurring_notes_by_slot`, the only place `notes` is ever set by the engine.
6. `GenerationContext` bullet: add the new field to the list of load-time guarantees, specifically that concatenation and week resolution happen at load time so the phase is a plain lookup.
7. Staging branch section: note that `context.py` gained a second, smaller staging-aware read (`_effective_template_start_week`), so the "only staging-aware code in the engine" claim stays true but now covers two helpers.
8. Router surface table: a `/recurring-notes` row.

Separately, and not part of this feature: line 449 still carries an `[UNRESOLVED]` marker about `railway.toml` using bare `alembic`/`uvicorn` while `nixpacks.toml` says the venv is not on the runtime PATH. That should be resolved against the repo on its own ticket before the next deploy.
