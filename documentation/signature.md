# Provisional Plan: Document Signature Tool

## Scope

A new "Signatures" tab in the existing rota app, unrelated to rota
generation. Admin staff drag a Word document onto a doctor's name; the
backend inserts that doctor's stored signature image into the bottom-left
cell of the document's table, applies Restrict Editing (read-only, fixed
shared password) directly via XML manipulation, and returns the modified
docx as an immediate browser download.

No PDF conversion, no LibreOffice, no new Railway service, no subprocess
calls. This rides entirely on the existing FastAPI/Postgres/Railway
service.

## Confirmed inputs

1. Signature storage: DB blob (new table), not a volume or object storage.
2. Insertion point: fixed and identical across every document — a
   two-column table, bottom row, left-hand cell. No template detection or
   marker-scanning needed.
3. Signature source: a pre-scanned JPG per doctor, uploaded once via the
   new tab and reused for every document from then on.
4. Output: immediate download, no server-side retention of the
   *processed* document (only the source signature image is persisted).
5. One signature per document (no multi-signature case to design for).

## Design decisions

- **New table, not a `Doctor` field.** `DoctorSignature` (doctor_id FK,
  unique; image bytes; content_type; uploaded_at). Keeps this as an
  optional 1:1 attachment separate from the core doctor record used by
  the rota engine — no risk to existing `Doctor` schema, tests, or forms.
- **New top-level backend area**, not inside `engine/` or mixed into an
  existing router. This is document manipulation, not rota logic, and
  has nothing to do with `GenerationContext`/`RotaGrid`. Proposed:
  `backend/app/documents/` for the processing logic, plus
  `backend/app/api/routers/signatures.py` for the two endpoints.
- **Table targeting by position, not content matching.** Since the format
  is confirmed identical across every document, the processor grabs
  `document.tables[0]`, then the last row, then cell index 0 — no text
  scanning, no bookmark, no heuristics. This is deliberately brittle to
  a table-format change; if admin staff ever start sending a different
  layout, this breaks loudly (a clear exception, not a silent wrong
  placement) rather than guessing. Worth flagging now: if the source
  documents ever come from more than one system or template in future,
  this assumption needs revisiting.
- **Restrict Editing via direct `settings.xml` manipulation**, per the
  earlier discussion — `python-docx` has no support for this, so it's a
  hand-built XML node inserted before re-zipping. Fixed password,
  shared across all documents (already agreed this is a deterrent, not
  real security, matching the current unprotected-PDF baseline).
- **No processed-document persistence.** The endpoint is stateless per
  request: receive docx + doctor_id, return modified docx. Nothing about
  the *output* document is stored, only the doctor's signature source
  image. This keeps the feature simple and avoids any data-retention
  question for documents that may contain patient-adjacent
  correspondence.
- **Signature image stored as uploaded**, no server-side resizing or
  processing at upload time. Sizing/placement handled at insertion time
  in the docx (fixed width, e.g. via `python-docx`'s `width=` on
  `add_picture`, so a large scan doesn't blow out the cell).

## New components

**Backend**
- `backend/app/models/signature.py` — `DoctorSignature` model
- Alembic migration (next sequential number)
- `backend/app/documents/signature_insert.py` — table-cell image
  insertion via `python-docx`
- `backend/app/documents/restrict_editing.py` — `settings.xml` node
  construction and injection into the docx zip
- `backend/app/api/schemas/signature.py`
- `backend/app/api/routers/signatures.py`:
  - `POST /api/v1/signatures/{doctor_id}` — upload/replace a doctor's
    signature image
  - `GET /api/v1/signatures/{doctor_id}` — fetch current signature
    (for the management UI to show a preview/thumbnail)
  - `POST /api/v1/signatures/{doctor_id}/apply` — accepts a docx file,
    returns the modified docx

**Frontend**
- `frontend/src/routes/SignaturesPage.tsx` — doctor list (reusing the
  existing active-doctor fetch/grouping pattern from `DoctorsPage`),
  each row a drop target; a small management affordance per doctor to
  upload/replace their signature image
- `frontend/src/api/signatures.ts` — upload, fetch, apply hooks
- Nav entry added to `App.tsx`'s `NAV_ITEMS`

## Out of scope / explicitly not doing

- PDF output, LibreOffice, Gotenberg, any subprocess-based conversion
- Per-doctor restriction passwords
- Any change to `engine/`, rota models, or existing routers
- Server-side storage or history of processed documents
- Template/marker detection for documents with a different table layout

## Open items for the implementation-plan pass

- Exact `settings.xml` node (legacy password-hash form vs. the newer
  `w:documentProtection` attributes) — a concrete technical decision,
  better resolved with code in front of us than guessed here.
- Max upload size / accepted image formats for the signature (JPG
  confirmed as the real-world case; worth deciding whether to hard-block
  other formats or just pass them through).
- Whether the doctor list on this page should be scoped to
  Partner/Salaried only, since those are the roles mentioned as needing
  signatures — Trainees/AHPs presumably don't sign these letters. Worth
  confirming before the endpoint/UI filters doctors.
