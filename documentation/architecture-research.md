# Rota Generator — Research Architecture

Covers the Research section only. Shared infrastructure — auth, the app shell, the HTTP client, tech stack, CI, deployment — is documented once in `documentation/architecture.md`; read that first if you haven't already. Neither rota is needed to work on this section, and this section is not needed to work on either rota: Research shares nothing with them but auth, the shell, the HTTP client and the deployment.

## Domain: Research

A fifth top-level section holding one page per research study the practice is a recruitment site for. As with the two rota docs, what follows records only what reading the code will not tell a future reader on its own — the reasons a shape was chosen over the obvious alternative.

**Where the code lives.** Two packages and nothing outside them: `backend/app/research/` (`models.py`, `schemas.py`, `catalogue.py`) and `backend/app/api/routers/research/` (`studies.py`, `documents.py`), with the frontend in `frontend/src/features/research/`. Research is the first section in the repo built to the domain-first convention in "Adding a Module" in `documentation/architecture.md` — its models and schemas are *inside* the section package rather than in `app/models/` and `app/api/schemas/`, which is what lets its `import-linter` contract name two source modules where reception's needs four. **Reception is not the shape to copy; this is.** The section's modules import model and schema submodules (`from ..models.enums import StudyStage`), never the `app.models` aggregate, for the two reasons that section gives: the contracts are direct-import only, and `app/models/__init__.py` imports `app/research/models.py` while it is still initialising.

### What this section is for, and what it deliberately is not

The practice already runs an intranet holding the full site pack and the patient database. **That intranet is, and remains, the record.** It is also hard to navigate: most of a site pack is irrelevant day to day, the three documents that matter are buried among superseded copies of themselves, and there is nowhere to see what stage a study is at or what is still outstanding.

This section is the answer to that and nothing more — a one-glance view of where each study is, and a shortcut to the handful of documents the team actually opens. Nothing here needs to survive forever, because the intranet already holds it. **It is a signpost, not a document management system**, and almost every decision below is that sentence applied to a particular question. The pressure on this section will always be to accept one more file, one more folder, one more field; the reason to refuse is that a second, worse copy of the intranet is of no use to anybody, and the section stops being a signpost the moment it can no longer be read at a glance.

### No participant-identifiable data, and where the line actually falls

This is the highest-risk thing about the section, and the distinction is the whole of it:

- **Fine, and wanted:** the *blank, current* patient information leaflet and the *blank, current* consent form. These are study templates, and two of the three reasons the page exists.
- **Never:** anything filled in about a real person — recruitment or screening logs, **signed** consent forms, participant lists, NHS numbers.

Delegation and training logs are *staff* documents and are fine. The line is "completed", not "consent form" — a rule phrased as "no consent forms" would read as forbidding the template, which is exactly the file the team came here for.

**Nothing in the schema can enforce this, and the docs say so rather than implying a check exists.** The controls are copy and permission scope: a standing, non-dismissible line on the study list and on every study page, the same blank/completed sentence repeated inside each upload control (not only once at the top of the page), and a `research` permission narrow enough that the Research preset grants it and nothing else. Pretending to a technical control here would be worse than stating the position plainly.

### The four stages

    setup  →  recruitment_open  →  recruitment_closed  →  closed

**One `stage` column holding a four-value native enum, never four booleans.** The stages are mutually exclusive, so a shape that can represent "recruitment open and closed at once" is a shape somebody will eventually save. `StudyStage` lives in `models/enums.py` rather than in the research package — a deliberate, documented exception to domain-first placement, because that file is the registry the migration `_enum()` helpers read (see "Adding a Module").

The order lives once, in `STUDY_STAGE_ORDER` beside the enum, and every transition is *derived* from it. Nothing anywhere writes out "the stage after `recruitment_open`", so a fifth stage is an edit there plus a migration, not a hunt through call sites.

**Progression is one step at a time, in either direction, never a jump.** `POST /research/studies/{id}/advance` and `POST /research/studies/{id}/revert`, each 409ing at the end it is being pushed past. Two endpoints rather than a settable `stage` field on the PATCH, for three reasons: the *transition* is the domain action rather than an edit; a body-supplied stage invites the jump; and a revert deserves its own audit sentence and its own confirmation copy rather than arriving indistinguishable from a typo fix. `StudyPatch` consequently has no `stage` field at all.

**Revert exists because a misclick otherwise needs a database edit**, and it is safe because no stage's data is ever deleted on leaving it. Setup's checklist is *hidden* in later stages, never destroyed, so reverting restores the page exactly as it was. That is the property to preserve if a later stage body ever gains data of its own.

**Stage-entry dates are four nullable date columns on the study row, not a history table.** "When did recruitment open?" is a question worth answering; "how many times did somebody bounce this study between stages?" is not, and the audit log already answers the second one for free if it is ever asked. Entering a stage stamps its column, including on the way back — reverting into setup is a re-entry like any other, which is why `setup_entered_on` exists at all even though it duplicates the date part of `created_at` for a study that has never moved.

### The setup checklist

Eight steps — sign mNCA, book SIV, complete SIV, delegation log, training log, site pack received, flow chart completed, green light — living in `backend/app/research/catalogue.py`, a dependency-free module on the same pattern and for the same reason as `models/permissions.py`: the router, the schemas, the model validation and the frontend's mirror all need one source of truth.

**Rows are created lazily, and their absence is data.** A new study has no `study_setup_steps` rows at all; the first PATCH to a step upserts one under a unique `(study_id, step_key)`, and a step with no row renders as "not done". Between that and `step_key` being a *checked string* rather than an enum type, a ninth step is a one-line catalogue addition with no migration and no backfill, and a step dropped from the catalogue leaves orphan rows that are simply never rendered again. `_to_out` filters unknown keys, so that last part is true for every reader at once rather than per page.

The unique constraint is what the upsert is for: the router catches `IntegrityError` on the insert and re-selects, so two people ticking the same box at the same moment is a race one of them loses quietly rather than a 500.

**The checklist never blocks a transition.** A hard gate on eight ticks teaches people to tick things they have not done. The API does not consult the steps when advancing at all; the frontend's confirmation dialog on "Open recruitment" *names* what is still outstanding, computed from data the page already holds, and then lets the user through. Warn, don't block — the same convention as reception's coverage warnings.

**`done_on` is the date the step was completed, entered by hand** — not a timestamp of when the box was ticked, which is the audit log's job.

### Documents: two slot shapes, and no third

`study_documents.slot` is non-nullable and validated against the catalogue. **There is no "general study document" and no folder**: a file that fits no slot belongs on the intranet. That is the single rule that keeps this from becoming a document store, and it is the one most likely to be eroded by a reasonable-sounding request.

- **Key slots** — `flow_chart`, `patient_information_leaflet`, `consent_form` — hold exactly one current file. Uploading replaces what is there, in one transaction, behind a confirmation. This is the direct answer to "all the old leaflets are in the same folder": **the page cannot show a superseded leaflet, because it does not keep one.** The superseded copy is not lost; the intranet has it. Doing the delete and the insert in one transaction is not fussiness — a key slot that briefly held nothing, or briefly held two files, is a page that briefly lied about which leaflet is current.
- **Setup-step slots** — `mnca`, `delegation_log`, `training_log` — hold any number, because a re-signed mNCA arriving beside the original is normal and neither copy is "superseded" in a way this page can judge.

`catalogue.slot_holds_one` is the switch. It is enforced in the router rather than by a partial unique index because expressing "unique only for these three slots" needs a per-dialect `where` clause for SQLite and Postgres, which is more machinery than a replace-in-one-transaction needs.

**Two steps deliberately own no slot.** `site_pack` keeps its tick and its note and points at the intranet: 95% of a site pack is not useful day to day, the intranet already holds all of it, and a slot would be an open invitation to copy the whole thing across — the precise failure this section exists to avoid. `flow_chart` has no step slot because the file is the *key* slot, so it stays visible in every stage instead of being buried in a checklist that disappears once setup is over. That is why `flow_chart` appears in both catalogue tables and means a different thing in each; the slot namespace stays unambiguous because the step contributes nothing to it.

**Bytes in the database, one blob column, no object storage.** Following `DoctorSignature` and for the reason given there: Railway runs one service with an ephemeral container filesystem, so bytea is a constraint rather than a preference, and adding S3 for a few dozen small PDFs is not a trade worth making. It also puts these rows in the same backups as the rota — the other half of why the section refuses to grow into a store. `size_bytes` sits beside the blob so a list can show a size without loading it, and every study query defers `StudyDocument.data`: without that, a study page load would pull every stored file's bytes out of the database to serialise their filenames.

**5 MB per file, and the cap is about intent, not memory.** It comfortably holds a flow chart, a leaflet, a consent form and a signed mNCA, and does not hold a site pack — which is the point. The same number is used on both sides; the frontend pre-check exists to give a faster message and the server stays authoritative. Be honest about what it does: like the two existing upload routes, this one reads the whole body and *then* measures it, so the cap bounds what is **stored**, not what is **buffered**.

**The allowlist checks the declared content type and the extension.** PDF, DOCX, XLSX, PNG, JPEG. `content_type` is client-supplied and is not evidence of anything, so the extension has to agree with it — but neither check is the real protection, which is the response headers below.

### Downloads are hardened per response

Every research document download sets three things, on the response itself:

- `Content-Disposition: attachment`, with a filename rebuilt from a stem run through `safe_filename_stem` (shared with `/signatures/{id}/apply` and `/eoi/fill`) and an extension echoed back only while it is in the allowlist,
- `X-Content-Type-Options: nosniff`,
- the stored `content_type`, echoed only if it is still in the upload allowlist, and `application/octet-stream` otherwise.

These files are served from the app's own origin, so a stored HTML or SVG served inline under its own content type would be script execution on that origin. Those three headers are what close it.

**They are set per response because there is no shared layer to forget them in.** `main.py` registers CORS and `AuditMiddleware` and no security-headers middleware at all. **Scope the claim carefully:** this hardening covers research documents, and nothing more. `GET /signatures/{id}/image` still serves a stored content type inline with no `nosniff` — a pre-existing gap that was out of scope here and has not been fixed, so the app does not harden downloads generally.

**Document reads are scoped to the study in the path**, not looked up by id alone: a document id belonging to another study 404s rather than being served because it happens to exist.

### The permission

`research` is a **levelled** permission (`none` / `read` / `write`), independent of `signatures` and `study_eoi`. There is a meaningful read-only view here — a clinician checking the current leaflet for a recruiting study has no business ticking setup steps — and levelling means the existing `require_access` machinery gates reads and writes with no new code.

**Writes are `research: write` and nothing wider.** The Manager preset gets `write`; a new **Research** preset grants `research: write` and *nothing else*, so the person who runs studies can be given exactly that and no access to scanned signatures or anyone's rota. Every other preset gets `none` — including Read-only, which grants `clinical: read` and `reception: read`: those two are rotas everyone benefits from seeing, and this is not. No preset grants `research: read`; it is assigned by hand when somebody asks, which is what presets being starting points rather than roles allows.

One consequence shapes the API: because the Research preset cannot read `/users`, `StudyOut` carries a denormalised `owner_name` alongside `owner_user_id`. Without it the study header could only show an id.

**`research` is levelled but deliberately NOT lockable.** `LOCKABLE_AREAS` stays `("clinical", "reception")`. The section editing lock exists because two people editing one shared rota grid overwrite each other; a research study is a per-study page of small independent fields, and locking a whole section so that one person can tick a box would be worse than the collision it prevents. This needs no code — `main.py` adds `require_edit_lock` only for areas in `LOCKABLE_AREAS`, and `ResearchShell` is not wrapped in an `EditLockProvider` — but it is worth stating, because a third levelled area is exactly what makes a reader ask. The import-time assert in `models/permissions.py` (lockable ⊆ levelled) still holds.

### Deletion is Setup-only

A study can be deleted only while it is in Setup; `DELETE` 409s in every other stage. A study created by mistake is real and needs a way out, but a study that ever recruited is a record — it gets closed, not deleted. A deliberate asymmetry rather than a soft-delete flag: a `deleted_at` column would need filtering in every query forever for the sake of a case that only happens on the day the study is created.

Cleanup is **ORM-level** `cascade="all, delete-orphan"` on all three child relationships, matching every other parent/child pair in this schema (the one DB-level `ON DELETE CASCADE` in the whole database is `school_holidays.school_id`, which is the exception). Because deletion is reachable only in setup, these cascades run on the day a study is created by mistake and essentially never again.

Both FKs to `users` — `studies.owner_user_id` and `study_documents.uploaded_by_user_id` — are left at the database default (RESTRICT), not `SET NULL`. Users in this app are deactivated and never deleted, so a delete that would orphan a study owner is a mistake worth failing on rather than quietly blanking a column.

### The persistent header

Name (required), CPMS code (nullable, uniquely indexed), study type, study website, owner, and contacts — shown above whichever stage body is active, in every stage, together with the three key documents and the stage indicator. **Persistent information is edited in one place and rendered by the study page rather than by each stage body**, so no stage body has to remember to draw it and a study that has left setup still shows its current flow chart, leaflet, consent form and whom to ring about them.

- **`cpms_code` is nullable and uniquely indexed.** A study in early setup often has no code yet; both SQLite and Postgres treat NULLs as distinct in a unique index, so any number of studies may sit without one while no two can claim the same one. Blank strings are normalised to NULL at the schema layer precisely so a form posting `""` for an empty box cannot collide. A clash is a 409 naming the other study, checked by a select *and* caught as an `IntegrityError` at the write — the select gives the right status and a useful sentence, the catch covers the race between the two.
- **`study_type` is free text, not an enum.** The taxonomy is set outside this practice and changes; a free string costs no migration to widen, and nothing in the app branches on the value.
- **`website_url` is validated to `http`/`https` only, and that is a security control, not tidiness.** The header renders the value as a link, and a stored `javascript:` URL rendered as a link is stored XSS on the app's own origin. The check lives in the schema because that is where the value enters — the column is a plain string, and a CHECK constraint could only repeat the rule badly. The rendered link also carries `rel="noopener noreferrer"`, which stops the tab it opens reaching back; both halves are pinned by tests, on both sides.
- **Contacts are a child table, not a free-text blob**, because scanning "who do I ring about this" is exactly the one-glance job the page exists for. They have **no endpoints of their own**: they are edited inside the study dialog and saved as a **full replace** on the study PATCH, so `{"contacts": [...]}` means "these are now all the contacts" and an absent key means "leave them alone". `StudyContactIn` therefore carries no id — sending one back would imply an identity the replace does not preserve — and `display_order` is renumbered from the sent order by the replace rather than maintained by the rows.

Everywhere else, the PATCH distinguishes **absent from null** via `model_fields_set`: `{"cpms_code": null}` clears the code, `{}` leaves it alone. A field the dialog did not touch must be omitted rather than sent as null.

### Frontend

`frontend/src/features/research/` — pages, components, API hooks, wire types and the client-side catalogue mirror together, the layout "Adding a Module" prescribes and the first section in the repo to use it. Section-owned wire types live in `types.ts` here rather than in `src/api/types.ts`; the one exception is the `research` key on `Permissions`, which is shared.

- **`ResearchShell` is modelled on `SignaturesShell`, not on the rota shells** — its own header, no left nav — because a list of study pages is not a set of sibling tools with a nav bar between them. One `PermissionAreaProvider` wraps the whole shell, since unlike Documents (two pages, two independent permissions) the whole section is the single `research` permission. An unknown path inside the section lands on the study list rather than a blank screen; a study id that no longer exists is the study page's own 404.
- **Studies are fetched wholesale — no search, no pagination**, per the app-wide convention for reference data. A practice runs a dozen studies. The list groups by stage and collapses Closed, which is the only affordance that size needs: the studies somebody is working on are the ones that are not closed, and a closed study is looked up rather than scanned for.
- **`StudyStage` is mirrored by value, not by index.** The backend's `STUDY_STAGE_ORDER` decides what "one stage forward" means, and the server never takes a stage from the client; the order repeated in `types.ts` is for display and for naming the next stage in a confirmation, so a mismatch would be a copy error rather than a protocol one.
- **The Recruitment-open body is deliberately an empty stub.** The point of building Setup first is to learn what the recruitment page actually needs from using it in anger, and a half-guessed set of accrual fields is harder to remove than to add. It says "more to come here" and nothing else, and it does not repeat the header, which the study page draws above it.

### Router surface

| Router | Responsibility | Key behaviour |
|---|---|---|
| `/research/studies` (`studies.py`) | Study CRUD, the stage machine, the setup checklist | `GET ""` (every study, wholesale), `POST ""`, `GET /{id}`, `PATCH /{id}` (persistent header; `contacts` present is a full replace, `stage` is not a field), `DELETE /{id}` (409 outside Setup), `PATCH /{id}/setup-steps/{step_key}` (upsert; 422 on a key the catalogue does not know), `POST /{id}/advance` and `POST /{id}/revert` (one step, 409 at each end). Every one but the delete returns the whole study, so the client's copy of the header, the checklist and the documents stays in step |
| `/research/studies` (`documents.py`) | The files hanging off a study | `POST /{id}/documents` (multipart, `slot` a required form field; 422 on an unknown slot or a type/extension mismatch, 413 over 5 MB; replaces in a key slot, appends in a step slot), `GET /{id}/documents/{document_id}` (the hardened download), `DELETE /{id}/documents/{document_id}` |

Two `APIRouter`s under one prefix is deliberate: the document endpoints are a separate concern with their own upload rules, and splitting them keeps either file readable. Both are classified `research` in `main.py`'s `_AREA`, so gating is entirely at registration time and nothing in either file gates itself.

**Uploads are audited as an event, not as content.** `AuditMiddleware` parses a body only when the content type is `application/json`, so a multipart upload records who uploaded to which study and nothing of the file, while the JSON PATCHes next door are recorded in full. Both halves are pinned by tests. This is the same behaviour the two existing signature uploads already rely on.

## What was deliberately left out

Recorded so these are not rediscovered later as omissions, and so anyone proposing one knows what argument they have to beat.

| Not done | Why |
|---|---|
| **Anything participant-level** — recruitment logs, screening logs, signed consent forms, ID lists | The line above. This is the one that matters, and widening it is not a feature decision |
| **Storing the site pack** | The intranet is the record and holds all of it; a slot here would invite copying the whole thing across, which is the failure the section exists to avoid |
| **Version history, review or expiry dates, full-text search, bulk download, folders** | Every one of them is a document management system growing out of a signpost. A key slot's superseded copy is on the intranet, which is what makes "replace" an acceptable answer rather than a lossy one |
| **The recruitment-open, recruitment-finished and close-down bodies** | Built as a stub on purpose — see the frontend note above. **The named gap:** "what meetings are booked, what is outstanding" is answered by the checklist during Setup and by nothing afterwards. That is the main thing the recruitment body will have to solve, and it is recorded here so it is not lost |
| **Any link between a study and doctors, reception staff, rotas or the engine** | There is no such relationship today. `Owner` is a plain FK to `users`, a different thing from "whose rota row is this" — see the identity-link note in `documentation/architecture.md` |
| **Moving the Study EOI autofill tool in here** | It stays under Documents (`/signatures/eoi`) on its own `study_eoi` permission. Revisit later; it is a document generator, not a study page |
| **Recruitment targets, accrual figures, payments, invoicing** | Not asked for, and every one of them is participant- or finance-shaped rather than signpost-shaped |
| **A partial unique index for the single-file key slots** | Per-dialect `where` clauses for SQLite and Postgres to express "unique only for these three slots", to replace a replace-in-one-transaction that is already correct |
| **A stage-history table** | Four nullable date columns answer the question anyone actually asks; the audit log answers the other one |
| **Making `research` lockable** | Covered above: the lock solves a shared-grid problem this section does not have |
