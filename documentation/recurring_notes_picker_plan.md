# Provisional plan: recurring notes become a pickable, per-run meeting list

Status: **provisional** (workflow step 1). To be reviewed and expanded into an
implementation plan before any code is written.

## Problem

Recurring notes today are defined against a set of *template* weeks (1-4) and
fire automatically on every matching week of every run. In practice meetings
move constantly for leave and other commitments, so the fortnightly stamp is
wrong more often than it is right, and the only way to correct it is to edit
the note text cell-by-cell on the generated draft grid.

## Desired behaviour

1. A recurring note is defined once as a **named meeting** ("Significant events
   meeting") with a default day, period and doctor list — **no template weeks**.
2. When generating a rota, the user picks which of those meetings apply to this
   run, from a tick-list.
3. A picked meeting can be edited **for that run only** (day, period, doctors,
   text, and which week of a multi-week run) without touching the definition.
4. The definitions page stays the library; it no longer schedules anything.

## Scope

In scope: `recurring_notes` model + schemas + router, a new per-run note table,
`engine/context.py` note resolution, the definitions page, the picker/editor UI,
migration, tests, architecture docs.

Out of scope: the draft-grid note editing that already exists (unchanged);
reception rota (unrelated); any change to how notes affect availability (they
still do not — annotation only).

## Design decisions

### D1. Which screen the picker lives on — **the staging page**, not the generate form

The ask says "it appears on the generate rota page", but the real flow is
`RotaPage` (choose dates → *Start staging*) → `StagingPage` (one-off edits) →
*Complete and generate*. The staging page is the right home:

- The picker needs a persisted parent to hang edits off. No `RotaConfig` exists
  until staging is created, so a tick on `RotaPage` would have to be carried in
  the create-staging payload as unsaved state, and "edit afterwards" would still
  need a second surface — which is the staging page anyway.
- Staging is already, by definition, the "changes here apply to this rota only"
  step. That is exactly the semantics of requirement 5.
- The staging page knows which doctors actually have a session in the chosen
  slot, so it can warn (see D5). `RotaPage` does not.

Worth flagging honestly: the clinic tick-boxes on `RotaPage` that the ask
compares this to are **not** per-run — they PATCH `clinic_types.is_enabled`
globally. So that analogy would not, in fact, give per-run behaviour.

Cost: one extra click, and the meeting list is one screen later than imagined.
If that matters, an optional follow-up is a read-only "meetings that will be
offered" hint on the generate form. Not recommended for the first cut.

### D2. Per-run notes attach to `RotaConfig`, not to `RotaStaging`

Both generation paths (`POST /rota/generate` and staging-complete) create a
`RotaConfig`, and `load_context()` is already keyed on it. Attaching there keeps
the engine lookup path single and means a scrap-and-regenerate re-stamps the
same notes. `POST /rota/generate` is API-only (the UI never calls it) and would
simply carry no notes — a documented no-op, not a regression.

The write endpoints still live under `/staging/{id}/notes` so they inherit the
active-staging guard; they write rows against `staging.config_id`.

### D3. New tables; `recurring_note_weeks` is deleted outright

```
recurring_notes           text, day, period, is_active   (unchanged — now DEFAULTS)
recurring_note_doctors    unchanged (default doctor list)
recurring_note_weeks      DROPPED

rota_config_notes
  id, config_id FK -> rota_configs
  source_note_id FK -> recurring_notes, NULLABLE (provenance only)
  text (200), week (1-4, GENERATION week), day, period
rota_config_note_doctors
  id, config_note_id FK, doctor_id FK, unique(config_note_id, doctor_id)
```

`source_note_id` is provenance, not a live link: the instance copies text/day/
period/doctors at pick time and never re-reads the definition. It exists so the
UI can tick the right boxes and show "from: Significant events meeting".
Deleting a definition nulls it in the router (there is no DB-level cascade
anywhere in this schema) and leaves the instance intact.

No cross-note uniqueness, same as today — overlapping notes on one slot
concatenate newline-joined in ascending id order.

The system is not live, so this is a plain destructive migration with no
backfill.

### D4. `week` is a **generation** week, defaulting to 1

Template-week anchoring is the thing being removed, so `template_week()` and
`_effective_template_start_week()` drop out of the note path entirely. On a
1-week run (the common case) the week selector is hidden and every instance is
week 1. On a 2- or 4-week run, ticking a meeting creates **one** instance in
week 1 and the user moves it or adds a second — no automatic repetition. That
is the whole point of the change.

Consequence: `engine/context.py::_effective_template_start_week()` and its read
of `RotaStaging.source_template_start_week` become dead and should be deleted.
Keep the column itself (cheap provenance of what the staging copied from), but
drop the docstring paragraphs that justify it via recurring notes.

### D5. Silent no-op becomes a visible warning

Phase 2 builds no `SessionSlot` where the doctor has no staged row for that
slot, so a note aimed at a doctor with no Wednesday PM session vanishes with no
warning. That is tolerable for a background stamp; it is not tolerable when the
user has just explicitly ticked "Significant events meeting, Wednesday PM" for
five named doctors. The staging page holds the full staged session list, so the
picker should show, live, "Dr X has no Wednesday PM session — this note will not
appear for them". Warning only, never a block — the user may be about to add
that session on the same screen.

Phase 2 itself stays unchanged.

## Open questions for the review chat

- **Q1.** Confirm D1 (picker on the staging page). If the picker really must be
  on the generate form, the alternative is: tick-list on `RotaPage` → selections
  travel in the create-staging payload → editing still happens on the staging
  page. Doable, more UI, same end state.
- **Q2.** Should un-ticking a meeting that has been *edited* warn before
  discarding the edits, or should edited instances become "unlinked" one-off
  notes that must be deleted explicitly? (Suggest: simple confirm dialog.)
- **Q3.** Do we want free-form one-off notes ("add a note not in the library")
  on the same panel? The table supports it for free; it is UI cost only.
  (Suggest: yes, it is a few lines and removes the temptation to create junk
  definitions.)
- **Q4.** Should a definition be able to have *no* default day/period (pick at
  use time)? (Suggest: no — keep them required defaults, simpler everywhere.)
- **Q5.** Should the picker default to all active definitions ticked, or none?
  (Suggest: none — the premise is that meetings are the exception, not the rule.)

## Task outline (to be expanded)

- **Task 1 — Data model.** Drop `RecurringNoteWeek`; add `RotaConfigNote` and
  `RotaConfigNoteDoctor`; alembic `012`; update `models/__init__.py` and
  `tests/test_models.py`.
- **Task 2 — Engine.** Rewrite `_load_recurring_notes()` as a `config_id`
  lookup over the new tables; delete `_effective_template_start_week()`; keep
  `phase2.py` and `GenerationContext.recurring_notes_by_slot`'s key shape
  unchanged. Update `tests/test_engine/test_recurring_notes.py` and
  `factories.py`.
- **Task 3 — API.** Remove `template_weeks` from `RecurringNoteIn/Out` and the
  router's replace-children step; null `source_note_id` on definition delete;
  add `GET`(embedded in `StagingOut`)/`POST`/`PATCH`/`DELETE`
  `/staging/{id}/notes` with doctor existence+active validation reused from
  `recurring_notes.py`; tests in `test_api/`.
- **Task 4 — Definitions page.** Strip the weeks checkbox group and the
  `formatWeeks` column from `RecurringNotesPage.tsx`; retitle the page as a
  library of meetings; update its tests and `api/types.ts`.
- **Task 5 — Staging picker.** New panel on `StagingPage.tsx`: tick-list of
  active definitions, list of picked instances with an edit dialog (text, day,
  period, week when `num_weeks > 1`, doctors), the D5 warning, optional one-off
  add. New `api/stagingNotes.ts` + msw handlers + tests.
- **Task 6 — Review and documentation.** Update `architecture-clinical.md`
  (the "Recurring notes" section, the `GenerationContext` bullet, the endpoint
  table, the staging paragraph's `source_template_start_week` justification,
  and the `RecurringNotesPage` line), then delete this plan.
