# Provisional Plan — Linking App Users to Rota Staff

**Status:** provisional. This is the output of a discussion chat, to be reviewed
and expanded into an implementation plan before any code is written.

## Problem

`users` and the two staff tables (`doctors`, `reception_staff`) are entirely
unrelated. `AccessLevel.DOCTOR` is a permission label, documented in
`models/enums.py` as "not linked to any Doctor or ReceptionStaff row". So the
app knows a request came from Charlie, but not that Charlie is `CH` on the
clinical rota.

That gap is what blocks every per-person feature — a personalised "my rota", a
self-service calendar subscription, "my leave balance", and anything later that
needs to know whose row is whose. This ticket closes the gap and builds the
first features that read from it.

## Scope

**In scope:** an optional link from a `User` to at most one `Doctor` and at most
one `ReceptionStaff`; managing that link; exposing it to the frontend; and one
or more read-only features that use it.

**Out of scope:** anything that lets a user *write* on behalf of their linked
staff member. Every feature here reads. Nothing in this ticket changes the
authorization model — reads are already open to all four tiers, so no new
endpoint needs a permission change, and `require_write_access` is untouched.

Also out of scope: changing what `access_level` means; automatic name matching;
creating logins from the Doctors page; and notifications of any kind.

## Design Decisions

### D1. Two nullable FK columns on `users`, each uniquely indexed

`users.doctor_id` and `users.reception_staff_id`, both `nullable=True`, each
under its own unique index.

- **On `users`, not on the staff tables**, because linking is a privilege
  grant: it decides whose rota is "yours" and, in any future ticket, what you
  are allowed to act on. The Users page is manager-only; the Doctors page is
  writable by any admin. Putting the column on `doctors` would let an admin
  grant themselves a clinical identity.
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
where a false positive means showing someone another person's rota as their own
is a bad trade for saving a one-off set of dropdown clicks at a practice with a
few dozen staff. Not even a "suggested match" hint in v1 — the suggestion is
what gets clicked through.

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

## Task Breakdown

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

### Task 4: The read-only self-service features

Deliberately last, and deliberately small — this task is what proves the link
is shaped right. Candidates, to be narrowed during review rather than all
built:

- **"My rota"** — highlight the logged-in user's own row in `RotaGrid`, and
  default the leave-planning and calendar views to their own doctor.
- **"My leave balance"** — the existing entitlement summary, defaulted to self.
- **Self-service calendar subscription** — an authenticated
  `GET /doctors/me/calendar-feed` returning the current user's own feed URL, so
  a doctor can subscribe without a manager fetching the token for them. The
  unauthenticated `.ics` route itself is unchanged, and the manager-only
  rotation endpoint stays where it is.

All three are GETs, so none of them touches the authorization model.

### Task 5: Review and documentation

The link is live. Fold D1–D5 and the shape of the link into
`documentation/architecture.md` (it is shared infrastructure — auth, not a
rota domain), note the reception-delete interaction in
`documentation/architecture-reception.md`, and delete this plan file.

## Open Questions for the Review Chat

1. **Which of Task 4's three candidates is actually wanted?** Any one of them
   validates the link. Building all three turns a small ticket into a large
   one, and the third (the calendar feed) is the only one that adds an
   endpoint rather than changing a default.
2. **Is a doctor allowed to see other doctors' leave and rota?** Today every
   tier reads everything, and this ticket does not change that. Worth
   confirming that is still intended once individuals have identities in the
   system, because "everyone sees everything" reads differently when the app
   knows who you are — and if the answer is no, that is a much bigger ticket
   than this one and should not be smuggled into it.
