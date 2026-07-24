

# Plan: Recurring Notes

## Scope

A new "Recurring Notes" tab, independent of the Master Rota template, where you define a note ("Partners meeting") tied to a day + period, and an explicit list of one or more doctors it applies to. At generation, any matching doctor/day/period combination gets that text stamped into `RotaSession.notes` as a starting value — same as today, you can still edit or clear it afterward on the draft grid.

This confirms your original instinct that a separate tab is the right shape, given multi-doctor notes need to be supported: the Master Rota grid has no unit that represents "several doctors, one note" — each cell belongs to exactly one doctor, so a practice-wide note would otherwise have to be typed onto every partner's cell separately and re-typed by hand whenever the partner list changes.

## Design Decisions

1. **New standalone entity, not a MasterRotaSession field.** `RecurringNote` (text, day, period, active) plus an association table to doctors. Decoupled from the template on purpose — it recurs by day-of-week every generation week, not by template week 1–4, so tying it to a template cell would be the wrong recurrence unit anyway.

2. **Doctor scope is an explicit, editable list — not role-based.** You tick the doctors it applies to (e.g. the current partners) rather than "all doctors of type Partner." Simpler and predictable for v1; the cost is a manual tick when a new partner joins. Flagging this because it's a real trade-off, not a settled decision — say if you'd rather have it follow doctor type automatically.

3. **Applied once, at generation time, inside Phase 2's grid build** — the exact place `SessionSlot.notes` already exists as a field but is currently never set by any phase. No new phase, no datatype changes to `SessionSlot`. `GenerationContext` gains one new field (`recurring_notes_by_doctor: dict[(doctor_id, Day, Period), str]`), loaded in `context.py` the same way `leave_set` is.

4. **Stamped as a default only, not re-applied on edit.** Once a rota is generated, the note lives on the `RotaSession` row like any other draft edit. Editing or clearing it afterward behaves exactly as it does today — a recurring note is not "restored" if cleared. Regenerating (scrap + regenerate) re-stamps it fresh, same as everything else in the pipeline.

5. **Open question — doctor on leave that day.** Should the note still be stamped if the doctor is on leave (they won't be at the meeting), or suppressed? I'd default to still stamping it (simplest, consistent with how `is_wfh` doesn't suppress anything either), but this is worth you confirming rather than me assuming.

6. **One recurring note per doctor per (day, period).** Enforced at the API layer (like clinic-priority contiguity and closure de-duplication elsewhere in this codebase), not the DB schema, since the constraint spans two tables (note + doctor association).

7. **No staging-specific code needed.** Staging-born rotas go through the same Phase 2 grid build, so recurring notes apply identically whether the rota came from the live template or a staging branch — consistent with the existing rule that no phase file has staging-specific logic.

## Files touched (indicative — will firm up at implementation-plan stage)

**Backend**
- `backend/app/models/recurring_note.py` — new model + association table
- `backend/alembic/versions/015_recurring_notes.py` — migration
- `backend/app/api/schemas/recurring_note.py`
- `backend/app/api/routers/recurring_notes.py` — CRUD, registered in `main.py`
- `backend/app/engine/datatypes.py` — new `GenerationContext` field
- `backend/app/engine/context.py` — load active recurring notes
- `backend/app/engine/phases/phase2.py` — stamp `slot.notes` at build time
- New/updated tests: router CRUD, `test_phase2` (or a new engine test), possibly `test_engine/factories.py`

**Frontend**
- `frontend/src/api/recurringNotes.ts`
- `frontend/src/routes/RecurringNotesPage.tsx` — list + create/edit dialog (text, day, period, doctor multi-select, active toggle)
- Nav entry in `App.tsx`
- Tests mirroring `ClosuresPage_test.tsx` / `CountersPage_test.tsx`

