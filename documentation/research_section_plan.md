# Provisional Plan — Research section

Output of the discussion chat. **This is a provisional plan, not an
implementation plan**: it is meant to be pasted into a fresh chat, reviewed,
corrected and expanded before any code is written. Every code fact in "State
of the world" was read off the file it names during this chat; everything in
"Design Decisions" is a proposal, and the four `TODO(decide)` items are
genuinely open.

## Gate before any code is written

Two things to settle first, because they can save several chats.

1. **Is there nowhere else for these documents to live?** This is a small
   document store with no versioning, no retention policy and one
   maintainer. The same gate is written at the top of
   `documentation/governance_documents_plan.md`, which is not yet built, and
   the same answer applies: it is justified if the alternative is genuinely
   "nowhere" or "a folder on one person's laptop". If the practice has a
   SharePoint that is unloved rather than absent, fixing that beats building
   this.
2. **The overlap with the unbuilt governance-documents area is real.** Both
   are "upload a file, list it, download it, delete it, bytes in Postgres".
   This plan proposes building the research one anyway and *not* waiting for
   or generalising the governance one, because a research document belongs to
   a study and a governance document belongs to nothing — the owning entity
   is the whole design, not a detail. But that is a decision worth making
   deliberately rather than discovering later. If governance documents ships
   first, do not retrofit studies onto a flat store.

## Plan

A fifth top-level section, `/research`, alongside Clinical Rota, Reception
Rota, Documents and Administration. It holds one page per research study the
practice is a recruitment site for. A study is created once, carries
identifying information that persists for its whole life (name, CPMS code,
sponsor, …), and moves through four mutually exclusive stages:

    setup  →  recruitment_open  →  recruitment_closed  →  closed

Each stage has its own body on the study page. What this plan builds is the
whole spine plus the **Setup** stage in full and **Recruitment open** as a
stub; the recruitment, recruitment-finished and close-down bodies are a
later plan, written once the setup page has been used in anger.

Setup's body is a checklist of eight steps, each with a tick, a date, a short
note and its own document slot:

| `step_key` | Label |
|---|---|
| `mnca` | Sign mNCA |
| `siv_booked` | Book Site Initiation Visit |
| `siv_complete` | Complete Site Initiation Visit |
| `delegation_log` | Complete delegation log |
| `training_log` | Complete training log |
| `site_pack` | Site pack received |
| `flow_chart` | Flow chart completed |
| `green_light` | Green light to start recruitment |

None of them blocks progression. They are a reminder list, and the only
thing that consults them is the confirmation dialog on "Open recruitment",
which names what is still outstanding.

## Scope

**In scope**

- A `research` permission (`none` / `read` / `write`), a fifth landing tile,
  a `ResearchShell`, and the migration that backfills the new key onto
  existing users.
- Study CRUD: create, list, edit the persistent information, delete (Setup
  only — see Decision 12).
- The four-stage machine: one step forward, one step back, no skipping.
- The eight setup steps: tick, date, note, and per-step document upload /
  download / delete.
- A stub Recruitment-open body showing the persistent information and the
  flow-chart document.

**Out of scope, each by an explicit decision below**

- Anything participant-level: recruitment logs, screening logs, consent
  forms, ID lists (Decision 9 — this is the one that matters).
- Version history on documents, review or expiry dates, full-text search,
  bulk download, folders.
- The recruitment-open, recruitment-finished and close-down bodies beyond
  the stub.
- Any link between a study and doctors, reception staff, rotas or the
  clinical engine.
- Moving the existing Study EOI autofill tool. It stays under Documents
  (`/signatures/eoi`) on its own `study_eoi` permission; revisit later.
- Recruitment targets, accrual figures, payments, invoicing.

## State of the world (verified in this chat)

- **Sections** are self-contained shells in `frontend/src/App.tsx`
  (`ClinicalShell`, `ReceptionShell`, `SignaturesShell`, `AdminShell`),
  sharing no route, component or nav item. `SignaturesShell` is the closest
  model for a new one: its own header, a sub-tab bar rather than a left nav,
  and a redirect to `/` when the permission is absent.
- **The landing page** (`frontend/src/routes/LandingPage.tsx`) is a
  `SECTIONS` array of four entries, each with an `enterable(permissions)`
  predicate, rendered into a `sm:grid-cols-2` grid. A fifth entry needs no
  layout change.
- **Permissions** live in `backend/app/models/permissions.py`, which imports
  nothing from FastAPI or SQLAlchemy. A new key touches, backend side:
  `PERMISSION_KEYS` / `AREA_KEYS`, `DEFAULT_PERMISSIONS`, all five `PRESETS`,
  `_FORBIDDEN_DETAIL` and `_READ_ONLY_DETAIL` in `backend/app/api/deps.py`
  (`_FORBIDDEN_DETAIL[area]` is a **direct subscript**, so a missing entry is
  an ImportError, not a runtime surprise), `PermissionSet` in
  `backend/app/api/schemas/auth.py`, and `_AREA` in
  `backend/app/api/main.py` (also a direct subscript — a new router is a
  `KeyError` at import until it is classified). Frontend side:
  `Permissions` in `api/types.ts`, `PERMISSION_PRESETS` in
  `lib/permissionPresets.ts`, the Zod object in `lib/userSchema.ts`, and
  `UserFormDialog`'s controls.
- **`PermissionSet` defaults every field to denied**, so a user row whose
  JSON predates the new key still serialises as `research: "none"` — the
  wire shape can never omit it. The backfill migration is therefore about
  the database being honest, not about avoiding a 500.
- **`canReadArea` in `frontend/src/auth/AuthContext.tsx` returns `true` for a
  key that is absent** (`granted !== "none"` with `granted === undefined`).
  Unreachable through the API for the reason above, but a hand-built test
  fixture hits it. Worth hardening while a fifth key is being added.
- **The only existing blob store** is `DoctorSignature`
  (`backend/app/models/signature.py`): bytes in Postgres via `LargeBinary`,
  `content_type` and `uploaded_at` as sibling columns, no object storage.
  Railway runs one service with an ephemeral container filesystem, so bytea
  is a constraint rather than a preference.
- **`AuditMiddleware`** (`backend/app/api/audit.py`) audits every non-GET
  request automatically; **multipart bodies pass through unbuffered** and
  never reach the log, which the two signature uploads already rely on. So
  document uploads will be audited as "an upload happened, by whom, to which
  study" and the ticks — plain JSON PATCHes — will be audited in full.
- **`audit_descriptions.py` is enforced by a test.**
  `backend/tests/test_api/test_audit_descriptions.py` walks the whole route
  tree and fails, with paste-ready dict entries, if any non-GET route has no
  plain-English description. Every new endpoint here needs one.
- **`test_authorization.py` sweeps every route in the OpenAPI schema** against
  one permission set per preset plus the deny-everything set. A new router
  and a new permission are covered the moment they exist; the sweep is what
  will catch a mis-registered research router.
- **`frontend/src/api/client.ts`** has `postForm` (multipart in, JSON out),
  `getBlob` (bare `Blob`, **discards headers, so no filename**) and
  `postFormBlob` (parses `Content-Disposition`). `lib/downloadBlob.ts`
  triggers the save and lives in its own module so tests can mock it. Since
  a document row carries its own `filename`, `getBlob` needs no change.
- **There is no security-headers middleware.** `main.py` registers CORS and
  `AuditMiddleware` and nothing else; `nosniff` appears nowhere in
  `backend/app`. Download headers must be set per-response.
- **No study or CPMS concept exists in the schema.** `study_eoi` is a
  permission name and `backend/app/documents/eoi_rules.py` holds static
  practice text; neither is a data model to build on.
- **Latest migration is `013_counter_opening_balance.py`**, so this work is
  `014` and `015`.
- **Nothing is paginated except the audit log**, by an explicit decision:
  reference data is fetched wholesale. A practice runs a handful of studies,
  so studies follow that convention.

## Design Decisions

1. **A fifth top-level section with its own shell, not a page inside
   Documents.** Research is a different job done by a different person from
   signing letters, and the section's whole shape (a list of study pages)
   matches no existing shell. It also keeps the permission clean: `research`
   is independent of `signatures` and `study_eoi`, so a research nurse gets
   studies without getting scanned signatures — which is the reason the
   permission model exists at all.

2. **`research` is a levelled permission (`none` / `read` / `write`), not a
   boolean.** Unlike a document generator, there is a meaningful read-only
   view here: a clinician who wants to see the flow chart for a study that is
   recruiting has no business ticking setup steps. Levelled also means the
   existing `require_access` machinery gates reads and writes with no new
   code.

3. **One `stage` column holding a four-value enum, never four booleans.** The
   stages are mutually exclusive, so a shape that can represent "recruitment
   open and closed at once" is a shape somebody will eventually save. Use a
   native Postgres enum, matching `models/enums.py`'s existing style, and
   keep the ordering in a plain list in one module so "the next stage" is
   derived rather than written out at each call site.

4. **Progression is one step at a time, in either direction, never a jump.**
   `POST /research/studies/{id}/advance` and
   `POST /research/studies/{id}/revert`, each rejecting with a 409 if the
   study is at the end it is being pushed past. Two endpoints rather than a
   `PATCH stage` field, because the *transition* is the domain action and
   because a body-supplied stage invites the jump. Reverting exists because a
   misclick otherwise needs a database edit, and it is a separate endpoint
   (with its own audit sentence and its own confirmation copy) so it can
   never happen by accident.

5. **The checklist never blocks a transition; the confirmation dialog names
   what is outstanding.** This is what the user asked for and it is also the
   right call — a hard gate on eight ticks teaches people to tick things
   they have not done. The unticked list is computed frontend-side from data
   it already holds; the API does not police it.

6. **Setup steps are rows in `study_setup_steps`, created lazily, with the
   catalogue in a dependency-free module.** The eight steps live in
   `backend/app/research/setup_steps.py` (key, label, order) — the same
   pattern as `models/permissions.py`, and the same reason: the router, the
   schema and the frontend labels all need one source of truth. A study
   starts with **no** step rows; the first PATCH to a step upserts one, under
   a unique `(study_id, step_key)`. A missing row renders as "not done".
   That way a ninth step is a one-line addition with no backfill, and a step
   dropped from the catalogue leaves orphan rows that are simply not
   rendered. `step_key` is validated against the catalogue on write (422
   otherwise) — it is a checked string, not an enum type, so the catalogue
   can change without a migration.

7. **Each step gets a document slot, and a slot holds any number of
   documents.** `study_documents` has `study_id` (FK, cascade delete) and a
   nullable `step_key` — nullable so a general study document can exist with
   no step, and a plain string rather than an FK to `study_setup_steps`
   because that table's rows do not exist until something is ticked. Many
   documents per slot rather than one, so there is no "replace" endpoint and
   no lost file when a re-signed mNCA arrives: upload adds, delete removes,
   and the slot renders as a short list. The honest cost is that nothing
   stops a slot accumulating five near-identical files, which is a
   housekeeping problem rather than a correctness one.

8. **The flow chart needs no special field.** It is the document(s) attached
   to `step_key = "flow_chart"`, so "the flow chart persists into
   recruitment while the rest of setup hides" falls out of the model: the
   recruitment body queries one `step_key`. Do not add a `flow_chart_id`
   column.

9. **No participant-identifiable data, ever, and the page has to say so.**
   This is the highest-risk decision in the plan. The moment a study is
   recruiting, the natural thing to upload to its page is a recruitment or
   screening log — which is a list of patients, and turns a rota app into an
   unassessed clinical record system. So: a standing, non-dismissible line on
   every study page naming what must not be uploaded (no recruitment or
   screening logs, no consent forms, no participant lists, no NHS numbers),
   and the same sentence in the upload control's own copy. Delegation and
   training logs are *staff* documents and are fine. The control is copy plus
   Decision 10's narrow permission; there is no technical enforcement
   possible here, and pretending otherwise would be worse than saying it
   plainly.

10. **Writes are the `research: write` permission and nothing wider.** The
    Manager preset gets `write`; a new **Research** preset gets `research:
    write` and nothing else, so the person who runs studies can be given
    exactly that. Every other preset gets `research: "none"` — including
    Read-only, which grants `clinical: read` and `reception: read` today:
    those two are rotas everyone benefits from seeing, and this is not.

11. **Stage-entry dates are four nullable date columns on the study row, not
    a history table.** "When did recruitment open?" is a question; "how many
    times did somebody bounce this study between stages?" is not. The audit
    log already answers the second one for free if it is ever asked.

12. **A study can be deleted only while it is in Setup; after that it is
    closed, not deleted.** A study created by mistake is real and needs a way
    out, but a study that ever recruited is a record. `DELETE` returns 409
    outside Setup, and cascades to that study's documents and step rows when
    it succeeds. This is a deliberate asymmetry rather than a soft-delete
    flag, because a `deleted_at` column would need filtering in every query
    for the sake of a case that only happens on the day the study is created.

13. **Persistent study information is edited in one place and shown in every
    stage.** A header panel on the study page (name, CPMS code, sponsor,
    stage) plus an edit dialog, rendered above whichever stage body is
    active. Setup's data is *hidden* in later stages, never deleted — so
    reverting a stage restores the page as it was, which is what makes
    Decision 4 safe.

14. **Downloads are hardened per-response, because there is no shared layer
    to forget it in.** Always `Content-Disposition: attachment` with a
    sanitised filename, always `X-Content-Type-Options: nosniff`, and the
    stored `content_type` echoed back only if it is in the upload allowlist,
    otherwise `application/octet-stream`. Same-origin serving means a stored
    HTML or SVG file served inline with its own content type is a
    script-execution hole on the app's own origin; these three headers close
    it. The upload allowlist itself is the first line: PDF, DOCX, XLSX, PNG,
    JPG.

15. **Bytes in Postgres, one blob column, no object storage.** Following
    `DoctorSignature` for the reason given there — the container filesystem
    is ephemeral, and adding S3 to this deployment for a few dozen PDFs a
    year is not a trade worth making. It does mean the per-file cap is
    load-bearing, since these rows land in the same database (and the same
    backups) as the rota.

16. **Studies are fetched wholesale, with no search and no pagination**, per
    the app-wide convention. The list page groups by stage and collapses
    Closed, which is the only affordance a practice with a dozen studies
    needs.

## Open questions

- `TODO(decide)` **Which identifiers and fields are "persistent study
  information"?** Certain: name, CPMS code. Candidates: IRAS number, sponsor,
  CRO, protocol number, local PI, study type (interventional /
  observational), recruitment target, a free-text notes field, a link to the
  study on the CPMS or sponsor portal. Settle the list before Task 2 — it is
  the one thing here that is genuinely a migration to change later.
- `TODO(decide)` **Is the CPMS code unique, and is it required at
  creation?** Proposal: nullable (a study in early setup may not have one
  yet) with a unique index, which both SQLite and Postgres allow to hold
  multiple NULLs.
- `TODO(decide)` **The per-file size cap.** 10 MB matches the EOI tool. A
  site pack can exceed that; 25 MB is a defensible cap given Decision 15.
  Pick one number and use it on both sides (the frontend pre-check exists to
  give a faster message, the server stays authoritative).
- `TODO(decide)` **Does the study list need an owner / responsible person
  field?** If yes, decide now whether it is free text or an FK to `users` —
  the second one is cheap here and impossible to add cleanly later.

---

# Task 1: The `research` permission and an empty section

**A.** Nothing exists yet. This task adds the permission, the landing tile
and an empty shell, and ships them on their own — so the gating is proven
before any study data model exists. No study, no document, no research
endpoint in this task.

**B.** Files and deliverables:

- `backend/app/models/permissions.py` — `research` in `AREA_KEYS` and
  `PERMISSION_KEYS`, in `DEFAULT_PERMISSIONS` (as `"none"`), in all five
  `PRESETS`, and a new `RESEARCH_PRESET` (Decision 10).
- `backend/app/api/deps.py` — a `research` entry in `_FORBIDDEN_DETAIL` and
  in `_READ_ONLY_DETAIL`.
- `backend/app/api/schemas/auth.py` — `research: AccessArea = "none"` on
  `PermissionSet`.
- `backend/alembic/versions/014_research_permission.py` — backfill
  `research: "none"` into every existing `users.permissions` JSON value and
  move the column `server_default` to the new `DEFAULT_PERMISSIONS_JSON`.
  Downgrade strips the key and restores the old default. Follow `010`'s
  shape, and remember CI runs the round trip against real Postgres.
- `frontend/src/api/types.ts`, `lib/permissionPresets.ts`,
  `lib/userSchema.ts`, `components/UserFormDialog.tsx` — the same key, plus
  the new preset and its control.
- `frontend/src/auth/AuthContext.tsx` — add `research` to `DENIED_PERMISSIONS`
  and harden `canReadArea` / `canWriteArea` so an absent key denies
  (State of the world, item 6), with a test for the absent-key case.
- `frontend/src/routes/LandingPage.tsx` — a fifth `SECTIONS` entry.
- `frontend/src/App.tsx` — a `ResearchShell` on `/research/*`, modelled on
  `SignaturesShell`: own header, redirect to `/` unless
  `canReadArea(permissions, "research")`, one `PermissionAreaProvider
  area="research"`, and a placeholder index page.
- Tests: extend `backend/tests/test_api/test_users.py` and the permission
  fixtures; `frontend/src/App.test.tsx` for the new shell's guard;
  `lib/userSchema.test.ts` and `lib/permissionPresets.test.ts` for the new
  key and preset.

**C.** Work outward from `models/permissions.py`; the two direct-subscript
sites (`_FORBIDDEN_DETAIL`, `_AREA`) will fail at import until they are
updated, which is the design working. `test_authorization.py` will start
sweeping the new permission with no edit — check it passes before touching
the frontend. Do not add a router in this task: there is nothing for `_AREA`
to classify yet.

# Task 2: Data model and migration

**A.** Task 1 is done: the permission exists and `/research` renders an
empty shell. This task adds the schema only — no endpoints, no UI.

**B.** Files and deliverables:

- `backend/app/models/enums.py` — a `StudyStage` enum
  (`setup`, `recruitment_open`, `recruitment_closed`, `closed`).
- `backend/app/research/setup_steps.py` (new package) — the eight-step
  catalogue: key, label, display order; a `by_key` lookup and an
  `is_valid_key` used by the schemas. Dependency-free, like
  `models/permissions.py`.
- `backend/app/models/study.py` — `Study` (identifying fields per the first
  `TODO(decide)`, `stage`, the four stage-entry dates, `created_at`),
  `StudySetupStep` (`study_id` FK, `step_key`, `done`, `done_on`, `note`,
  unique `(study_id, step_key)`) and `StudyDocument` (`study_id` FK,
  nullable `step_key`, `filename`, `content_type`, `size_bytes`,
  `LargeBinary` bytes, `uploaded_at`, `uploaded_by_user_id` FK to `users`).
  Cascade deletes from `Study` to both children.
- `backend/app/models/__init__.py` — import the new models so `create_all`
  sees them (the test suite builds SQLite from the models).
- `backend/alembic/versions/015_research_studies.py` — three tables and the
  native enum type, with the downgrade dropping the enum type explicitly.
- `backend/tests/test_models/` — a round-trip test per table, the unique
  constraint, and both cascades.

**C.** Note the two FK traps this repo has already hit: `PRAGMA
foreign_keys=ON` is enabled in the API test engine, and
`tests/test_api/conftest.py`'s stub user is **not** a database row — so any
test inserting a `StudyDocument` with `uploaded_by_user_id` needs a real
seeded user. Decide `uploaded_by_user_id`'s on-delete behaviour explicitly:
users are deactivated and never deleted in this app, so `RESTRICT` is
accurate and `SET NULL` is defensive; pick one and say why in the docstring.

# Task 3: The REST API

**A.** The permission and the schema exist. This task adds
`backend/app/api/routers/research.py`, its schemas, and its tests. No
frontend work.

**B.** Files and deliverables:

- `backend/app/api/schemas/research.py` — `StudyOut` (with its setup steps
  and its document metadata, never the bytes), `StudyIn`, `StudyPatch`,
  `SetupStepPatch` (`done`, `done_on`, `note`, all optional),
  `StudyDocumentOut`.
- `backend/app/api/routers/research.py`:
  - `GET /research/studies`, `POST /research/studies`,
    `GET /research/studies/{id}`, `PATCH /research/studies/{id}`,
    `DELETE /research/studies/{id}` (409 outside Setup — Decision 12).
  - `PATCH /research/studies/{id}/setup-steps/{step_key}` — upsert, 422 on a
    key outside the catalogue (Decision 6).
  - `POST /research/studies/{id}/advance`, `POST /research/studies/{id}/revert`
    — 409 at either end (Decision 4).
  - `POST /research/studies/{id}/documents` (multipart; optional `step_key`
    form field; size and content-type allowlist), `GET
    /research/studies/{id}/documents/{doc_id}` (the hardened download —
    Decision 14), `DELETE /research/studies/{id}/documents/{doc_id}`.
- `backend/app/api/main.py` — import the router, add it to `_ALL_ROUTERS`
  and `_AREA` (`research`). Not `_UNGATED`, not `_SHARED_READ`.
- `backend/app/api/audit_descriptions.py` — one sentence per new non-GET
  route, in the UI's own vocabulary ("Opened recruitment for study 4"), or
  `test_audit_descriptions.py` fails with the missing keys.
- `backend/tests/test_api/test_research.py` — CRUD, the step upsert, both
  transition endpoints at both ends, the delete rule, upload/download/delete,
  the size and type rejections, and the three response headers.

**C.** Reuse `routers/_uploads.py` rather than writing new validation: it
already holds `safe_filename_stem`, written for exactly this problem (both
existing upload routes echo a client-supplied filename into a
`Content-Disposition` header and neither may echo a path or a quote), plus
the size constant and media-type constant. The allowlist here is wider than
DOCX, so it belongs in the new router, not in `_uploads.py`. Confirm by test that the upload's bytes never reach the audit
log (multipart passes through unbuffered) and that the metadata PATCHes do.

# Task 4: Study list and study page shell

**A.** The API is complete and tested. This task builds the section's two
pages and the persistent header, with the stage bodies stubbed.

**B.** Files and deliverables:

- `frontend/src/api/research.ts` — TanStack Query hooks with hierarchical
  keys, mutations invalidating the resource root per the app convention.
- `frontend/src/api/types.ts` — the wire mirrors (`Study`, `StudySetupStep`,
  `StudyDocument`, `StudyStage`), enums mirrored by **value**.
- `frontend/src/routes/research/StudiesPage.tsx` — the index: grouped by
  stage, Closed collapsed, a "New study" dialog, write controls through
  `useWriteGate()`.
- `frontend/src/routes/research/StudyPage.tsx` — `/research/studies/:id`:
  the persistent header panel (Decision 13), a four-stage indicator, the
  standing data-protection line (Decision 9), the advance/revert controls,
  and a switch on `stage` rendering the body.
- `frontend/src/components/research/StudyFormDialog.tsx` — create and edit,
  Zod-validated, mirroring the server's rules.
- `frontend/src/App.tsx` — the two real routes inside `ResearchShell`.
- Tests alongside each, MSW-backed, including a read-only user seeing the
  page with its controls disabled.

**C.** The transition confirmation belongs here, not in Task 5: it is the
header's control. It lists the outstanding steps from data the page already
holds, and its copy differs between advance and revert.

# Task 5: The Setup stage body

**A.** The study page renders with stub bodies. This task builds the Setup
body in full.

**B.** Files and deliverables:

- `frontend/src/routes/research/SetupStage.tsx` — the eight steps in
  catalogue order, each a tick, a date input, a note field and a document
  slot. Labels come from a frontend mirror of the catalogue (one module,
  `lib/setupSteps.ts`), not from strings inlined in the component.
- `frontend/src/components/research/DocumentSlot.tsx` — upload (drag and
  drop plus a file input, following `EoiPage`), the slot's document list
  with download and delete, the client-side size and type pre-checks, and
  the no-participant-data copy.
- Tests: a tick persisting, an unticked step rendering with no row present
  server-side, upload rejection paths, and `downloadBlob` mocked to assert
  the stored filename is used.

**C.** Mirror the size and type checks from the server rather than inventing
looser ones, and keep the server authoritative on failure. `getBlob`
returns no filename, so pass the document row's `filename` to
`downloadBlob` explicitly.

# Task 6: The Recruitment-open stub

**A.** Setup works end to end. This task adds the minimum second-stage body,
so that advancing a study lands somewhere coherent.

**B.** `frontend/src/routes/research/RecruitmentOpenStage.tsx`: the
persistent information (from the shared header, so nothing is duplicated),
the flow-chart documents (`step_key = "flow_chart"`), and an explicit
"more to come here" placeholder. Plus the two remaining stages rendering the
same minimal body for now. Tests: advancing a study hides the setup
checklist and keeps the flow chart visible.

**C.** Resist adding recruitment fields here. The point of the stub is to
learn what the recruitment page needs from using the setup page first; a
half-guessed set of accrual fields is harder to remove than to add.

# Task 7: Review and documentation

**A.** Tasks 1–6 are complete and the section is live. This task is review
and documentation only.

**B.** Deliverables:

- `documentation/architecture-research.md` — a new domain document in the
  style of `architecture-reception.md`: the stage machine and why it is one
  enum column, the lazy step rows and the catalogue module, the document
  model and the three download headers, the data-protection stance, and what
  was deliberately left out.
- `documentation/architecture.md` — the Domains list, the Document Index,
  the permission table, and the Tech Stack auth row all name the new
  permission and the new document.
- Delete `documentation/research_section_plan.md`.

**C.** Do not cite this plan or a task number in any code comment or
architecture doc — write the decision itself. Re-read the section as a
first-time user before writing the doc: the questions you have to answer for
yourself are the ones the doc should answer.
