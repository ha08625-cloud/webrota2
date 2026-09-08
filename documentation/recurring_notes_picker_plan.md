# Implementation plan: recurring notes become a pickable, per-run meeting list

Status: **implementation plan** (workflow step 2 complete). Tasks 1-6 below are
each intended as the whole context for one chat.

## Plan

Recurring notes today are defined against a set of *template* weeks (1-4) and
fire automatically on every matching week of every run. In practice meetings
move constantly for leave and other commitments, so the fortnightly stamp is
wrong more often than it is right, and the only way to correct it is to edit
the note text cell-by-cell on the generated draft grid.

After this change:

1. A recurring note is defined once as a **named meeting** ("Significant events
   meeting") with a default day, period and doctor list — **no template weeks**.
   The definitions page becomes a library; it no longer schedules anything.
2. On the staging page the user ticks which meetings apply to this run. A tick
   **copies** the definition into a per-run instance.
3. A picked instance can be edited for that run only (text, day, period,
   doctors, and which generation week on a multi-week run) without touching the
   definition, and free-form one-off notes can be added that have no definition
   behind them at all.

## Scope

In scope: `recurring_notes` model + schemas + router, two new per-run tables,
`engine/context.py` note resolution, `RecurringNotesPage`, a new picker panel on
`StagingPage`, alembic `012`, tests, architecture docs.

Out of scope: the draft-grid note editing that already exists (unchanged);
reception rota; any change to how notes affect availability (they remain
annotation only — Phase 4 still applies duty and Phase 5 still assigns a clinic
to a slot carrying a note).

The system is not live, so every migration below is plainly destructive with no
backfill.

## Design decisions

### D1. The picker lives on the staging page, not the generate form

`RotaPage` → *Start staging* → `StagingPage` → *Complete and generate* is the
real flow; `RotaPage`'s submit calls `useCreateStaging`, and `useGenerateRota`
has no call site in the app at all.

- The picker needs a persisted parent to hang per-run edits off. No `RotaConfig`
  exists until staging is created, so a tick on `RotaPage` would have to travel
  as unsaved state in the create-staging payload, and "edit it afterwards" would
  still need a second surface — the staging page.
- Staging is already, by definition, the "changes here apply to this rota only"
  step, which is exactly these notes' semantics.
- The staging page holds the full staged session list and the closed slots, so
  it can raise the D5 warning. `RotaPage` cannot.

Note for anyone tempted to move it: the clinic tick-boxes on `RotaPage` that
this feature superficially resembles are **not** per-run — `ClinicStatusList`
fires `PATCH /clinic-types/{id}` and changes `is_enabled` globally.

### D2. Per-run notes attach to `RotaConfig`, not to `RotaStaging`

Both generation paths (`POST /rota/generate` and `POST /staging/{id}/complete`)
run `generate(db, config_id)`, and `load_context()` is already keyed on the
`RotaConfig`. Attaching there keeps the engine's lookup path single and needs no
staging-specific branch in the engine. The write endpoints still live under
`/staging/{id}/notes` so they inherit `_require_active()` and the staging
router's existing guards; they write rows against `staging.config_id`.

`POST /rota/generate` therefore carries no notes — a documented no-op, not a
regression, since the UI never calls it.

**Notes share the staging's lifetime, and that is the honest limit of this
design.** `scrap_rota()` deletes the `GeneratedRota` and leaves the
`RotaConfig`, but no endpoint regenerates against an existing config:
`complete_staging` sets `completed_at` and `_require_active` blocks a second
completion, so the only routes back are a new staging (fresh `RotaConfig`) or
`POST /rota/generate` (fresh `RotaConfig`, no notes). Scrapping a draft
therefore discards the picked notes — exactly as it already discards every
staged session edit. Do not write "scrap-and-regenerate re-stamps the same
notes" anywhere; it is false.

Consequence that must be handled in code (see Task 1): `abandon_staging`
hard-deletes the staging **and its `RotaConfig`** (`routers/staging.py`, the
explicit `db.flush()` between the two deletes). A `config_id` FK with no ORM
cascade would make abandoning a staging that has any picked note fail with an
`IntegrityError`.

### D3. New tables; `recurring_note_weeks` is deleted outright

```
recurring_notes           text, day, period, is_active   (unchanged — now DEFAULTS)
recurring_note_doctors    unchanged (default doctor list)
recurring_note_weeks      DROPPED

rota_config_notes
  id, config_id FK -> rota_configs (ORM cascade from RotaConfig)
  source_note_id FK -> recurring_notes, NULLABLE (provenance only)
  text (200), week (CHECK 1-4, GENERATION week), day, period
rota_config_note_doctors
  id, config_note_id FK, doctor_id FK, unique(config_note_id, doctor_id)
```

`source_note_id` is provenance, not a live link: the instance copies text, day,
period and doctors at pick time and never re-reads the definition. It exists so
the UI can tick the right boxes and show "from: Significant events meeting". A
definition that is later edited, deactivated or deleted does not change any
instance already picked; delete nulls `source_note_id` in the router (there is
no DB-level cascade anywhere in this schema) and leaves the instance intact. A
free-form one-off note has `source_note_id = NULL` from the start, so the UI
must distinguish "unlinked" by that alone and cannot tell the two apart —
accepted, because the only thing the distinction would buy is a label.

No cross-note uniqueness, same as today — overlapping notes on one slot
concatenate newline-joined in ascending `rota_config_notes.id` order.

### D4. `week` is a **generation** week, and a tick may create several

Template-week anchoring is the thing being removed, so `template_week()` and
`_effective_template_start_week()` leave the note path entirely. On a 1-week run
the week selector is hidden and every instance is week 1.

On a 2- or 4-week run, ticking a meeting opens a week checkbox group defaulting
to **week 1 only**, and creates one instance per ticked week. This is not the
old recurrence returning: the weeks are per-run generation weeks chosen by the
user for this run, not a stored property of the definition, and each instance is
independently editable or deletable afterwards. Without it, a genuinely weekly
meeting on a 4-week run would need four manual adds, which is a regression
against today's behaviour for the one case today gets right.

`week` also needs a **router-level** bound, not just the CHECK constraint: a
week-3 note on a 2-week run is silently dead. `StagingSessionCreateIn` has this
exact problem and 422s in the router against the staging's own `num_weeks`;
mirror that.

Consequence: `engine/context.py::_effective_template_start_week()` becomes dead
(`load_context()` is its only caller) and is deleted. `week_map.template_week()`
itself stays — phase0, phase2, `grid_utils` and `staging.py` all still use it.
Keep `RotaStaging.source_template_start_week` (cheap provenance of what the copy
started from) but strip the docstring paragraphs justifying it via recurring
notes, in both `models/staging.py` and `architecture-clinical.md`.

### D5. Silent no-op becomes a visible warning, with one known blind spot

Phase 2 builds no `SessionSlot` in three cases, and a note aimed at a suppressed
slot vanishes with no warning:

| Suppressor | Visible from staging data? |
|---|---|
| No staged row for that doctor/week/day/period | Yes — `StagingOut.sessions` |
| Closed `(date, period)` | Yes — `StagingOut.closed_slots` |
| Doctor outside their employment window | **No** — `StagingSessionOut` carries no window data |

The picker warns on the first two, live, as the user edits: "Dr X has no
Wednesday PM session — this note will not appear for them". The window case is
an accepted blind spot; adding `doctor_window` data to `StagingOut` for it is
not worth the payload.

Leave is **not** a suppressor — `phase2.py` builds the slot with
`is_on_leave=True`, so a note on a doctor on leave still appears. That is the
right behaviour for a meeting and is deliberate, not an oversight.

Warning only, never a block: the user may be about to add that session on the
same screen. Phase 2 itself is unchanged.

### D6. Resolved open questions

- **Un-ticking a picked meeting** shows a confirm dialog **only when the
  instance has diverged** from the definition it came from (text, day, period,
  week, or doctor set differ). An untouched pick is removed silently. The
  rejected alternative — edited instances survive as unlinked one-offs — leaves
  orphans the user then has to hunt down.
- **Free-form one-off notes are in scope**, same dialog, `source_note_id = NULL`.
  Without them the library accumulates junk definitions created for single runs.
- **A definition keeps required day/period defaults.** Nullable defaults would
  mean a nullable column, a conditional validator and a "you must pick a day"
  state in the dialog, for no gain.
- **The picker defaults to nothing ticked.** Meetings are the exception.

### D7. Two things that need no work

- **Audit logging** is middleware-based (`api/audit.py` intercepts every
  non-safe method), so the new write endpoints are covered with no change.
- **The authorization sweep** (`tests/test_api/test_authorization.py`)
  enumerates routes off the OpenAPI schema, and `/staging` is already mapped to
  the `clinical` area in `_AREA_FOR_PREFIX`. New routes under that prefix are
  swept automatically; the prefix-set assertion does not change.

---

## Task 1: Data model and migration

**A. State of the world.** Nothing has been done yet. This task lands the schema
change only; the engine still reads `recurring_note_weeks` after it and the
suite will not be green until Task 2. Land Tasks 1 and 2 together in one PR if
CI-green-per-commit matters.

**B. Files and deliverables.**

- `backend/app/models/recurring_note.py` — delete `RecurringNoteWeek` and
  `RecurringNote.weeks`; add `RotaConfigNote` and `RotaConfigNoteDoctor`;
  rewrite the module docstring.
- `backend/app/models/rota.py` — add the `RotaConfig.notes` relationship (note the
  cross-module reference to `RotaConfigNote`, which lives in `recurring_note.py`).
- `backend/app/models/staging.py` — strip the recurring-note justification from
  the `source_template_start_week` docstring paragraph; keep the column.
- `backend/app/models/__init__.py` — drop `RecurringNoteWeek` from the import
  and `__all__`, add the two new classes to both.
- `backend/alembic/versions/012_recurring_note_instances.py` — new.
- `backend/tests/test_models.py` — replace the `RecurringNoteWeek` tests.

**C. Instructions.**

1. Delete `RecurringNoteWeek` and the `weeks` relationship on `RecurringNote`.
   Leave `RecurringNote`, `RecurringNoteDoctor` and their constraints otherwise
   untouched — they are now the *definition* (default day, period, doctors).
2. Add:

   ```python
   class RotaConfigNote(Base):
       __tablename__ = "rota_config_notes"
       __table_args__ = (CheckConstraint("week BETWEEN 1 AND 4", name="ck_rcn_week"),)

       id: Mapped[int] = mapped_column(primary_key=True)
       config_id: Mapped[int] = mapped_column(ForeignKey("rota_configs.id"), nullable=False)
       source_note_id: Mapped[int | None] = mapped_column(
           ForeignKey("recurring_notes.id"), nullable=True
       )
       text: Mapped[str] = mapped_column(String(200), nullable=False)
       week: Mapped[int] = mapped_column(Integer, nullable=False)
       day: Mapped[Day] = mapped_column(enum_col(Day), nullable=False)
       period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)

       doctors: Mapped[list["RotaConfigNoteDoctor"]] = relationship(
           back_populates="note", cascade="all, delete-orphan"
       )
   ```

   `RotaConfigNoteDoctor` mirrors `RecurringNoteDoctor` exactly, with
   `config_note_id` in place of `note_id` and
   `UniqueConstraint("config_note_id", "doctor_id", name="uq_rcnd_note_doctor")`.
   Index `config_id` — the engine's only query filters on it.

3. **Add the cascade on `RotaConfig`** — this is load-bearing, not tidiness:

   ```python
   notes: Mapped[list["RotaConfigNote"]] = relationship(
       cascade="all, delete-orphan"
   )
   ```

   `routers/staging.py::abandon_staging` hard-deletes the staging *and* its
   `RotaConfig`. Without this relationship, abandoning a staging that has any
   picked note raises an `IntegrityError` on the config delete. Adding a
   relationship rather than an explicit delete in the router matches how every
   other parent/child pair in this schema works; there is still no DB-level
   `ON DELETE CASCADE` anywhere and none is being introduced.

4. Migration `012` (`revises = "011"`): create both tables, drop
   `recurring_note_weeks`. Downgrade recreates `recurring_note_weeks` (with its
   `ck_rnw_week` check and `uq_rnw_note_week` unique constraint) empty and drops
   the two new tables. Follow `011`'s docstring convention — explain what the
   tables are for and why there is no backfill. Only Postgres runs migrations;
   the test suite builds SQLite from the models via `create_all`.

5. `tests/test_models.py`: delete the `RecurringNoteWeek` tests, and add
   round-trip tests for the two new tables, the `week` check constraint, the
   `(config_note_id, doctor_id)` unique constraint, and — the one that matters —
   **deleting a `RotaConfig` deletes its notes and their doctor rows**.

---

## Task 2: Engine

**A. State of the world.** Task 1 is complete: `recurring_note_weeks` is gone
and `rota_config_notes` / `rota_config_note_doctors` exist. The engine still
references the dropped table and is broken until this task lands.

**B. Files and deliverables.**

- `backend/app/engine/context.py` — delete `_effective_template_start_week()`;
  rewrite `_load_recurring_notes()`.
- `backend/tests/test_engine/factories.py` — replace the recurring-note factory.
- `backend/tests/test_engine/test_recurring_notes.py` — rewrite.
- `backend/tests/test_engine/test_context.py`, `test_phase2.py` — fix any
  fallout.

**C. Instructions.**

1. Delete `_effective_template_start_week()` entirely. `load_context()` is its
   only caller. Do **not** touch `week_map.template_week()` — phase0, phase2,
   `grid_utils` and `routers/staging.py` all still use it.
2. Rewrite `_load_recurring_notes(db, config)` (the `start_week` parameter goes)
   as a flat query over the new tables:

   ```python
   notes = db.execute(
       select(RotaConfigNote)
       .where(RotaConfigNote.config_id == config.id)
       .options(selectinload(RotaConfigNote.doctors))
       .order_by(RotaConfigNote.id.asc())
   ).scalars().all()
   ```

   Then for each note, for each associated doctor, append `note.text` under the
   key `(doctor_id, note.week, note.day, note.period)`, and join with `"\n"` as
   today. No week mapping, no `is_active` filter (an instance is a copy — the
   definition's active flag is irrelevant once picked), no `num_weeks` loop.
   Keep the existing "doctor-active status is deliberately not checked here"
   reasoning in the docstring; it still holds.
3. `GenerationContext.recurring_notes_by_slot` keeps its key shape
   `(doctor_id, gen_week, day, period)` and its `str` values, so `phase2.py` is
   untouched. Verify this rather than assuming it.
4. `factories.py`: replace the note factory with one that writes a
   `RotaConfigNote` + doctor rows for a given config. Keep a definition factory
   too — Task 3's API tests need one.
5. `test_recurring_notes.py`: delete
   `test_staged_run_resolves_weeks_against_source_template_start_week` and every
   other template-week case; they test behaviour that no longer exists. Keep and
   re-point: single note stamps the right slot, overlapping notes concatenate in
   ascending id order, a note for a doctor with no template row is a silent
   no-op, a note on a different config is not picked up. Add: a note whose
   `week` exceeds `config.num_weeks` is simply never looked up (a dead key, not
   an error).

---

## Task 3: API

**A. State of the world.** Tasks 1-2 are complete: the schema and the engine
read per-run notes off `rota_config_notes`. Nothing writes them yet, and
`/recurring-notes` still accepts and returns `template_weeks` against a dropped
table.

**B. Files and deliverables.**

- `backend/app/api/schemas/recurring_note.py` — drop `template_weeks` from
  `RecurringNoteIn`/`Out` and its validator.
- `backend/app/api/schemas/staging.py` — add `StagingNoteIn`, `StagingNotePatchIn`,
  `StagingNoteOut`; add `notes` to `StagingOut`.
- `backend/app/api/schemas/__init__.py` — export the three new schemas.
- `backend/app/api/routers/recurring_notes.py` — drop the weeks half of
  `_apply()`; null `source_note_id` on delete.
- `backend/app/api/routers/staging.py` — four endpoints and `_staging_out()`.
- `backend/tests/test_api/test_recurring_notes.py`, `test_staging.py`.

**C. Instructions.**

1. **Definitions.** Remove `template_weeks` from both schemas, its validator,
   and `RecurringNoteOut.from_orm_note()`. In `_apply()`, remove `note.weeks`
   from the clear-and-flush step and the reassignment — the flush is still
   needed for `doctors`, for the reason the module docstring gives. In
   `delete_recurring_note`, before `db.delete(note)`, null the provenance:

   ```python
   db.execute(
       update(RotaConfigNote)
       .where(RotaConfigNote.source_note_id == note_id)
       .values(source_note_id=None)
   )
   ```

   Without it the FK blocks the delete.
2. **`StagingNoteOut`**: `id`, `source_note_id`, `text`, `week`, `day`,
   `period`, `doctor_ids` (sorted ascending). Same `from_orm_note()` classmethod
   pattern `RecurringNoteOut` uses, for the same reason — the ORM relationship
   is a list of child rows, not a flat id list.
3. **`StagingOut.notes: list[StagingNoteOut]`**, ordered by id ascending, built
   in `_staging_out()` off `staging.config_id`. Every staging write endpoint
   already returns `StagingOut`, so the picker refreshes for free.
4. **New endpoints**, all under the existing `/staging/{staging_id}` prefix so
   they inherit `_staging_or_404()` and `_require_active()`:
   - `POST /staging/{staging_id}/notes` → `StagingOut`, 201. Body
     `StagingNoteIn`: `text`, `day`, `period`, `week`, `doctor_ids`,
     `source_note_id: int | None`. Accept a **list** of weeks?  No — one note
     per call; the frontend loops for the D4 multi-week tick, which keeps the
     endpoint and its validation single-shaped.
   - `PATCH /staging/{staging_id}/notes/{note_id}` → `StagingOut`. Full replace
     of the same fields except `source_note_id`, which is immutable after
     creation.
   - `DELETE /staging/{staging_id}/notes/{note_id}` → 204.
   - No `GET` — `StagingOut` carries them.
5. **Validation**, in this order, each a distinct message:
   - `text` stripped, 1-200 chars; `doctor_ids` non-empty and duplicate-free
     (Pydantic, copied from `RecurringNoteIn`).
   - `week` bounded `1..4` in the schema **and** `<= config.num_weeks` in the
     router, 422 naming the run's week count. The schema bound is necessary but
     not sufficient — see D4 and `StagingSessionCreateIn`'s identical case.
   - Doctor existence and active check: **extract
     `recurring_notes.py::_validate_doctor_ids` to a shared helper** rather than
     copying it, and have both routers call it.
   - `source_note_id`, when not null, must name an existing `RecurringNote`;
     422 otherwise. It is not required to be active — a definition may be
     deactivated between page load and submit, and rejecting that would be a
     confusing failure for a copy operation.
   - A note whose `note.config_id != staging.config_id` 404s on PATCH/DELETE.
6. Tests in `test_api/test_staging.py`: create/patch/delete round-trips, the
   `week > num_weeks` 422, the missing/inactive-doctor 422, the bad
   `source_note_id` 422, the cross-staging 404, `_require_active` 409 on a
   completed staging, and **abandon-with-notes returns 204 and leaves no
   orphaned rows** (the Task 1 cascade — assert it from the API, not just the
   model). In `test_recurring_notes.py`: deleting a definition that has been
   picked leaves the instance with `source_note_id = None`.

---

## Task 4: Definitions page

**A. State of the world.** Tasks 1-3 are complete. The API no longer accepts or
returns `template_weeks`, so `RecurringNotesPage` is sending a field the backend
422s on.

**B. Files and deliverables.**

- `frontend/src/api/types.ts` — drop `template_weeks` from `RecurringNote` and
  `RecurringNoteIn`; add `StagingNote`, `StagingNoteIn` and `notes` on `Staging`
  (Task 5 needs them, but the types belong with the rest of the interfaces).
- `frontend/src/routes/RecurringNotesPage.tsx` — strip the weeks UI.
- `frontend/src/routes/RecurringNotesPage.test.tsx` — update.

**C. Instructions.**

1. Delete the `WEEKS` constant, `formatWeeks()`, the weeks checkbox group in the
   dialog, the weeks column in the table, and `template_weeks` from the form
   state and submit payload.
2. Retitle the page and its intro copy: this is a **library of meetings** with
   default day, period and doctors. It schedules nothing; a meeting appears on a
   rota only when it is ticked on the staging page for that run. Say that in one
   sentence on the page — otherwise the page reads exactly as it did when it
   *did* schedule things, and that is the single most likely source of user
   confusion from this change.
3. Update the tests: remove the weeks assertions, assert the new copy exists.

---

## Task 5: Staging picker

**A. State of the world.** Tasks 1-4 are complete. The backend serves
`StagingOut.notes` and the three write endpoints; the definitions page is a
library. Nothing in the UI picks a meeting yet — this task is the whole user-
facing feature.

**B. Files and deliverables.**

- `frontend/src/api/stagingNotes.ts` — new hooks.
- `frontend/src/components/StagingNotesPanel.tsx` — new.
- `frontend/src/components/StagingNotesPanel.test.tsx` — new.
- `frontend/src/routes/StagingPage.tsx` — mount the panel.
- `frontend/src/test/fixtures/staging.ts` — `notes: []` on `makeStaging`, plus a
  `makeStagingNote` factory.
- `frontend/src/test/msw/handlers.ts` — handlers for the three endpoints.

**C. Instructions.**

1. `stagingNotes.ts`: `useCreateStagingNote`, `useUpdateStagingNote`,
   `useDeleteStagingNote`, following `staging.ts`'s existing shape and
   invalidating `stagingKeys.active()`. No list hook — the notes come down on
   `StagingOut`.
2. `StagingNotesPanel`, mounted between the header buttons and `StagingGrid` on
   `StagingPage`, sourcing definitions from `useRecurringNotes()` and instances
   from `staging.notes`:
   - **Tick-list** of active definitions (inactive ones are not offered). A
     definition is shown ticked when any instance has that `source_note_id`.
     Ticking copies text/day/period/doctors from the definition. On a run with
     `num_weeks > 1` the tick first opens a week checkbox group defaulting to
     week 1 only, and creates one instance per ticked week (D4); on a 1-week run
     it creates one week-1 instance with no prompt.
   - **Un-ticking** deletes that definition's instances. If any of them has
     diverged from the definition (text, day, period or doctor set differ, or
     more than one week is present), confirm first (D6).
   - **Instance list** with an edit dialog: text, day, period, doctors, and week
     when `num_weeks > 1`. Show "from: <definition text>" when `source_note_id`
     is set. Editing never writes back to the definition.
   - **"Add a one-off note"** opens the same dialog with empty defaults and
     posts `source_note_id: null`.
   - **D5 warning**, computed live from `staging.sessions` and
     `staging.closed_slots` for every instance: name each doctor with no staged
     session at that week/day/period, and say so if the slot's date is closed.
     Warning text only — never disable the save. Do not attempt the
     employment-window case; it is not in the payload.
   - Everything write-gated with `useWriteGate()`, like the rest of the page.
3. Tests: tick creates an instance; tick on a 4-week run with weeks 1 and 3
   ticked fires two POSTs; un-tick of an edited instance confirms first and of
   an untouched one does not; editing an instance does not touch
   `/recurring-notes`; the warning appears for a doctor with no matching staged
   session and disappears once one exists; the one-off add posts a null
   `source_note_id`; read-only permissions disable every control.

---

## Task 6: Review and documentation

**A. State of the world.** Tasks 1-5 are complete and the feature is live. This
task is review and documentation only — no behaviour changes.

**B. Files and deliverables.**

- `documentation/architecture-clinical.md` — five edits, listed below.
- `documentation/recurring_notes_picker_plan.md` — delete.

**C. Instructions.**

1. Rewrite the **"Recurring notes"** section: definitions are a library of
   meetings with default day/period/doctors and no weeks; a run's notes are
   per-`RotaConfig` copies created by ticking on the staging page; a copy never
   re-reads its definition and `source_note_id` is provenance only. Carry over
   D2's honest lifetime statement — notes die with a scrapped draft, like every
   other staged edit — and **do not** write that scrap-and-regenerate re-stamps
   them.
2. Fix the line stating there is "deliberately no 'no rows means every week'
   shorthand in `recurring_note_weeks`" — that table no longer exists.
3. Update the endpoint table: revise the `/recurring-notes` row (no more weeks)
   and add the `/staging/{id}/notes` writes.
4. Strip the recurring-note justification from the paragraph explaining
   `RotaStaging.source_template_start_week`; the column stays as provenance,
   but nothing reads it any more. Check `models/staging.py`'s docstring was
   fixed in Task 1 and say so here if not.
5. Update the `GenerationContext` bullet (`recurring_notes_by_slot` is now a
   flat per-config lookup with no week mapping) and the `RecurringNotesPage`
   line, and add `StagingNotesPanel` alongside `StagingGrid` in the staging
   frontend section.
6. Record D5's blind spot (employment window) and D4's per-run multi-week tick
   as decisions, so neither is rediscovered as a bug.
7. Delete this plan file.
