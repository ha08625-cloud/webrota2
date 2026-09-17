# Nurse Rota — Implementation Plan

Stage 2 of the workflow. The provisional plan
(`nurse_rota_provisional_plan.md`) was checked against the code; its design
decisions survive almost intact, with the corrections and additions recorded
below. Each task is one chat.

## Scope

1. A **Nurse Rota** section showing nurse rows only, editable, reading and
   writing the same `MasterRotaSession` rows the Master Rota does.
2. A new **`nurse_rota` permission area**, so a nursing-team login can edit
   the nurse rota without being able to touch the clinical rota.

Settled and unchanged from the provisional plan:

- The nurse rota edits the **master template only** — the 4-week repeating
  pattern. Not committed rotas, not a week-specific surface.
- A cell is **"which room, or not working"**. The existing
  `(session_type, room_id)` model is enough; no named duties, times or breaks.
- A nurse may be placed in **any room**, but may not displace a non-nurse.

Out of scope, stated so nobody assumes otherwise: nurse leave (nurses have no
entitlement in `leave_entitlement.py` and no UI creates a `Leave` row for
one — Phase 2 *would* honour one if it existed, so the machinery works and
this is a separate ticket); a dated "where am I next Tuesday" view; and any
engine change. `INERT_TYPES = (DoctorType.NURSE,)` and
`NON_ALLOCATABLE_ROOM_TYPES = (RoomType.TR,)` already say everything the
engine needs to know, and nothing in `backend/app/engine/` is touched.

## What already exists — verified

- `DoctorType.NURSE` is inert to the engine (`engine/phases/_shared.py:30`),
  and `phase7_9a`'s docstring confirms a nurse with an unresolved
  `REQUIRES_ROOM` is a Phase 12 report, not something a phase rooms.
- `RoomType.TR` exists with exactly **four** rooms — TR1/TR2/TR3 at SHC and CK
  at Cutteslowe (`seed/seed_rooms.py`, migration `019`).
- `MasterRotaSessionOut` already carries `doctor_type`, so a nurse-filtered
  read costs nothing new on the wire.
- `MASTER_ROTA_WEEKS` is a fixed `[1,2,3,4]` constant, not derived from the
  sessions — for the reason the nurse grid needs too (an empty week still
  needs a tab to click into).
- `GET /doctors` is in `_SHARED_READ`, so nurse *rows* come free; `GET /rooms`
  is clinical-gated and does not.
- `groupDoctors.ts` and `pivotSessions.ts` already handle `Nurse` as a type.

## Design Decisions

DD1–DD14 from the provisional plan stand except where a numbered correction
below replaces them. The corrections are the substance of this review.

### DD1 — Its own top-level section, `/nurse-rota`, not a tab in the clinical shell

Confirmed against `App.tsx`: `ClinicalShell` redirects anyone who cannot read
`clinical` to `/`, so a `nurse_rota: write` / `clinical: none` login would be
bounced off a tab inside it. Same shape as the `/admin/*` split. Own route,
own `NurseRotaShell`, own `SECTIONS` tile on `LandingPage`, wrapped in
`<PermissionAreaProvider area="nurse_rota">`.

### DD2 — `nurse_rota` is levelled (`none`/`read`/`write`)

Unchanged.

### DD3 — A separate router, and what this actually makes true

The router boundary is forced: `_AREA[module]` in `main.py` is a mandatory
direct subscript resolved at `include_router` time, so one endpoint cannot
serve two areas.

**Correction 1.** The provisional plan claimed this is "the first case where a
permission area is not a module". It is not. `signatures` and `study_eoi` are
already permission areas whose routers are flat modules in the clinical tree
and are listed as clinical sources in the import contract. What is genuinely
new — and what the architecture doc should say at the end of this ticket — is
that **two permission areas now write to the same table**. `clinical` and
`nurse_rota` both mutate `master_rota_sessions`, partitioned by
`Doctor.doctor_type` rather than by table. That is the claim worth recording,
because it is the one that makes DD5 and DD7 load-bearing rather than
decorative.

### DD4 — One table, two views, no sync

Unchanged. Separate TanStack Query keys mean an edit in one page is not
reflected in an already-open other page until it refetches; accepted.

### DD5 — Nurse rows only, and a nurse may not displace a non-nurse

Every write resolves the target `doctor_id` and 404s unless
`doctor_type == NURSE` — 404 rather than 403, because the session is not part
of this resource. Where `master_rota.py` **silently displaces** the same-slot
room holder, the nurse router **refuses with 409 naming the holder** when that
holder is not a nurse. Nurse-on-nurse displacement keeps the master rota's
existing behaviour (clear `room_id`; a displaced `PRE_ASSIGNED` becomes
`REQUIRES_ROOM`).

Displacement is the exact mechanism by which a `nurse_rota`-only login could
otherwise reach and mutate a doctor's row. This rule is the permission
boundary, not a nicety.

The reverse is unchanged: a clinical writer on the Master Rota can still
displace a nurse. `clinical: write` is the superset.

### DD5a (new) — `/nurse-rota/active` returns slot occupancy

**Correction 2, and the largest gap in the provisional plan.**
`MasterCellEditPopover` detects a steal client-side with
`findMasterRoomHolder` over the `sessions` array it is given. On a nurse page
that array holds nurse rows only, so a nurse picking a room a doctor holds
would see no confirmation, get a bare 409, and have no way to know which of
four TR rooms — plus every D/consulting room — is actually free. That is not a
usable surface.

So `GET /nurse-rota/active` returns, alongside the nurse sessions and the room
list, an **occupancy list**: one entry per non-nurse template session holding a
room, as `(week, day, period, room_id, doctor_code)`. The grid greys out taken
rooms and names the holder in the disabled entry, and DD5's 409 becomes a
race-condition backstop rather than the normal path.

This deliberately shows a `nurse_rota`-only login which rooms doctors occupy,
and their codes. Decided in review: without it the feature does not work, the
information is room-occupancy rather than clinical detail, and `doctor_code` is
what makes "why can't I have TR2" answerable. Nothing else about a doctor's
row crosses — no session type, no session id, no name.

A nurse who books D3 makes D3 unavailable to the generator for that slot,
because an inert occupant's room is an ordinary occupied room. That is correct
behaviour and it is now at least *visible* to the rota administrator on the
Master Rota. If it bites, the follow-up is a Phase 0 warning, not a
restriction.

### DD6 — Three session types only: pre-assigned, admin time, not working

`REQUIRES_ROOM` on a nurse is a bug state, not a choice — nurses are inert, so
no phase rooms them. `WFH` for a nurse is meaningless. The nurse router accepts
`PRE_ASSIGNED`, `ADMIN_TIME` and `NO_SURGERY` and 422s the other two; the
popover offers three options. Enforced server-side, not just hidden in the
menu.

The master rota keeps all five for nurse rows: it is a permissive verbatim
writer by design. A Phase 0 warning for any nurse row holding `REQUIRES_ROOM`
would catch rows predating this work; not scoped here.

### DD7 — `nurse_rota` joins `LOCKABLE_AREAS`, **and the frontend half is built**

**Correction 3.** The provisional plan added `nurse_rota` to the backend
`LOCKABLE_AREAS` and listed no frontend work. That combination is worse than
no lock at all: `require_edit_lock` would gate every nurse write, and with no
`EditLockProvider`, no banner and no `LOCKABLE_AREAS` entry in
`frontend/src/api/locks.ts`, a second nurse would get an unexplained 409 with
no read-only downgrade and nothing on screen saying why.

Decided in review: keep the lock and build both halves. Task 5 exists for it.
`LOCKABLE_AREAS` already carries an import-time assert that it is a subset of
`AREA_KEYS`, `main.py`'s loop adds `require_edit_lock` off the area already in
`_AREA`, and `locks.py`'s `_validate_area` reads `LOCKABLE_AREAS` — so the
backend is two entries and no new mechanism. The frontend is a second literal
of the tuple plus a provider and the two banner components.

**The residual hole, stated rather than closed:** a clinical writer holding the
clinical lock can still edit nurse rows from the Master Rota while a nurse
holds the nurse lock. Accepted — `clinical: write` is the superset, and the
practice has one rota administrator. Closing it would mean Master Rota writes
taking both locks, which would let any nurse block the rota administrator's
whole section.

### DD8 — The page fetches rooms from its own endpoint; `_SHARED_READ` stays at two

`GET /nurse-rota/active` returns `{template_id, name, sessions, rooms,
occupancy}`. One fetch for the whole page and no third hole in default-deny.
`architecture.md` is explicit that a third `_SHARED_READ` entry needs
justification as specific as the two that are there; this does not need one.

Consequence for DD10: `NurseRotaGrid` cannot call `useRooms()` the way
`MasterRotaGrid` does, so rooms arrive as a prop from the page.

### DD9 — Grid rows come from `/doctors`, filtered to `Nurse`

Same rule and reason as `MasterRotaGrid`: active nurses with no template
sessions still get a row, plus any inactive nurse who still holds sessions,
badged. `useDoctors(false)` is `GET /doctors` with a query string, which
`_SHARED_READ` matches on `route.path`, so it is reachable.

### DD10 — `NurseRotaGrid` **and** `NurseCellEditPopover` are clones

**Correction 4.** The provisional plan reused `MasterCellEditPopover` "with the
option list narrowed". That component hard-codes its five options and takes no
option-list prop, so reuse means adding a prop to a component the live Master
Rota and Staging grids both depend on, and updating its tests — and it would
still need the occupancy-aware holder lookup of DD5a, which its
`findMasterRoomHolder(sessions, …)` signature cannot express.

It also crosses a shell boundary. `architecture.md` states that **no route,
component, or nav item is shared between shells**; `MasterCellEditPopover` is
shared today only *within* `ClinicalShell` (master and staging grids).

So: clone it as `NurseCellEditPopover` in the feature folder. The clone is
substantially smaller than the 409-line original — three options instead of
five, one room submenu instead of two, no WFH branch — and it takes occupancy
rather than a session list for its holder lookup. This is the call the repo has
made twice already (`StagingGrid` from `MasterRotaGrid`,
`MasterCellEditPopover` as a deliberate sibling of `CellEditPopover`), and it
leaves the live master popover untouched.

Week tabs are the fixed `MASTER_ROTA_WEEKS` constant, for the same reason the
master grid uses it.

`MasterRotaConflictsPanel` is not cloned: it recomputes double-booked rooms
from the session list, and the nurse page holds nurse rows only, so it could
only ever see half a conflict. Conflicts stay the Master Rota's job.

### DD10a (new) — The frontend lives in `src/features/nurseRota/`

`architecture.md`: a new section's frontend goes in
`frontend/src/features/<section>/`, with only the permission key itself in the
shared `api/types.ts`. Research is the worked example. The flat
`routes/`/`components/`/`api/` trees are where existing sections happen to
live, not where new ones go.

The one shared import is `@/lib/pivot`'s `DAYS`/`PERIODS` and
`pivotSessions`/`groupDoctors`, which are domain-neutral pivot helpers already
used by four grids. No page, route or nav item is shared with another shell.

### DD11 — Undo is included

`MasterRotaPage`'s undo is replay of inverse API calls against live server
state. `StagingGrid` skipped it, but staging's recovery path is
abandon-and-restart, which the nurse rota does not have — a mis-click here
edits the live template, and this is the least technical audience in the
building. `lib/undoStack.ts` is generic and is reused as-is; the replay builder
is cloned.

### DD11a (new) — Paths resolve the active template server-side

**Correction 5.** The master rota's writes are
`/master-rota/templates/{template_id}/sessions/{session_id}`. The provisional
plan's nurse paths drop `template_id` — which is the better shape for this
surface, but only if the router then *verifies* the target session belongs to
the active template. Without that check, dropping the path parameter would let
a nurse edit an archived template's rows by id.

So the nurse endpoints are `/nurse-rota/sessions` and
`/nurse-rota/sessions/{session_id}`; the router resolves the active template
itself (lowest id among `is_active`, matching `get_active_template`) and 404s
any session id not in it. Consequence: `nurseUndo`'s replay steps carry no
`templateId`, so it is a near-clone of `masterUndo` rather than a literal copy.

### DD12 — A new "Nurse rota" preset, and the key added to all six existing presets

`PRESETS` are hand-written dicts, not derived from the key list, so a preset
missing the new key silently grants nothing while claiming to be complete.

| Preset | `nurse_rota` |
|---|---|
| Manager | `write` |
| Rota admin | `write` |
| Reception admin | `none` |
| Documents | `none` |
| Research | `none` |
| Read-only | `read` |
| **Nurse rota** (new) | `write`, everything else `none`/`false` |

### DD13 — A data migration, even though the shape needs none

`PermissionSet` defaults every field, so an old row already deserialises
correctly. Write the migration anyway, as research's `016` did: move the
column's `server_default` to the new key set and backfill existing rows with
`nurse_rota: "none"`. Without it, every row inserted outside the app from then
on is minted missing the key.

### DD14 — `access_level` is not touched

`AccessLevel.NURSE` is a decorative label, permission-identical to `DOCTOR`,
and nothing gates on it. Do not derive the new area from it and do not assume a
nursing login carries it. `PRESET_FOR_ACCESS_LEVEL["nurse"]` stays
`READ_ONLY_PRESET`.

## Things to check before starting — corrected

1. **Four TR rooms exist** (TR1, TR2, TR3, CK). Confirmed in the seed and in
   migration `019`. If more than four nurses ever run concurrently, more rooms
   must be added on the Rooms page before the surface can represent reality.
   Worth five minutes against the spreadsheet; it does not block the build,
   because DD5 permits any room.
2. **The nurse template rows probably do not exist yet**, and there is no bulk
   entry path. **Correction 6:** the provisional plan said a "copy week 1 to
   weeks 2–4" operation was "already sitting on the outstanding-tasks list".
   It is not — `planned_updates.md` contains no such entry, and neither does
   any other doc. Nor is "`doctor_type` on `RotaSessionOut`" an existing
   outstanding task. So the options are genuinely: budget for 4 × 5 × 2 cells
   of hand entry per nurse, extend `seed/seed_master_rota.py` as a one-off, or
   scope the bulk-copy operation as a new ticket. Decide before Task 4 ships,
   not after.
3. **Nurse leave is out of scope and has no surface.** See "Scope" above.
4. **The template has no dates.** Expect "where am I next Tuesday?" as the
   first request after launch. The follow-up needs `doctor_type` on
   `RotaSessionOut` plus a read-only nurse-filtered committed-rota view; it is
   a separate ticket, not a partially-built one.

---

# Task 1: Permission area wiring and migration

**A. State of the world.** Nothing is built. This task makes the
`nurse_rota` permission area exist and grant nothing — no router, no frontend.

**B. Files and deliverables.**

| File | Deliverable |
|---|---|
| `backend/app/models/permissions.py` | `nurse_rota` in `AREA_KEYS`, `LOCKABLE_AREAS`, `DEFAULT_PERMISSIONS`; the new `NURSE_ROTA_PRESET`; the key in **all six** existing presets |
| `backend/app/api/deps.py` | `_FORBIDDEN_DETAIL` and `_READ_ONLY_DETAIL` entries |
| `backend/app/api/schemas/auth.py` | `nurse_rota: AccessArea = "none"` on `PermissionSet` |
| `backend/alembic/versions/022_nurse_rota_permission.py` | new |
| `backend/tests/test_api/test_authorization.py` | `_PROFILES` entry, `_may_reach`'s levelled tuple, floors |

**C. Instructions.**

- `AREA_KEYS` becomes `("clinical", "reception", "research", "nurse_rota")`.
  `DEFAULT_PERMISSIONS` gains `"nurse_rota": NONE`; `DEFAULT_PERMISSIONS_JSON`
  re-renders itself from it, so no separate edit.
- `LOCKABLE_AREAS` becomes `("clinical", "reception", "nurse_rota")`. Extend
  the comment there to say why: two locks over disjoint row sets of one table,
  and DD5's no-cross-type-displacement rule is what makes them disjoint from
  the nurse side. State the residual hole (a clinical writer can still edit
  nurse rows under the clinical lock) in the same comment — it is exactly the
  kind of thing that tuple's comment block exists to record.
- `NURSE_ROTA_PRESET = "nurse_rota"`, granting `nurse_rota: WRITE` and nothing
  else. Add `nurse_rota` to every one of the six existing preset dicts per
  DD12's table. `READ_ONLY_PRESET` gets `READ`, on the same argument the module
  already makes for the two rotas.
- `_FORBIDDEN_DETAIL["nurse_rota"] = "Your permissions do not include the
  nurse rota"`; `_READ_ONLY_DETAIL["nurse_rota"] = "Your access to the nurse
  rota is read-only"`. Both dicts are hand-written and both are consulted by
  `require_access`; a missing `_FORBIDDEN_DETAIL` entry is a `KeyError` at
  import, a missing `_READ_ONLY_DETAIL` entry silently falls back to the flat
  denial via `.get()`.
- Migration `022`, down-revision `021`: `ALTER COLUMN users.permissions SET
  DEFAULT` to the new `DEFAULT_PERMISSIONS_JSON`, and `UPDATE users SET
  permissions = permissions || '{"nurse_rota": "none"}'` (or the SQLite-safe
  equivalent the existing migrations use — read `016_research_permission.py`
  and follow it exactly rather than inventing a second idiom). Downgrade
  reverses both.
- `test_authorization.py` needs **three** edits, not one:
  - `_PROFILES["nurse_rota"] = preset(NURSE_ROTA_PRESET)`. This one fails
    *silently* if forgotten — the preset is simply never swept.
  - `_may_reach` hard-codes `elif area in ("clinical", "reception",
    "research")`. Add `"nurse_rota"`, or the sweep will treat it as a boolean
    area. **This is not in the provisional plan's checklist.** Consider
    importing `AREA_KEYS` here instead; the hand-written duplication that the
    module docstring defends is about `_AREA_FOR_PREFIX`, not about the
    levelled/boolean split, which is a property of the permission shape rather
    than of a router's classification.
  - `_NON_GET_FLOORS` and `_GET_FLOORS` each need a `"nurse_rota"` row. They
    are floors, not exact counts, so existing rows do not need updating — but
    the new profile has none and the test will `KeyError`. With no router yet
    the nurse_rota profile reaches only the two `_SHARED_READ` reads and the
    two ungated ones; set the floors from an actual run rather than guessing,
    and re-check them in Task 2 once the router exists.
- No `_AREA_FOR_PREFIX` entry yet — there is no `/nurse-rota` path until
  Task 2.

Verify with `uv run pytest tests/test_api/test_authorization.py
tests/test_api/test_users.py` and `uv run alembic upgrade head` against a
scratch DB.

---

# Task 2: The `/nurse-rota` router

**A. State of the world.** Task 1 is complete: the `nurse_rota` area exists,
is lockable, and grants nothing because no router is classified into it.
This task adds the four endpoints.

**B. Files and deliverables.**

| File | Deliverable |
|---|---|
| `backend/app/api/schemas/nurse_rota.py` | new — the nurse wire shapes |
| `backend/app/api/routers/nurse_rota.py` | new — four endpoints |
| `backend/app/api/main.py` | import, `_ALL_ROUTERS`, `_AREA` |
| `backend/app/api/audit_descriptions.py` | one sentence per non-GET route |
| `backend/pyproject.toml` | contract entries — see below |
| `backend/tests/test_api/test_nurse_rota.py` | new |
| `backend/tests/test_api/test_authorization.py` | `_AREA_FOR_PREFIX` entry, revised floors |

**C. Instructions.**

**Schemas** (`api/schemas/nurse_rota.py`). Reuse `MasterRotaSessionOut` from
`schemas/master_rota.py` for the session rows — same table, same shape, and
`doctor_type` is already on it. New here:

```
NURSE_SESSION_TYPES = {PRE_ASSIGNED, ADMIN_TIME, NO_SURGERY}   # DD6

NurseSlotOccupancy:   week, day, period, room_id, room_code, doctor_code
NurseRotaOut:         template_id, name, sessions, rooms, occupancy
NurseSessionPairIn:   session_type, room_id  + the DD6 membership validator
                      + the same room/type validator MasterSessionPairIn has
NurseSessionPatchIn:  NurseSessionPairIn
NurseSessionCreateIn: NurseSessionPairIn + doctor_id, week (ge=1,le=4), day, period
NurseSessionWriteOut: session, displaced_session | None
```

The DD6 restriction belongs on the Pydantic model (a 422 with a field name),
not in the router body. Keep the `PRE_ASSIGNED requires a room_id` /
`NO_SURGERY must not have a room_id` pair validator — with `WFH` and
`REQUIRES_ROOM` rejected upstream, `_ROOM_FORBIDDEN` reduces to
`{NO_SURGERY}` and `ADMIN_TIME` stays optional-room.

**Router** (`api/routers/nurse_rota.py`), `prefix="/nurse-rota"`:

- `GET /nurse-rota/active` → `NurseRotaOut`. Resolve the active template the
  way `master_rota.get_active_template` does (lowest id among `is_active`,
  404 if none). Load all its sessions once and all doctors once; split on
  `doctor_type == NURSE`. Nurse rows serialise through the same join logic;
  non-nurse rows with a non-null `room_id` become `occupancy` entries
  (DD5a) and contribute nothing else. Rooms: every `Room`, not just `TR` —
  DD5 permits any room.
- `PATCH /nurse-rota/sessions/{session_id}` → `NurseSessionWriteOut`.
- `POST /nurse-rota/sessions` → 201, `NurseSessionWriteOut`.
- `DELETE /nurse-rota/sessions/{session_id}` → 204.

A shared helper resolves the active template and the target session together,
and every write goes through it:

1. No active template → 404.
2. Session not found, or `template_id` is not the active template's → 404
   (DD11a).
3. Target doctor is not `DoctorType.NURSE` → **404**, not 403 (DD5: the
   session is not part of this resource, and a 403 would confirm it exists).
   On POST, the same check on `payload.doctor_id`.

Room displacement (DD5), for PATCH and POST alike, when the payload sets a
non-null `room_id`:

- Find the same-slot holder exactly as `master_rota._find_room_holder` does
  — same `(template_id, week, day, period, room_id)` predicate, same
  `order_by(id).first()`, same `exclude_id` on PATCH and `None` on POST.
  Import it rather than copying it; it is a module-level private helper in a
  file this router is a sibling of, and one copy of that predicate is the
  point.
- Holder is a nurse → displace exactly as master does (clear `room_id`; a
  displaced `PRE_ASSIGNED` becomes `REQUIRES_ROOM`).
- Holder is not a nurse → **409**, naming the holder's `doctor_code`, and
  nothing is written. This is the permission boundary; test it directly.

POST also keeps master's one-session-per-slot 409
(`(template_id, doctor_id, week, day, period)` already taken).

**`main.py`**: import the module, add it to `_ALL_ROUTERS`, and add
`nurse_rota: "nurse_rota"` to `_AREA`. The lock gate attaches itself because
`nurse_rota` is in `LOCKABLE_AREAS` — no second table to edit. The two
assertions fail at import if either half is missed.

**`audit_descriptions.py`**: three entries, in the UI's vocabulary, under a
`# Nurse rota` heading next to the master template block —
`"Added a session to the nurse rota"` / `"Changed a session on the nurse
rota"` / `"Removed a session from the nurse rota"`. `test_audit_descriptions.py`
fails with the missing keys otherwise.

**`pyproject.toml` — Correction 7.** The provisional plan said to add the
router "to contract 2's sources and to the other contracts' `forbidden_modules`".
Only the first half is right:

- Contract 2, *Clinical must not import reception*: add
  `"app.api.routers.nurse_rota"` to `source_modules`. Clinical routers are
  listed longhand because they are flat modules; a new one is uncovered until
  it is added.
- Contracts 1 (*Reception*) and 5 (*Research*): add
  `"app.api.schemas.nurse_rota"` to `forbidden_modules`, alongside the
  existing `app.api.schemas.master_rota`. **Do not add the router** — no
  clinical router appears in any `forbidden_modules` list; those lists name
  clinical models, schemas and helper packages. Adding one would be a new
  convention, not the existing one.
- Contracts 3 (*Documents*) and 4 (*Shared kernel*) need nothing: both already
  forbid `app.api` / `app.api.routers` wholesale.

Run `uv run lint-imports` before the tests.

**Tests** (`tests/test_api/test_nurse_rota.py`): the happy path for each
endpoint; a non-nurse session id 404s on PATCH and DELETE; a non-nurse
`doctor_id` 404s on POST; a `WFH` or `REQUIRES_ROOM` body 422s; nurse-on-nurse
displacement behaves as master's does; nurse-on-doctor 409s **and writes
nothing** (re-read the row and assert it is unchanged); `GET /active`
occupancy contains the doctor's room and no nurse rooms. Then add
`f"{API_PREFIX}/nurse-rota": "nurse_rota"` to `_AREA_FOR_PREFIX` and re-run
the authorization sweeps, updating the Task 1 floors from the actual result.

---

# Task 3: Frontend permission mirrors

**A. State of the world.** The backend is complete: the area exists, the
router serves it, the lock gates it. The frontend knows nothing about
`nurse_rota`, so the user form cannot grant it. This task makes the permission
appear in the user form and nowhere else.

**B. Files and deliverables.**

`frontend/src/api/types.ts` · `frontend/src/lib/permissionPresets.ts` ·
`frontend/src/lib/userSchema.ts` · `frontend/src/components/UserFormDialog.tsx` ·
`frontend/src/auth/AuthContext.tsx` · the matching `.test.ts(x)` files.

**C. Instructions.**

- `types.ts`: `nurse_rota: AccessArea` on `Permissions`. `PermissionArea` is
  `keyof Permissions`, so it widens itself — no second edit.
- `permissionPresets.ts`: `PERMISSION_AREAS` gains `"nurse_rota"`;
  `AREA_LABELS` gains `nurse_rota: "Nurse rota"`; the six preset objects each
  gain the key per DD12; a new `nurse_rota` preset object;
  `PRESET_ORDER` and `PRESET_LABELS` each gain an entry. `PRESET_ORDER` is
  "most privileged first" — `nurse_rota` sits after `research` and before
  `read_only`. A missing `PRESET_ORDER` or `AREA_LABELS` entry is a control
  that silently does not render.
  `isEmptyPermissions` and `permissionsSummary` both loop over
  `PERMISSION_AREAS`, so they need no edit **provided** that array is updated.
- `userSchema.ts`: `nurse_rota: z.enum(["none", "read", "write"])`.
- `UserFormDialog.tsx`: check whether it renders the levelled areas from
  `PERMISSION_AREAS` or names them by hand, and edit only if the latter.
- `AuthContext.tsx`: the hard-coded deny-everything `Permissions` literal
  (the one `usePermissions` falls back to) gains `nurse_rota: "none"`.
  `canReadArea`/`canWriteArea` are key-agnostic and need no edit.
- `permissionPresets.test.ts` almost certainly pins preset contents and key
  counts; update rather than delete those assertions.

Nothing routes to `/nurse-rota` yet; a login granted the permission sees no
tile. That is the intended end state of this task.

---

# Task 4: The section

**A. State of the world.** Tasks 1–3 are complete: the API serves
`/nurse-rota/*` under its own permission, and a user can be granted it. There
is still no page. This task builds the section, minus its edit-lock UI (Task 5)
and undo (Task 6).

**B. Files and deliverables.**

| File | Deliverable |
|---|---|
| `frontend/src/features/nurseRota/api.ts` | new — query keys and four hooks |
| `frontend/src/features/nurseRota/types.ts` | new — the section's wire types |
| `frontend/src/features/nurseRota/NurseRotaPage.tsx` | new |
| `frontend/src/features/nurseRota/NurseRotaGrid.tsx` | new |
| `frontend/src/features/nurseRota/NurseCellEditPopover.tsx` | new |
| `frontend/src/features/nurseRota/occupancy.ts` | new — the holder lookup |
| `frontend/src/App.tsx` | `NurseRotaShell` and its route |
| `frontend/src/routes/LandingPage.tsx` | `SECTIONS` tile |
| matching `.test.tsx` files | |

**C. Instructions.**

- **Feature folder, per DD10a.** Only the permission key lives in the shared
  `api/types.ts` (done in Task 3); every wire shape this section puts on the
  wire is its own.
- **`api.ts`**: `nurseRotaKeys`, `useActiveNurseRota()` (`GET
  /nurse-rota/active`), and `useUpdateNurseSession` /
  `useCreateNurseSession` / `useDeleteNurseSession`. Follow
  `api/masterRota.ts`'s mutate-then-invalidate convention exactly; the paths
  carry no `templateId` (DD11a).
- **`occupancy.ts`**: `findSlotHolder(occupancy, week, day, period, roomId)`
  → the occupying `doctor_code` or null. This is `slotConflict.ts`'s
  `findMasterRoomHolder` re-expressed over the occupancy list instead of over
  a session array, and it is what lets the popover answer DD5a.
- **`NurseCellEditPopover.tsx`**: a clone of `MasterCellEditPopover`, not a
  generalisation (DD10). Three options — **Pre-assigned room** (room submenu,
  required), **Admin time** (room submenu with a "No room" entry at the top),
  **Not working** (`NO_SURGERY`, direct pick) — plus the edit-mode-only
  "Remove session". A room already held by a **nurse** shows the existing
  confirm-before-steal view; a room held by a **non-nurse** renders
  **disabled**, labelled with the holder's code, and cannot be picked at all.
  Keep `useWriteGate()` on the trigger, as the original does.
- **`NurseRotaGrid.tsx`**: a clone of `MasterRotaGrid`. Rows are
  `useDoctors(false)` filtered to `doctor_type === "Nurse"` (DD9), pivoted
  with the existing `pivotSessions`/`pivotMasterRota` helpers and the
  `MASTER_ROTA_WEEKS` constant. **Rooms and occupancy arrive as props from the
  page** — it must not call `useRooms()`, which is clinical-gated (DD8). Keep
  the absent-cell rule: a "+" affordance on an active nurse's row, inert on an
  inactive one.
- **`NurseRotaPage.tsx`**: one `useActiveNurseRota()` call feeding the grid.
  404 renders "No active master rota template", as `MasterRotaPage` does. A
  one-line subtitle saying changes apply to future generated rotas only. No
  conflicts panel (DD10).
- **`App.tsx`**: `NurseRotaShell` with `ShellHeader title="Rota Generator -
  Nurse Rota"`, a `canReadArea(permissions, "nurse_rota")` redirect to `/`,
  and `<PermissionAreaProvider area="nurse_rota">` around its routes. Model it
  on `ResearchShell` — own header, **no left nav**, since one page needs no nav
  bar. Route `/nurse-rota/*`, with a `*` fallback redirecting to the index the
  way Research does.
- **`LandingPage.tsx`**: a `SECTIONS` tile — `to: "/nurse-rota"`, title
  "Nurse Rota", `enterable: (p) => canReadArea(p, "nurse_rota")`. The comment
  above `SECTIONS` says "the five sections"; make it six and keep the sentence
  true.
- Tests: the grid renders nurse rows only; a non-nurse-held room is offered
  disabled with the holder's code; picking a nurse-held room confirms first;
  the three session types are the only ones offered; a read-level login gets
  the grid with every control disabled.

The word "tab" in the original request is served by a landing-page tile, not a
nav entry beside Master Rota. A `writeOnly` clinical nav entry pointing at
`/nurse-rota` is a one-line addition later, but it crosses a shell boundary,
which `architecture.md` rules out — a deliberate decision, not a default.

---

# Task 5: The edit lock, frontend half

**A. State of the world.** Task 4 is complete and the section works. The
backend has been gating every nurse write on the `nurse_rota` edit lock since
Task 1, but nothing on the frontend acquires it, releases it or explains it —
so a second concurrent nurse gets an unexplained 409. This task closes that
(Correction 3).

**B. Files and deliverables.**

`frontend/src/api/locks.ts` · `frontend/src/App.tsx` · `frontend/src/features/nurseRota/NurseRotaPage.tsx` (if the 409 toast needs it) · `frontend/src/api/locks.test.tsx`.

**C. Instructions.**

- `locks.ts`: `LOCKABLE_AREAS` becomes `["clinical", "reception",
  "nurse_rota"] as const`. It is a second literal of the backend tuple with no
  codegen between them; `locks.test.tsx` pins the strings and the backend
  asserts its own half at import. Update both the constant's docstring and the
  module docstring, which currently both say "Two locks exist at most".
- `App.tsx`: wrap the `/nurse-rota/*` route in `<EditLockProvider
  area="nurse_rota">`, outside `NurseRotaShell` so the header — and the logout
  button in it, which releases the lock explicitly — is inside the provider,
  exactly as `/clinical/*` and `/reception/*` do.
- `NurseRotaShell`: render `<EditLockBanner />` and `<EditLockDialog />`
  directly under `ShellHeader`, as the two other lockable shells do. Neither
  takes props — the section they describe is the one they are mounted in.
- `EditLockProvider` already downgrades `useCanWrite()` for a non-holder, and
  `NurseCellEditPopover`'s `useWriteGate()` inherits that with no change.
- Check `models/edit_lock.py`'s docstring and `EditLockBanner`'s: both say "at
  most two rows ever exist" / "Two locks exist at most". Correct them in the
  same task so the three copies of that sentence stay true.
- Tests: a nurse_rota lock row appears in `GET /locks` for a login that can
  read the area and not for one that cannot (backend, `test_locks.py`); the
  provider acquires on entry and releases on unmount (frontend).

---

# Task 6: Undo

**A. State of the world.** Tasks 1–5 are complete and the nurse rota is
usable and locked. It has no undo, so a mis-click edits the live template with
no way back (DD11).

**B. Files and deliverables.**

`frontend/src/features/nurseRota/undo.ts` (new) · `NurseRotaPage.tsx` ·
`NurseRotaGrid.tsx` · matching tests. `lib/undoStack.ts` is generic and is
reused unchanged.

**C. Instructions.**

- Clone `lib/masterUndo.ts` as the feature's `undo.ts`: the same
  `patch`/`create`/`delete` discriminated union and the same
  **displaced-first** replay ordering — restore whatever was stolen before
  undoing the action that stole it. Read `buildMasterReplaySteps`' docstring
  in full; the ordering rationale is subtle and it is the same here.
- Two differences from the master version, both from DD11a and DD5:
  - Replay steps carry no `templateId` — the router resolves the active
    template itself.
  - `displaced` can only ever be **another nurse**, because a non-nurse holder
    is refused outright. The displaced-`PRE_ASSIGNED`-became-`REQUIRES_ROOM`
    note in `MasterPatchUndoEntry` still applies: the undo must restore the
    *pre-displacement* type, not what the response left behind — and since
    DD6 makes `REQUIRES_ROOM` unwritable through this router, the restore path
    must never try to send it. Assert that in a test.
- `NurseRotaPage` grows its own three mutation instances for replay (separate
  from the grid's forward-edit instances), the `useUndoStack` hook, the Undo
  button with `writeGate`, and the toast. Follow `MasterRotaPage` line for
  line; it is the shortest file in this plan.

---

# Task 7: Review and documentation

**A. State of the world.** Tasks 1–6 are complete and the feature is live.
This step is review and documentation.

**B. Files and deliverables.**

`documentation/architecture.md` · `documentation/architecture-clinical.md` ·
delete `documentation/nurse_rota_provisional_plan.md` and
`documentation/nurse_rota_implementation_plan.md` ·
`documentation/planned_updates.md`.

**C. Instructions.**

- `architecture.md`:
  - The permission list gains `nurse_rota` as a fourth levelled area, and
    `LOCKABLE_AREAS` gains a third entry — with the reason the lock applies
    and the residual hole (a clinical writer under the clinical lock can still
    edit nurse rows) recorded, since that is the kind of accepted gap this doc
    exists to hold.
  - The `App.tsx` bullet says "one route per section" and names five shells;
    make it six.
  - **The design decision worth recording** (DD3, as corrected): two permission
    areas now write to the same table, partitioned by `Doctor.doctor_type`
    rather than by table or module. `nurse_rota` is a permission area *inside*
    the clinical module; "Adding a Module" assumes a new area means a new
    domain package, and this is the first case where the partition is a row
    predicate. Say what makes it safe — the nurse router's type check and its
    refusal to displace a non-nurse — because those two rules, not the router
    boundary, are what stop a `nurse_rota`-only login reaching a doctor's row.
  - Note in the "Adding a Module" wiring table that `test_authorization.py`
    needs a third edit for a levelled area (`_may_reach`'s tuple), or fix
    `_may_reach` to read `AREA_KEYS` and say so instead.
- `architecture-clinical.md`: the Nurse Rota surface — what it is, its
  three session types and why `REQUIRES_ROOM`/`WFH` are refused, the
  no-displacing-a-non-nurse rule and its 409, and the occupancy payload with
  the information-flow decision behind it (DD5a). Keep it to design decisions
  and data flow; the endpoint shapes are readable from the router.
- `planned_updates.md`: remove "add nurse edit option"; add the two real
  follow-ups this ticket names and does not build — a bulk "copy week 1 to
  weeks 2–4" master-template operation (there is no bulk entry path today, and
  someone has to type 4 × 5 × 2 cells per nurse without one), and a dated
  read-only nurse view of committed rotas, which needs `doctor_type` on
  `RotaSessionOut`.
- Review pass: confirm `uv run lint-imports`, the full backend suite and
  `npm run test` are green, and that a `nurse_rota`-only login can reach the
  nurse rota and nothing else — by hand, against the deployed staging app, not
  only in tests.
- Then delete both plan files.
