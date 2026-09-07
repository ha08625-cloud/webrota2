# Fine-Grained Permissions — Provisional Plan

Status: **provisional**. Written in the discussion chat, not yet reviewed
against every call site. Step 2 of the workflow is to paste this into a new
chat, correct it, and expand the task sketches at the bottom into a full
implementation plan with per-task file lists and instructions.

## Plan

Replace the single four-value `access_level` tier with a per-user
**permission set**: an access level (`none` / `read` / `write`) for each of
the two rota areas, plus boolean capabilities for the document tools and for
user administration. The existing role names survive only as presets that
pre-fill the permission set when a user is created; nothing checks the role
at request time afterwards.

The motivation is the signature feature: uploading and applying signatures is
admin work, but it exposes a scanned signature image, and that should be
available to as few logins as possible — independently of whether someone can
edit a rota.

### State of the world today

Backend (`backend/app/api/deps.py`, `backend/app/api/main.py`):

- `User.access_level` is one enum, mapped to integer tiers in `deps.py`:
  `nurse` and `doctor` are both 0, `admin` 1, `manager` 2. Doctor and nurse
  are deliberately permission-identical labels.
- `require_write_access` is method-aware and attached **once**, in main.py's
  `include_router` loop, to every router except `auth`, `users` and
  `calendar`. That is what makes writes default-deny: a new router or a new
  POST is gated the moment it is registered.
- `require_manager` is method-agnostic and applied per-endpoint, in
  `routers/users.py`, `routers/audit.py` and the doctor-rotation endpoint.
- **Reads are open to every authenticated user, everywhere.** There is no
  read gating anywhere in the system.

Frontend:

- `frontend/src/auth/AuthContext.tsx` derives `canWrite` and `isManager` and
  is the only place the tier is compared. ~30 components consume
  `useCanWrite` / `useWriteGate` / `useIsManager`.
- `App.tsx` has three shells — `ClinicalShell` (`/clinical/*`),
  `ReceptionShell` (`/reception/*`), `SignaturesShell` (`/signatures/*`,
  holding Signatures and Study EOI) — plus a landing page. Nav items carry an
  optional `managerOnly` flag; only Users and Audit Log use it.

The router set is already cleanly partitioned by area, and gating is already
centralised in one dependency. That is what makes this a moderate job rather
than a rewrite.

## Scope

**In scope**

- Per-area permissions for clinical rota, reception rota, signatures, study
  EOI, and user administration.
- Read gating (the "read only" half of the request), which does not exist
  today.
- Frontend nav filtering, route guards, and section-scoped write gating.
- A permissions editor in the Users admin page.
- Reworking `backend/tests/test_api/test_authorization.py`'s sweeps.

**Out of scope**

- Per-record permissions ("may edit only their own leave"). The existing
  `linked_doctor` / `linked_reception_staff` machinery already covers the
  "mine" cases and is orthogonal to this.
- Any change to what the pages themselves do.
- Audit log content changes (it already records `user_access_level`; that
  field's meaning is revisited in Task 1).

## Design Decisions

**D1 — Levels per area, not six flat flags.** The request lists "clinical
rota" and "clinical rota — read only" as two permissions. They are one
permission with two levels. Modelling them as `none` / `read` / `write` per
area halves the number of controls and makes contradictory states
("read-only" and "write" both ticked) unrepresentable, rather than something
the code has to resolve. Signatures and study EOI stay booleans — there is no
meaningful read-only view of a document generator.

**D2 — Five permissions in total.**

| Permission | Type | Covers |
| --- | --- | --- |
| `clinical` | none / read / write | the whole `/clinical` section |
| `reception` | none / read / write | the whole `/reception` section |
| `signatures` | bool | upload, delete, apply, and **view** signature images |
| `study_eoi` | bool | the EOI autofill tool |
| `user_admin` | bool | user management and the audit log |

`user_admin` replaces today's `require_manager`. It is a separate permission
rather than part of `clinical: write` because it is the one that can grant
every other permission.

**D3 — Storage: a JSON column on `users`.** A `permissions` JSON/JSONB column
holding an object (`{"clinical": "write", "reception": "none", "signatures":
true, ...}`), not a boolean column per permission and not an association
table. The set is small, always read whole, never queried across users, and
adding a sixth permission should not be a migration. Nothing is live, so
there is no data migration beyond `backend/seed/seed_users.py`.

**D4 — Keep `access_level`, demote it to a preset.** The column stays and
keeps its enum, because the audit log snapshots it and because "manager" is
still a useful label in the UI. It stops being consulted for authorization.
Creating a user picks a role, which pre-fills the permission checkboxes;
after that the checkboxes are the truth. Reviewer note: the alternative is to
drop the column entirely and store the preset name — decide in step 2.

**D5 — Gating stays centralised and default-deny.** No per-endpoint
permission decorators. main.py grows a `router module -> area` map, and
`require_access` (the generalised `require_write_access`) looks the request's
router up in it and compares the method against the user's level for that
area. A router that is not in the map raises at import time rather than
defaulting to open, so adding a router without classifying it is a startup
failure, not a silent hole. This preserves the property the current design
was built around and the reason it must not become per-endpoint: with ~78
non-GET and ~39 GET routes, per-endpoint gating is default-open.

**D6 — Reads become gated, with a shared-reference exemption.** Gating GETs
is the substantive change: today every tier reads everything. A small set of
endpoints must stay readable by any authenticated user because other areas
depend on them — the known case is `GET /doctors`, which the Signatures page
calls (`useDoctors()` in `routes/SignaturesPage.tsx`) to build its
Partner/Salaried picker. Options: (a) classify `doctors` GET as shared-read,
(b) add a minimal id/name/type endpoint for the signature picker and keep the
full doctor list clinical. (a) for the first cut, (b) if the doctor record
turns out to carry anything worth withholding. **This needs a decision in
step 2**, along with a swept list of every other cross-area read.

**D7 — Frontend: the section provides the area, so call sites do not
change.** Components are almost all section-specific. Putting a
`<PermissionAreaProvider area="clinical">` in each shell lets `useCanWrite()`
resolve the area from context, so the ~30 existing `useCanWrite` /
`useWriteGate` call sites need no edit. Only genuinely cross-area components
(none identified yet — verify in step 2) would need an explicit area.

**D8 — Route guards, not just hidden nav.** Hiding a nav item is not enough
once reads are gated: a bookmarked `/reception/leave` would otherwise render
a page full of failed queries. Each shell redirects to the landing page (with
an explanatory message) when the user has no access to that area, and the
landing page shows only the sections the user can enter. The frontend gating
remains UX only — the API 403 is still the security boundary.

**D9 — Fix the signature-image hole first and separately.** `GET
/signatures/{doctor_id}/image` (`backend/app/api/routers/signatures.py:118`)
returns the stored signature image and is covered only by the *write* gate,
which does not apply to GETs. Every logged-in user, nurse tier included, can
currently fetch every stored signature. That is the exact exposure this whole
piece of work is meant to close, and it does not need the permission model to
fix — see Task 0.

## Open questions for the review chat

1. **D6**: the full list of cross-area reads. `GET /doctors` from the
   Signatures page is confirmed; `closures` and `school_holidays` are
   clinical routers that reception scheduling may or may not read — check the
   reception pages and `app/reception_*.py` before classifying them.
2. Should `signatures` and `study_eoi` imply read access to anything else, or
   is the shared-reference set from D6 sufficient?
3. Does a reception-only user need to *see* the clinical rota (many practices
   want reception to read the doctor rota)? If commonly yes, the default
   preset for reception staff should be `clinical: read`.
4. What happens to a user with no areas at all — is that a valid state (login
   works, landing page empty) or should the form refuse to save it?
5. The existing "last active manager" guard in `routers/users.py`
   (`_active_manager_count`) becomes "last active `user_admin`". Confirm that
   is the intended replacement.
6. Does the audit log's `user_access_level` snapshot become the permission
   set, or stay the (now decorative) role label? Snapshotting the permissions
   is more useful for "why was this allowed", and is a wider column change.

## Proposed task breakdown

To be expanded into the full template in step 2. Task 0 is independent of
everything else and can ship on its own.

**Task 0 — Close the signature-image read hole.** Gate `GET /signatures` and
`GET /signatures/{id}/image` to admin/manager under the *existing* tier
model, ahead of the permission work. Small, self-contained, and removes the
live exposure immediately. Touches `routers/signatures.py`, needs a
regression test asserting a viewer-tier 403 on the image endpoint.

**Task 1 — Data model.** `permissions` column on `User` + Alembic migration;
the permission types and preset-per-role table; `UserOut` / user schemas;
`seed_users.py`. No gating changes yet — the column is written and returned
but nothing reads it.

**Task 2 — Backend gate rework.** Generalise `require_write_access` into
`require_access` in `deps.py`; add the router-to-area map in `main.py` with
the import-time completeness check; replace `require_manager` with the
`user_admin` check in `users.py`, `audit.py` and the doctor-rotation
endpoint; implement the shared-read exemption from D6.

**Task 3 — Authorization test rework.** `tests/test_api/test_authorization.py`
currently sweeps every GET asserting all tiers can read (39 routes) and every
non-GET asserting viewers are blocked (78 routes). Both sweeps become
per-area: for each permission profile, every route in an area the profile
cannot reach must 403, and every route it can reach must not be blocked by
the gate. Keep the "sweep is not empty" tripwires. This is the task that
keeps the system default-deny; do not trim it.

**Task 4 — Frontend permission model.** `AuthContext.tsx`: replace
`canWrite` / `isManager` with the permission set plus the area provider from
D7; keep `useCanWrite` / `useWriteGate` signatures intact so call sites are
untouched. Nav filtering (generalise `managerOnly` to a permission
predicate), the three shells' area providers, route guards, and the landing
page's section list.

**Task 5 — Users admin UI.** Permission editor in `UserFormDialog.tsx` /
`UsersPage.tsx`: role preset picker that fills the controls, then per-area
radio groups and per-capability checkboxes. Show the effective permissions in
the user list.

**Task 6 — Review and documentation.** State of the world: Tasks 0–5 complete
and the feature is live. Update `documentation/architecture.md` with the
permission model and the default-deny gating property, remove the stale
four-tier description, and delete this plan file.

## Effort

Roughly: Task 0 is under an hour. Tasks 1–2 are the backend day, Task 3 a
half-day of careful test work, Tasks 4–5 the frontend day. The read gating
(D6) is the part most likely to overrun, because it is the only part where
the current system has no equivalent to generalise from.
