# Implementation Plan — Governance Documents area

Reviewed and corrected from the provisional plan produced in the discussion
chat. Every code fact below was re-verified against the file it names during
the review. Corrections made in review are marked **[review]** so the
reasoning behind a change from the provisional plan is not lost.

Two values are still open and are marked `TODO(decide)` in the text. Neither
blocks Task 1; both must be settled before Task 2 ships.

## Gate before any code is written

Record, in writing, that there is genuinely nowhere else for these documents
to live. This feature is a small document management system with no
versioning, no search beyond a text filter, no retention policy and one
maintainer. It is justified if the alternative is "nowhere". If the practice
has a SharePoint or Teams that is merely unloved rather than absent, fixing
that is the better answer and this feature should not be built.

**[review]** In the provisional plan this was a paragraph of prose. It is a
gate because it is the only part of this plan that can save four chats.

## Plan

A new top-level section alongside Clinical, Reception and Signatures:
upload a document, list what is stored, download it, replace it, edit its
metadata, delete it. One flat collection, bytes in Postgres, manager-only
writes, reads open to every logged-in tier.

The immediate driver is DTAC packs held by the data protection lead. These
are not public but carry nothing confidential. The app is a plausible home
only because it already solves the hard parts: real per-user login with no
anonymous access and no fail-open, a Postgres database that is backed up,
same-origin deployment, and an audit log that captures every write for free.
Nothing else about a rota generator makes it a document store.

## Scope

In scope: list, upload, download, replace file, edit title/description,
delete. A standing non-dismissible warning on the page. A fourth landing
tile and a `/governance` route.

Out of scope, each by an explicit decision below: version history, review or
expiry dates, per-document access restriction, folders or categories,
full-text search inside documents, bulk download, and any link to doctors,
reception staff or rotas.

## State of the world (verified)

- `DoctorSignature` is the only existing blob store: bytes in Postgres via
  `LargeBinary`, `content_type` and `uploaded_at` as sibling columns, no
  object storage and no filesystem (`backend/app/models/signature.py`).
- Railway runs one service from the repo root with an ephemeral container
  filesystem (`railway.toml`, "Deployment" in
  `documentation/architecture.md`). Anything written to disk is lost on
  redeploy, so bytea is not merely a preference.
- Routers are registered in one loop in `backend/app/api/main.py`, each with
  `Depends(require_write_access)` unless listed in `_UNGATED`. Only `auth`
  and `users` are exempt.
- `require_manager` (`backend/app/api/deps.py:186`) gates reads as well as
  writes and is already used per-endpoint by `routers/users.py` and
  `routers/audit.py`.
- `AuditMiddleware` (`backend/app/api/audit.py`) captures every non-GET
  request automatically. Request bodies are audited as JSON only; multipart
  passes through unbuffered and never lands in memory or the log — the two
  signature uploads already rely on this. GET requests are not audited
  anywhere in the app, by an explicit decision.
- `routers/users.py` has **no** `DELETE` endpoint: users are deactivated via
  `PATCH`, never removed. An FK to `users` therefore never dangles.
- `frontend/src/api/client.ts` has `postForm` (multipart, JSON response,
  `:115`), `getBlob` (`:165`) and `postFormBlob` (`:177`).
- `downloadBlob` (`frontend/src/lib/downloadBlob.ts`) triggers a browser
  save from an in-memory Blob, and lives in its own module specifically so
  tests can mock it.
- `LandingPage` (`frontend/src/routes/LandingPage.tsx`) is a
  `sm:grid-cols-2` grid of three tiles; a fourth needs no layout change and
  in fact squares the grid off.
- `App.tsx` mounts one self-contained shell per section, sharing no route,
  component or nav item. `SignaturesShell` (`frontend/src/App.tsx:205`) is
  the model: a single page on its own top-level route.

### Four corrections to the provisional plan's reading of the code

1. **`apiClient.getBlob` does not return a filename.** The
   `Content-Disposition` parser (`parseFilename`, `client.ts:133`) is wired
   into `postFormBlob` only; `getBlob` returns a bare `Blob` and discards
   headers. See Decision 12.
2. **`_StubUser` is not a database row.** `backend/tests/test_api/conftest.py:101`
   sets `id = 1` on a lightweight object, and `api_engine` enables
   `PRAGMA foreign_keys=ON`. An FK to `users` therefore fails on insert in
   every API test unless a real row is seeded. The conftest docstring
   predicts exactly this. See Task 2 deliverable (f).
3. **`App.test.tsx` covers `ClinicalShell` nav only.** Every case sits under
   `describe("ClinicalShell nav")` / `"ClinicalShell nav by access level"`.
   There is no test of the landing tiles and none of `SignaturesShell`;
   `LandingPage.tsx` has no test file at all. Task 3's nav test is new
   ground, not a pattern copy.
4. **There is no security-headers middleware.** `main.py` registers CORS and
   `AuditMiddleware` and nothing else; `nosniff` appears nowhere in
   `backend/app`. Decision 4's headers must be set per-response on the
   download endpoint — there is no shared layer they could be forgotten in.

## Design Decisions

1. **Named narrowly: "Governance Documents", route `/governance`.** An area
   called "Documents" accumulates whatever people have lying around — an
   incident log naming a patient, a disciplinary letter, a contract with
   bank details. That is the actual data protection risk in this feature.
   "Governance" covers DTAC packs, clinical safety cases, DPIAs, supplier
   assurance and policies, and reads as wrong for anything personal.

   **[review]** The provisional plan called naming "the primary control".
   It is the weakest of the three. Naming acts only on someone who stops to
   think about the name; Decision 2 acts at the moment of upload and
   Decision 6 bounds who can upload at all. Keep the name; stop asking it to
   carry the feature.

   `TODO(decide)`: confirm "Governance Documents" against what will actually
   be filed, or substitute another **narrow** name. Not a broad one.

2. **Reinforced by a standing UI warning.** The page carries a permanent,
   non-dismissible line: not for patient-identifiable, personal or
   confidential information. Free to build, and it is the thing a user
   actually sees at the moment they are about to upload the wrong file.

3. **Bytes in Postgres bytea, following `DoctorSignature`.** No object
   storage, no filesystem. Backups stay atomic and there is no second system
   to operate. The ceiling is honest and goes in the model docstring: the
   whole file is held in memory on upload and download, and every document
   inflates the database backup. Fine for tens to low hundreds of documents;
   the signal to move to object storage is upload size growth, not document
   count.

   `TODO(decide)`: the upload cap. `20 MB` is the provisional value. Set it
   from the largest DTAC pack actually held, not guessed — and note it is
   the **only** size bound anywhere in the stack (Decision 14). If nobody
   can measure it, ship 20 MB and record in the docstring that it was a
   guess.

4. **Downloads are always `Content-Disposition: attachment`, never inline,
   with `X-Content-Type-Options: nosniff`.** FastAPI serves the SPA
   same-origin (`mount_frontend()`) and the session token lives in
   `localStorage` (`auth/tokenStore.ts`). An uploaded `.html` or `.svg`
   served inline from this origin would execute script with full access to
   that token. Serving every download as an attachment defuses it regardless
   of what was uploaded. Set both headers explicitly on the response; there
   is no middleware to put them in (correction 4 above).

5. **Upload allowlist rather than magic-byte sniffing, with the extension
   authoritative.** Signatures sniffs leading bytes because it must branch
   on format to process the file; this feature stores and returns bytes
   untouched, so an allowlist is proportionate. Allowed: `.pdf`, `.docx`,
   `.xlsx`, `.pptx`, `.txt`, `.csv`, `.png`, `.jpg`/`.jpeg`. HTML and SVG
   are excluded explicitly even though Decision 4 already covers them — two
   independent controls, because this one is a one-line regression away from
   being removed.

   **[review]** The provisional plan allowlisted extensions *and* declared
   content types together. `.docx`/`.xlsx`/`.pptx` are zip containers and
   browsers routinely send `application/octet-stream` or `application/zip`
   for them — which is why `apply_signature` refuses to check declared
   content type at all (`signatures.py:208`). An allowlist over declared
   types would bounce real DTAC packs. So: **the extension decides**; the
   declared content type is stored for display and never used to accept or
   reject.

6. **Manager-only writes, layered on the global gate, not exempted from
   it.** Upload, replace, edit and delete each take
   `Depends(require_manager)`, while the router stays inside the normal
   `require_write_access` registration. `_UNGATED` is not touched: unlike
   `users`, this router has no endpoint that every tier must be able to
   call, so an exemption would buy nothing and cost the default-deny
   property.

   *Recorded so it is a decision rather than an oversight:* admin staff can
   read and download but cannot file anything, and admin staff are usually
   the people who file documents. Chosen knowingly. Loosening later is a
   one-line change to a dependency list; tightening after people have
   started uploading is not.

7. **Reads open to every logged-in tier, and not audited.** Consistent with
   the app-wide decision that reads are not logged. It holds here only
   because of Decisions 1, 2 and 5: the content is non-sensitive by
   construction. If the sensitivity ceiling ever rises, auditing GETs on
   this one router — as a deliberate, documented exception — is the first
   thing to add.

8. **No versioning: replace and delete act in place.** Re-uploading
   overwrites; the audit log records that it happened, who did it and when,
   but not the superseded bytes. The rejected alternative — a version row
   per upload — roughly doubles the schema and the UI and adds unbounded
   storage growth with no pruning story, for a store where the current
   version is what anyone wants.

9. **No review or expiry dates.** Explicitly considered and dropped. DTAC
   packs and safety cases do need periodic reassessment, and a due/overdue
   view would be the feature that most earns this area its keep. It stays
   out of the first cut. If it is ever added it is additive — nullable
   column plus a filter — and invalidates nothing here.

10. **Flat list with a client-side text filter over title and description.
    No folders or categories.** At tens of documents a category scheme is
    ceremony, and it is the kind of taxonomy that gets designed wrong before
    anyone knows what will be stored. Default ordering is `uploaded_at`
    descending.

11. **`uploaded_by_user_id` is stored on the row, denormalised from the
    audit log.** The log can answer "who uploaded this" only by matching a
    timestamp to a path, which is unusable in a list view. One FK to `users`
    makes the list genuinely useful. `DoctorSignature` omits this because
    nothing displays it.

    **[review]** No name snapshot. `routers/users.py` has no `DELETE` — users
    are deactivated, never removed — so the FK cannot dangle and the join
    always resolves. One consequence, recorded so it is not later filed as a
    bug: renaming a user retroactively changes the displayed uploader on
    their old documents. That is correct behaviour for an attribution field.

12. **Downloads go through `apiClient.getBlob` and `downloadBlob`, never a
    plain `<a href>`, and take the filename from the list payload.**
    Authentication is an `Authorization: Bearer` header, not a cookie, so a
    direct link to the download endpoint 401s — worth stating because it is
    the obvious first implementation and it fails in a way that looks like a
    permissions bug.

    **[review]** The provisional plan had the frontend read the filename off
    `Content-Disposition`. `getBlob` discards headers (correction 1). Do
    **not** extend the shared client for one caller: the list already
    carries `original_filename` for display, so pass that straight to
    `downloadBlob`. The server still sends the header — it is what makes
    Decision 4 true — the client just does not read it.

13. **Replace is its own endpoint; Signatures' upload-or-replace shape is
    not copied.** Signatures keys on `doctor_id`, a natural unique key, so
    one call can mean either. Governance has no natural key: `POST` must
    create, so replace has to target an id. Delete-then-upload is not
    equivalent — it burns the id and resets `uploaded_at`/`uploaded_by` in a
    way that reads as a new document. Endpoints:

    | Method | Path | Gate | Purpose |
    |---|---|---|---|
    | `GET` | `/governance` | any tier | list metadata, newest first |
    | `GET` | `/governance/{id}/file` | any tier | download bytes as attachment |
    | `POST` | `/governance` | manager | create (multipart: file + title + description) |
    | `PUT` | `/governance/{id}/file` | manager | replace bytes in place |
    | `PATCH` | `/governance/{id}` | manager | edit title/description (JSON) |
    | `DELETE` | `/governance/{id}` | manager | delete, 204 |

14. **The size cap is checked before the bytes are read, and it is the only
    bound in the stack.** **[review]** Signatures reads the whole upload and
    then checks `len()` (`signatures.py:150`). Starlette spools multipart
    beyond ~1 MB to a temp file, so an unbounded upload writes to Railway's
    ephemeral disk — the disk of the one container that also serves the app —
    before the 413 fires. Nothing else in the stack limits request size.
    Check `UploadFile.size` first and 413 immediately; re-check the length
    after reading, since `size` is client-advisory.

15. **The stored filename is sanitised on the way out.** **[review]** The
    filename is user-supplied and goes into a `Content-Disposition` header.
    A filename containing `"` or CRLF is header injection, sitting directly
    beside the decision this plan calls its most important. Reuse
    `signatures.py`'s `_safe_filename_stem` / `_FILENAME_SAFE` rather than
    reinventing them; store the original for display, sanitise for the
    header.

16. **The download serves `application/octet-stream`, not the stored content
    type.** **[review]** Decision 4 defuses inline rendering, but echoing a
    client-declared MIME string back is unnecessary risk for no gain. Store
    the declared type for the list view; serve octet-stream. This makes
    Decisions 4 and 5 independent of each other, which is what Decision 5
    says it wants.

17. **The list endpoint must not load the file bytes.** **[review]** A plain
    `select(GovernanceDocument)` pulls every document's bytea into memory on
    every page load — the whole store, for a list view. Defer the data
    column, or select columns explicitly. Note that `list_signatures`
    (`signatures.py:117`) has this bug today, so copying that precedent is
    the failure mode to avoid.

18. **Its own shell, its own tile, sharing nothing.** `GovernanceShell`
    modelled on `SignaturesShell` — one page, one route, its own header and
    `ChangePasswordDialog`.

---

# Task 1: Data model and migration

**A. State of the world.** Nothing built yet. This task adds the table and
nothing else — no router, no schemas, no frontend.

**B. Files and deliverables.**

- `backend/app/models/governance.py` — new, `GovernanceDocument`.
- `backend/app/models/__init__.py` — import and `__all__` entry.
- `backend/alembic/versions/007_governance_documents.py` — new; `006` is the
  current head (`006_reception_displaced_role.py`).

**C. Instructions.**

Columns, exactly:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | int PK | no | |
| `title` | `String` | no | user-supplied, shown in the list |
| `description` | `String` | yes | free text, filtered on with `title` |
| `original_filename` | `String` | no | as uploaded; sanitised at serve time, not at store time |
| `content_type` | `String` | no | as declared by the client; display only, never trusted (Decisions 5, 16) |
| `size_bytes` | int | no | shown in the list; avoids `length(data)` on every read |
| `data` | `LargeBinary` | no | the file itself |
| `uploaded_at` | `DateTime(timezone=True)` | no | no model or DB default — set explicitly by the router, matching `DoctorSignature` |
| `uploaded_by_user_id` | int FK `users.id` | no | Decision 11 |

Add a `relationship()` to `User` with no `back_populates` — this is a
one-directional attachment and `User` stays untouched, exactly as
`DoctorSignature` leaves `Doctor` alone.

The module docstring carries Decision 3's ceiling in full: whole file in
memory both directions, every document inflates the backup, the move signal
is upload size not document count, and the cap is the only size bound in the
stack.

The migration is a plain `create_table` / `drop_table` — no enums, so no
native type cleanup. It must survive CI's Postgres
upgrade/downgrade/upgrade round trip. `LargeBinary` maps to `BYTEA` on
Postgres and `BLOB` on SQLite, as it already does for `doctor_signatures`.

---

# Task 2: Backend router, schemas and tests

**A. State of the world.** Task 1 is done: the `GovernanceDocument` model
and its migration exist. There is no router, no schema and no test file.

**B. Files and deliverables.**

- `backend/app/api/schemas/governance.py` — new.
- `backend/app/api/schemas/__init__.py` — re-exports.
- `backend/app/api/routers/governance.py` — new.
- `backend/app/api/main.py` — import, and add to `_ALL_ROUTERS`. **Not**
  `_UNGATED` (Decision 6).
- `backend/tests/test_api/conftest.py` — a fixture seeding a real `User`
  row (deliverable (f) below).
- `backend/tests/test_api/test_governance.py` — new.

**C. Instructions.**

(a) **Schemas are metadata only** — bytes never travel as JSON. Follow
`schemas/signature.py`, including its docstring habit of saying so.
`GovernanceDocumentOut` carries `id`, `title`, `description`,
`original_filename`, `content_type`, `size_bytes`, `uploaded_at`,
`uploaded_by_user_id` and a resolved `uploaded_by_name`.
`GovernanceDocumentPatch` carries optional `title` and `description` only.

(b) **The six endpoints of Decision 13.** Writes take
`Depends(require_manager)` individually; the router is registered in the
normal gated loop.

(c) **Upload validation, in this order** — the order is the point:

1. `UploadFile.size` over the cap → 413 before any read (Decision 14).
2. Extension not in the allowlist → 422 (Decision 5). Extension decides;
   declared content type is stored, never consulted.
3. Read the bytes; length over the cap → 413 (client-advisory `size`).

(d) **Download** returns `Response` with `media_type="application/octet-stream"`
(Decision 16) and headers `Content-Disposition: attachment; filename="..."`
plus `X-Content-Type-Options: nosniff` (Decisions 4, 15). The filename is
run through `signatures.py`'s `_safe_filename_stem` / `_FILENAME_SAFE` —
import and reuse, or lift them to a shared helper if that reads better; do
not write a second copy.

(e) **The list query must not load `data`** (Decision 17): `defer()` the
column or select the others explicitly. Order by `uploaded_at` descending.
Resolve `uploaded_by_name` with a join to `users`, not an N+1 per row.

(f) **The test-fixture trap, and the reason this task is not small.**
`_StubUser` (`conftest.py:101`) has `id = 1` but is not a database row, and
`api_engine` turns on `PRAGMA foreign_keys=ON`. Every insert carrying
`uploaded_by_user_id` will raise `IntegrityError` until a matching `users`
row exists. The conftest docstring already anticipates this: *"if a future
router needs a real FK to users, switch that test to a real row instead of
widening the stub."*

Add a fixture that inserts a real `User` whose `id` matches the stub's, and
have the governance tests request it. Do **not** widen `_StubUser` and do
**not** loosen the FK. Keep the change additive so no existing test file
changes behaviour.

(g) **Tests.** Cover: the size cap (both branches of (c)); the extension
allowlist, including a `.docx` sent as `application/octet-stream` being
**accepted** and an `.html` being **rejected**; the attachment and nosniff
headers on download; a filename containing a `"` not escaping the header;
the list query not returning bytes; and each tier against each endpoint
(viewer/admin read but cannot write, manager can).

Note the conftest trap for the tier tests: `app.dependency_overrides` is one
dict on one shared `app`, so a test may use **exactly one** client fixture.
`client_at_tier` raises on a second call rather than failing mysteriously.
Split per-tier assertions into separate tests.

---

# Task 3: Frontend

**A. State of the world.** Tasks 1 and 2 are done: the table exists and the
six endpoints are live and tested. Nothing frontend exists.

**B. Files and deliverables.**

- `frontend/src/api/governance.ts` — TanStack Query hooks.
- `frontend/src/api/types.ts` — the `GovernanceDocument` wire mirror.
- `frontend/src/routes/GovernanceDocumentsPage.tsx` + `.test.tsx`.
- `frontend/src/App.tsx` — `GovernanceShell` and the `/governance` route.
- `frontend/src/routes/LandingPage.tsx` — a fourth tile.
- `frontend/src/App.test.tsx` — a nav/route case.

**C. Instructions.**

(a) **Hooks** follow the per-resource convention: hierarchical query keys,
mutations invalidating the resource's key root rather than splicing.
Multipart create/replace go through `apiClient.postForm`; `PATCH` and
`DELETE` through `apiClient.patch` / `.delete`.

(b) **Download** uses `apiClient.getBlob` plus `downloadBlob`, with the
filename taken from the row already in the list — not from
`Content-Disposition`, which `getBlob` discards (Decision 12). Mock
`@/lib/downloadBlob` in the test, as `SignaturesPage.test.tsx` does.

(c) **The standing warning** (Decision 2) is permanent and non-dismissible,
rendered above the upload control where it is read before a file is chosen,
not below the list. Assert its presence in the test — it is a control, so it
gets a test like any other.

(d) **Write controls use the existing gate**, but note this section is
manager-only for writes while `useCanWrite()` is manager-**or-admin**. Use
`useIsManager()` / `useWriteGate()`'s manager equivalent here, or the UI will
offer an admin an upload button that 403s. Frontend gating is UX only — the
403 is the boundary — but an enabled control that always fails is worse than
a disabled one.

(e) **`GovernanceShell`** is modelled on `SignaturesShell`
(`App.tsx:205`): its own header, a "Switch app" link, `ChangePasswordDialog`
(open to every tier), logout, and one page in `<main>`. It shares no route,
component or nav item with any other shell.

(f) **The landing tile** goes in the existing `sm:grid-cols-2` grid — no
layout change, and a fourth tile squares it off. Copy the tile markup from
its siblings.

(g) **Tests.** `App.test.tsx` gets a case driving `/governance` through
`window.history` and asserting the shell renders — note this file currently
covers `ClinicalShell` only, so this is a new `describe`, not an added case
in an existing one. The page test covers: the warning renders, upload posts
multipart, download calls the mocked `downloadBlob` with the row's filename,
the text filter matches on both title and description, and a non-manager
sees no enabled write control.

---

# Task 4: Documentation, and delete this plan

**A. State of the world.** Tasks 1–3 are done: the feature is built, tested
and merged.

**B. Files and deliverables.**

- `documentation/architecture.md` — a Governance Documents subsection.
- `documentation/governance_documents_plan.md` — deleted.

**C. Instructions.**

Fold the decisions above into `documentation/architecture.md`. The section
is small enough not to warrant its own architecture doc, exactly as
Signatures is — put it beside the Signatures material and cross-reference
the Audit Log and Authentication Boundary sections rather than restating
them.

Record the high-level shape and the decisions that are *not* visible from
the code: why bytea rather than object storage and what the move signal is
(Decision 3); why every download is an attachment and what that defuses
(Decision 4); why the extension is authoritative and the declared content
type is not (Decision 5); why writes are manager-only when the rest of the
app writes at admin (Decision 6, including the admin-staff consequence); why
reads are unaudited here and what would change that (Decision 7); and why
there is no versioning (Decision 8).

Do not restate the endpoint table or the column list — both are read off the
code. Update the "Domains" paragraph and the Document Index table so the new
section is discoverable.

Then delete this file.
