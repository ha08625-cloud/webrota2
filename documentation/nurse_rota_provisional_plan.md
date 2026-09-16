# Nurse Rota — Provisional Plan

Stage 1 of the workflow: design decisions and a provisional task breakdown, to be
reviewed and expanded into an implementation plan in a fresh chat.

## Scope

Two things:

1. A **Nurse Rota** surface showing nurse rows only, editable, reading and writing the
   same master template rows the Master Rota does — so a change in either is visible in
   the other.
2. A new **`nurse_rota` permission area**, so a nursing-team login can edit the nurse
   rota without being able to edit the clinical rota.

Settled at the start of the discussion, and what the rest of this plan assumes:

- **The nurse rota edits the master template only.** Not committed rotas, not a
  week-specific surface. Nurses see the 4-week repeating pattern.
- **A cell is "which room, or not working".** No named nurse duties, no times, no
  breaks — the existing `(session_type, room_id)` cell model is enough.
- **A nurse may be placed in any room**, not just TR, but may not displace a non-nurse.

## What already exists

Most of the data model is in place — nurses were modelled properly when the staff type
was added, they were just never given a surface.

- `DoctorType.NURSE` exists and is **inert to the generation engine**
  (`engine/phases/_shared.INERT_TYPES`): a nurse's room is decided by a human on the
  master rota, Phase 2 copies it into the grid, and no phase reads a nurse as demand or
  moves them. Their room is an ordinary occupied room to everybody else.
- `RoomType.TR` exists (TR1–TR3 at SHC, CK at Cutteslowe) and is in the room-side mirror
  of that rule — no phase may ever allocate one.
- Nurses already flow through generation end to end. Phase 2 is type-agnostic, so a
  nurse row on the template already lands in every generated rota.
- `MasterRotaSessionOut` already carries `doctor_type`, so a nurse-filtered read costs
  nothing new on the wire.

So this is a permissions and UI ticket, not an engine ticket. Nothing in
`backend/app/engine/` needs to change.

## Design Decisions

### DD1 — The nurse rota is its own top-level section, not a tab inside the clinical shell

`ClinicalShell` is wrapped in `<PermissionAreaProvider area="clinical">` and **redirects
anyone who cannot read `clinical` to `/`**. A login holding `nurse_rota: write` and
`clinical: none` — the whole point of requirement 2 — would be bounced off a tab inside
it before it rendered.

This is the identical problem that moved Users and Audit Log out of `ClinicalShell` into
`AdminShell`: see "`/admin/*` is its own section for a permission-shaped reason" in
`architecture.md`. The precedent is direct, so: route `/nurse-rota`, its own
`NurseRotaShell`, its own `SECTIONS` tile on `LandingPage`, wrapped in
`<PermissionAreaProvider area="nurse_rota">`.

**Rejected:** widening `ClinicalShell`'s guard to "can read `clinical` *or*
`nurse_rota`". It would make the shell's single area provider a lie, and every
`useCanWrite()` inside the shell — ~30 call sites — would then be answering about the
wrong area for half its users.

The word "tab" in the original request is therefore served by a landing-page tile rather
than a nav entry beside Master Rota. If it turns out rota administrators want it
adjacent to Master Rota, a `writeOnly` clinical nav entry pointing at `/nurse-rota` is a
one-line addition later — but it crosses a shell boundary, which `architecture.md`
currently rules out ("no route, component, or nav item is shared between shells"), so it
is a decision to take deliberately rather than by default.

### DD2 — `nurse_rota` is a levelled area (`none`/`read`/`write`), not a boolean

Consistent with `clinical`, `reception` and `research`. A nurse who may look but not edit
is the common case — most of the nursing team — and a read level is also what makes the
area lockable (DD7). Booleans are reserved for areas with no meaningful read-only view.

### DD3 — A separate router, `/nurse-rota/*`, writing the same `MasterRotaSession` rows

Permission gating is applied **at router-registration time** in `api/main.py`
(`_AREA[module]`, a mandatory direct subscript). One endpoint therefore cannot serve two
permission areas, so the permission boundary has to be a router boundary. A new flat
module `app/api/routers/nurse_rota.py` alongside `master_rota.py`, serving:

| Method | Path | Notes |
|---|---|---|
| GET | `/nurse-rota/active` | active template, nurse rows only, plus the room list (DD8) |
| PATCH | `/nurse-rota/sessions/{id}` | verbatim `(session_type, room_id)` setter, as master |
| POST | `/nurse-rota/sessions` | create |
| DELETE | `/nurse-rota/sessions/{id}` | delete |

**Note what this makes true, because `architecture.md` does not currently say it:
permission areas and module boundaries are no longer 1:1.** `nurse_rota` is a permission
area *inside* the clinical module — the router imports clinical models and is clinical
code for every import-contract purpose. "Adding a Module" assumes a new area means a new
domain package; this is the first case where it does not, and the architecture doc needs
that stated at the end of the ticket.

### DD4 — "Linked to the master rota" means one table and two views. There is no sync

Both grids read and write the same `MasterRotaSession` rows, so there is nothing to keep
in step and no sync code to get wrong. The Master Rota grid already renders nurse rows
today; the Nurse Rota is the same rows with a `doctor_type === "Nurse"` filter and a
narrower editor.

The one real consequence: `api/masterRota.ts` and a new `api/nurseRota.ts` have separate
TanStack Query keys, so an edit made in one page is not reflected in an *already open*
other page until it refetches. Accepted — it matches every other cross-page staleness in
the app, and the edit lock (DD7) makes simultaneous editing rare.

### DD5 — Nurse rows only, and a nurse may not displace a non-nurse

Every write on the nurse router resolves the target `doctor_id` and refuses unless
`doctor_type == NURSE` (404 on a non-nurse session id, rather than 403 — the session is
not part of this resource).

On rooms: any room is allowed, per the scoping answer. But where the master rota's
endpoints **silently displace** the same-slot holder, the nurse router **refuses with a
409 naming the holder** when that holder is not a nurse. This matters more than it looks:
displacement is otherwise the exact mechanism by which a `nurse_rota`-only login could
reach and mutate a doctor's row, which is the thing the permission exists to prevent.
Nurse-on-nurse displacement keeps the master rota's existing behaviour.

The reverse is deliberately unchanged: a clinical writer on the Master Rota can still
displace a nurse. `clinical: write` is the superset.

A consequence worth naming to the practice: a nurse who books D3 makes D3 unavailable to
the generator for that slot, because an inert occupant's room is an ordinary occupied
room. That is correct behaviour, but it is invisible on the nurse rota. If it turns out
to bite, the follow-up is a Phase 0 warning, not a restriction.

### DD6 — Only three session types on the nurse rota: pre-assigned, admin time, not working

`REQUIRES_ROOM` on a nurse is a **bug state, not a choice**. Nurses are inert, so no
phase rooms them — `phase7_9a`'s docstring says so explicitly ("A nurse left with an
unresolved `REQUIRES_ROOM` slot is reported by Phase 12, not roomed here"). `WFH` for a
nurse is meaningless. So the nurse router accepts `PRE_ASSIGNED`, `ADMIN_TIME` and
`NO_SURGERY` and rejects the other two with a 422, and the popover offers three options.

Enforced server-side, not just hidden in the menu — the client filter is UX, the 422 is
the boundary, same as everywhere else in this app.

The master rota keeps all five for nurse rows: it is a permissive verbatim writer by
design, and narrowing it is a separate (small, and probably worthwhile) change. Worth
considering as an optional extra task: a Phase 0 warning for any nurse row holding
`REQUIRES_ROOM`, which would catch rows predating this work.

### DD7 — `nurse_rota` joins `LOCKABLE_AREAS` with its own lock

Two locks over disjoint row sets of one table. DD5's no-cross-type-displacement rule is
what makes them genuinely disjoint *from the nurse side*, which is the side that matters.

`LOCKABLE_AREAS` carries an import-time assert that it is a subset of `AREA_KEYS`, and
`main.py`'s registration loop adds `require_edit_lock(area)` off the area already in
`_AREA` — so this is two entries and no new mechanism.

**The residual hole, stated rather than closed:** a clinical writer holding the clinical
lock can still edit nurse rows from the Master Rota while a nurse holds the nurse lock.
Accepted — `clinical: write` is the superset, and the practice has one rota
administrator. Closing it would mean making Master Rota writes take both locks, which
would let any nurse block the rota administrator's whole section.

### DD8 — The page fetches its rooms from its own endpoint; `_SHARED_READ` does not grow

`GET /rooms` is clinical-gated, and a `nurse_rota`-only login needs the room list to
render the picker. Rather than add a third `_SHARED_READ` entry — `architecture.md` says
a third needs justification as specific as the two that are there — `GET
/nurse-rota/active` returns `{template_id, name, sessions, rooms}`. One fetch for the
whole page, and no new hole in default-deny.

`GET /doctors` is already in `_SHARED_READ`, so the nurse *rows* come free.

### DD9 — Grid rows come from `/doctors`, not from the sessions payload

Same rule and same reason as `MasterRotaGrid`: active nurses with no template sessions
still get a row, plus any inactive nurse who still holds sessions, badged.

### DD10 — `NurseRotaGrid` is a clone of `MasterRotaGrid`, not a generalisation

The repo has made this call twice already (`StagingGrid` is a clone of `MasterRotaGrid`;
`MasterCellEditPopover` is a deliberate sibling of `CellEditPopover`). Following the
precedent rather than re-litigating it.

It *does* reuse `MasterCellEditPopover` the way `StagingGrid` does — the popover is
hook-agnostic — with the option list narrowed per DD6 and the nurse mutation hooks
swapped in. Week tabs are the fixed 1–4 constant, same as the master grid, for the same
reason (an empty week still needs a tab to click into).

`MasterRotaConflictsPanel` is not cloned: it recomputes double-booked rooms from the
session list, and the nurse page only holds nurse rows, so it could only ever see half a
conflict. Conflicts stay the Master Rota's job.

### DD11 — Undo is included

`MasterRotaPage`'s undo is replay of inverse API calls against live server state
(`lib/masterUndo.ts` + the shared `lib/undoStack.ts`), and cloning it for three mutation
hooks is close to mechanical. `StagingGrid` skipped it, but staging's recovery path is
abandon-and-restart, which the nurse rota does not have — a mis-click here edits the live
template. This is also the least technical audience in the building. Worth the extra
task.

### DD12 — A new "Nurse rota" preset, and the key added to all six existing presets

`PRESETS` are hand-written dicts, not derived from the key list, so **a preset missing the
new key silently grants nothing while claiming to be complete**. Proposed values:

| Preset | `nurse_rota` |
|---|---|
| Manager | `write` |
| Rota admin | `write` |
| Reception admin | `none` |
| Documents | `none` |
| Research | `none` |
| Read-only | `read` |
| **Nurse rota** (new) | `write`, everything else `none`/`false` |

Read-only gets `read` on the same argument the doc already makes for the two rotas: they
are things everyone benefits from seeing.

### DD13 — A data migration, even though the shape needs none

Permissions are string-keyed in a `MutableDict(JSON)` column and `PermissionSet` defaults
every field, so an old row already deserialises correctly. Write the migration anyway, as
research's `016` did: move the column's `server_default` to the new key set and backfill
existing rows with `nurse_rota: "none"`. Without it, every row inserted outside the app
from then on is minted missing the key.

### DD14 — `access_level` is not touched

`AccessLevel.NURSE` already exists as a decorative label, permission-identical to
`DOCTOR`, and nothing gates on it. Do not re-derive the new area from it, and do not
assume a nursing login carries it. `PRESET_FOR_ACCESS_LEVEL["nurse"]` stays
`READ_ONLY_PRESET`.

## Wiring checklist

Adapted from "Adding a Module" in `architecture.md`. This is a new *area* and a new
router inside an existing module, so it is shorter than a full section — but none of it
is optional, and several entries fail silently if skipped.

**Backend**

| Where | What |
|---|---|
| `models/permissions.py` | `AREA_KEYS`, `LOCKABLE_AREAS`, `DEFAULT_PERMISSIONS`, `DEFAULT_PERMISSIONS_JSON`, the new `NURSE_ROTA_PRESET`, and `nurse_rota` in **all six** existing presets |
| `api/deps.py` | `_FORBIDDEN_DETAIL` and `_READ_ONLY_DETAIL` entries |
| `api/schemas/auth.py` | the permissions schema field |
| `api/routers/nurse_rota.py` | new |
| `api/main.py` | import, `_ALL_ROUTERS`, `_AREA` (the assertions fail at import if missed) |
| `api/audit_descriptions.py` | one sentence per non-GET nurse route, or `test_audit_descriptions.py` fails with the missing keys |
| `tests/test_api/test_authorization.py` | `_AREA_FOR_PREFIX["/nurse-rota"]` **and** the new preset in `_PROFILES` — the first fails loudly, the second fails *silently* by never sweeping the preset |
| `backend/pyproject.toml` | `app.api.routers.nurse_rota` added longhand to contract 2's sources (clinical routers are flat modules) and to the other contracts' `forbidden_modules` |
| `alembic/versions/` | DD13 |

**Frontend**

`api/types.ts` · `lib/permissionPresets.ts` (`PERMISSION_AREAS`, `AREA_LABELS`,
`PRESET_ORDER`, `PRESET_LABELS`, the preset dicts) · `lib/userSchema.ts` ·
`components/UserFormDialog.tsx` · `auth/AuthContext.tsx` · `routes/LandingPage.tsx`
(`SECTIONS` tile) · `App.tsx` (`NurseRotaShell`) · new `api/nurseRota.ts`,
`routes/NurseRotaPage.tsx`, `components/NurseRotaGrid.tsx`, `lib/nurseUndo.ts`.

`isEmptyPermissions` and `canReadArea` already loop over the key arrays rather than
naming keys by hand, so they need no edit **provided** `PERMISSION_AREAS` is updated.

## Things to check before this is implemented

These are practical, not architectural, and two of them could change the shape of the
work.

1. **There are only four TR rooms** — TR1, TR2, TR3 at SHC and CK at Cutteslowe. If more
   than four nurses ever run concurrently, the rota cannot represent reality until more
   rooms are added on the Rooms page. Check the spreadsheet against this first; it is a
   five-minute answer that determines whether the surface is usable on day one.
2. **The nurse template rows probably do not exist yet.** Nurses were treated as
   invisible, so their four weeks of pattern may be largely empty, and somebody has to
   enter 4 × 5 × 2 cells per nurse by hand. The only bulk path today is
   `seed_master_rota.py`, a seed script, not a UI. Either budget for the data entry or
   pull forward the "copy week 1 to weeks 2–4" bulk operation already sitting on the
   outstanding-tasks list.
3. **Nurse leave is out of scope and there is no surface for it.** Nurses have no leave
   entitlement in the model (`leave_entitlement.py` gives AHPs, nurses and locums none).
   Phase 2 *does* honour a `Leave` row on a nurse if one exists, so the machinery works —
   but nothing in the UI creates one for a nurse today. If the spreadsheet tracks nurse
   annual leave, that is a separate ticket and should be scoped as one.
4. **The template has no dates, and nurses will ask "where am I next Tuesday?"** This is
   the accepted cost of the template-only decision and it is the right v1 scope, but
   expect it as the first request after launch. The follow-up is small and already
   half-built: a read-only nurse-filtered committed-rota view, needing `doctor_type` on
   `RotaSessionOut` — which is already an outstanding task for the room view.

## Provisional task breakdown

Roughly one chat each, in dependency order.

1. **Permission area wiring + migration.** `models/permissions.py`, `deps.py`,
   `schemas/auth.py`, the Alembic migration, and the `test_authorization.py` entries.
   No router yet — the area exists and grants nothing.
2. **The `/nurse-rota` router.** Schemas, the four endpoints, DD5's type and displacement
   rules, DD6's session-type restriction, DD8's embedded room list, `main.py` wiring,
   `audit_descriptions.py`, the import contract, and API tests.
3. **Frontend permission mirrors.** `types.ts`, `permissionPresets.ts`, `userSchema.ts`,
   `UserFormDialog.tsx`, `AuthContext.tsx` — the new area appears in the user form and
   nowhere else yet.
4. **The section.** `NurseRotaShell` in `App.tsx`, the `LandingPage` tile,
   `api/nurseRota.ts`, `NurseRotaPage`, `NurseRotaGrid`, the narrowed
   `MasterCellEditPopover` option list.
5. **Undo.** `lib/nurseUndo.ts` and the page-level stack, cloned from the master pattern.
6. **Review and documentation.** Update `architecture.md` (the new permission key, the
   lock, and — importantly — the note from DD3 that a permission area is no longer
   necessarily a module) and `architecture-clinical.md` (the nurse rota surface and its
   write rules), then delete this plan.
