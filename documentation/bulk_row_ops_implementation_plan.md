# Implementation Plan — Master template bulk row operations

Reviewed and expanded from `bulk_row_ops_provisional_plan.md`, which this replaces.

## Plan

One new endpoint per surface — a verbatim replace of **one doctor's rows across a named
set of template weeks** — plus one dialog per surface driving it in two modes: **copy a
week into other weeks**, and **clear a set of weeks**.

- `PUT /master-rota/templates/{template_id}/doctors/{doctor_id}/weeks`
- `PUT /nurse-rota/doctors/{doctor_id}/weeks`

Body: `{ "weeks": [2, 3, 4], "sessions": [{week, day, period, session_type, room_id}, …] }`.
After the call, that doctor's rows in those weeks are exactly `sessions`.

## Scope

**In scope**

- Master Rota (`/master-rota`) — all doctor rows.
- Nurse Rota (`/nurse-rota`) — nurse rows only. The motivating case: it shipped with no
  bulk entry path, so a nurse's pattern is 4 × 5 × 2 cells typed by hand.
- Two of the three operations named on the `architecture.md` Outstanding Tasks row:
  **"copy week 1 to weeks 2–4"** and **"remove all of a leaver's sessions"**.

**Out of scope, deliberately**

- **"Populate a new doctor's full week."** Worth stating plainly because the provisional
  plan implied the copy dialog covers it and it does not: a brand-new doctor has no
  source week to copy from, so copy-week gives them nothing. The endpoint is the
  primitive for it (`weeks: [1,2,3,4]` with a full list), but the UI that would compose
  such a list from nothing — a blank-pattern editor — is not built here. The Outstanding
  Tasks row is therefore **narrowed to this one operation, not dropped**.
- **Staging.** Its grid mirrors the master write contract and the endpoint would clone
  cleanly, but a staging is a short one-off range whose recovery path is
  abandon-and-restart, and it has no undo for the same reason. Nothing in the ticket's
  evidence points at it.
- **Reception master template.** Separate domain, separate schema, its own weekday
  template shape. A different ticket.
- **Whole-grid copy** ("copy everyone's week 1 into weeks 2–4"). Week-to-week variation is
  real data, so a whole-grid copy would flatten deliberate variation in one click. The
  endpoint is per-doctor; a whole-grid variant would be N calls over the same primitive.

## Design Decisions

### 1. One general endpoint, not a `copy-week` verb

A verbatim replace, not an intent verb. Rows present in `weeks` and absent from `sessions`
are deleted; listed rows are updated in place where the slot already exists and inserted
where it does not.

Three reasons for this shape:

- **It is the philosophy the whole write surface is built on.** PATCH is a verbatim
  `(session_type, room_id)` pair setter and rota-side `set-role` a verbatim triple setter,
  specifically so undo replay is another call of the same shape. A `copy-week` verb would
  need a second `restore-weeks` endpoint to be undoable — two endpoints either way, and
  the second only ever called by undo.
- **Copy and clear are the same call.** Clear is `sessions: []`. No second endpoint.
- **Undo is expressible.** The page captures the doctor's current rows for the target
  weeks from the cache it already holds, and the bulk half of undo is one PUT with that
  list.

**Correction to the provisional plan:** it claimed undo is "one PUT … no N-call replay
loop, no partial-failure window". That is true only when nothing was displaced. Restoring
displaced rows is a PATCH each, so undo is **1 PUT + N PATCHes** in the general case — the
same shape, and the same partial-failure exposure, as the existing single-cell undos
(§6). The endpoint choice still stands; the claim it was justified with does not.

**Copy semantics live on the frontend.** The client already holds every row of the
template, so "week 1 → weeks 2–4" is a pure derivation over cached data. The dialog needs
that derived list to render its preview anyway, so computing it server-side would compute
it twice.

The **audit row is weaker** than a verb's would be: it records a row-set write, not
"copied week 1 to weeks 2–4 for CH". `audit_descriptions.py` must be honest about that.
It is still a large improvement on the 40 single-cell rows the operation would otherwise
produce, and it is consistent with the coarseness `architecture.md` already accepts for
bulk endpoints. A 40-row body is roughly 4 KB, well inside the middleware's 16 KB body cap,
so the request body itself is captured in full.

### 2. Nurse mirror keeps the router's three rules

`PUT /nurse-rota/doctors/{doctor_id}/weeks` — no `template_id` in the path, as with every
other nurse endpoint; the router resolves the active template itself. Unchanged:

- target doctor must be a `NURSE`, 404 otherwise (`_require_nurse`);
- `session_type` restricted to `pre_assigned` / `admin_time` / `no_surgery` on the Pydantic
  model, 422 otherwise;
- a room held in a target slot by a **non-nurse** refuses with 409 naming the holder
  (`_displace_or_409`), rather than displacing.

Note the write **deletes and overwrites the nurse's own rows only**. It never deletes a
non-nurse row, so the boundary argument in `routers/nurse_rota.py` is unchanged.

**The `requires_room` / `wfh` problem, resolved.** A nurse's rows can hold either type,
because the Master Rota is a permissive verbatim writer over the same table. The
provisional plan treated this as one case; it is two, and they get different answers:

- **Source week** contains `requires_room` or `wfh`: those rows cannot be sent through the
  nurse endpoint, so the dialog **refuses up front**, naming the offending cells and
  saying they must be fixed on the Master Rota first. Coercing them to
  `admin_time` was rejected — it would quietly change what the rota says.
- **Target weeks** contain `requires_room` or `wfh`: the forward call is **allowed**
  (overwriting them is exactly what the user asked for), but the *undo* PUT could not
  restore them, so the page **pushes no undo entry and clears the stack**. This is the
  existing precedent on this page, applied unchanged: `asNurseSessionType` returns null
  and `NurseRotaPage.handleMutationApplied` clears rather than pushes, because leaving the
  previous entry in place would put an enabled Undo button next to an edit it would not
  undo. Refusing the forward operation for this case would be over-strict.

### 3. Replace the target weeks, and say so before doing it

Target weeks end up matching the source week exactly. "Fill only empty cells" was rejected:
it leaves the target matching neither the source nor its prior state, which is not what
anybody means by copy. "Refuse unless empty" was rejected: it makes the fix-up-an-existing-
pattern case impossible. Because it destroys rows, the dialog is **preview and confirm**,
not a bare button.

### 4. Room clashes: preview them, then apply the existing displacement rule

A copied `pre_assigned` row carries a `room_id`, and that room may be held in a target week
by somebody else. The master rule is silent displacement (holder's `room_id` cleared, a
displaced `pre_assigned` becoming `requires_room`). A bulk call can fire that rule up to
ten times per target week, which is far too much to do silently.

The dialog therefore **lists every displacement before it happens** — which room, taken
from whom, in which week and slot — computed client-side. Direct precedent:
`MasterRotaConflictsPanel` is deliberately client-side with no endpoint of its own,
recomputed from the session list the page already holds. On the nurse surface the same
preview comes from the `occupancy` list `GET /nurse-rota/active` already returns, and a
**non-nurse holder is a blocker, not a displacement** — the endpoint 409s rather than
displacing, so Confirm is disabled while any blocker is listed.

Confirming applies the normal rule. The response returns every displaced row so the cache
and the toast are honest ("Week 1 copied to weeks 2–4 — 3 sessions displaced"). The 409
stays the race-condition backstop it already is, not the normal path.

### 5. The self-exclusion rule — corrected

The provisional plan asserted that deletes and overwrites must be applied and flushed
*before* displacement is looked up, or the call would displace a row it is about to
destroy, and called `uq_mrs_slot` "load-bearing" for that ordering. Reading the constraint
and the displacement predicate together, that is not quite right, and getting it right
simplifies the endpoint:

- `uq_mrs_slot` is `(template_id, doctor_id, week, day, period)`, so **a doctor has at most
  one row per slot**, and `_find_room_holder` matches on `(template_id, week, day, period,
  room_id)` — strictly within one slot.
- This call writes **at most one row per slot** (one doctor, one row per
  `(week, day, period)`), so the only row of this doctor's that a holder lookup can collide
  with is the very row being written. Excluding self by id — exactly what PATCH already
  does — is the whole of the rule. There is no cross-slot interaction to order around.
- A leftover row being deleted is, by definition, in a slot this call writes nothing to,
  so it can never be found by a lookup this call performs.

**Therefore: update in place, never delete-and-reinsert the same slot.** Per target slot:
resolve the doctor's existing row if any, look up the holder excluding that row's id,
displace, then assign the pair. Delete the leftovers. One transaction, one commit,
all-or-nothing.

The flush ordering the provisional plan was reaching for is real elsewhere in this repo —
`POST /leave-planning/bulk` flushes its clears before any insert because SQLAlchemy emits a
mapper's INSERTs before its DELETEs within one flush — and it **would** bite a variant that
deleted and recreated a slot. Update-in-place avoids it entirely; a comment at the delete
step should say so, so a later refactor to delete-and-recreate does not reintroduce it
silently.

Where the self-exclusion subtlety *does* bite is the **frontend preview**: it must exclude
every one of the doctor's rows in the target weeks, not just one session id, or it will
report the doctor displacing themselves out of a room they are about to vacate.
`findMasterRoomHolder`'s single `excludeSessionId` parameter cannot express that, which is
why the preview gets its own pure function rather than reusing it.

### 6. Undo inverts the page's displaced-first ordering, and that is correct

Every existing replay on these pages restores the displaced side *first*. **The bulk entry
is the opposite: the bulk PUT goes first, then the displaced rows are restored.**

The provisional plan's reasoning was right and can be made exact. Let the forward call
displace holder H out of room R in slot S. H held R in S before the call, so the doctor's
*prior* row in S did not hold R. Restoring the prior rows therefore **frees R in S**, and
the restore of H that follows displaces nobody. Doing it the other way round would put H
back into a room the copied row still occupies, and the bulk write that follows could
displace H a second time.

This contradicts the stated convention in `masterUndo.ts` and `nurseRota/undo.ts`, so it is
commented at the new branch rather than left to be "tidied up" into consistency later.

**Which displaced rows the entry carries.** The pre-displacement state is only knowable
before the call, so the entry is built from the **client-side predicted displacement list**
— the same list the preview rendered — exactly as `MasterRotaGrid.handlePick` already
builds its entry from the popover's client-side lookup rather than from the response. New
rule for the bulk case, because the exposure is ten rows rather than one: **if the
response's displaced session ids are not exactly the predicted set, push no entry and clear
the stack.** A stale cache is the only way the two can disagree, and an undo that restores
the wrong rows is worse than no undo.

### 7. `PUT` is right, and the API already has PUTs

The operation is idempotent and addresses a resource ("this doctor's rows in these weeks"),
so `PUT`. The provisional plan flagged a risk that the API has no PUTs and that
`AuditMiddleware` or `test_authorization.py`'s sweeps might assume so. **Checked, and it is
a non-issue**: nine PUT routes already exist (`/clinic-types/{id}`, `/duty/adjustment`,
`/leave/entitlement/{doctor_id}`, `/counters/…/adjustment`, and others), the audit
middleware branches only on a safe-method set, and both authorization sweeps enumerate
`route.methods` rather than a hard-coded list. The *master rota router* is currently
GET/POST/PATCH/DELETE only; the API is not.

### 8. No new permission, no new lock wiring

`require_access` and `require_edit_lock` are both applied at `include_router` time in
`api/main.py`, keyed off `_AREA` and `LOCKABLE_AREAS` (`clinical`, `reception`,
`nurse_rota`), so a new route on either existing router inherits its area gate and its lock
with no edit. `clinical: write` covers the master endpoint, `nurse_rota: write` the nurse
one. The authorization sweeps' `_NON_GET_FLOORS` are floors, not exact counts, so two new
routes cannot fail them.

The one thing that is **not** automatic is `audit_descriptions.py`: one entry per new route,
or `test_audit_descriptions.py::test_every_write_route_has_a_description` fails.

### 9. Answers to the provisional plan's open questions

1. **Nurse in the same PR?** Same plan, separate tasks. The nurse surface is the motivating
   case and waits on nothing but the shared backend helpers.
2. **`PUT` or `POST`?** `PUT` — see §7.
3. **A "don't take anyone's room" option** (copy clashing cells as `requires_room`)? No, not
   in v1. It is a second semantics to explain in a dialog that already explains replacement
   and displacement, and the user can decline, fix and retry. It is also not expressible on
   the nurse surface at all, where `requires_room` is refused.
4. **"Copy to all other weeks" as one click?** Yes — the other three weeks are
   **pre-checked by default**, with per-week checkboxes to narrow. It is the named use
   case, so it is the default, not a second mode.

### 10. The dialog has two modes, and Clear is in v1

Copy and Clear share the endpoint, the preview machinery, the undo entry and the cache
operation; Clear differs only in that its session list is empty, its preview lists
deletions, and it can never displace anyone. It is a few lines per task rather than a
feature, and it is the second of the three named operations. It is in v1 for that reason.
Its trigger must be reachable on an **inactive** doctor's row — clearing a leaver is
precisely that case — even though the grid suppresses the "+" create affordance there.

---

## Task 1: Backend, master rota endpoint

**A.** State of the world: nothing is built. The master rota router serves GET/POST/PATCH/
DELETE over `master_rota_sessions` with a per-slot room-displacement rule. This task adds
the bulk verbatim writer and its schemas.

**B.** Files and deliverables:

- `backend/app/api/schemas/master_rota.py` — new input and output models.
- `backend/app/api/routers/master_rota.py` — the `PUT` endpoint.
- `backend/app/api/audit_descriptions.py` — one entry.
- `backend/tests/test_api/test_master_rota.py` — tests.

**C.** Instructions:

1. **Schemas.** Refactor `MasterSessionCreateIn` so the slot coordinates are shared rather
   than duplicated: introduce `MasterSlotSessionIn(MasterSessionPairIn)` carrying
   `week: int = Field(ge=1, le=4)`, `day: Day`, `period: Period`, and make
   `MasterSessionCreateIn(MasterSlotSessionIn)` add only `doctor_id`. This is
   behaviour-preserving (same fields, same validators; only OpenAPI field order moves) and
   keeps the bulk row and the create body from drifting.

   Add `MasterWeeksReplaceIn`:

   - `weeks: list[int]` — `min_length=1`, every entry in 1–4, **de-duplicated and rejected
     if duplicated** (a repeated week is a client bug, not something to silently collapse).
   - `sessions: list[MasterSlotSessionIn]`.
   - A `model_validator(mode="after")` asserting **every session's `week` is in `weeks`** —
     otherwise the call would write rows outside the range it claims to replace, and undo
     over `weeks` could not reverse it.
   - A second validator asserting **no two sessions share `(week, day, period)`**. Without
     it a duplicated slot reaches `uq_mrs_slot` and surfaces as a 500 at flush, exactly the
     failure mode the create endpoint's pre-check 409 exists to avoid.

   Add `MasterWeeksReplaceOut` with `sessions: list[MasterRotaSessionOut]` (the doctor's
   rows in `weeks` after the write, the full set, not a delta) and
   `displaced_sessions: list[MasterRotaSessionOut]`.

2. **Endpoint** — `PUT /master-rota/templates/{template_id}/doctors/{doctor_id}/weeks`,
   response model `MasterWeeksReplaceOut`:

   - 404 unknown `template_id`, 404 unknown `doctor_id` — same shape as the existing
     handlers. No active-doctor check: the server stays a permissive verbatim writer, and
     that is what lets a leaver's rows be cleared.
   - 404 any `room_id` in `sessions` that does not exist, resolved once per distinct room
     up front rather than per row.
   - Load the doctor's existing rows for `(template_id, doctor_id, week in weeks)` into a
     dict keyed by `(week, day, period)`.
   - For each payload session, in payload order: find the doctor's existing row for that
     slot; when `room_id` is not null call `_find_room_holder(..., exclude_id=existing.id
     if existing else None)` and apply the standard displacement (clear `room_id`; a
     displaced `PRE_ASSIGNED` becomes `REQUIRES_ROOM`, an `ADMIN_TIME` keeps its type);
     then either assign the pair onto the existing row **in place** or `db.add` a new
     `MasterRotaSession`. Collect displaced rows, de-duplicated by id.
   - Delete every existing row in `weeks` whose slot is not in the payload.
   - Comment the update-in-place choice at the delete step per §5, naming the
     INSERT-before-DELETE flush hazard a delete-and-recreate variant would inherit.
   - One `db.flush()`, one `db.commit()`. Serialise the doctor's rows in `weeks` plus the
     displaced rows via `_session_outs`.

3. **Audit**: `("PUT", "/master-rota/templates/{template_id}/doctors/{doctor_id}/weeks"):
   "Replaced a doctor's sessions across one or more master rota weeks"`.

4. **Tests** in `tests/test_api/test_master_rota.py`, following the file's existing
   fixtures and class layout: a copy that inserts where slots were empty and updates where
   they were filled; leftover rows deleted; `sessions: []` clears the named weeks and
   touches no other week; a displacement fires and is reported, with `pre_assigned`
   becoming `requires_room` and `admin_time` keeping its type; **the doctor's own row in a
   target slot is not treated as a holder** (the §5 regression test); week not in `weeks`
   422; duplicate slot 422; duplicate week 422; empty `weeks` 422; unknown template, doctor
   and room 404; a `pre_assigned` row with no room 422 via the inherited pair validator.

---

## Task 2: Backend, nurse rota mirror

**A.** Task 1 is complete: the master bulk endpoint, its schemas and its tests exist. This
task adds the nurse-gated mirror over the same table.

**B.** Files and deliverables:

- `backend/app/api/schemas/nurse_rota.py` — `NurseSlotSessionIn`, `NurseWeeksReplaceIn`,
  `NurseWeeksReplaceOut`.
- `backend/app/api/routers/nurse_rota.py` — the `PUT` endpoint.
- `backend/app/api/audit_descriptions.py` — one entry.
- `backend/tests/test_api/test_nurse_rota.py` — tests.

**C.** Instructions:

1. **Schemas** mirror Task 1 against `NurseSessionPairIn`, so the three-type restriction and
   the nurse room rules apply to every row. Same refactor: `NurseSlotSessionIn` carries the
   slot coordinates, `NurseSessionCreateIn` subclasses it adding `doctor_id`. Same three
   validators on `NurseWeeksReplaceIn` (weeks non-empty and unique, every session's week in
   `weeks`, no duplicate slots).

2. **Endpoint** — `PUT /nurse-rota/doctors/{doctor_id}/weeks`, response
   `NurseWeeksReplaceOut`. Structurally the master endpoint with three substitutions:
   `_active_template(db)` instead of a path `template_id`; `_require_nurse(db, doctor_id)`
   instead of the plain doctor lookup; `_displace_or_409(...)` instead of the inline
   displacement, so a non-nurse holder refuses the **whole call** — which is correct, since
   the transaction is all-or-nothing and a partially applied copy is worse than a refusal.
   Reuse `_require_room` and `_session_outs` as the existing handlers do. Prefer factoring
   the shared body out of the master endpoint into a helper parameterised on the
   displacement callable only if it comes out genuinely shorter; two readable siblings
   beat one helper with a strategy argument, and the routers already accept that trade.

3. **Audit**: `("PUT", "/nurse-rota/doctors/{doctor_id}/weeks"): "Replaced a nurse's
   sessions across one or more template weeks"`.

4. **Tests** in `tests/test_api/test_nurse_rota.py`: the happy copy; clear; nurse-on-nurse
   displacement reported; **a non-nurse holder in any target slot 409s and writes nothing**
   (assert the other target slots are unchanged — this is the all-or-nothing claim);
   `doctor_id` of a non-nurse 404; a `requires_room` or `wfh` row in the payload 422; a
   session id belonging to an archived template unreachable (the active-template
   resolution); target weeks whose existing rows are `requires_room` / `wfh` are
   overwritten successfully — the forward call is allowed, per §2.

---

## Task 3: Frontend shared pieces — derivation, preview, dialog

**A.** Tasks 1–2 are complete: both endpoints are live and tested. Nothing frontend exists
yet. This task builds the pure logic and the presentational dialog both surfaces will use;
it wires up neither.

**B.** Files and deliverables:

- `frontend/src/lib/bulkWeekOps.ts` + `.test.ts` — the pure module.
- `frontend/src/components/CopyWeekDialog.tsx` + `.test.tsx` — presentational only.

Shared rather than cloned, unlike `MasterCellEditPopover` / `NurseCellEditPopover`: the
dialog renders week checkboxes and a preview list and holds no domain logic, which is the
opposite of the popover case where the domain logic *was* the component. Nurse already
imports `@/components/Toast`, so this crosses no shell boundary.

**C.** Instructions:

1. **`lib/bulkWeekOps.ts`** — pure functions over data the pages already hold:

   - `deriveCopiedSessions(sessions, doctorId, sourceWeek, targetWeeks)` → the payload rows:
     the doctor's source-week rows re-stamped with each target week, carrying
     `(day, period, session_type, room_id)`.
   - `findBulkDisplacements(allSessions, doctorId, targetWeeks, payloadRows)` → one entry
     per `(week, day, period, room_id)` a payload row claims that another **doctor** holds,
     carrying the holder's code and the slot. **It must exclude every row of `doctorId` in
     `targetWeeks`**, not one session id — see §5. Do not reuse `findMasterRoomHolder`; its
     signature cannot express this, and a comment should say so.
   - `findNurseBlockers(occupancy, targetWeeks, payloadRows)` → the same over the nurse
     page's occupancy list, returning blockers rather than displacements.
   - `findUncopyableNurseCells(sessions, doctorId, sourceWeek)` → source-week rows whose
     `session_type` is `requires_room` or `wfh`, reusing `asNurseSessionType` from
     `features/nurseRota/undo.ts` as the single definition of what a nurse row may hold.
   - `sessionsToClear(sessions, doctorId, targetWeeks)` → the rows Clear mode will delete,
     for its preview and its undo entry.

   Unit tests carry the edge cases the dialog depends on: an empty source week, a target
   week identical to the source, a room held by the doctor themselves in a target week
   (must **not** appear as a displacement — the regression test for §5), and a room held by
   somebody else in only some of the target weeks.

2. **`components/CopyWeekDialog.tsx`** — Radix `Dialog`, following
   `ForceDeleteRotaDialog`'s convention of owning its own trigger and open state and
   resetting that state in `onOpenChange`. Props: doctor code, source week, the available
   target weeks, a `mode` of `"copy" | "clear"`, a computed preview
   (`{ rowCount, displacements, blockers, uncopyable }`), `onConfirm(targetWeeks)`, and a
   `saving` flag. It owns the target-week checkbox state (all other weeks pre-checked, per
   §9.4) and calls back with the selection; it computes nothing itself, so the page can
   recompute the preview as the selection changes. Confirm is disabled while any blocker or
   uncopyable cell is listed, and the reason is stated in the dialog rather than left to a
   greyed button. Gate the trigger with `useWriteGate()`.

---

## Task 4: Frontend, Master Rota

**A.** Tasks 1–3 are complete: both endpoints are live, and the shared preview logic and
dialog exist. This task wires the master surface to them.

**B.** Files and deliverables:

- `frontend/src/api/masterRota.ts` (+ test) — `useReplaceMasterDoctorWeeks`.
- `frontend/src/lib/masterUndo.ts` (+ test) — the `"bulk-weeks"` entry and replay branch.
- `frontend/src/components/MasterRotaGrid.tsx` (+ test) — the per-row trigger.
- `frontend/src/routes/MasterRotaPage.tsx` (+ test) — the replay wiring.

**C.** Instructions:

1. **Hook and cache.** `useReplaceMasterDoctorWeeks` PUTs the body and, on success,
   performs a **third cache shape** alongside splice and append: drop every cached row
   where `doctor_id === doctorId && weeks.includes(week)`, concatenate
   `response.sessions`, then splice `response.displaced_sessions` through the existing
   `spliceMasterSessions`. Same `setQueryData`/no-invalidate convention as the other three
   hooks. Document the new shape in the module comment that currently describes the other
   two.

2. **Undo entry.** Add `MasterBulkWeeksUndoEntry` to the union:
   `{ kind: "bulk-weeks"; doctorId; weeks: number[]; previous: MasterSlotPair[];
   displaced: { sessionId; sessionType; roomId }[] }`, where `previous` is every row of the
   doctor in `weeks` **before** the call, in the endpoint's row shape, and `displaced`
   carries **pre-displacement** snapshots taken from the predicted list.

   Extend `buildMasterReplaySteps` with a `"bulk-weeks"` branch and a new
   `{ op: "replace-weeks" }` step. **The bulk step goes first, then one `patch` per
   displaced row** — the inverse of the other three branches. Comment the reason at the
   branch, per §6, rather than leaving it to read as an inconsistency.

   Add the toast builders: `masterWeeksCopiedMessage(doctorCode, sourceWeek, targetWeeks,
   displacedCount)` and `masterWeeksClearedMessage(doctorCode, targetWeeks, rowCount)`.

3. **Trigger.** A small button in the grid's sticky doctor cell — the cell already renders
   once per doctor via `rowSpan`, so it is the natural per-row home. It opens
   `CopyWeekDialog` with the grid's `activeWeek` as the source. Available on **inactive**
   doctors' rows too, unlike the "+" create affordance, because clearing a leaver is the
   case that needs it (§10). The grid computes the preview from the `sessions` prop it
   already receives and recomputes it when the week selection changes.

4. **Page.** On success, build the entry and push it — unless the response's displaced ids
   differ from the predicted set, in which case `undoStack.clear()` instead (§6). Add the
   page-level `useReplaceMasterDoctorWeeks` instance for replay, alongside the three that
   already exist, extend `handleUndo`'s step loop with the `replace-weeks` op, and include
   it in the `undoing` disable condition.

---

## Task 5: Frontend, Nurse Rota

**A.** Tasks 1–4 are complete: the master surface ships the operation end to end, and the
shared dialog and preview logic are in place. This task does the same for
`features/nurseRota/`.

**B.** Files and deliverables:

- `frontend/src/features/nurseRota/api.ts` (+ test) — `useReplaceNurseDoctorWeeks`.
- `frontend/src/features/nurseRota/undo.ts` (+ test) — the bulk entry and replay branch.
- `frontend/src/features/nurseRota/NurseRotaGrid.tsx` (+ test) — the trigger.
- `frontend/src/features/nurseRota/NurseRotaPage.tsx` (+ test) — the replay wiring.

**C.** Instructions:

1. Mirror Task 4 against the nurse hooks and undo module. Replay steps carry no
   `templateId`. The cache operation is the same third shape over `rota.sessions`;
   `occupancy` is never touched, for the reason already documented in `api.ts` — a nurse
   write can never move a non-nurse.

2. **The dialog's two refusals** are the nurse surface's own:
   - `findUncopyableNurseCells` non-empty → refuse, naming the cells and saying they must
     be fixed on the Master Rota first (§2).
   - `findNurseBlockers` non-empty → refuse, naming the room, the holder's code and the
     slot. The server's 409 stays the backstop.

3. **Undo entry builder** returns `null` when any of the doctor's **prior** rows in the
   target weeks is `requires_room` or `wfh` (`asNurseSessionType` returns null for it), and
   the page clears the stack — the existing `handleMutationApplied` null branch already
   does exactly this, so this is a new caller of a decided rule, not a new rule (§2). Same
   for a predicted/actual displacement mismatch.

4. Trigger placement and the inactive-nurse rule match Task 4. Keep the grid's `canWrite`
   treatment: this section hides inert affordances rather than showing them, so the trigger
   is hidden rather than disabled for a read-level login.

---

## Task 6: Review and documentation

**A.** Tasks 1–5 are complete and the feature is live on both surfaces. This step is review
and documentation.

**B.** Files: `documentation/architecture-clinical.md`, `documentation/architecture.md`,
`documentation/planned_updates.md`, and this plan.

**C.** Instructions:

1. `architecture-clinical.md`:
   - **"Master rota write surface"** — add the bulk verbatim writer: what it replaces, the
     validators that make the contract checkable, the per-slot self-exclusion rule and why
     update-in-place avoids the INSERT-before-DELETE flush hazard (§5), and the weaker
     audit row the verbatim shape costs (§1).
   - **"Frontend: Master Rota"** — the third cache shape, the client-side displacement
     preview and why it needs its own helper rather than `findMasterRoomHolder`, and the
     **inverted replay ordering** with its reasoning, since it contradicts the
     displaced-first convention stated two paragraphs earlier.
   - **"Nurse Rota"** — replace the **"Bulk entry does not exist"** paragraph, which is now
     false. State the two nurse-only refusals and the target-week stack-clearing rule.
2. `architecture.md` — **narrow**, do not drop, the "Master rota bulk row operations"
   Outstanding Tasks row: copy-week and clear-weeks ship; "populate a new doctor's full
   week" does not, and the endpoint is already the primitive for it (§Scope).
3. `planned_updates.md` — narrow the bullet the same way.
4. Delete `documentation/bulk_row_ops_provisional_plan.md` and this file.
