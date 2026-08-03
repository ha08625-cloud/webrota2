# Plan

**Status.** Tasks 1–4 are implemented and CI-green, and Task 5's documentation
half is done (`documentation/architecture-clinical.md` now has a "Signatures and
documents" section and a `/signatures` router row). Task 5 points 1–3 — the
live Railway conversion of two or three real EMIS exports, the timing figure on
Railway, and the first-conversion-after-deploy check — **have not been done**;
they need a deployment and real patient-facing exports, neither of which is
available from a chat container. This file moves to `documentation/completed/`
once those three are ticked off.

Extend the existing Signatures feature to accept `.rtf` certificates (EMIS Web
exports) in addition to `.docx`, insert the doctor's stored signature image
under the "Signature" label, and return a **PDF** rather than an editable
document. The RTF is modified by literal text splicing and then converted to
PDF by a headless LibreOffice subprocess.

This is a provisional plan: design decisions below are the outcome of a
discussion chat and were validated experimentally against the real sample
export (`Certificates_administration_DUCK_Donald_Ms_0907_20Jul2026.rtf`), but
the plan has not yet been through review. Measured figures are quoted where
they drove a decision.

Five tasks, strictly sequential. Each is intended as self-contained context
for a separate implementation chat.

## Why not rebuild the document as HTML

The discarded alternative was: extract text from the RTF with `striprtf`,
re-render it through a hand-built Jinja2/HTML template, and produce the PDF
with WeasyPrint — avoiding LibreOffice entirely.

Rejected, on inspection of the real file:

- The document is the **University of Oxford medical certificate form**, not a
  letter. It contains 12 `FORMCHECKBOX` form fields, 45 table rows, section
  shading, an embedded Oxford crest (one `\pngblip`), and a dozen free-text
  cells the GP fills in via EMIS.
- `striprtf` flattens all of that to linear text. Reassembling it would mean
  regex-mapping every answer back to its correct cell and every tick back to
  its correct checkbox. The failure mode is **silent content corruption on a
  medico-legal document** — a dropped paragraph of clinical opinion, or a tick
  migrating from "No" to "Yes". Unlike the existing `signature_insert.py`
  checks, this cannot be made to fail loudly, because text you failed to
  extract is text you cannot detect the absence of.
- The output would be a reproduction of a form Oxford owns, maintained as two
  artifacts (template + parser) against EMIS's undocumented export format.

The LibreOffice cost that motivated the alternative did not survive
measurement — see Decision 8.

# Scope

**In scope**

- New pure module `backend/app/documents/rtf_signature_insert.py` — splice a
  signature image into RTF bytes
- New module `backend/app/documents/pdf_convert.py` — RTF/DOCX bytes to PDF
  bytes via a headless LibreOffice subprocess
- `backend/app/api/routers/signatures.py` — format sniffing on `/apply`, PDF
  response for the RTF path
- Frontend: widen the document picker/drop to `.docx,.rtf`, adjust the default
  download filename
- `nixpacks.toml` — LibreOffice Writer and fonts in the deploy image
- `.github/workflows/ci.yml` — LibreOffice in the backend test job
- Backend unit + API tests; frontend test updates

**Out of scope**

- Any change to `DoctorSignature`, the upload/list/image/delete endpoints, or
  the database — no migration in this work
- Any change to `engine/`, rota models, or other routers
- Server-side persistence of processed documents (unchanged: in-memory only)
- Changing the existing `.docx` path's behaviour (still returns a protected
  `.docx`) — see Open Question 1
- A resident/pooled LibreOffice (`unoserver`) — see Decision 9
- Reading legacy `.doc` binary files — still rejected with a clear error

# Design Decisions

1. **Pipeline is splice-then-convert, and the RTF is never the deliverable.**
   `insert_signature_rtf(rtf_bytes, image_bytes, content_type) -> bytes`
   returns modified RTF; `convert_to_pdf(doc_bytes, suffix) -> bytes` renders
   it. The intermediate RTF is a temp artifact that only LibreOffice ever
   reads, which means the splice only has to satisfy LibreOffice's RTF reader,
   not Word's. This materially lowers the bar on the generated `\pict` group.

2. **Format detection by content sniffing, not extension or declared MIME.**
   `{\rtf1` prefix means RTF; `PK` means a zip, i.e. docx. Anything else is a
   `DocumentFormatError`. This follows the precedent already documented in the
   router ("declared content type is not checked here — browsers are
   inconsistent"). Sniff on a stripped copy of the first bytes: some producers
   emit a UTF-8 BOM or leading whitespace before `{\rtf1`.

3. **Anchor on the "Signature" label plus its paragraph break, and require
   exactly one match.** A naive search for `Signature` finds **three** matches
   in the sample, and the first two are in the RTF stylesheet — the built-in
   style names `Signature;` and `E-mail Signature;` — not the document body.
   Splicing at the first hit would inject the image into the style table.

   Use the regex `rb"Signature[\s]*\\par[\s]*\}"`, which matches exactly once
   in the sample (verified; the stylesheet entries are followed by
   `\lsdsemihidden1`, not `\par`). The `[\s]*` tolerance matters because RTF
   line breaks are cosmetic — Word wraps output at ~255 characters, so the
   exact position of the `\r\n` is not stable across exports and must not be
   hard-coded.

   Zero matches or more than one match raises `DocumentFormatError` with a
   message aimed at a non-technical admin. This is the same loud-failure
   philosophy as `signature_insert.py`'s column-count check: a
   wrong-but-silent insertion is worse than a visible failure.

4. **Splice, do not parse.** Insert immediately after the matched anchor:

   ```
   {{\pict\picw<w>\pich<h>\picwgoal<gw>\pichgoal<gh>\pngblip <hex>}\par }
   ```

   This is a pure string insertion between two already-balanced groups; no
   RTF group-tree parser is needed for an operation this narrow. Verified end
   to end: the image renders inside the Signature cell, directly beneath the
   label, with the rest of the document unchanged.

5. **No image re-encoding.** Signature images are already validated as JPEG or
   PNG at upload time. Map the stored `content_type` to `\jpegblip` or
   `\pngblip` and hex-encode the stored bytes as-is. Both paths were verified
   to render correctly.

6. **Image dimensions come from python-docx, not a new dependency.**
   `docx.image.image.Image.from_blob(image_bytes)` exposes `.px_width`,
   `.px_height`, `.horz_dpi`, `.vert_dpi`, and `.content_type` from the file
   header. python-docx is already a runtime dependency, so **Pillow is not
   needed**. It also raises `UnrecognizedImageError` on a corrupt image, which
   maps naturally onto `DocumentFormatError`.

   Sizing mirrors the docx module's fixed `Cm(4)`: `picwgoal = 2268` twips
   (4 cm x 567 twips/cm), `pichgoal = round(2268 * px_height / px_width)`.
   `picw`/`pich` are the image's *native* size in hundredths of a millimetre
   (`px / dpi * 2540`) using the header's real DPI, not an assumed 96.

7. **Per-request isolated LibreOffice profile — this is a correctness
   requirement, not a tuning knob.** Two concurrent `soffice` invocations
   sharing the default profile were measured to collide: one exited 1 and
   **silently produced no output file**. With
   `-env:UserInstallation=file:///<temp dir>` per invocation, both concurrent
   conversions succeeded (1.9 s wall for two in parallel). A fresh isolated
   profile costs nothing measurable (1.2 s, 552 KB), so there is no reason to
   share one and no need for a mutex. Use `tempfile.TemporaryDirectory()` for
   both the profile and the input/output files, so cleanup is automatic even
   on exception.

8. **LibreOffice is fast enough; the observed "cold start" was desktop profile
   creation, not conversion.** Measured on the real sample in a container
   comparable to Railway's: **1.7 s** with a completely fresh profile, **1.1 –
   1.3 s** on subsequent runs — and that is spawning a whole new `soffice`
   process per document, the worst case. Fidelity was excellent: crest,
   checkboxes, section shading, table geometry and pagination all correct.

9. **Spawn per request; do not add `unoserver` yet.** A resident LibreOffice
   would cut conversions to roughly 0.3 – 0.8 s, but adds a second
   long-running process, its own supervision and crash-recovery story, and a
   failure mode where a wedged instance breaks every request. At ~1 s for a
   handful of certificates a day this is not worth it. Revisit only if volume
   changes.

10. **Conversion failure is a 502, not a 422.** `DocumentFormatError` means
    "your file is wrong" (422). A LibreOffice non-zero exit, a timeout, or a
    missing output file means "our converter failed" — a distinct new error
    type (`ConversionError`) mapped to 502, so the two are not conflated in
    logs or in the message the admin sees. Always pass an explicit
    `timeout=` to `subprocess.run` (60 s is generous at a measured ~1.3 s);
    a hung `soffice` must never hold a request thread open indefinitely.

11. **Read-only protection is dropped for the RTF path, and this is a gain
    rather than a gap.** The original signatures plan's Decision 7 concern
    dissolves: the deliverable is a PDF, which is a stronger "do not edit
    this" than the `w:documentProtection` password, and RTF has no equivalent
    construct anyway. `apply_read_only_protection` is simply not called on
    this path. `DOC_LOCK_PASSWORD` remains in use by the docx path.

12. **Response is `application/pdf` with `<stem>-signed.pdf`**, reusing the
    existing `_safe_filename_stem` sanitiser unchanged.

13. **Size caps.** Hex encoding doubles the image's contribution to the RTF, so
    a 5 MB signature adds ~10 MB to the intermediate document. Keep the
    existing 10 MB cap on the *uploaded* document and apply it before
    splicing; the intermediate is never returned or stored, so its size only
    affects peak memory. Note for review: a 5 MB signature is already far
    beyond what a 4 cm-wide image needs, so tightening the *image* cap is
    worth considering separately, but is not proposed here.

14. **Deployment needs `libreoffice-writer`, not just `libreoffice-core`.**
    The container initially had `libreoffice-core` and `libreoffice-common`
    without Writer, and `soffice --convert-to pdf` failed with the unhelpful
    `Error: source file could not be loaded` — which looks like a corrupt
    input rather than a missing component. Installing `libreoffice-writer`
    fixed it. Also install `fonts-liberation`: the template uses Arial and
    Times New Roman, and without metric-compatible substitutes the layout
    shifts.

15. **Frontend change is minimal.** Widen `accept` from `.docx` to
    `.docx,.rtf` and adjust the fallback download name. The existing
    error/success toast plumbing needs no changes, because backend
    `DocumentFormatError` messages already surface verbatim.

## Open questions for review

1. **Should the `.docx` path also return PDF?** Consistency argues yes; blast
    radius argues no. This plan leaves docx alone. If the docx source is
    genuinely retired, converting both and deleting `restrict_editing.py`
    would be a simplification worth its own ticket.
2. **Font exactness.** Liberation fonts are metric-compatible substitutes for
    Arial/Times New Roman, so line breaks and pagination match, but glyph
    shapes differ subtly. If a byte-identical look to Word's output matters,
    that means `ttf-mscorefonts-installer` and its EULA. Recommend accepting
    Liberation.
3. **Validate against more real exports before Task 1 is signed off.** All
    measurements here come from a single sample whose checkboxes are all
    unticked and whose free-text cells are empty. Two or three real EMIS
    exports with ticked boxes and filled-in clinical text should be converted
    and eyeballed, since form-field state is the element most likely to
    surprise.

---

# Task 1: RTF splice module

**A: State of the world.** Nothing has been implemented. The existing
`backend/app/documents/` package is pure (bytes in, bytes out — no FastAPI, no
DB) and currently holds `errors.py`, `signature_insert.py` (docx) and
`restrict_editing.py`. This task adds the RTF equivalent of
`signature_insert.py` and its unit tests. No new dependency, no infrastructure
— this task is entirely testable in isolation.

**B: Relevant files and deliverables.**

Reference (read, follow the patterns):
- `backend/app/documents/signature_insert.py` — module docstring style, the
  loud-failure validation philosophy
- `backend/app/documents/errors.py` — `DocumentFormatError`
- `backend/app/documents/__init__.py` — docstring inventory + re-export list
- `backend/tests/test_documents/test_signature_insert.py` — test style,
  in-test fixture construction

Deliverables:
1. `backend/app/documents/rtf_signature_insert.py` — new
2. `backend/app/documents/__init__.py` — export `insert_signature_rtf`, and
   add it to the docstring inventory
3. `backend/tests/test_documents/test_rtf_signature_insert.py` — new
4. `backend/tests/fixtures/certificate_sample.rtf` — the real sample export,
   committed as a test fixture (it contains no patient data beyond the
   synthetic "DUCK, Donald" test record; confirm this before committing)

**C: Instructions.**

1. `insert_signature_rtf(rtf_bytes: bytes, image_bytes: bytes, content_type: str) -> bytes`.
   Work in `bytes` throughout — do not decode to `str`. RTF is 7-bit ASCII
   with escapes, but the sample contains raw high bytes, and a decode/encode
   round trip risks corrupting them.
2. Validate the RTF magic first: strip a leading UTF-8 BOM and leading
   whitespace, then require `{\rtf1`. Otherwise raise
   `DocumentFormatError("File is not a valid .rtf document")`.
3. Locate the anchor with `re.compile(rb"Signature[\s]*\\par[\s]*\}")`:
   - zero matches: `DocumentFormatError("Could not find the Signature label in this document")`
   - more than one match: `DocumentFormatError` naming the count — the
     template has changed and positional assumptions are no longer safe
   - Add a comment explaining *why* the `\par` is part of the anchor: a bare
     `Signature` search hits the stylesheet's `Signature;` and
     `E-mail Signature;` style names first.
4. Read dimensions and validate the image via
   `docx.image.image.Image.from_blob(image_bytes)`; catch
   `docx.image.exceptions.UnrecognizedImageError` and re-raise as
   `DocumentFormatError`. Guard against a zero/absent DPI (fall back to 96)
   before dividing.
5. Map `content_type` to the blip keyword: `image/png` -> `\pngblip`,
   `image/jpeg` -> `\jpegblip`; anything else is a `DocumentFormatError`.
   Prefer the *parsed* content type from the header over the caller's string
   if they disagree — the header is authoritative.
6. Build and splice per Decision 4 and Decision 6. Hex-encode with
   `image_bytes.hex()`. Do not wrap the hex at 128 columns; long lines are
   legal and LibreOffice reads them (verified on a ~3 KB image, and on the
   ~130 KB crest already inline in the sample).
7. Return the new bytes. No file I/O in this module.
8. Tests (build inputs in-test; use the committed sample for the realistic
   case):
   - Happy path against `certificate_sample.rtf` with a small generated PNG:
     assert the result still starts with `{\rtf1`, contains exactly one
     `\pngblip` more than the input did (the sample already has one, for the
     crest), and that the inserted group appears *after* the anchor's offset
     in the output.
   - JPEG variant: assert `\jpegblip` present.
   - Byte-preservation: assert the output contains the input's bytes before
     and after the splice point unchanged (i.e. it is a pure insertion).
   - Not-RTF input (`b"PK\x03\x04..."`, random bytes) -> `DocumentFormatError`.
   - Anchor missing: take the sample, replace `Signature` in the body with
     another word, assert `DocumentFormatError`.
   - Anchor duplicated: concatenate the anchor region twice, assert
     `DocumentFormatError` mentioning multiple matches.
   - **Stylesheet regression test** (the point of Decision 3): assert the
     splice offset is greater than the offset of the last `E-mail Signature;`
     occurrence in the file — i.e. the insertion is in the body, not the
     style table. This test is what stops a future "simplification" of the
     anchor regex.
   - Corrupt image bytes -> `DocumentFormatError`.

---

# Task 2: PDF conversion module, plus the infrastructure it needs to run

**A: State of the world.** Task 1 is complete: `insert_signature_rtf` produces
signed RTF bytes and is unit-tested. Nothing yet turns those bytes into a PDF.
This task adds the LibreOffice wrapper. Its tests cannot run without
LibreOffice present, so the nixpacks and CI changes land **in this task, not a
later one** — otherwise the test suite is red on CI the moment it is written.

**B: Relevant files and deliverables.**

Reference:
- `backend/app/documents/errors.py`
- `nixpacks.toml` (repo root) — note its header comment explaining why every
  command is explicit; follow that style
- `.github/workflows/ci.yml` — the `test` job

Deliverables:
1. `backend/app/documents/pdf_convert.py` — new
2. `backend/app/documents/errors.py` — add `ConversionError`
3. `backend/app/documents/__init__.py` — exports + docstring inventory
4. `backend/tests/test_documents/test_pdf_convert.py` — new
5. `nixpacks.toml` — LibreOffice + fonts in the install phase
6. `.github/workflows/ci.yml` — LibreOffice in the backend `test` job

**C: Instructions.**

1. `convert_to_pdf(doc_bytes: bytes, suffix: str = ".rtf", timeout: float = 60.0) -> bytes`:
   - One `tempfile.TemporaryDirectory()` holding the input file, the output
     directory, and the LibreOffice profile directory.
   - Command:
     ```
     soffice -env:UserInstallation=file://<profile dir>
             --headless --norestore --convert-to pdf
             --outdir <out dir> <input path>
     ```
     `-env:UserInstallation` is **required** per Decision 7, not optional.
   - `subprocess.run(..., capture_output=True, timeout=timeout, check=False)`.
     Do not use `shell=True`; pass an argument list.
   - Treat all three of these as failures, raising `ConversionError`:
     non-zero return code, `subprocess.TimeoutExpired`, and a zero exit that
     produced no output file. The third is real: the concurrency collision in
     Decision 7 produced exactly that shape once. Include the tail of
     stderr/stdout in the exception message for the log, but keep the message
     safe to show a user.
   - `FileNotFoundError` on `soffice` (not installed) -> `ConversionError`
     saying PDF conversion is unavailable on this server.
   - Read and return the output bytes. Assert they start with `%PDF-`.
   - Resolve the binary via a module constant (`SOFFICE_BIN`, default
     `"soffice"`) overridable by an env var, so a container with an unusual
     path can be pointed at it without a code change.
2. Tests: guard the module with
   `pytest.mark.skipif(shutil.which("soffice") is None, ...)` so a developer
   without LibreOffice can still run the suite, while CI (which installs it)
   really exercises it.
   - Convert the committed sample RTF: assert `%PDF-` magic and a non-trivial
     length.
   - Convert the output of `insert_signature_rtf` (the real composition):
     assert it succeeds. If a text-extraction library is available, assert
     the text still contains "Declaration" and "Signature"; otherwise assert
     size only, and say so in a comment rather than pretending to assert
     content.
   - Garbage input bytes -> `ConversionError`.
   - `timeout=0.001` -> `ConversionError` (proves the timeout path is wired,
     without depending on a slow document).
   - **Concurrency test**: run two conversions simultaneously via
     `ThreadPoolExecutor` and assert *both* return valid PDFs. This is the
     regression test for Decision 7 and the reason that decision exists —
     without isolated profiles this test fails.
3. `nixpacks.toml`: add an apt install for `libreoffice-writer` and
   `fonts-liberation` in the install phase, before the Python install.
   `libreoffice-core` alone is insufficient (Decision 14). Add a comment
   saying so, so nobody "slims the image" by dropping back to core and
   reintroduces the misleading `source file could not be loaded` error.
   Expect a few hundred MB of image growth; call that out in the comment as
   accepted.
4. `ci.yml`: in the `test` job only (not `migrations-postgres`, not
   `frontend`), add a step before "Install dependencies":
   `sudo apt-get update && sudo apt-get install -y libreoffice-writer fonts-liberation`.
   Note in a comment that this is what makes the `pdf_convert` skipif inert on
   CI.
5. Sanity-check memory: a conversion peaks around 200 MB transient. Confirm
   that is comfortable on the Railway plan in use before Task 3 ships.

---

# Task 3: Router wiring

**A: State of the world.** Tasks 1–2 are complete: `insert_signature_rtf` and
`convert_to_pdf` exist, are exported from `app.documents`, and are tested, and
LibreOffice is installed in both the deploy image and CI. The
`/signatures/{doctor_id}/apply` endpoint still handles docx only. This task
teaches it to branch on format. No schema, model, or migration change.

**B: Relevant files and deliverables.**

Reference:
- `backend/app/api/routers/signatures.py` — the whole file; `apply_signature`
  in particular
- `backend/tests/test_api/test_signatures.py` — API test style and fixtures

Deliverables:
1. `backend/app/api/routers/signatures.py` — edited
2. `backend/tests/test_api/test_signatures.py` — extended

**C: Instructions.**

1. Add a small private `_sniff_format(data: bytes) -> str` returning `"rtf"` or
   `"docx"`, per Decision 2 (strip BOM/leading whitespace; `{\rtf1` vs `PK`).
   Unknown -> raise `DocumentFormatError`, which the existing `except` clause
   already maps to 422 — check that the message reads sensibly for an admin
   who dropped a `.doc` or a PDF.
2. In `apply_signature`, keep the existing size cap and the 409-when-no-
   signature behaviour, then branch:
   - `docx`: unchanged — `insert_signature` /
     `apply_read_only_protection` / `save_docx`, docx media type,
     `-signed.docx`.
   - `rtf`: `insert_signature_rtf(data, signature.image, signature.content_type)`
     then `convert_to_pdf(spliced, suffix=".rtf")`; respond
     `media_type="application/pdf"` with `<stem>-signed.pdf`.
   - Rename the local `docx_bytes` to something format-neutral
     (`document_bytes`), and update the stale comment above it that says
     "docx".
3. Catch `ConversionError` separately from `DocumentFormatError` and map it to
   **502** (Decision 10). Log the full exception server-side; return a short
   message. Do not leak file paths or stderr into the response body.
4. Add `_PDF_MEDIA_TYPE = "application/pdf"` alongside the existing
   `_DOCX_MEDIA_TYPE` constant.
5. Tests, extending the existing file:
   - RTF apply happy path: post the sample fixture, assert 200,
     `application/pdf`, `Content-Disposition` contains `-signed.pdf`, and the
     body starts with `%PDF-`. Skipif `soffice` is missing, matching Task 2.
   - Assert the existing docx tests still pass untouched — the docx path is a
     regression surface here, not a new one.
   - Unknown format (random bytes, a PDF) -> 422.
   - RTF with the anchor removed -> 422 with the "Signature label" message.
   - No signature stored + RTF upload -> still 409, and assert **no**
     conversion was attempted (monkeypatch `convert_to_pdf` to raise if
     called) — the 409 must come first, so a missing signature never spawns a
     subprocess.
   - `ConversionError` -> 502: monkeypatch `convert_to_pdf` to raise. This
     test needs no LibreOffice and so must **not** be skipped.

---

# Task 4: Frontend

**A: State of the world.** Tasks 1–3 are complete: `/apply` accepts RTF and
returns a PDF. The UI still advertises only `.docx` and names the fallback
download `signed.docx`. The relevant files are
`frontend/src/routes/SignaturesPage.tsx` (row-level drop target, hidden file
input at line ~171 with `accept=".docx"`, `handleApplyFile`) and
`frontend/src/api/signatures.ts` (`useApplySignature`, which resolves
`{blob, filename}` and needs no change — it is format-agnostic already).

**B: Relevant files and deliverables.**

Reference:
- `frontend/src/routes/SignaturesPage.tsx`
- `frontend/src/routes/SignaturesPage.test.tsx`
- `frontend/src/test/msw/handlers.ts` — the signature handlers
- `frontend/src/lib/downloadBlob.ts`

Deliverables:
1. `frontend/src/routes/SignaturesPage.tsx` — edited
2. `frontend/src/routes/SignaturesPage.test.tsx` — extended
3. `frontend/src/test/msw/handlers.ts` — apply handler returns a PDF

**C: Instructions.**

1. Change the document input's `accept` from `.docx` to `.docx,.rtf`.
2. The success-path fallback filename `"signed.docx"` is now wrong for RTF
   input. The server always sends `Content-Disposition`, so the fallback is
   only reached if that header is missing; derive it from the dropped file's
   name instead (`.rtf` in -> `-signed.pdf` fallback, otherwise
   `-signed.docx`). Keep this simple — it is a fallback, not the main path.
3. Consider updating the button label from "Sign a document..." only if the
   wording now misleads; no change is needed just because the format widened.
4. `useApplySignature` and `downloadBlob` need no changes — verify rather than
   assume, then say so in the task's completion notes.
5. Tests:
   - Assert the input's `accept` attribute includes `.rtf`.
   - Drop an `.rtf` `File` onto a row with a stored signature: assert the
     mutation fires and the success toast appears (the existing docx drop test
     is the template).
   - MSW apply handler: return a PDF body with
     `Content-Disposition: attachment; filename="cert-signed.pdf"` and assert
     the download helper is called with that name.
   - Error path unchanged: a 502 with a detail string surfaces via the toast
     exactly as 422 does — add a case, since 502 is a new status for this
     page.

---

# Task 5: Live verification and documentation

**A: State of the world.** Tasks 1–4 are complete and CI is green. Nothing has
been verified against a real deployment, and no documentation reflects the new
pipeline. This task closes both.

**B: Relevant files and deliverables.**

Deliverables:
1. `documentation/architecture-clinical.md` — Signatures/documents section
   updated
2. `documentation/completed/rtf_signature_pdf.md` — this plan, moved on
   completion with the review corrections folded in
3. No code changes expected; any that emerge from verification are fixes, not
   new scope

**C: Instructions.**

1. Deploy to Railway and convert **two or three real EMIS exports** with
   ticked checkboxes and filled-in clinical text (Open Question 3). Compare
   each PDF against what Word produces from the same RTF. Check specifically:
   checkbox tick state, the crest, section shading, table borders, pagination,
   and that the signature sits inside the Signature cell rather than
   overflowing it.
2. Time a conversion on Railway and record the real figure. The 1.1 – 1.7 s
   measured locally is the expectation; a materially worse number is a signal
   the deploy image is missing fonts or is CPU-throttled, and should be
   investigated rather than accepted.
3. Confirm the first conversion after a fresh deploy is not anomalously slow.
   With per-request profiles there is no shared warm profile to build, so it
   should not be — but this is the exact failure that motivated the whole
   ticket, so measure it rather than reasoning about it.
4. Update the architecture doc: the two new modules, the sniff-and-branch
   shape of `/apply`, the isolated-profile requirement and *why* it exists
   (silent failure under concurrency), and the LibreOffice deploy dependency.
   Keep it to design decisions and data flow — do not restate what the code
   plainly shows.

---

# Post-implementation notes (not a task)

- **Unrelated staleness spotted while planning:** `documentation/architecture.md`
  carries an `[UNRESOLVED]` note in the Deployment section saying `railway.toml`
  might use bare `alembic`/`uvicorn` rather than `/opt/venv/bin/*`. The repo
  copy of `railway.toml` does use the explicit `/opt/venv/bin/` paths, so the
  note is stale and can be deleted. Flagged, not fixed — it is outside this
  ticket.
- If the docx source is retired (Open Question 1), `restrict_editing.py`,
  `DOC_LOCK_PASSWORD`, and the docx branch all become dead code and should be
  deleted in one follow-up rather than left as an unused second path.
