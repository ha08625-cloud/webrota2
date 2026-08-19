# Provisional Plan — Governance Documents area

Provisional plan, produced in a discussion chat. It records the scope,
the decisions already taken, and the questions a review chat still needs to
settle before this becomes an implementation plan. Every code fact below was
checked against the file it names.

## Problem

The practice has no robust place to store non-clinical documents. The
immediate driver is DTAC packs held by the data protection lead. These are
not public, but carry nothing confidential. Today they live wherever the
person who last touched them left them.

This app is a plausible home only because it already solves the hard parts:
real per-user login with no anonymous access and no fail-open, a Postgres
database that is backed up, same-origin deployment, and an audit log that
captures every write for free. Nothing else about a rota generator makes it
a document store.

**Honest caveat, recorded deliberately:** this is scope creep. What is being
built is a small document management system with no versioning, no search
beyond a text filter, no retention policy and one maintainer. It is
justified if the alternative is genuinely "nowhere". If the practice has a
SharePoint or Teams that is merely unloved rather than absent, fixing that is
the better answer and this feature should not be built.

## Scope

A new top-level section alongside Clinical, Reception and Signatures: upload
a document, list what is stored, download it, replace it, delete it. One flat
collection.

Out of scope, each by an explicit decision below: version history, review or
expiry dates, per-document access restriction, folders or categories,
full-text search inside documents, and any link to doctors, reception staff
or rotas.

## State of the world (verified)

- `DoctorSignature` is the only existing blob store: bytes in Postgres via
  `LargeBinary`, `content_type` and `uploaded_at` as sibling columns, no
  object storage and no filesystem (`backend/app/models/signature.py`). Its
  docstring records the reasoning — volumes are small.
- Railway runs one service from the repo root with an ephemeral container
  filesystem (`railway.toml`, and "Deployment" in
  `documentation/architecture.md`). Anything written to disk is lost on
  redeploy, so the bytea route is not merely a preference.
- Routers are registered in one loop in `backend/app/api/main.py:175`, each
  with `Depends(require_write_access)` unless listed in `_UNGATED`. Only
  `auth` and `users` are exempt, and the comment above `_UNGATED` says not to
  extend it without a reason as specific as theirs.
- `require_manager` exists in `backend/app/api/deps.py` and is already used
  per-endpoint by `routers/users.py` and `routers/audit.py`.
- `AuditMiddleware` (`backend/app/api/audit.py`) captures every non-GET
  request automatically — uploads and deletes are logged the day the router
  exists, with no work in the router. GET requests are not audited anywhere
  in the app, by an explicit decision.
- Request bodies are audited as JSON only; multipart passes through
  unbuffered and never lands in memory or the log — the two signature
  uploads already rely on this.
- The frontend HTTP client already has everything this needs:
  `apiClient.postForm` (multipart), `apiClient.getBlob`, `postFormBlob`, and
  a `Content-Disposition` filename parser (`frontend/src/api/client.ts:115`,
  `:165`, `:177`, `:133`).
- `downloadBlob` (`frontend/src/lib/downloadBlob.ts`) triggers a browser save
  from an in-memory Blob, and lives in its own module specifically so tests
  can mock it.
- `LandingPage` is a `sm:grid-cols-2` grid of three tiles
  (`frontend/src/routes/LandingPage.tsx`); a fourth needs no layout change.
- `App.tsx` mounts one self-contained shell per section, sharing no route,
  component or nav item. `SignaturesShell` (`frontend/src/App.tsx:205`) is
  the closest model: a single-page section on its own top-level route.
- Nav structure is covered by `frontend/src/App.test.tsx`, which drives the
  real `App` via `window.history`.

## Design Decisions

1. **Named narrowly: "Governance Documents", route `/governance`.** The
   naming is the primary control, not decoration. An area called "Documents"
   accumulates whatever people have lying around — an incident log naming a
   patient, a disciplinary letter, a contract with bank details. That is the
   actual data protection risk in this feature, and it is a governance
   problem that no amount of code fixes. "Governance" covers DTAC packs,
   clinical safety cases, DPIAs, supplier assurance and policies, and reads
   as wrong for anything personal. The review chat may substitute another
   narrow name; it should not substitute a broad one.

2. **Reinforced by a standing UI warning.** The page carries a permanent,
   non-dismissible line: not for patient-identifiable, personal or
   confidential information. Free to build, and it is the thing a user
   actually sees at the moment they are about to upload the wrong file.

3. **Bytes in Postgres bytea, following `DoctorSignature`.** No object
   storage, no filesystem. Backups stay atomic and there is no second system
   to operate. The ceiling is honest and should be written into the model
   docstring: the whole file is held in memory on both upload and download,
   and every document inflates the database backup. Fine for tens to low
   hundreds of documents; the signal to move to object storage is upload size
   growth, not document count. **Cap uploads at 20 MB** and reject above it
   with a clear message.

4. **Downloads are always `Content-Disposition: attachment`, never inline,
   with `X-Content-Type-Options: nosniff`.** This is the single most
   important security decision in the feature and the one most easily got
   wrong. FastAPI serves the SPA same-origin (`mount_frontend()`), and the
   session token lives in `localStorage` (`auth/tokenStore.ts`). An uploaded
   `.html` or `.svg` served inline from this origin would execute script with
   full access to that token. Serving every download as an attachment
   defuses it regardless of what was uploaded.

5. **Upload allowlist rather than magic-byte sniffing.** Signatures sniffs
   leading bytes because it must branch on format to process the file; this
   feature stores and returns bytes untouched, so an allowlist of extensions
   and declared content types (PDF, `.docx`, `.xlsx`, `.pptx`, plain text,
   PNG/JPEG) is proportionate. HTML and SVG are excluded explicitly even
   though Decision 4 already covers them — two independent controls, because
   this one is a one-line regression away from being removed.

6. **Manager-only writes, layered on the global gate, not exempted from
   it.** Upload, replace and delete each take `Depends(require_manager)`,
   while the router stays inside the normal `require_write_access`
   registration. `_UNGATED` is not touched: unlike `users`, this router has
   no endpoint that every tier must be able to call, so an exemption would
   buy nothing and cost the default-deny property.

   *Recorded so it is a decision rather than an oversight:* this means admin
   staff can read and download but cannot file anything, and admin staff are
   usually the people who file documents. Chosen knowingly. Loosening it
   later is a one-line change to a dependency list; tightening after people
   have started uploading is not.

7. **Reads open to every logged-in tier, and not audited.** Consistent with
   the app-wide decision that reads are not logged. It holds here only
   because of Decisions 1, 2 and 5: the content is non-sensitive by
   construction. If the sensitivity ceiling ever rises, auditing GETs on
   this one router — as a deliberate, documented exception — is the first
   thing to add, and it is the reason Decision 1 matters more than it looks.

8. **No versioning: replace and delete act in place.** Re-uploading
   overwrites; the audit log records that it happened, who did it and when,
   but not the superseded bytes. Matches how Signatures already behaves.
   The rejected alternative — a version row per upload — roughly doubles the
   schema and the UI and adds unbounded storage growth with no pruning
   story, for a store where the current version is what anyone wants.

9. **No review or expiry dates.** Explicitly considered and dropped: DTAC
   packs and safety cases do need periodic reassessment, and a due/overdue
   view would be the feature that most earns this area its keep. It stays
   out of the first cut, tracked in whatever spreadsheet does that job
   today. If it is ever added, it is additive — nullable column plus a
   filter — and does not invalidate anything here.

10. **Flat list with a client-side text filter over title and description.
    No folders or categories.** At tens of documents a category scheme is
    ceremony, and it is the kind of taxonomy that gets designed wrong before
    anyone knows what will be stored. Deferred deliberately, not overlooked.

11. **`uploaded_by_user_id` is stored on the row, denormalised from the audit
    log.** The log can answer "who uploaded this" only by matching a
    timestamp to a path, which is unusable in a list view. One FK to `users`
    makes the list genuinely useful. `DoctorSignature` omits this because
    nothing displays it.

12. **Downloads go through `apiClient.getBlob` and `downloadBlob`, never a
    plain `<a href>`.** Authentication is an `Authorization: Bearer` header,
    not a cookie, so a direct link to the download endpoint 401s. Worth
    stating because it is the obvious first implementation and it fails in a
    way that looks like a permissions bug.

13. **Its own shell, its own tile, sharing nothing.** `GovernanceShell`
    modelled on `SignaturesShell` — one page, one route, its own header and
    `ChangePasswordDialog`. A fourth landing tile needs no layout change.

## Proposed task breakdown

Each task is intended to be a single chat.

- **Task 1 — Data model and migration.** `GovernanceDocument` model
  (`backend/app/models/`), registered in `models/__init__.py`, plus an
  Alembic migration. Columns per Decisions 3 and 11. Must survive the CI
  Postgres upgrade/downgrade/upgrade round trip.
- **Task 2 — Backend router, schemas and tests.** `routers/governance.py`
  with list, download, upload, replace, delete; registration in
  `main.py`'s `_ALL_ROUTERS` (not `_UNGATED`); metadata-only Pydantic
  schemas, bytes never travelling as JSON, following
  `schemas/signature.py`. Tests cover the size cap, the type allowlist, the
  attachment header, and each tier against each endpoint. Note the
  conftest trap: a test may use exactly one client fixture.
- **Task 3 — Frontend.** `api/governance.ts` hooks, `GovernanceDocumentsPage`,
  `GovernanceShell` and route in `App.tsx`, the landing tile, the standing
  warning line, and tests including an `App.test.tsx` nav case.
- **Task 4 — Documentation.** Fold the decisions above into
  `documentation/architecture.md` (the section is small enough not to
  warrant its own architecture doc, exactly as Signatures is), then delete
  this plan.

## Open questions for the review chat

1. Is "Governance Documents" the right name for what will actually be
   stored, or is there a narrower one? Decision 1 stands or falls on this.
2. Should replace be a distinct endpoint, or is delete-then-upload enough?
   Signatures uses a uniform upload-or-replace with a 200; copying it is the
   default unless there is a reason not to.
3. Is 20 MB the right cap? It should be set from the largest DTAC pack
   actually held, not guessed.
4. Does the list need a stored uploader *name* snapshot, or is the FK to
   `users` enough given users are deactivated rather than deleted?
