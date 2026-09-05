# Provisional Plan — Linking App Users to Rota Staff

**Status:** provisional. This is the output of a discussion chat, to be reviewed
and expanded into an implementation plan before any code is written.

## Problem

`users` and the two staff tables (`doctors`, `reception_staff`) are entirely
unrelated. `AccessLevel.DOCTOR` is a permission label, documented in
`models/enums.py` as "not linked to any Doctor or ReceptionStaff row". So the
app knows a request came from Charlie, but not that Charlie is `CH` on the
clinical rota. Every per-person feature is blocked on closing that gap:
self-service leave requests, a personalised "my rota", an authenticated
calendar feed, "my leave balance", and later per-user notifications.

## Scope

**In scope:** an optional link from a `User` to at most one `Doctor` and at most
one `ReceptionStaff`; managing it; exposing it to the frontend; and the features
that link unlocks, phased.

**Out of scope:** changing what `access_level` means; automatic name matching;
creating logins from the Doctors page; email or push notification of any kind;
partial approval of a leave request.

## Phasing (a design decision, not scheduling)

The link is a half-day of work. Self-service leave requests is a new model, a
new router, an approval UI and a change to the API's authorization
architecture. Shipping them as one unit means a working link sits behind an
unfinished approval workflow.

- **Phase 1 — the link and read-only self-service.** FK, manager-facing picker,
  `/auth/me` exposure, and the features that only *read*. Useful standing
  alone, and it proves the link's shape before anything writes through it.
- **Phase 2 — leave requests.** Request model, approval workflow, and the
  authorization change that lets a viewer-tier user write one thing.

Phase 2 should be re-planned after Phase 1 lands, not detailed now.

## Design Decisions

### D1. Two nullable FK columns on `users`, each uniquely indexed

`users.doctor_id` and `users.reception_staff_id`, both `nullable=True`, each
under its own unique index.

- **On `users`, not on the staff tables**, because linking is a privilege
  grant: it decides whose leave you may request and whose rota is "yours". The
  Users page is manager-only; the Doctors page is writable by any admin.
  Putting the column on `doctors` would let an admin grant themselves a
  clinical identity.
- **Two typed FK columns, not a polymorphic `(kind, ref_id)` pair**, which
  would give up referential integrity to save one column in a schema that has
  exactly two staff types and no prospect of a third.
- **Unique indexes give the 0..1 : 0..1 semantics for free.** Both SQLite and
  Postgres treat NULLs as distinct in a unique index, so any number of users
  may be unlinked while no two users can claim the same staff row.
- **Both columns may be set on the same user.** Not expected to be common, but
  a nurse who also covers reception is real, and allowing it costs nothing.

### D2. The link is manual, chosen by a manager. No name matching.

`Doctor.code` is initials-style, `ReceptionStaff.code` is a human-typed display
name ("Emily M"), and `User.name` is free text. Matching two free-text fields
where a false positive means booking leave as the wrong person is a bad trade
for saving a one-off set of dropdown clicks at a practice with a few dozen
staff. Not even a "suggested match" hint in v1 — the suggestion is what gets
clicked through.

### D3. The link is orthogonal to `access_level`. Neither derives the other.

A partner who runs the rota needs `manager` tier *and* a doctor link; a
practice manager needs no link at all; a locum may have a Doctor row and no
login. So:

- Linking does not require or imply `access_level == doctor`.
- Changing `access_level` never changes the link, and vice versa.
- `AccessLevel.DOCTOR` stays exactly what its docstring says it is: a label,
  permission-identical to `NURSE`.

This is the decision most likely to get quietly fudged during implementation,
and fudging it produces a permission model with two disagreeing sources of
truth.

### D4. Deactivation and deletion null the link; they never delete a user

- `Doctor` DELETE is a soft delete (`active=False`), so a linked doctor row
  never disappears. A link to an inactive doctor is allowed and shown as such
  rather than being auto-cleared — clearing it silently would lose the record
  of who that login belonged to.
- `ReceptionStaff` DELETE is a **hard** delete that explicitly purges every
  referencing table, with a test in `test_reception_staff.py` asserting the
  purge list is complete. Adding this FK will fail that test, correctly. The
  fix is to null `users.reception_staff_id` in that purge, not to add `users`
  to the delete list.
- Deactivating a user leaves the link intact.

### D5. The link reaches the frontend through `/auth/me`, and nowhere else

`UserOut` gains `linked_doctor` and `linked_reception_staff`, each nullable and
carrying `{id, code}` only. `AuthContext` derives `linkedDoctorId` /
`linkedReceptionStaffId` alongside `canWrite` / `isManager`, so components ask
the context rather than reading the user object — the same one-file-change
property the existing tier comparisons have.

### D6. (Phase 2) A viewer-tier write needs an exemption in `require_write_access`, not a new `_UNGATED` router

`require_write_access` is attached globally in `main.py`'s `include_router`
loop, so every non-GET 403s for `doctor`/`nurse`. A doctor posting their own
leave request is exactly that request. Two options exist and only one is
acceptable:

- Adding the router to `_UNGATED` and gating per-endpoint. This is what
  `users.py` does, and its own docstring correctly calls it default-OPEN and
  invisible to `test_authorization.py`'s sweep. Rejected.
- An exempt `(method, path)` set checked inside `require_write_access` —
  which `deps.py` already nominates as the intended fix for this exact
  situation. **Chosen.** It must be a module constant that the authorization
  sweep imports, so that adding an entry is one deliberate edit in one place
  and the sweep asserts the exemptions are exactly that set.

An exemption makes the path writable by *every* tier, so the endpoint's own
ownership check ("this request is for your linked doctor") is the actual
security boundary, not a convenience. An unlinked user calling it gets a 403.

### D7. (Phase 2) Leave requests are a separate table; `LeaveEntry` stays the engine's truth

A `LeaveRequest` row is a *request*, not leave. Approving one materialises
`LeaveEntry` rows through the existing bulk-add path, so the engine, the
charging calculation and the draft-room-release behaviour are untouched and
un-forked. Rejecting one writes nothing.

Consequences to settle during Phase 2 planning, listed here so they are not
rediscovered: a request stores a date range plus a period mode (not expanded
slots), so the chargeable-session count shown at request time is advisory and
recomputed at approval; approval is whole-request only, with the admin editing
leave directly afterwards for anything finer; and the existing bulk endpoint's
"skipped" reporting covers the case where some of the dates already have leave.

### D8. (Phase 2) There is no notification channel, and the badge is the answer

This app sends no email and has no push. A pending request reaches a manager
only if someone looks at a page, so Phase 2 needs a pending-count badge on the
nav entry. Accepting that deliberately is better than discovering it after the
workflow is built.

## Phase 1 — Task Breakdown

### Task 1: Data model and migration

Files: `backend/app/models/user.py`, `backend/alembic/versions/`,
`backend/tests/test_auth_models.py`.

Add `doctor_id` and `reception_staff_id` to `User` per D1, each a nullable FK
with its own unique index, plus `doctor` / `reception_staff` relationships.
One Alembic revision adding both columns and both indexes, with a downgrade
that drops them; it must survive the Postgres upgrade/downgrade/upgrade round
trip that CI runs. No backfill — every existing row is legitimately unlinked.

### Task 2: API — reading and setting the link

Files: `backend/app/api/schemas/auth.py`, `backend/app/api/routers/users.py`,
`backend/app/api/routers/reception_staff.py`,
`backend/tests/test_api/test_users.py`,
`backend/tests/test_api/test_reception_staff.py`.

- `UserOut` gains the two nullable link objects (D5); `UserIn`/`UserPatch` gain
  nullable `doctor_id` / `reception_staff_id`. They are **not** added to
  `UserSelfPatch` — self-linking is self-promotion.
- Reject a link to a nonexistent staff row (404) and to one already claimed by
  another user (409, matching the email-conflict precedent in the same file).
- Extend the `ReceptionStaff` hard-delete purge to null the link (D4), which is
  also what makes the existing FK-coverage test pass again.

### Task 3: Frontend — the picker and the auth context

Files: `frontend/src/api/types.ts`, `frontend/src/auth/AuthContext.tsx`,
`frontend/src/routes/UsersPage.tsx` (and its dialog), plus tests.

Two dropdowns on the user create/edit dialog, sourced from the existing doctors
and reception-staff hooks, each with an explicit "not linked" option and each
excluding staff already claimed by another user. `AuthContext` exposes the
derived ids per D5. Mirror the new wire fields in `types.ts` by hand, as that
file's convention requires.

### Task 4: The first read-only self-service features

Deliberately last, and deliberately small — this task is what proves the link
is shaped right. Candidates, to be chosen during review rather than all built:

- "My rota" — highlight the logged-in user's own row in `RotaGrid`, and default
  the leave-planning and calendar views to their own doctor.
- "My leave balance" — the existing entitlement summary, defaulted to self.
- An authenticated `GET /doctors/me/calendar-feed` returning the current user's
  feed URL, so a doctor can subscribe without a manager fetching the token for
  them. The unauthenticated `.ics` route itself is unchanged.

### Task 5: Review and documentation

Phase 1 is live. Fold D1–D5 and the shape of the link into
`documentation/architecture.md` (it is shared infrastructure — auth, not a
rota domain), note the reception-delete interaction in
`documentation/architecture-reception.md`, remove "request leave by user" from
`documentation/planned_updates.md` only once Phase 2 has shipped, and delete
this plan file.

## Open Questions for the Review Chat

1. **Does reception get self-service leave in Phase 2, or clinical only?**
   `ReceptionLeaveEntry` is much thinner than `LeaveEntry` (whole days, no
   period, no notes), so the two request flows would not share a schema. Doing
   both roughly doubles Phase 2's API and UI surface. Recommendation:
   clinical first, reception as a follow-on.
2. **Should an approved leave request be revocable by the requester?** Cancelling
   approved leave means deleting `LeaveEntry` rows that a committed rota may
   already reflect. Recommendation: no — cancellation is an admin action.
3. **Which of Task 4's three candidates is actually wanted first?** Any one of
   them validates the link; building all three before Phase 2 delays the
   feature that motivated this.
4. **Is a doctor allowed to see other doctors' leave?** Today every tier reads
   everything, and Phase 1 does not change that. Worth confirming that is
   still intended once individuals have identities in the system, because
   "everyone sees everything" reads differently when the app knows who you are.
