# Provisional Plan — Master template bulk row operations ("copy week 1 to weeks 2–4")

Status: provisional. Discussion output only — to be reviewed and expanded into an
implementation plan in a fresh chat, then broken into tasks.

## Scope

One operation, on two surfaces:

- **Master Rota** (`/master-rota`, `api/routers/master_rota.py`) — all doctor rows.
- **Nurse Rota** (`/nurse-rota`, `api/routers/nurse_rota.py`) — nurse rows only. This is
  the motivating case: it shipped with no bulk entry path, so a nurse's pattern is
  4 × 5 × 2 cells typed by hand.

**Out of scope, deliberately:**

- **Staging.** Its grid mirrors the master rota's write contract, so the endpoint would
  clone cleanly, but a staging is a short one-off range whose recovery path is
  abandon-and-restart, and it has no undo for the same reason. Nothing in the ticket's
  evidence points at it. Add later if it is actually missed.
- **Reception master template.** Separate domain, separate schema, its own weekday
  template shape. A different ticket.
- **Whole-grid copy** ("copy everyone's week 1 into weeks 2–4"). Week-to-week variation
  is real data — CL is D1 on Thursday in weeks 1/3 and W1 in weeks 2/4 — so a
  whole-grid copy would flatten deliberate variation in one click. The endpoint below is
  per-doctor; a whole-grid variant is N calls or a later server-side loop over the same
  primitive, not a rewrite.

## Design Decisions

### 1. One general endpoint, not a `copy-week` verb

`PUT /master-rota/templates/{template_id}/doctors/{doctor_id}/weeks`

Body: `{ "weeks": [2, 3, 4], "sessions": [{week, day, period, session_type, room_id}, ...] }`

It is a **verbatim replace of one doctor's rows across a named set of weeks**: after the
call, that doctor's rows in those weeks are exactly `sessions`. Rows present in `weeks`
and absent from `sessions` are deleted; listed rows are updated in place where the slot
already exists and inserted where it does not.

Three reasons this shape rather than `POST .../copy-week {source_week, target_weeks}`:

- **It is the same philosophy the entire write surface is built on.** PATCH is a verbatim
  `(session_type, room_id)` pair setter and `set-role` a verbatim triple setter,
  specifically so that undo replay is another call of the same shape. A bulk verbatim
  writer extends that; a `copy-week` verb does not, and would need a second
  `restore-weeks` endpoint to be undoable — two endpoints either way, and the second one
  would only ever be called by undo.
- **Undo is then exact and atomic.** The page captures the doctor's current rows for the
  target weeks from the cache it already holds, and undo is one PUT with that list. No
  N-call replay loop, no partial-failure window.
- **It is the primitive for the other two bulk ops in the same ticket.** "Populate a new
  doctor's full week" is `weeks: [1,2,3,4]` with a full list; "remove all of a leaver's
  sessions" is `weeks: [1,2,3,4]` with `sessions: []`. Neither needs new backend work.

The cost, recorded because it is real: the **audit row is weaker**. `copy-week` would
record intent ("copied week 1 to weeks 2–4 for CH"); this records a row-set write. The
description in `audit_descriptions.py` therefore has to be honest about that ("replaced a
doctor's sessions across one or more template weeks"), and it is still a large improvement
on the 40 single-cell rows the operation would otherwise produce.

**Copy semantics live on the frontend.** The client already holds every row of the
template, so "week 1 → weeks 2–4" is a pure derivation over cached data: take the source
week's rows, re-stamp `week`, submit. The dialog needs that derived list anyway to render
its preview, so computing it server-side would mean computing it twice.

### 2. Nurse mirror: `PUT /nurse-rota/doctors/{doctor_id}/weeks`

No `template_id` in the path, as with every other nurse endpoint — the router resolves the
active template itself. It keeps that router's three existing rules unchanged:

- target doctor must be a `NURSE`, 404 otherwise;
- `session_type` restricted to `pre_assigned` / `admin_time` / `no_surgery` on the Pydantic
  model, 422 otherwise;
- a room held in a target slot by a **non-nurse** refuses with 409 naming the holder,
  rather than displacing.

**Named edge case, needs a decision at implementation-plan stage.** A nurse's source week
can contain a `requires_room` or `wfh` row, because the Master Rota is a permissive
verbatim writer over the same table and can write either onto a nurse row. Copying such a
week through the nurse endpoint would 422 the whole call. The page already has a precedent
for exactly this state: a forward edit whose previous state was `requires_room` or `wfh`
**clears the undo stack** rather than offering an undo that cannot run. The consistent
answer is the same honesty here — the dialog **refuses up front**, naming the offending
cells and saying they must be fixed on the Master Rota first, rather than silently
converting them to `requires_room`'s nearest legal neighbour. Alternative considered and
rejected: coerce to `admin_time`, which would quietly change what the rota says.

### 3. Replace the target week, and say so before doing it

The target week ends up matching the source week exactly. "Fill only empty cells" was
rejected: it leaves the target week matching neither the source nor its prior state, which
is not what anybody means by copy. "Refuse unless empty" was rejected: it makes the
new-doctor case work and the fix-up-an-existing-pattern case impossible.

Because it destroys rows, the dialog is a **preview and confirm**, not a bare button. See
§5.

### 4. Room clashes: preview them, then apply the existing displacement rule

A copied `pre_assigned` row carries a `room_id`, and that room may be held in the target
week by somebody else. The master rota's existing rule is silent displacement — holder's
`room_id` cleared, a displaced `pre_assigned` becoming `requires_room`. A bulk call can
fire that rule up to ten times, which is far too much to do silently.

So: **the dialog lists every displacement before it happens** (which room, taken from
whom, in which week and slot), computed client-side. There is a direct precedent —
`MasterRotaConflictsPanel` is deliberately client-side with no endpoint of its own,
recomputed from the session list the page already holds, and `findMasterRoomHolder` is
already the lookup. On the nurse surface the same preview is computed from the
`occupancy` list `GET /nurse-rota/active` already returns, via `occupancy.ts`'s
`findSlotHolder`, and a non-nurse holder is shown as a **blocker** rather than a
displacement, because the endpoint will 409 rather than displace.

Confirming applies the normal rule. The response returns every displaced row so the cache
and the toast are honest ("Week 1 copied to weeks 2–4 — 3 sessions displaced"). The
server's 409 for a non-nurse holder stays as the backstop it already is for single-cell
edits, not the normal path.

### 5. Ordering inside the transaction — the one non-obvious implementation rule

**Deletes and overwrites are applied before displacement is looked up.** Otherwise a room
the same call is freeing (the doctor's own old row in the target week, being replaced)
reads as an occupied clash, and the call would displace a row that is about to cease to
exist. Concretely: resolve the target row set, delete the leftovers and flush, then upsert
the new rows, looking up holders only against what remains — and exclude the rows this
call is itself writing. `uq_mrs_slot` makes the flush ordering load-bearing rather than
stylistic.

One transaction, one commit, all-or-nothing.

### 6. Undo inverts the page's displaced-first ordering, and that is correct

Every existing replay on this page restores the displaced side *first* — restore what was
stolen before undoing the action that stole it. **The bulk entry is the opposite: the bulk
write goes first, then the displaced rows are restored.** The reason is that the bulk write
is itself what releases the stolen rooms. Restoring a displaced holder first would put them
back into a room the copied row still occupies, and the bulk write that follows could then
displace them a second time if the doctor's *prior* row held that same room. Writing the
prior rows first frees the rooms, and the restores that follow then find them empty.

This contradicts a stated convention in `masterUndo.ts`, so it has to be commented at the
new branch rather than left to be "tidied up" into consistency later.

### 7. No new permission, no new lock wiring

`require_edit_lock` and `require_access` are both applied at `include_router` time in
`main.py`, so a new endpoint on either existing router inherits its area gate and its lock
with no edit. `clinical: write` covers the master endpoint, `nurse_rota: write` the nurse
one, exactly as the single-cell writes are covered. The one thing that is **not**
automatic is `audit_descriptions.py`, which needs a line per new route or
`test_audit_descriptions.py` fails.

## Open questions for the review chat

1. **Does the nurse surface ship in the same PR as the master one, or immediately after?**
   Recommendation: same plan, separate tasks — the nurse one is the motivating case, and
   splitting the PR means the motivating case waits on nothing.
2. **`PUT` or `POST`?** The operation is idempotent and addresses a resource ("this
   doctor's rows in these weeks"), so `PUT` is right. Worth confirming nothing in
   `test_authorization.py`'s sweeps or `AuditMiddleware` assumes the API has no PUTs —
   the surface is currently GET/POST/PATCH/DELETE only.
3. **Does the preview need a "don't take anyone's room" option** — copy clashing cells as
   `requires_room` instead of displacing? Recommendation: no, not in v1. It is a second
   semantics to explain in a dialog that already has to explain replacement and
   displacement, and the user can decline, fix, and retry.
4. **Should the dialog offer "copy to all other weeks" as one click** as well as
   per-week checkboxes? Recommendation: yes — it is the named use case, and it is a
   default, not a second mode.

## Provisional task breakdown

Sketch only; the review chat sets the real boundaries.

1. **Backend, master rota.** Schemas (`MasterWeeksReplaceIn` and its response, reusing
   `MasterSessionPairIn`'s room/type validator and adding a "every session's `week` is in
   `weeks`" validator), the `PUT` endpoint, the ordering rule in §5,
   `audit_descriptions.py`, tests in `tests/test_api/test_master_rota.py`.
2. **Backend, nurse rota.** The mirror, reusing the master helpers as
   `nurse_rota.py` already reuses `_find_room_holder` and `_session_outs`; the three nurse
   rules; `audit_descriptions.py`; tests in `tests/test_api/test_nurse_rota.py`.
3. **Frontend shared pieces.** The copy derivation and preview computation (a new
   `lib/` module with unit tests — derive rows, find displacements, find blockers), and a
   presentational `components/CopyWeekDialog.tsx` taking a computed preview plus
   `onConfirm`. Shared rather than cloned: it renders week checkboxes and a preview list
   and holds no domain logic, which is the opposite of the
   `MasterCellEditPopover`/`NurseCellEditPopover` case, where the domain logic *was* the
   component. Nurse already imports `@/components/Toast`, so this crosses no boundary.
4. **Frontend, Master Rota.** The bulk mutation hook and its cache operation (replace all
   cached rows for `(doctor, weeks)` with the response set, then splice displaced — a
   third cache shape alongside splice and append), the `"bulk-weeks"` undo entry and its
   replay branch with the §6 ordering, the per-row trigger in the grid's sticky doctor
   cell, toast text.
5. **Frontend, Nurse Rota.** The same against `features/nurseRota/`, with the
   occupancy-based preview and the §2 refusal.
6. **Review and documentation.** Update `architecture-clinical.md` ("Master rota write
   surface", "Frontend: Master Rota", and the "Bulk entry does not exist" paragraph under
   "Nurse Rota", which becomes false), drop the "Master rota bulk row operations" row from
   `architecture.md`'s Outstanding Tasks if all three ops are covered — or narrow it to
   what is left — remove the bullet from `planned_updates.md`, and delete this plan.
