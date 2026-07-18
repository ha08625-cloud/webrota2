# Plan

Add a "Signatures" feature to the rota app: admin staff upload one signature
image (JPG/PNG) per Partner/Salaried doctor, then drop a Word document onto a
doctor's row; the backend inserts the signature into the bottom-left cell of
the document's table, applies Word Restrict Editing (read-only, fixed shared
password), and returns the modified docx as an immediate browser download.
Stateless per request: only the signature source image is persisted.

Five tasks, strictly sequential. Each task is self-contained context for a
separate implementation chat.

# Scope

**In scope**

- New table `doctor_signatures` + migration 009
- New backend package `backend/app/documents/` (pure document manipulation,
  no FastAPI, no DB)
- New router `backend/app/api/routers/signatures.py` (upload, list, image
  fetch, delete, apply)
- Frontend: binary/multipart support in `client.ts`, `api/signatures.ts`
  hooks, `routes/SignaturesPage.tsx`, nav entry
- Backend unit + API tests, frontend Vitest/MSW tests

**Out of scope**

- PDF output, LibreOffice/Gotenberg, any subprocess
- Per-doctor passwords; real document security
- Any change to `engine/`, rota models, or existing routers
- Server-side storage or history of processed documents
- Template/marker detection for other table layouts
- Reading `.doc` (legacy binary) files — rejected with a clear error

# Design Decisions

1. **`DoctorSignature` is a new table**, not a `Doctor` column: optional 1:1
   attachment (`doctor_id` FK, unique), image bytes in Postgres (`LargeBinary`
   / bytea). Volumes are small (one small JPG/PNG per doctor); no object
   storage.
2. **Table targeting is positional and deliberately brittle**:
   `document.tables[0]`, last row, cell index 0. Assumptions are asserted
   explicitly (document opens as OOXML, has >= 1 table, table[0] has exactly
   2 columns); violation raises a typed error the router maps to a 422 with a
   human-readable message. No content scanning, no heuristics.
3. **Target cell is empty** (confirmed). The image is added to the cell's
   first (empty) paragraph — no clearing, no prepend/append logic.
4. **Fixed image width of 4 cm** via `add_picture(width=Cm(4))`; height
   scales automatically, so an oversized scan cannot blow out the cell. No
   server-side image processing at upload time.
5. **Restrict Editing via `document.settings.element`** — python-docx exposes
   the `w:settings` lxml root directly, so the `w:documentProtection` node is
   inserted into the loaded document before a single `document.save()`. No
   re-zipping, no `[Content_Types].xml` handling. Inserted as the **first
   child** of `w:settings` (the schema places it near the front; Word is
   tolerant of exact position but not of it trailing the whole sequence).
6. **Modern password hash form**: `w:edit="readOnly"`, `w:enforcement="1"`,
   `w:cryptProviderType="rsaAES"`, `w:cryptAlgorithmClass="hash"`,
   `w:cryptAlgorithmType="typeAny"`, `w:cryptAlgorithmSid="14"` (SHA-512),
   `w:cryptSpinCount="100000"`, base64 `w:hash`/`w:salt`. Algorithm spec is
   written out verbatim in Task 2 so it is not re-derived from memory.
7. **Password source**: env var `DOC_LOCK_PASSWORD`, read per request (same
   pattern as `API_TOKEN` in `deps.py`), defaulting to a module constant.
   This is a deterrent, not security — anyone can strip the node by unzipping
   the docx — matching the previously-unprotected baseline.
8. **Upload validation whitelist**: content type must be `image/jpeg` or
   `image/png`, hard 5 MB cap on signature images, 10 MB cap on documents.
   Anything else is a 422 (oversize: 413). No pass-through of other formats.
9. **UI filtered to Partner/Salaried, endpoints unscoped** (confirmed): the
   page lists only Partner/Salaried active doctors; the API accepts any
   doctor_id so an unusual case remains possible without a schema change.
10. **Binary transport through explicit fetch, never URLs**: auth is an
    `X-API-Token` header, so `<img src>` and plain download links cannot
    work. The signature preview and the docx download both go through
    header-carrying fetches; `client.ts` gains form-data and blob-returning
    methods (its current `request()` force-sets JSON `Content-Type` when a
    body exists, so multipart must bypass it). Same-origin serving (prod and
    Vite proxy in dev) means `Content-Disposition` is readable without CORS
    changes.
11. **Returned filename**: original stem + `-signed.docx`, sanitised
    (basename only, no path separators), via `Content-Disposition:
    attachment`.
12. **File drop is native HTML5 drag-and-drop** (`onDragOver`/`onDrop` with
    `DataTransfer.files`), not dnd-kit — dnd-kit moves DOM elements, not OS
    files. A click-to-browse file input is the fallback on every row.
13. **No processed-document persistence**: the apply endpoint reads the
    upload, transforms in memory, returns bytes. Nothing written to DB or
    disk.
14. **Router auth**: every endpoint depends on `get_current_user` exactly as
    the existing routers do, so signatures are not accidentally the one open
    surface when `API_TOKEN` is set.

---

# Task 1: Data model, migration, dependencies

**A: State of the world.** The signature feature is starting from scratch;
nothing has been implemented. This task adds the persistence layer and the
two new Python dependencies. The codebase uses SQLAlchemy 2.0
`Mapped`/`mapped_column` models under `backend/app/models/`, sequential
Alembic migrations `001`–`008` under `backend/alembic/versions/`, and
`uv` + `pyproject.toml` for packaging.

**B: Relevant files and deliverables.**

Reference (read, follow the patterns):
- `backend/app/models/doctor.py` — model style, FK conventions
- `backend/app/models/__init__.py` — re-export list
- `backend/alembic/versions/008_generated_rota_archived_at.py` — migration
  header/docstring style; revision chain (`009` revises `008`)
- `backend/pyproject.toml`
- `backend/tests/test_models.py` — model round-trip test style

Deliverables (create/edit):
1. `backend/app/models/signature.py` — new
2. `backend/app/models/__init__.py` — export `DoctorSignature`
3. `backend/alembic/versions/009_doctor_signatures.py` — new
4. `backend/pyproject.toml` — add dependencies
5. `backend/tests/test_models.py` — add round-trip test

**C: Instructions.**

1. `DoctorSignature` in `models/signature.py`:
   - `__tablename__ = "doctor_signatures"`
   - `id`: int PK
   - `doctor_id`: `ForeignKey("doctors.id")`, `nullable=False`, `unique=True`
     (one signature per doctor — enforce at the schema level, not just the
     router)
   - `image`: `LargeBinary`, `nullable=False`
   - `content_type`: `String`, `nullable=False` (`"image/jpeg"` or
     `"image/png"`; stored so the GET endpoint can set the response type
     without sniffing)
   - `uploaded_at`: `DateTime(timezone=True)`, `nullable=False` — set by the
     router at write time (`datetime.now(timezone.utc)`), no server default
   - Optional `doctor` relationship for convenience; no back_populates needed
     on `Doctor` (keep `Doctor` untouched).
2. Migration `009_doctor_signatures.py`: `create_table` mirroring the model
   exactly, unique constraint on `doctor_id` named `uq_doctor_signatures_doctor_id`.
   No enums, so none of 001/002's enum-type handling applies — say so in the
   docstring per house style. `downgrade()` drops the table.
3. `pyproject.toml`: add `"python-docx"` and `"python-multipart"` to
   `[project] dependencies` (multipart is required by FastAPI for
   `UploadFile`; nothing in the app uploads files today). These are runtime
   deps, not dev extras — Task 2/3 code imports python-docx in production
   paths.
4. Test in `test_models.py`: create a doctor, attach a `DoctorSignature`
   with a few bytes, flush, read back, assert bytes/content_type round-trip;
   assert a second signature for the same doctor raises `IntegrityError`
   (the test engines enforce FKs and constraints on SQLite).
5. Do not touch the seeds — signatures are entered via the UI only.

---

# Task 2: Document processing modules

**A: State of the world.** Task 1 is complete: `DoctorSignature` exists,
migration 009 applied, `python-docx` and `python-multipart` are installed.
This task builds the pure document-manipulation package with no FastAPI and
no DB access — bytes in, bytes out — plus its unit tests. The engine
package (`backend/app/engine/`) is the precedent for "pure logic, framework
free"; this package is a sibling, not part of the engine.

**B: Relevant files and deliverables.**

Reference:
- `backend/app/engine/__init__.py` — package docstring style
- `backend/tests/test_engine/` — test layout precedent (the new tests need
  no DB, so no conftest machinery is required)

Deliverables:
1. `backend/app/documents/__init__.py` — new (docstring + re-exports)
2. `backend/app/documents/errors.py` — new
3. `backend/app/documents/signature_insert.py` — new
4. `backend/app/documents/restrict_editing.py` — new
5. `backend/tests/test_documents/__init__.py` (empty) and
   `backend/tests/test_documents/test_signature_insert.py`,
   `backend/tests/test_documents/test_restrict_editing.py` — new

**C: Instructions.**

1. `errors.py`: `class DocumentFormatError(ValueError)` carrying a
   human-readable message. This is the only exception type the router will
   translate to a 422; every validation failure in this package raises it.
2. `signature_insert.py`:
   - `insert_signature(docx_bytes: bytes, image_bytes: bytes) -> "Document"`
     — returns the open python-docx `Document` (not bytes) so the caller can
     apply protection before a single save.
   - Open with `Document(io.BytesIO(docx_bytes))`; catch
     `docx.opc.exceptions.PackageNotFoundError` and `zipfile.BadZipFile` and
     re-raise as `DocumentFormatError("File is not a valid .docx document")`
     — this is the path a legacy `.doc` upload takes, so the message matters.
   - Validate: `len(document.tables) >= 1` else
     `DocumentFormatError("Document contains no table")`; the target table
     must have exactly 2 columns (`len(table.columns) == 2`) else
     `DocumentFormatError` naming the expected layout. These checks are the
     deliberate loud-failure guard for a template change.
   - Target cell: `document.tables[0].rows[-1].cells[0]`. The cell is
     confirmed empty in the real documents; insert with
     `cell.paragraphs[0].add_run().add_picture(io.BytesIO(image_bytes),
     width=Cm(4))`. Do not clear or add paragraphs.
   - python-docx reads image dimensions from the image header itself, so no
     content-type parameter is needed here.
3. `restrict_editing.py`:
   - `apply_read_only_protection(document, password: str) -> None` — mutates
     the loaded document's settings part.
   - Hash algorithm (ISO/IEC 29500 password verifier, as written by current
     Word — implement exactly this, do not substitute the legacy 32-bit
     hash):
     ```
     salt = os.urandom(16)
     h = hashlib.sha512(salt + password.encode("utf-16-le")).digest()
     for i in range(100_000):
         h = hashlib.sha512(h + i.to_bytes(4, "little")).digest()
     ```
     `w:hash = base64(h)`, `w:salt = base64(salt)`.
   - Build the node with python-docx's oxml helpers
     (`from docx.oxml.ns import qn`, `from docx.oxml import OxmlElement`):
     `w:documentProtection` with attributes `w:edit="readOnly"`,
     `w:enforcement="1"`, `w:cryptProviderType="rsaAES"`,
     `w:cryptAlgorithmClass="hash"`, `w:cryptAlgorithmType="typeAny"`,
     `w:cryptAlgorithmSid="14"`, `w:cryptSpinCount="100000"`, plus hash and
     salt. All attribute names go through `qn("w:...")`.
   - If a `w:documentProtection` element already exists in the settings,
     remove it first (idempotent re-application).
   - Insert as the **first child** of `document.settings.element`.
   - Also export `save_docx(document) -> bytes` (save to `BytesIO`, return
     `getvalue()`) so the router composes
     `insert -> protect -> save` without knowing python-docx internals.
     Put it in `__init__.py` or `restrict_editing.py` — implementer's choice,
     re-exported from the package either way.
4. Password default: module constant `DEFAULT_LOCK_PASSWORD` in
   `restrict_editing.py`; the env-var read happens in the router (Task 3),
   not here — this package stays configuration-free.
5. Tests (no DB, no fixtures on disk — build documents in-test with
   python-docx):
   - Helper building a docx: `Document()`, `add_table(rows=3, cols=2)`, some
     text in other cells, save to bytes.
   - Insert test: run `insert_signature` with a minimal valid 1x1 PNG (a
     hardcoded base64 constant in the test file), save, reopen, assert the
     bottom-left cell's XML contains a `w:drawing`
     (`cell._element.findall(".//" + qn("w:drawing"))`), assert the
     document's image parts count increased by one, assert the text in other
     cells is untouched.
   - Failure tests: random bytes -> `DocumentFormatError`; docx with no
     table -> error; docx whose first table has 3 columns -> error message
     mentions the layout.
   - Protection test: apply to a fresh document, save, reopen, locate
     `w:documentProtection` in `document.settings.element`, assert every
     attribute value above, assert `base64.b64decode` succeeds on hash (64
     bytes) and salt (16 bytes), assert it is the first child. Apply twice,
     assert exactly one node.
   - Determinism note for the implementer: salt is random, so do not assert
     hash values — assert structure and lengths.

---

# Task 3: API schemas, router, API tests

**A: State of the world.** Tasks 1–2 are complete: the `DoctorSignature`
model and migration exist, and `backend/app/documents/` provides
`insert_signature`, `apply_read_only_protection`, `save_docx`,
`DocumentFormatError`, `DEFAULT_LOCK_PASSWORD`. This task exposes the five
endpoints and registers the router. The existing routers all follow the
same shape: `APIRouter(prefix=..., tags=[...])`, every endpoint depending on
`get_db` and `get_current_user` from `..deps`.

**B: Relevant files and deliverables.**

Reference:
- `backend/app/api/routers/rooms.py` — minimal router shape
- `backend/app/api/routers/doctors.py` — 404 handling style
- `backend/app/api/deps.py` — dependencies; per-request env-var read pattern
- `backend/app/api/main.py` — router registration loop
- `backend/tests/test_api/conftest.py` — TestClient/DB fixture pattern
- `backend/tests/test_api/test_doctors.py` — API test style

Deliverables:
1. `backend/app/api/schemas/signature.py` — new
2. `backend/app/api/schemas/__init__.py` — export
3. `backend/app/api/routers/signatures.py` — new
4. `backend/app/api/main.py` — import + add to the registration tuple
5. `backend/tests/test_api/test_signatures.py` — new

**C: Instructions.**

1. Schema: `SignatureMetaOut` — `doctor_id: int`, `content_type: str`,
   `uploaded_at: datetime`. Metadata only; image bytes never travel as JSON.
2. Router `prefix="/signatures"`, `tags=["signatures"]`. Endpoints:
   - `GET /signatures` -> `list[SignatureMetaOut]`, all rows, ordered by
     `doctor_id`. This is how the page shows per-doctor status without N
     image fetches.
   - `GET /signatures/{doctor_id}/image` -> raw bytes,
     `Response(content=row.image, media_type=row.content_type)`; 404 if no
     signature.
   - `POST /signatures/{doctor_id}` — multipart `UploadFile` field named
     `file`. 404 if the doctor does not exist (any doctor is accepted —
     endpoints are deliberately unscoped by doctor_type; the UI filter is
     frontend-only). Validate `file.content_type` in
     `{"image/jpeg", "image/png"}` -> else 422; read bytes, reject > 5 MB
     with 413. Upsert: update the existing row's image/content_type/
     uploaded_at, or insert. Return `SignatureMetaOut`, 200 on replace / 201
     on create (or a uniform 200 — implementer's choice, but test whichever
     is chosen).
   - `DELETE /signatures/{doctor_id}` -> 204; 404 if no signature exists.
   - `POST /signatures/{doctor_id}/apply` — multipart `UploadFile` `file`.
     404 unknown doctor; **409** with detail
     `"No signature stored for this doctor"` if no `DoctorSignature` row —
     it's a state conflict, not a malformed request. Reject > 10 MB with
     413. Then:
     `doc = insert_signature(docx_bytes, row.image)` /
     `apply_read_only_protection(doc, os.environ.get("DOC_LOCK_PASSWORD", DEFAULT_LOCK_PASSWORD))` /
     `out = save_docx(doc)`. Catch `DocumentFormatError` -> 422 with its
     message. Response: `Response(content=out, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")`
     with `Content-Disposition: attachment; filename="<stem>-signed.docx"`
     where stem is `Path(file.filename or "document").name` with the suffix
     stripped — basename only, never a client-supplied path. Quote the
     filename; strip characters outside `[A-Za-z0-9._ -]` to keep the header
     parseable.
   - Do not check the upload's declared content type for `/apply` — browsers
     are inconsistent about docx MIME types; the real validation is
     `DocumentFormatError` from actually opening it.
3. `main.py`: import `signatures` in the routers import block and add it to
   the `for module in (...)` tuple.
4. Tests (`test_signatures.py`, using the existing conftest fixtures):
   - Fixture helpers: insert a doctor directly via the session; a tiny valid
     1x1 PNG constant; a docx-builder using python-docx (2-col table).
   - Upload: 201/200 with meta; replace updates `uploaded_at`; wrong content
     type 422; unknown doctor 404; oversize 413 (send > 5 MB of bytes).
   - List and image GET round-trip (image bytes equal, content type echoed);
     image 404 when absent.
   - Delete: 204 then image GET 404; delete-when-absent 404.
   - Apply happy path: response 200, correct media type,
     `Content-Disposition` contains `-signed.docx`, and the returned bytes
     reopen with python-docx showing a `w:drawing` in the bottom-left cell
     and a `w:documentProtection` node in settings (import `qn` in the
     test).
   - Apply failure paths: no signature stored -> 409; garbage bytes -> 422
     with the not-a-docx message; docx with no table -> 422.
   - Auth: with `API_TOKEN` monkeypatched, a request without the header is
     401 (mirrors the existing auth-shim tests).

---

# Task 4: Frontend API layer — binary transport and hooks

**A: State of the world.** Tasks 1–3 are complete: the five endpoints are
live and tested. This task gives the frontend the transport it needs.
`client.ts` currently JSON-encodes every body and force-sets
`Content-Type: application/json` whenever a body is present, and `request()`
always parses JSON — so both multipart upload and blob download need new
paths through the client. Auth is an `X-API-Token` header attached from
`tokenStore`, which is why no `<img src>` or `<a href>` can hit the API
directly.

**B: Relevant files and deliverables.**

Reference:
- `frontend/src/api/client.ts` and `client_test.ts`
- `frontend/src/api/doctors.ts` — hook module pattern (query keys,
  invalidation)
- `frontend/src/api/types.ts` — wire-type mirrors
- `frontend/src/test/msw/handlers.ts` — MSW handler registry

Deliverables:
1. `frontend/src/api/client.ts` — extended
2. `frontend/src/api/client_test.ts` — extended
3. `frontend/src/api/types.ts` — add `SignatureMeta`
4. `frontend/src/api/signatures.ts` — new
5. `frontend/src/api/signatures_test.tsx` — new
6. `frontend/src/test/msw/handlers.ts` — add signature handlers

**C: Instructions.**

1. `client.ts`: refactor minimally so the token/401/ApiError logic is shared.
   Add:
   - `apiClient.postForm<T>(path, formData: FormData)` — JSON response;
     crucially **never sets Content-Type** (the browser sets the multipart
     boundary).
   - `apiClient.getBlob(path)` -> `Promise<Blob>` — sends the token header,
     same 401/ApiError behaviour (error bodies are still JSON), no JSON
     parse on success.
   - `apiClient.postFormBlob(path, formData)` ->
     `Promise<{ blob: Blob; filename: string | null }>` — filename parsed
     from `Content-Disposition` (`filename="..."`; null when absent).
   - Non-2xx handling is identical across all of them: build the same
     `ApiError` `{status, detail}` plain object.
2. `types.ts`: `SignatureMeta = { doctor_id: number; content_type: string; uploaded_at: string }`.
3. `signatures.ts` hooks (TanStack Query, key root `["signatures"]`):
   - `useSignatures()` — `GET /signatures`, returns the list; consumers
     derive a `Map<doctorId, SignatureMeta>`.
   - `useSignatureImage(doctorId, enabled)` — fetches the image via
     `getBlob`, converts to a **data URL** with `FileReader` inside the
     query function and returns the string. Data URLs avoid the object-URL
     revoke lifecycle entirely; images are small. Keyed
     `["signatures", doctorId, "image"]`.
   - `useUploadSignature()` — mutation `(doctorId, file)` via `postForm`;
     on success invalidate `["signatures"]` (root — picks up the image
     query too).
   - `useDeleteSignature()` — mutation, invalidate root.
   - `useApplySignature()` — mutation `(doctorId, file)` via
     `postFormBlob`, resolves `{blob, filename}`. No invalidation (nothing
     server-side changed). The download trigger lives in the page (Task 5),
     not here.
4. MSW handlers: list, image (respond with a small binary body +
   `Content-Type`), upload, delete, apply (binary body +
   `Content-Disposition`). MSW supports `HttpResponse` with an
   `ArrayBuffer`/`Blob` body — use that, not a JSON stand-in.
5. Tests:
   - `client_test.ts`: `postForm` sends no explicit JSON Content-Type and
     passes FormData through; `getBlob` resolves a Blob and still throws
     `ApiError` on 500 with a JSON body; `postFormBlob` extracts the
     filename from `Content-Disposition` and returns null when the header is
     missing; 401 fires the unauthorized listener on the new paths.
   - `signatures_test.tsx`: hooks against MSW — list resolves, image hook
     resolves a `data:` string, upload invalidates the list (spy on
     `queryClient.invalidateQueries` or assert refetch), apply resolves blob
     + filename.

# Task 5: Signatures page, nav, page tests

**A: State of the world.** Tasks 1–4 are complete: endpoints live, client
supports multipart and blobs, `api/signatures.ts` hooks exist and are
tested. This task builds the UI. The doctors list pattern to reuse:
`useDoctors()` returns active doctors; `groupDoctors` is the canonical
display order (Partner, Salaried, Trainee, AHP; alphabetical by code).
`Toast.tsx` is the existing feedback component.

**B: Relevant files and deliverables.**

Reference:
- `frontend/src/routes/DoctorsPage.tsx` and `DoctorsPage_test.tsx` — list
  page structure, hook usage, test style
- `frontend/src/lib/groupDoctors.ts`
- `frontend/src/components/Toast.tsx`
- `frontend/src/App.tsx` — `NAV_ITEMS` + routes

Deliverables:
1. `frontend/src/routes/SignaturesPage.tsx` — new
2. `frontend/src/routes/SignaturesPage_test.tsx` — new
3. `frontend/src/App.tsx` — nav item `{ to: "/signatures", label: "Signatures" }`
   and route

**C: Instructions.**

1. Page structure: fetch doctors with `useDoctors()`, filter to
   `doctor_type` Partner or Salaried (client-side only — the endpoints stay
   unscoped by design), order with `groupDoctors`. Fetch `useSignatures()`
   once and build the per-doctor lookup.
2. Each doctor row shows:
   - Code/name and a signature status: a thumbnail (`<img>` bound to
     `useSignatureImage(doctorId, hasSignature)` — enabled only when the
     meta list says one exists) or "No signature".
   - Upload/Replace: a hidden `<input type="file" accept="image/jpeg,image/png">`
     triggered by a button; on change fire `useUploadSignature`. Client-side
     pre-check of type/size mirrors the server limits for a faster message,
     but the server response is authoritative.
   - Remove: `useDeleteSignature` behind a confirm.
3. Document drop:
   - The whole row is a native drop target: `onDragOver` calls
     `preventDefault` and sets a visual highlight state; `onDrop` reads
     `e.dataTransfer.files[0]` and fires `useApplySignature`.
   - Rows without a stored signature are inert drop targets: no highlight,
     and a drop shows a toast telling the user to upload a signature first —
     do not send a request that will 409.
   - A per-row "Sign a document..." button opens a file picker
     (`accept=".docx"`) as the non-drag path.
   - On success: create an object URL from the blob, click a synthetic
     `<a download={filename ?? "signed.docx"}>`, revoke the URL. Show a
     success toast.
   - On `ApiError`: toast the `detail` string — the backend's 422 messages
     ("no table", "not a valid .docx") are written for humans and should be
     shown verbatim; 409 likewise.
   - Disable the row's drop/apply affordances while a mutation for that
     doctor is pending.
4. `App.tsx`: add the nav item after "Counters" and the
   `<Route path="/signatures" ...>`.
5. Tests (Vitest + RTL + MSW, following `DoctorsPage_test.tsx`):
   - Renders only Partner/Salaried doctors; Trainee/AHP absent.
   - Shows "No signature" vs thumbnail per the meta list.
   - Upload flow: choose a file, assert the multipart request fired and the
     list refetched.
   - Apply flow: `fireEvent.drop` with a `DataTransfer` containing a File on
     a signatured row; assert the mutation fired and the success toast
     appears. jsdom cannot really download — mock/spy the anchor-click
     helper (extract it as a small exported function so the test can stub
     it).
   - Drop on a signature-less row fires no request and shows the guidance
     toast.
   - Error path: MSW returns 422 with a detail; assert the toast shows that
     detail text.

---

# Post-implementation notes (not a task)

- Architecture docs: after Task 5, the user's architecture.md gains a short
  "Documents / Signatures" section (new `backend/app/documents/` package,
  the positional-targeting and protection-node decisions, the binary
  transport constraint from header auth). Claude's project copy should be
  updated to match.
- CI needs no changes: the new backend tests are collected by the existing
  pytest job, the frontend tests by the existing Vitest job.
- Deployment needs no changes beyond migration 009 running via the existing
  migrate-then-serve start command. Optionally set `DOC_LOCK_PASSWORD` on
  Railway; the default constant applies otherwise.
