# Implementation Plan — Research section

## Plan

A fifth top-level section, `/research`, alongside Clinical Rota, Reception
Rota, Documents and Administration. It holds one page per research study the
practice is a recruitment site for.

**What this page is for, and what it is not.** The practice already has an
intranet holding the full site pack and the patient database. That intranet
is, and remains, the record. It is also hard to navigate: most of a site pack
is irrelevant day to day, the three documents that matter are buried among
superseded copies of themselves, and there is nowhere to see what stage a
study is at or what is still outstanding. This section is the answer to that
and nothing more — a one-glance view of where each study is, and a shortcut to
the handful of documents the team actually opens. Nothing here needs to
survive forever, because the intranet already holds it. Every design decision
below follows from that: it is a signpost, not a document management system.

A study is created once, carries identifying information that persists for its
whole life, and moves through four mutually exclusive stages:

    setup  →  recruitment_open  →  recruitment_closed  →  closed

Each stage has its own body on the study page. This plan builds the whole
spine, the persistent header, the three key documents, and the **Setup** stage
in full, with **Recruitment open** as a stub; the recruitment,
recruitment-finished and close-down bodies are a later plan, written once the
setup page has been used in anger.

### The persistent header

Shown above whichever stage body is active, in every stage:

| Field | Shape |
|---|---|
| Name | required text |
| CPMS code | nullable text, unique index |
| Study type | nullable free text (see Decision 17) |
| Study website | nullable URL, `http`/`https` only |
| Owner | nullable FK to `users` |
| Contacts | zero or more rows: name, role, email, phone |

Plus the three **key documents**, each a single current file:

| `slot` | Label |
|---|---|
| `flow_chart` | Flow chart |
| `patient_information_leaflet` | Patient information leaflet |
| `consent_form` | Consent form |

### The Setup checklist

Eight steps, each with a tick, a date and a short note. Three of them also
carry a document slot; the rest do not, because the document belongs on the
intranet or in the key-document row above.

| `step_key` | Label | Document slot? |
|---|---|---|
| `mnca` | Sign mNCA | yes (many) |
| `siv_booked` | Book Site Initiation Visit | no |
| `siv_complete` | Complete Site Initiation Visit | no |
| `delegation_log` | Complete delegation log | yes (many) |
| `training_log` | Complete training log | yes (many) |
| `site_pack` | Site pack received | **no** — Decision 18 |
| `flow_chart` | Flow chart completed | no — the file is the key slot |
| `green_light` | Green light to start recruitment | no |

None of them blocks progression. They are a reminder list, and the only thing
that consults them is the confirmation dialog on "Open recruitment", which
names what is still outstanding.

## Scope

**In scope**

- A `research` permission (`none` / `read` / `write`), a fifth landing tile, a
  `ResearchShell`, and the migration that backfills the new key onto existing
  users.
- Study CRUD: create, list, edit the persistent information and its contacts,
  delete (Setup only — Decision 12).
- The four-stage machine: one step forward, one step back, no skipping.
- The three key-document slots: upload (replacing the current file), download,
  delete.
- The eight setup steps: tick, date, note, and per-step document upload /
  download / delete on the three steps that have a slot.
- A stub Recruitment-open body showing the persistent header and the key
  documents.
- The section's domain-first layout and its `import-linter` contract pair
  (Decision 22). Research is the first section built to the "Adding a Module"
  convention in `documentation/architecture.md`, so the layout is a deliverable
  here, not a tidy-up afterwards.

**Out of scope, each by an explicit decision below**

- Anything participant-level: recruitment logs, screening logs, **signed**
  consent forms, ID lists (Decision 9 — this is the one that matters).
- Storing the site pack, or anything else the intranet is the home for
  (Decision 18).
- Version history on documents, review or expiry dates, full-text search, bulk
  download, folders.
- The recruitment-open, recruitment-finished and close-down bodies beyond the
  stub. **Named gap:** "what meetings are booked, what is outstanding" is
  answered by the checklist during Setup and by nothing afterwards. That is
  the main thing the recruitment body will have to solve, and it is recorded
  here so it is not lost.
- Any link between a study and doctors, reception staff, rotas or the clinical
  engine.
- Moving the existing Study EOI autofill tool. It stays under Documents
  (`/signatures/eoi`) on its own `study_eoi` permission; revisit later.
- Recruitment targets, accrual figures, payments, invoicing.

## State of the world (verified against the code)

- **Sections** are self-contained shells in `frontend/src/App.tsx`
  (`ClinicalShell`, `ReceptionShell`, `SignaturesShell`, `AdminShell`), sharing
  no route, component or nav item. `SignaturesShell` is the closest model for a
  new one: its own header, a sub-tab bar rather than a left nav, and a redirect
  to `/` when the permission is absent.
- **The landing page** (`frontend/src/routes/LandingPage.tsx`) is a `SECTIONS`
  array of four entries, each with an `enterable(permissions)` predicate,
  rendered into a `sm:grid-cols-2` grid. A fifth entry needs no layout change.
- **Permissions** live in `backend/app/models/permissions.py`, which imports
  nothing from FastAPI or SQLAlchemy. A new key touches, backend side:
  `PERMISSION_KEYS` / `AREA_KEYS`, `DEFAULT_PERMISSIONS`, all five `PRESETS`,
  `_FORBIDDEN_DETAIL` and `_READ_ONLY_DETAIL` in `backend/app/api/deps.py`
  (`_FORBIDDEN_DETAIL[area]` is a **direct subscript**, so a missing entry is an
  ImportError, not a runtime surprise), `PermissionSet` in
  `backend/app/api/schemas/auth.py`, and `_AREA` in `backend/app/api/main.py`
  (also a direct subscript — a new router is a `KeyError` at import until it is
  classified).
- **`LOCKABLE_AREAS` is deliberately not an alias of `AREA_KEYS`**, with an
  import-time assert that it is a subset. A third levelled area therefore has
  to state whether it is lockable — see Decision 19.
- **Frontend permission helpers are hand-written, not derived from a key
  list.** `frontend/src/lib/permissionPresets.ts` holds `PERMISSION_PRESETS`,
  `PRESET_ORDER`, `PRESET_LABELS`, `PERMISSION_AREAS`, `AREA_LABELS`, and —
  critically — **`isEmptyPermissions`, which names each key by hand**. A login
  holding only `research: write` (exactly what Decision 10's preset produces)
  would read as empty and `UserFormDialog` would refuse to save it. The
  backend's `is_empty` loops over `AREA_KEYS` and needs no edit; the frontend
  does. Also `lib/userSchema.ts`'s Zod object and `api/types.ts`'s
  `Permissions`.
- **`PermissionSet` defaults every field to denied**, so a user row whose JSON
  predates the new key still serialises as `research: "none"` — the wire shape
  can never omit it. The backfill migration is therefore about the database
  being honest, not about avoiding a 500.
- **`canReadArea` in `frontend/src/auth/AuthContext.tsx` returns `true` for a
  key that is absent** (`granted !== "none"` with `granted === undefined`).
  `canWriteArea` is `granted === "write"` and already denies an absent key, so
  **only `canReadArea` needs hardening**. Unreachable through the API for the
  reason above, but a hand-built test fixture hits it.
- **`test_authorization.py` does NOT pick up a new router or preset on its
  own.** `backend/tests/test_api/test_authorization.py` holds a hand-written
  `_AREA_FOR_PREFIX` map (path prefix → area) and a hand-listed `_PROFILES`
  dict (one set per preset). Both need an explicit edit — `_PROFILES` in Task 1
  for the new preset, `_AREA_FOR_PREFIX` in Task 3 for the new router. The
  module docstring says the map is hand-written on purpose; do not try to
  derive it.
- **The only existing blob store** is `DoctorSignature`
  (`backend/app/models/signature.py`): bytes in Postgres via `LargeBinary`,
  `content_type` and `uploaded_at` as sibling columns, no object storage.
  Railway runs one service with an ephemeral container filesystem, so bytea is
  a constraint rather than a preference.
- **Existing uploads read the whole body before checking its size.**
  `signatures.py` does `file.file.read()` and then compares `len()` against the
  cap, so the cap bounds what is *stored*, not what is *buffered*. See
  Decision 20.
- **`AuditMiddleware`** (`backend/app/api/audit.py`) audits every non-GET
  request automatically; **multipart bodies pass through unbuffered** and never
  reach the log (`audit.py` parses a body only when the content type starts
  `application/json`), which the two signature uploads already rely on. So
  document uploads will be audited as "an upload happened, by whom, to which
  study" and the ticks — plain JSON PATCHes — will be audited in full.
- **`audit_descriptions.py` is enforced by a test.**
  `backend/tests/test_api/test_audit_descriptions.py` walks the whole route
  tree and fails, with paste-ready dict entries, if any non-GET route has no
  plain-English description. Every new endpoint here needs one.
- **`frontend/src/api/client.ts`** has `postForm` (multipart in, JSON out),
  `getBlob` (bare `Blob`, **discards headers, so no filename**) and
  `postFormBlob` (parses `Content-Disposition`). `lib/downloadBlob.ts` triggers
  the save and lives in its own module so tests can mock it. Since a document
  row carries its own `filename`, `getBlob` needs no change.
- **There is no security-headers middleware.** `main.py` registers CORS and
  `AuditMiddleware` and nothing else; `nosniff` appears nowhere in
  `backend/app`. Download headers must be set per-response. Note that
  `GET /signatures/{id}/image` returns the stored `content_type` inline with no
  `nosniff` today — that is a pre-existing gap, out of scope here, and the
  architecture doc must not claim the app hardens downloads generally.
- **No study or CPMS concept exists in the schema.** `study_eoi` is a
  permission name and `backend/app/documents/eoi_rules.py` holds static
  practice text; neither is a data model to build on.
- **No DB-level `ON DELETE CASCADE` exists anywhere in this schema** except
  `school_holidays.school_id`; every other parent/child cleanup is ORM-level
  `relationship(cascade="all, delete-orphan")`. `PRAGMA foreign_keys=ON` is
  enabled in the API test engine.
- **Latest migration is `014_edit_locks.py`** (revision `"014"`,
  down_revision `"013"`), so this work is **`015` and `016`**.
- **`backend/tests/test_models.py` is a module, not a package.** New model
  tests go in a new sibling module (`test_research_models.py`), not in a
  `tests/test_models/` directory.
- **Nothing is paginated except the audit log**, by an explicit decision:
  reference data is fetched wholesale. A practice runs a handful of studies, so
  studies follow that convention.

## Design Decisions

1. **A fifth top-level section with its own shell, not a page inside
   Documents.** Research is a different job done by a different person from
   signing letters, and the section's whole shape (a list of study pages)
   matches no existing shell. It also keeps the permission clean: `research` is
   independent of `signatures` and `study_eoi`, so a research nurse gets studies
   without getting scanned signatures — which is the reason the permission model
   exists at all.

2. **`research` is a levelled permission (`none` / `read` / `write`), not a
   boolean.** There is a meaningful read-only view here: a clinician who wants
   to check the current PIS for a recruiting study has no business ticking
   setup steps. No preset grants `read` (Decision 10); it is assigned by hand
   when someone asks, which is what presets being starting points rather than
   roles allows. Levelled also means the existing `require_access` machinery
   gates reads and writes with no new code.

3. **One `stage` column holding a four-value enum, never four booleans.** The
   stages are mutually exclusive, so a shape that can represent "recruitment
   open and closed at once" is a shape somebody will eventually save. Use a
   native Postgres enum, matching `models/enums.py`'s existing style, and keep
   the ordering in a plain list in one module so "the next stage" is derived
   rather than written out at each call site.

4. **Progression is one step at a time, in either direction, never a jump.**
   `POST /research/studies/{id}/advance` and
   `POST /research/studies/{id}/revert`, each rejecting with a 409 if the study
   is at the end it is being pushed past. Two endpoints rather than a `PATCH
   stage` field, because the *transition* is the domain action and because a
   body-supplied stage invites the jump. Reverting exists because a misclick
   otherwise needs a database edit, and it is a separate endpoint (with its own
   audit sentence and its own confirmation copy) so it can never happen by
   accident.

5. **The checklist never blocks a transition; the confirmation dialog names
   what is outstanding.** A hard gate on eight ticks teaches people to tick
   things they have not done. The unticked list is computed frontend-side from
   data it already holds; the API does not police it.

6. **Setup steps are rows in `study_setup_steps`, created lazily, with the
   catalogue in a dependency-free module.** The eight steps live in
   `backend/app/research/catalogue.py` (key, label, display order, whether it
   has a document slot) — the same pattern as `models/permissions.py`, and the
   same reason: the router, the schema and the frontend labels all need one
   source of truth. A study starts with **no** step rows; the first PATCH to a
   step upserts one, under a unique `(study_id, step_key)`. A missing row
   renders as "not done". That way a ninth step is a one-line addition with no
   backfill, and a step dropped from the catalogue leaves orphan rows that are
   simply not rendered. `step_key` is validated against the catalogue on write
   (422 otherwise) — it is a checked string, not an enum type, so the catalogue
   can change without a migration. **The upsert must catch `IntegrityError` and
   re-select** rather than 500 on two concurrent PATCHes to the same step.

7. **Documents live in named slots, and the three key slots hold exactly one
   current file while setup-step slots hold many.** `study_documents` has
   `study_id` (FK) and a **non-nullable** `slot` string, validated against the
   catalogue. There is no "general study document" and no folder: a file that
   fits no slot belongs on the intranet (Decision 18).
   - **Key slots** (`flow_chart`, `patient_information_leaflet`,
     `consent_form`) hold one document. Uploading replaces the current file in
     one transaction, behind a confirmation. This is the direct answer to "all
     the old PISs are in the same folder": the page cannot show a superseded
     leaflet, because it does not keep one. The superseded copy is not lost —
     the intranet has it.
   - **Setup-step slots** (`mnca`, `delegation_log`, `training_log`) hold any
     number, because a re-signed mNCA arriving alongside the original is normal
     and neither is "superseded" in a way the page can judge.
   Single-document-ness on key slots is enforced in the router, not by a
   partial unique index: the index would need per-dialect `where` clauses for
   SQLite and Postgres to express "unique only for these three slots", which is
   more machinery than a replace-in-one-transaction needs.

8. **The flow chart is a key slot, not a setup-step attachment.** It is one of
   the three documents the team opens day to day, and it has to be visible in
   every stage. The `flow_chart` setup step survives as a *tick* ("flow chart
   completed") with no document slot of its own; the file lives in the header.
   Do not add a `flow_chart_id` column — the slot name is the lookup.

9. **No participant-identifiable data, ever, and the page has to say so — but
   the line is drawn at "completed", not at "consent form".** This is the
   highest-risk decision in the plan, and the distinction is the whole of it:
   - **Fine, and wanted:** the *blank, current* patient information leaflet and
     the *blank, current* consent form. These are study templates. They are two
     of the three reasons this page exists.
   - **Never:** anything filled in about a real person — recruitment or
     screening logs, **signed** consent forms, participant lists, NHS numbers.
   Delegation and training logs are *staff* documents and are fine. The control
   is copy plus Decision 10's narrow permission: a standing, non-dismissible
   line on every study page and the same sentence in each upload control,
   naming the blank/completed distinction explicitly rather than saying "no
   consent forms" (which would read as forbidding the template). There is no
   technical enforcement possible here, and pretending otherwise would be worse
   than saying it plainly.

10. **Writes are the `research: write` permission and nothing wider.** The
    Manager preset gets `write`; a new **Research** preset gets
    `research: write` and nothing else, so the person who runs studies can be
    given exactly that. Every other preset gets `research: "none"` — including
    Read-only, which grants `clinical: read` and `reception: read` today: those
    two are rotas everyone benefits from seeing, and this is not.

11. **Stage-entry dates are four nullable date columns on the study row, not a
    history table.** "When did recruitment open?" is a question; "how many times
    did somebody bounce this study between stages?" is not. The audit log
    already answers the second one for free if it is ever asked.

12. **A study can be deleted only while it is in Setup; after that it is
    closed, not deleted.** A study created by mistake is real and needs a way
    out, but a study that ever recruited is a record. `DELETE` returns 409
    outside Setup, and cascades to that study's documents, contacts and step
    rows when it succeeds. A deliberate asymmetry rather than a soft-delete
    flag, because a `deleted_at` column would need filtering in every query for
    the sake of a case that only happens on the day the study is created.

13. **Persistent study information is edited in one place and shown in every
    stage.** A header panel on the study page (the six fields plus the three key
    documents plus the stage) with an edit dialog, rendered above whichever
    stage body is active. Setup's data is *hidden* in later stages, never
    deleted — so reverting a stage restores the page as it was, which is what
    makes Decision 4 safe.

14. **Downloads are hardened per-response, because there is no shared layer to
    forget it in.** Always `Content-Disposition: attachment` with a sanitised
    filename, always `X-Content-Type-Options: nosniff`, and the stored
    `content_type` echoed back only if it is in the upload allowlist, otherwise
    `application/octet-stream`. Same-origin serving means a stored HTML or SVG
    file served inline with its own content type is a script-execution hole on
    the app's own origin; these three headers close it.

15. **Bytes in Postgres, one blob column, no object storage.** Following
    `DoctorSignature` for the reason given there — the container filesystem is
    ephemeral, and adding S3 to this deployment for a few dozen small PDFs is
    not a trade worth making. These rows land in the same database and the same
    backups as the rota, which is the other half of why the section refuses to
    become a document store.

16. **Studies are fetched wholesale, with no search and no pagination**, per the
    app-wide convention. The list page groups by stage and collapses Closed,
    which is the only affordance a practice with a dozen studies needs.

17. **The persistent fields, settled.** `name` (required),
    `cpms_code` (nullable, unique index — a study in early setup may not have
    one yet, and both SQLite and Postgres allow multiple NULLs under a unique
    index), `study_type` (nullable **free text**, not an enum: the taxonomy is
    set outside this practice and changes, and a free string costs no
    migration to widen), `website_url` (nullable, **`http`/`https` only**,
    validated server-side and rendered with `rel="noopener noreferrer"` — a
    stored `javascript:` URL rendered as a link is a stored-XSS hole),
    `owner_user_id` (nullable FK to `users`). **Contacts are a child table**
    (`study_contacts`: name, role, email, phone, display order) rather than a
    free-text blob, because scanning "who do I ring about this" is exactly the
    one-glance job the page exists for. They are edited inside the study edit
    dialog and saved as a **full replace** on the study PATCH, so they need no
    endpoints of their own.

18. **The site pack is not stored here, and the `site_pack` step has no
    document slot.** 95% of a site pack is not useful day to day and the
    intranet already holds all of it. A slot would be an invitation to copy the
    whole thing across, which is the precise failure this section exists to
    avoid. The step keeps its tick ("site pack received") and its note; the copy
    beside it points at the intranet.

19. **`research` is levelled but NOT lockable.** `LOCKABLE_AREAS` stays
    `("clinical", "reception")`. The section editing lock exists because two
    people editing one shared rota grid overwrite each other; a research study
    is a per-study page with small independent fields, and locking the whole
    section so one person can tick a box would be worse than the collision it
    prevents. The import-time assert in `models/permissions.py` still holds
    (lockable ⊆ levelled), and `main.py`'s registration loop adds
    `require_edit_lock` only for areas in `LOCKABLE_AREAS`, so this needs no
    code — but it needs saying, because a third levelled area makes the reader
    ask.

20. **5 MB per file, and the cap is about intent, not about memory.** 5 MB
    comfortably holds a flow chart, a PIS, a consent form and a signed mNCA, and
    does not hold a site pack — which is the point. Use the same number on both
    sides (the frontend pre-check exists to give a faster message, the server
    stays authoritative). Be honest in the docstring that the server reads the
    body before measuring it, following the existing upload routes, so the cap
    bounds what is *stored* rather than what is *buffered*.

21. **The upload allowlist checks both the declared content type and the file
    extension.** PDF, DOCX, XLSX, PNG, JPG. `content_type` is client-supplied
    and not evidence of anything, so the extension is checked too and the real
    protection remains Decision 14's three response headers.

22. **Research is laid out domain-first, and is the first section in the repo
    to be.** Everything the section owns lives in two packages,
    `backend/app/research/` (models, schemas, catalogue) and
    `backend/app/api/routers/research/` — not spread across `app/models/`,
    `app/api/schemas/` and a flat `app/api/routers/research.py`. The
    convention, and the wiring it still requires, are written up under
    "Adding a Module" in `documentation/architecture.md`; read that section
    before Task 2 rather than inferring the shape from this plan.

    Two things make it worth the small extra thought. Packages mean the
    section's import contract is two `source_modules` lines that cover every
    file added later, where reception — which has the packages but left its
    models and schemas in the shared trees — needs four and would need a
    fifth for a new home. And a domain-first model module makes a
    cross-domain import a *direct* edge, which is the only kind
    `import-linter` can see here. Reception is therefore not the layout to
    copy; it is the halfway point.

    Two constraints survive the layout, and both are called out again at the
    tasks that hit them, because a domain-first layout is exactly what
    invites people to forget them:

    - **`app/models/__init__.py` must still import the new models.**
      `create_all` and Alembic autogenerate rely on importing that one
      package to register every mapper, and the test suite builds SQLite
      from the models. Models living in `app/research/` does not mean an
      unregistered mapper; it means one import line pointing somewhere new.
    - **The permission wiring stays where it is.** `models/permissions.py`,
      `api/deps.py`, `api/schemas/auth.py` and `api/main.py` are shared
      kernel, they are meant to grow by one key per section, and Task 1
      already gets them right. Nothing about this decision moves them.

---

# Task 1: The `research` permission and an empty section

**A.** Nothing exists yet. This task adds the permission, the landing tile and
an empty shell, and ships them on their own — so the gating is proven before
any study data model exists. No study, no document, no research endpoint in
this task.

**B.** Files and deliverables:

- `backend/app/models/permissions.py` — `research` in `AREA_KEYS` and
  `PERMISSION_KEYS`, in `DEFAULT_PERMISSIONS` (as `"none"`), in all five
  existing `PRESETS` (as `"none"` everywhere except `MANAGER_PRESET`, which
  gets `WRITE`), and a new `RESEARCH_PRESET` granting `research: WRITE` and
  nothing else (Decision 10). Leave `LOCKABLE_AREAS` alone and extend its
  comment to say why research is not in it (Decision 19).
- `backend/app/api/deps.py` — a `research` entry in `_FORBIDDEN_DETAIL` and in
  `_READ_ONLY_DETAIL`.
- `backend/app/api/schemas/auth.py` — `research: AccessArea = "none"` on
  `PermissionSet`.
- `backend/alembic/versions/015_research_permission.py` — backfill
  `research: "none"` into every existing `users.permissions` JSON value and
  move the column `server_default` to the new `DEFAULT_PERMISSIONS_JSON`.
  Downgrade strips the key and restores the old default. Follow `010`'s shape,
  and remember CI runs the round trip against real Postgres.
- `frontend/src/api/types.ts` — `research: AccessArea` on `Permissions`.
- `frontend/src/lib/permissionPresets.ts` — the new key in every entry of
  `PERMISSION_PRESETS`; the new `research` preset; `PRESET_ORDER` and
  `PRESET_LABELS`; `PERMISSION_AREAS` and `AREA_LABELS`; and **`isEmptyPermissions`,
  which is hand-written and would otherwise report a research-only login as
  empty and block the form** (State of the world).
- `frontend/src/lib/userSchema.ts` — `research` in the Zod permissions object.
- `frontend/src/components/UserFormDialog.tsx` — the new level control (it
  renders from `PERMISSION_AREAS`, so confirm rather than assume).
- `frontend/src/auth/AuthContext.tsx` — `research` in `DENIED_PERMISSIONS`,
  the `PermissionArea` doc comment updated from "five" to "six", and
  **`canReadArea` hardened so an absent key denies** (`canWriteArea` already
  does — do not change it), with a test for the absent-key case.
- `frontend/src/routes/LandingPage.tsx` — a fifth `SECTIONS` entry,
  `enterable: (p) => canReadArea(p, "research")`.
- `frontend/src/App.tsx` — a `ResearchShell` on `/research/*`, modelled on
  `SignaturesShell`: own header, redirect to `/` unless
  `canReadArea(permissions, "research")`, one `PermissionAreaProvider
  area="research"` on the shell (not per route — unlike Documents this is one
  permission), and a placeholder index page. The shell itself stays in
  `App.tsx` with the other four; the placeholder page is the section's first
  own file and goes in `frontend/src/features/research/` (Decision 22), so
  that Task 4 extends a directory rather than creating one and moving into it.
- Tests: `backend/tests/test_api/test_authorization.py` — add the research
  preset to `_PROFILES`; `backend/tests/test_api/test_users.py` and the
  permission fixtures; `frontend/src/App.test.tsx` for the new shell's guard;
  `lib/userSchema.test.ts` and `lib/permissionPresets.test.ts` for the new key,
  the new preset, and `isEmptyPermissions` returning `false` for a
  research-only set.

**C.** Work outward from `models/permissions.py`; the two direct-subscript
sites (`_FORBIDDEN_DETAIL`, `_AREA`) will fail at import until they are
updated, which is the design working. Do not add a router in this task: there
is nothing for `_AREA` to classify yet. Run
`backend/tests/test_api/test_authorization.py` before touching the frontend —
its `_PROFILES` edit is the only backend test change this task needs.

# Task 2: Data model and migration

**A.** Task 1 is done: the permission exists and `/research` renders an empty
shell. This task adds the schema only — no endpoints, no UI.

**B.** Files and deliverables:

- `backend/app/models/enums.py` — a `StudyStage` enum (`setup`,
  `recruitment_open`, `recruitment_closed`, `closed`), plus the ordered tuple
  the transitions are derived from (Decision 3). This one file **stays
  shared** even though the enum is research-only: `models/enums.py` is the
  registry that migration `001`'s `_enum()` / `_create_enum_types()` pattern
  and the `enum_col` helper both read, and `ReceptionRole` already sets the
  precedent. It is the one named exception to Decision 22, not an oversight.
- `backend/app/research/__init__.py` — creates the package. A docstring and
  whatever thin re-export surface the section wants; no logic.
- `backend/app/research/catalogue.py` — the eight setup steps
  (key, label, display order, `has_documents`) and the three key document slots
  (slot, label). A `by_key` lookup, an `is_valid_step`, an `is_valid_slot`, and
  a `slot_holds_one` predicate used by the router and the schemas.
  Dependency-free, like `models/permissions.py`.
- `backend/app/research/models.py` (**not** `app/models/study.py` — Decision
  22):
  - `Study` — `name`, `cpms_code` (unique index, nullable), `study_type`,
    `website_url`, `owner_user_id` (FK `users`), `stage`, the four nullable
    stage-entry dates, `created_at`.
  - `StudyContact` — `study_id` FK, `name`, `role`, `email`, `phone`,
    `display_order`.
  - `StudySetupStep` — `study_id` FK, `step_key`, `done`, `done_on`, `note`,
    unique `(study_id, step_key)`.
  - `StudyDocument` — `study_id` FK, **non-nullable** `slot`, `filename`,
    `content_type`, `size_bytes`, `LargeBinary` bytes, `uploaded_at`,
    `uploaded_by_user_id` FK to `users`.
  - Cleanup from `Study` to all three children is **ORM-level**
    `relationship(cascade="all, delete-orphan")`, matching every other
    parent/child pair in this schema — not DB-level `ON DELETE CASCADE`, which
    exists in exactly one place here and is not the convention.
- `backend/app/models/__init__.py` — `from ..research.models import Study,
  StudyContact, StudySetupStep, StudyDocument`, so `create_all` sees them (the
  test suite builds SQLite from the models). Easy to skip now that the models
  are not in this directory; the symptom is a missing table in the test DB.
- `backend/pyproject.toml` — the section's `forbidden` contract, **in this PR,
  alongside the section's first module** rather than at the end of the
  section's work. One source module for now, `app.research`; Task 3 adds
  `app.api.routers.research` when that package exists. It cannot be listed
  ahead of time — verified: import-linter fails the whole run with "Module
  'app.api.routers.research' does not exist", it does not skip the entry.
  Forbid the engine, the documents package, the loose clinical helpers, every
  clinical model and schema module, and reception's four. Then add
  `app.research` to the *other* sections' and the shared kernel's
  `forbidden_modules`, so the ban is mutual. Run `uv run lint-imports` from
  `backend/` (it needs the `dev` extra).
- `backend/alembic/versions/016_research_studies.py` — four tables and the
  native enum type, following `001`'s `_enum()` / `_create_enum_types()`
  pattern, with the downgrade dropping the enum type explicitly.
- `backend/tests/test_research_models.py` (a new module — `tests/test_models.py`
  is a file, not a package) — a round-trip test per table, the `cpms_code`
  unique index allowing multiple NULLs, the `(study_id, step_key)` unique
  constraint, and all three cascades.

**C.** Note the two FK traps this repo has already hit: `PRAGMA
foreign_keys=ON` is enabled in the API test engine, and
`tests/test_api/conftest.py`'s stub user is **not** a database row — so any
test inserting a `StudyDocument` with `uploaded_by_user_id`, or a `Study` with
`owner_user_id`, needs a real seeded user. Users are deactivated and never
deleted in this app, so `RESTRICT` is the accurate on-delete behaviour for both
user FKs; say so in the docstring rather than defaulting to `SET NULL`.

`research/models.py` must import `Base` from `..database` and `StudyStage`
from `..models.enums` — the **submodules**, never the `app.models` aggregate.
Two reasons, both real: the aggregate route is invisible to the import
contracts (they are direct-import only), and `app/models/__init__.py` now
imports this module while it is still initialising, so going back through the
aggregate is a circular import waiting on whichever name happens to be bound
after yours.

# Task 3: The REST API

**A.** The permission and the schema exist. This task adds the
`backend/app/api/routers/research/` router package, the section's schemas, and
their tests. No frontend work.

**B.** Files and deliverables:

- `backend/app/research/schemas.py` (**not** `app/api/schemas/research.py` —
  Decision 22) — `StudyOut` (with its contacts, its
  setup steps and its document metadata, never the bytes), `StudyIn`,
  `StudyPatch` (contacts as a full-replace list), `StudyContactIn/Out`,
  `SetupStepPatch` (`done`, `done_on`, `note`, all optional),
  `StudyDocumentOut`. `website_url` validated to `http`/`https` only
  (Decision 17).
- `backend/app/api/routers/research/__init__.py` — docstring only, naming the
  package's convention (each module exposes a module-level `router:
  APIRouter`), like `routers/reception/__init__.py`.
- `backend/app/api/routers/research/studies.py`:
  - `GET /research/studies`, `POST /research/studies`,
    `GET /research/studies/{id}`, `PATCH /research/studies/{id}`,
    `DELETE /research/studies/{id}` (409 outside Setup — Decision 12).
  - `PATCH /research/studies/{id}/setup-steps/{step_key}` — upsert catching
    `IntegrityError`, 422 on a key outside the catalogue (Decision 6).
  - `POST /research/studies/{id}/advance`, `POST /research/studies/{id}/revert`
    — 409 at either end (Decision 4).
- `backend/app/api/routers/research/documents.py`:
  - `POST /research/studies/{id}/documents` (multipart; **required** `slot`
    form field, 422 outside the catalogue; replace-in-one-transaction for the
    three key slots, append for step slots; 5 MB cap; content-type **and**
    extension allowlist), `GET /research/studies/{id}/documents/{doc_id}` (the
    hardened download — Decision 14),
    `DELETE /research/studies/{id}/documents/{doc_id}`.
- `backend/app/api/main.py` — import **both** router modules (following the
  `from .routers.reception import counters as reception_counters, ...` form),
  and add each to `_ALL_ROUTERS` and to `_AREA` (`research`). The assertion
  there fails at import if one is missed, which is the design working. Not
  `_UNGATED`, not `_SHARED_READ`. No
  `require_edit_lock` — research is not in `LOCKABLE_AREAS` (Decision 19), and
  the registration loop handles that on its own.
- `backend/app/api/audit_descriptions.py` — one sentence per new non-GET route,
  in the UI's own vocabulary ("Opened recruitment for study 4"), or
  `test_audit_descriptions.py` fails with the missing keys.
- `backend/tests/test_api/test_authorization.py` — **add
  `f"{API_PREFIX}/research": "research"` to `_AREA_FOR_PREFIX`.** The map is
  hand-written on purpose, so the sweeps can catch a router filed under the
  wrong section. It is not optional and it is not silent: `_area_for` raises
  `KeyError` on an unclassified path, and
  `test_the_area_table_agrees_with_the_app` compares the map against main.py's
  `_AREA`, so omitting it fails the suite rather than quietly skipping the new
  router.
- `backend/tests/test_api/test_research.py` — CRUD, contacts full-replace, the
  step upsert, both transition endpoints at both ends, the delete rule,
  upload/download/delete, key-slot replacement vs step-slot append, the size,
  type and slot rejections, the `javascript:` URL rejection, and the three
  response headers.

- `backend/pyproject.toml` — add `app.api.routers.research` to the source
  modules of the contract added in Task 2 (this is the task that makes that
  package exist, and so the first task in which it may be named), add it to
  the other sections' `forbidden_modules` alongside `app.research`, and
  **promote
  `app.api.routers._uploads` to the shared kernel**: move it out of the
  clinical source list in "Clinical must not import reception" and into the
  source list of "Shared kernel must not import domains". See **C** — this is
  a deliberate Decision 2 addition, and the comment must say so.

**C.** Reuse `routers/_uploads.py`'s `safe_filename_stem` rather than writing
new filename validation: it was written for exactly this problem (no
client-supplied path or quote may reach a `Content-Disposition` header). The
allowlist and the 5 MB constant are wider/different than the DOCX ones there,
so they belong in the new router, not in `_uploads.py`.

That reuse is the one place this section legitimately reaches outside its own
package, and the contracts currently classify `_uploads` as **clinical**, so
importing it from `routers/research/documents.py` would fail
`lint-imports` — correctly, given today's classification. Do not work around
it by deleting a line from a `forbidden_modules` list. `_uploads.py` imports
nothing from `app` at all: it is a stdlib-only filename-safety helper that
happens to live in `routers/` because that is where its two callers were, and
its own docstring already calls `safe_filename_stem` "the one genuinely shared
piece". Promoting it is the honest fix, and it is a decision being taken here
rather than a convenience: the shared kernel gains one leaf module that three
sections need, and the file itself does not move (relocating it would touch
live signatures and EOI routes for no gain). Record it in the kernel list in
`architecture.md` in Task 7. Confirm by test that
the upload's bytes never reach the audit log (multipart passes through
unbuffered) and that the metadata PATCHes do.

# Task 4: Study list and study page shell

**A.** The API is complete and tested. This task builds the section's two pages
and the persistent header, with the stage bodies stubbed.

**B.** Files and deliverables:

Everything below lives under `frontend/src/features/research/`, not in the
flat `src/api/`, `src/lib/`, `src/routes/` and `src/components/` trees
(Decision 22). The existing sections stay where they are; nothing enforces
this on the frontend, so it is convention only — but it is the convention, and
this is the section establishing it. The one exception is the *shared*
`Permissions` key, which Task 1 already added to `src/api/types.ts` and which
belongs there.

- `frontend/src/features/research/api.ts` — TanStack Query hooks with
  hierarchical keys, mutations invalidating the resource root per the app
  convention. It still imports the shared `client.ts` (`getBlob`, `postForm`)
  — that is shared infrastructure, not another section's code.
- `frontend/src/features/research/types.ts` — the wire mirrors (`Study`,
  `StudyContact`, `StudySetupStep`, `StudyDocument`, `StudyStage`), enums
  mirrored by **value**.
- `frontend/src/features/research/catalogue.ts` — the frontend mirror of the
  setup steps and key slots (labels and order in one place, never inlined in a
  component).
- `frontend/src/features/research/StudiesPage.tsx` — the index: grouped by
  stage, Closed collapsed, a "New study" dialog, write controls through
  `useWriteGate()`.
- `frontend/src/features/research/StudyPage.tsx` — `/research/studies/:id`: the
  persistent header panel (the six fields, the contacts table and the three key
  documents — Decision 13), a four-stage indicator, the standing
  data-protection line (Decision 9), the advance/revert controls, and a switch
  on `stage` rendering the body.
- `frontend/src/features/research/StudyFormDialog.tsx` — create and edit
  including the contacts rows, Zod-validated, mirroring the server's rules
  (including the `http`/`https` URL rule).
- `frontend/src/App.tsx` — the two real routes inside `ResearchShell`.
- Tests alongside each, MSW-backed, including a read-only user seeing the page
  with its controls disabled, and the website link rendering with
  `rel="noopener noreferrer"`.

**C.** The transition confirmation belongs here, not in Task 5: it is the
header's control. It lists the outstanding steps from data the page already
holds, and its copy differs between advance and revert. The three key documents
live in the header too, so they are present in every stage without each stage
body re-rendering them.

# Task 5: The Setup stage body

**A.** The study page renders with stub bodies and a working header. This task
builds the Setup body in full.

**B.** Files and deliverables:

- `frontend/src/features/research/SetupStage.tsx` — the eight steps in catalogue
  order, each a tick, a date input and a note field, with a document slot on
  the three steps whose catalogue entry says they have one. `site_pack` renders
  its tick and note with the "the site pack stays on the intranet" copy and no
  upload control (Decision 18).
- `frontend/src/features/research/DocumentSlot.tsx` — one component serving
  both shapes, taking a `holdsOne` flag: upload (drag and drop plus a file
  input, following `EoiPage`), the slot's document list with download and
  delete, the client-side 5 MB and type pre-checks, the replace confirmation
  for single-document slots, and the no-participant-data copy with the
  blank-vs-completed distinction spelled out.
- Tests: a tick persisting, an unticked step rendering with no row present
  server-side, upload rejection paths, a key-slot replace showing the
  confirmation and leaving one document, and `downloadBlob` mocked to assert
  the stored filename is used.

**C.** Mirror the size and type checks from the server rather than inventing
looser ones, and keep the server authoritative on failure. `getBlob` returns no
filename, so pass the document row's `filename` to `downloadBlob` explicitly.

# Task 6: The Recruitment-open stub

**A.** Setup works end to end. This task adds the minimum second-stage body, so
that advancing a study lands somewhere coherent.

**B.** `frontend/src/features/research/RecruitmentOpenStage.tsx`: nothing but an
explicit "more to come here" placeholder — the persistent information and the
three key documents are already in the shared header and must not be
duplicated. Plus the two remaining stages rendering the same minimal body for
now. Tests: advancing a study hides the setup checklist and keeps the header's
key documents visible.

**C.** Resist adding recruitment fields here. The point of the stub is to learn
what the recruitment page needs from using the setup page first; a half-guessed
set of accrual fields is harder to remove than to add. The known gap — "what is
outstanding and what meetings are booked, once setup is over" — is recorded in
Scope and is the next plan's problem, not this stub's.

# Task 7: Review and documentation

**A.** Tasks 1–6 are complete and the section is live. This task is review and
documentation only.

**B.** Deliverables:

- `documentation/architecture-research.md` — a new domain document in the style
  of `architecture-reception.md`: what the section is for and the intranet it
  deliberately does not replace, the stage machine and why it is one enum
  column, the lazy step rows and the catalogue module, the two document slot
  shapes and why key slots replace, the three download headers, the
  blank-vs-completed data-protection stance, why research is levelled but not
  lockable, and what was deliberately left out.
- `documentation/architecture.md` — the Domains list, the Document Index, the
  permission table, and the Tech Stack auth row all name the new permission and
  the new document. Also: add `app.api.routers._uploads` to the shared-kernel
  list under "Module Boundaries" with the reason (Task 3, **C**), list the new
  contract pair among the contracts, and update "Adding a Module" where
  research proved it wrong or incomplete — that section was written before any
  section had been built to it, so treat anything that tripped you up in Tasks
  2–6 as a fix owed to the next section rather than a note for this plan.
- Delete `documentation/research_section_plan.md`.

**C.** Do not cite this plan or a task number in any code comment or
architecture doc — write the decision itself. Do not claim the app hardens
downloads generally: `GET /signatures/{id}/image` still serves a stored content
type inline without `nosniff`, and the research doc should scope its claim to
research documents. Re-read the section as a first-time user before writing the
doc: the questions you have to answer for yourself are the ones the doc should
answer.
