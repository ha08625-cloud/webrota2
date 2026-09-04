# Implementation plan: Study EOI autofill

Status: implementation plan (workflow step 2). Reviewed and expanded from the
provisional plan. Tasks below are sized for individual chats.

## Prerequisites (do these before Task 1)

1. **Make the repository private.** Decided during review. The rule set holds
   practice-identifying data -- CQC rating, ODP reporting dates, recruitment
   totals, and the named contacts and site details in the answer paragraphs --
   and `backend/tests/fixtures/README.md` already records this project's bar
   for what may be committed to a public repo. The hardcoded-constant design
   below is only acceptable once visibility is flipped. Note the two knock-on
   effects: GitHub Actions minutes are metered on private repos (public repos
   are unmetered), and the Railway deploy needs the GitHub connection to still
   have access after the change.
2. **Commit the two source inputs.** Neither is currently in the repository:
   - the `FillResearchSite` VBA macro source (put it at
     `documentation/reference/FillResearchSite.bas`), which is the only record
     of the eleven rules' trigger phrases and answer text;
   - `76021_Blank_site_ID_form.docx`, as
     `backend/tests/fixtures/site_id_form_blank.docx`. Check it before
     committing: it must be the blank template with no sponsor or practice
     content. Add a section to `backend/tests/fixtures/README.md` saying what
     it is and that it was checked.

   Task 1 cannot be written without both.

## Scope

A second tab on the Signatures page that fills the standard sections of an
NIHR Site Identification form, replacing the `FillResearchSite` VBA macro the
research lead currently pastes into each document.

In scope:
- A hardcoded rule set porting the macro's eleven sections.
- A pure `.docx` fill function in `app/documents/`.
- One endpoint: upload a form, get the filled `.docx` back. Nothing persisted.
- A tab shell over the existing Signatures page.

Out of scope:
- Editable answers / an answer-bank UI (see "Rejected alternatives").
- Per-submission overrides, named profiles.
- `.doc` and PDF forms; `.docx` only.
- The sponsor-specific questions at the end of the form. Those are the
  variable 20% and stay manual, as they do today.
- Signing, PDF conversion, Restrict Editing. This produces a plain editable
  `.docx` because the user still has to answer the variable sections in Word.
- Correcting the stale figures in the macro's answer text (see Design
  Decisions). Ported verbatim; a follow-up ticket corrects them.

## Background: what the macro does

`FillResearchSite` walks every cell of every table in the document. For each
cell whose text contains a trigger phrase (with, for two sections, an
additional phrase that must be *absent*), it blanks the cell **to the right**
and writes a fixed block of paragraphs into it. Section 4 is the one
exception: it overwrites the matched cell itself.

The rule shape is therefore:

    (required substrings, excluded substrings, max source length) -> target -> answer paragraphs

Nothing in it needs Word. All eleven sections are data.

Critically, the macro replaces **whole cells** rather than doing find-and-
replace inside text. That matters: the form's text is heavily run-split (the
Investigator label cell is `"Name and " / "R" / "ole:" / " [insert here]"`),
so a replace-based macro would be far harder to port to python-docx. Whole-
cell replacement sidesteps run splitting entirely.

## Analysis of the reference form

`76021_Blank_site_ID_form` contains two tables. Table 0 holds the study title
and a covering note and matches no trigger. Table 1 is the form: 25 rows x 2
columns, 38 distinct cells, with 12 merged regions.

Three of those merges are load-bearing for the rules:

| merged cell | rows | rule that depends on it |
| --- | --- | --- |
| "Main contact for feasibility discussions / Research Setting" | 3-4, col 0 | Section 3 |
| "Please briefly outline the other infrastructure..." | 12-13, col 0 | Section 8 |
| "Please provide a brief outline of any unique elements of Network..." | 18-19, col 0 | Section 11 |

python-docx's `table.rows[i].cells[j]` returns the *same* cell object for each
row a vertical merge spans -- `_Row.cells` maps a `vMerge` continuation back
to the origin `tc`. Naive iteration therefore visits these three cells twice
and would fill each target twice. Deduplication is required, not optional, and
it must be on `id(cell._tc)`: `_Cell` defines no `__eq__`, so two `_Cell`
wrappers around the same `tc` are unequal and a plain `set` of cells will not
dedup them. (Verified against python-docx 1.2.0, the pinned version.) VBA's
`tbl.Range.Cells` already enumerates distinct cells, which is why the macro
does not hit this.

Sponsor-specific questions occupy rows 21-24; their answer cells are empty and
stay empty.

## Defects in the macro, to be fixed rather than reproduced

These were found by tracing the macro against the reference form. Each changes
behaviour, so they are called out explicitly rather than folded in silently.

1. **Section 4 destroys three lines.** The rule matches `r4c1`, which holds
   four paragraphs -- `Primary Care Y/N (_)`, `Secondary Care Y/N (_)`,
   `Community Care Y/N (_)`, `Other [insert detail here]` -- and replaces the
   *entire cell* with the string `"Primary Care Y"`. The other three lines are
   lost. Fix: a `same_cell_line` target mode that replaces only the matching
   paragraph within the cell, leaving its siblings intact.

2. **Stale `targetCell`.** `targetCell` is never reset to `Nothing`, and
   `On Error Resume Next` leaves the previous value in place when
   `Cell(row, col + 1)` does not exist. On this form it is harmless but
   visible: Section 9's phrase "site-specific activities" appears in the
   answer text the macro has just written into `r14c1`, so the loop re-matches
   that cell, the column-3 lookup fails, and it rewrites `r14c1` with the same
   text. On a three-column form the same path would write an answer into an
   unrelated cell with no error. Fix: no target resolved means no write, and
   matching runs against a pre-write snapshot (see Design Decisions).

3. **`InStr` is case-sensitive.** A sponsor writing "Research Site" for
   "Research site" silently gets no match. Fix: casefold both sides.

4. **Section 10 never fires on this form.** There is no "Non-Commercial ...
   Studies" cell in it. The macro reports "Form has been filled in
   successfully!" regardless. Fix: report unmatched rules via the response
   header. The rule itself is kept -- it presumably matches other variants.

5. **Answers are stale and inconsistent.** "CQC ... rating = Good (September
   2016)", "ODP 2023-04-06", and two different non-commercial study counts
   (32 studies / 960 recruits in Section 10; 13 studies / 840 recruits in
   Section 11). Ported verbatim so the port is diffable against the macro;
   correcting them is a follow-up ticket, and see "Rejected alternatives" for
   why they will keep drifting.

## Design decisions

**Rules live in a Python constant, not the database.** User's explicit choice:
a straight port, with the forms being identical every time. One module,
`eoi_rules.py`, holds the eleven rules as a module-level tuple. Updating a
figure is a one-line edit to one file and a deploy. The rule dataclass is
shaped so that moving to a table later is a data-source swap, not a rewrite,
but no such table is built now. This decision is *conditional on the
repository being private* -- see Prerequisites.

**Matching runs against a pre-write snapshot.** The deduplicated cell list and
each cell's text are captured once, before any rule writes anything. Every
rule matches against that snapshot, and each target cell is written at most
once. This makes defect 2's self-match impossible by construction rather than
by bookkeeping, and it makes rule order irrelevant to the result -- which is
what you want from a rule table that may grow.

**Whole-cell replacement, with formatting taken from the cell being
overwritten.** `add_paragraph` on a cleared cell yields Normal style, which
will not match the form's font. Before clearing a target, copy the `pPr` of
its first paragraph and the `rPr` of that paragraph's first run, and apply
them to each paragraph/run written. If the target cell is empty (the common
case -- it is a blank answer cell), fall back to the `pPr`/`rPr` of the
*trigger* cell's first paragraph. This is the one place the fill function
touches XML directly; keep it in one small helper with a comment saying why.

**`same_cell_line` collapses the matched paragraph to a single run.** Section
4's fix rewrites one paragraph inside a run-split cell, so intra-paragraph
formatting in that paragraph is lost -- it is replaced by one run carrying the
`rPr` of the paragraph's first run. Acceptable: the paragraphs it targets are
uniformly formatted checkbox lines. If more than one paragraph in the cell
matches the trigger, the **first** is replaced and the rest are left alone.

**Report via response header, not a two-step preview.** The user does not want
a review screen. But a silent miss is defect 4 above, so the response carries
an `X-EOI-Unmatched` header listing the **ids** of any rules that found no
target -- `section-4,section-10`, not the human labels. Header values are
latin-1 and comma is the natural separator, so ids keep the header short and
encodable; the frontend maps ids to labels for display. The header is always
present, and is the empty string when every rule matched. This keeps the
existing `postFormBlob` download flow intact -- no base64, no JSON envelope.

**Zero matches is still a 200.** An unrelated `.docx` comes back unchanged
with all eleven ids in the header. The frontend's warning names them, which is
a clearer message than a 422 could give, and the endpoint stays a pure
transform with one success shape.

**Output is an unprotected `.docx`.** Unlike the signature flow, the point
here is that the document is still being worked on.

**Nothing is persisted.** Same posture as `POST /signatures/{id}/apply`: read
the upload, transform in memory, return bytes.

**Access tier: the standard write gate, admin.** Registering the router
outside `_UNGATED` is the whole of it. Nothing here is more sensitive than
signing a document, which is already admin-tier, and manager-only would cost a
`require_manager` dependency plus a `_MANAGER_ONLY` entry in
`test_authorization.py` for no gain.

## Task 1: Rules and fill engine

**Progress note (Task 1, partial).** The engine is built and tested --
`eoi_rules.py` (the `EoiRule` dataclass), `eoi_fill.py` (`fill_eoi`, the
snapshot walk, merge dedup, both write modes, formatting inheritance) and
`tests/test_documents/test_eoi_fill.py`, all against synthetic documents.
`EOI_RULES` is still an empty tuple, because **the prerequisites below are
not done**: the repository is still public, and neither the macro source nor
the blank form is committed. What remains of this task is the verbatim
transcription of the eleven rules plus the assertions that need the real form
(the three vertical merges, the 38-cell snapshot, `section-10` unmatched,
Section 4's sibling checkbox lines).

**A. State of the world.** Nothing is built. The prerequisites above are done:
the repository is private, the macro source is at
`documentation/reference/FillResearchSite.bas`, and the blank form is at
`backend/tests/fixtures/site_id_form_blank.docx`. This task builds the pure
layer only -- no FastAPI, no DB, the same convention as the rest of
`app/documents/` and `app/engine/`.

**B. Files and deliverables.**
- `backend/app/documents/eoi_rules.py` (new) -- the `EoiRule` dataclass and
  `EOI_RULES`, the eleven rules ported from the macro.
- `backend/app/documents/eoi_fill.py` (new) -- `fill_eoi()`.
- `backend/app/documents/__init__.py` -- export `EoiRule`, `EOI_RULES`,
  `fill_eoi`; extend the module docstring, which documents the package's
  contents file by file.
- `backend/tests/test_documents/test_eoi_fill.py` (new).
- Read for reference: `backend/app/documents/signature_insert.py` (the
  existing python-docx conventions and error handling).

**C. Instructions.**

1. `EoiRule` is a frozen dataclass:
   - `id: str` -- stable, url-safe, e.g. `"section-4"`. Used in the response
     header.
   - `label: str` -- human name, for the frontend's warning text.
   - `required: tuple[str, ...]` -- all must appear in the cell text.
   - `excluded: tuple[str, ...] = ()` -- none may appear.
   - `max_source_length: int | None = None` -- the guard ported from Section
     10's `Len(Trim(cellText)) < 50`; the trigger cell's stripped text must be
     shorter than this.
   - `target: Literal["right_cell", "same_cell_line"] = "right_cell"`.
   - `answer: tuple[str, ...]` -- the paragraphs to write. For
     `same_cell_line` this is exactly one string.
   All matching is casefolded on both sides (defect 3), and whitespace in the
   cell text is normalised (Word splits runs, and the extracted text can carry
   `\xa0` and doubled spaces) before the substring test.
2. Transcribe all eleven rules from the macro verbatim, one per `If` block, in
   macro order. Do not correct the figures (defect 5). Keep Section 10's rule
   even though it matches nothing on the reference form (defect 4).
3. `fill_eoi(docx_bytes: bytes, rules: Sequence[EoiRule] = EOI_RULES) ->
   tuple[bytes, list[str]]` returns the filled document and the ids of rules
   that found no target. Raise `DocumentFormatError` (from
   `app.documents.errors`) if python-docx cannot open the bytes -- match how
   `signature_insert.py` does it.
4. Build the snapshot first: for every table, walk `table.rows[i].cells[j]`,
   dedup on `id(cell._tc)` preserving order, and record `(cell, table_index,
   row_index, col_index, normalised_text)`. Nothing is written during this
   pass.
5. Then apply rules against the snapshot. `right_cell` resolves the entry at
   `(table_index, row_index, col_index + 1)` *in the snapshot*; if there is no
   such entry, the rule is unmatched and nothing is written (defect 2). A cell
   already written this run is not a valid target and not a valid trigger.
6. Formatting: implement the `pPr`/`rPr` copy described in Design Decisions as
   one helper in `eoi_fill.py`. Clearing a cell means removing all its `<w:p>`
   children and adding fresh paragraphs -- do not use `cell.text = ""`, which
   leaves a Normal-styled empty paragraph behind.
7. Tests, against the committed blank form:
   - the three vertical merges are each filled exactly once (assert on the
     resulting cell text, and assert the snapshot length is 38);
   - `right_cell` writes to the right and leaves the trigger cell untouched;
   - `same_cell_line` replaces only the matching paragraph -- assert the other
     three "Primary/Secondary/Community/Other" lines survive (defect 1);
   - a synthetic rule whose trigger is in the last column resolves no target,
     writes nothing, and is reported unmatched (defect 2);
   - Section 9's answer text containing its own trigger phrase does not cause
     a second write (defect 2);
   - a rule whose trigger differs only in case still matches (defect 3);
   - `section-10` is reported unmatched on this form (defect 4);
   - `max_source_length` rejects a trigger cell that is too long;
   - written paragraphs carry the expected font/size, not Normal;
   - the returned bytes reopen cleanly in python-docx;
   - a non-docx input raises `DocumentFormatError`.
   Build small synthetic documents with python-docx for the rule-mechanics
   tests; use the committed form for the merge and end-to-end assertions.

## Task 2: Endpoint

**A. State of the world.** Task 1 is complete: `fill_eoi` and `EOI_RULES` are
exported from `app.documents` and unit-tested. This task exposes them over
HTTP. Nothing is persisted and no model or migration is involved.

**B. Files and deliverables.**
- `backend/app/api/routers/eoi.py` (new) -- `POST /eoi/fill`.
- `backend/app/api/routers/signatures.py` -- lift `_safe_filename_stem` to a
  shared home and import it back.
- `backend/app/api/routers/_uploads.py` (new) -- or whatever name fits; holds
  `safe_filename_stem()` and the docx byte constants.
- `backend/app/api/main.py` -- add `eoi` to the imports and `_ALL_ROUTERS`;
  add `expose_headers` to the CORS middleware.
- `backend/tests/test_api/test_eoi.py` (new).
- Read for reference: `backend/app/api/routers/signatures.py` (`apply_signature`
  is the model for this endpoint) and `backend/tests/test_api/test_authorization.py`.

**C. Instructions.**

1. `POST /eoi/fill`, multipart `file`, `Depends(get_current_user)` and
   `Depends(get_db)` matching the signatures router's shape (the DB session is
   not used, so omit it). Reject uploads over the same 10 MB cap.
2. Do **not** reuse `_sniff_format`: it returns `"rtf" | "docx"` and this
   endpoint accepts docx only. Check the leading `PK` yourself and 422 with a
   message naming `.docx` specifically. Lift only `_safe_filename_stem` --
   that one is a clean shared win; move it, re-import it in
   `signatures.py`, and leave `signatures.py` otherwise untouched.
3. Call `fill_eoi`, map `DocumentFormatError` to 422 exactly as
   `apply_signature` does, and return a `Response` with the docx media type,
   `Content-Disposition: attachment; filename="<stem>-filled.docx"`, and
   `X-EOI-Unmatched: <comma-joined ids>` (empty string when all matched).
4. In `main.py`, add to the CORS middleware:
   `expose_headers=["Content-Disposition", "X-EOI-Unmatched"]`. Note this also
   fixes a pre-existing bug: the signature flow's `parseFilename` cannot read
   `Content-Disposition` cross-origin today, so filenames silently fall back
   to the client-side guess whenever the frontend is served from a different
   origin than the API (i.e. in dev). Say so in the commit message.
5. `eoi` goes in `_ALL_ROUTERS` and **not** in `_UNGATED`. No edit to
   `test_authorization.py` is needed -- its sweeps enumerate routes from the
   OpenAPI schema, so the new endpoint is covered automatically, and it is not
   manager-only so it needs no `_MANAGER_ONLY` entry. Do not add one.
6. Tests in `test_eoi.py`: 200 with a docx body and an `X-EOI-Unmatched`
   header naming `section-10` for the blank form; 422 for a `.rtf` upload and
   for a non-document upload; 413 over the cap; filename derived from the
   upload and sanitised; an unrelated docx returns 200 with every id in the
   header. Reuse the fixture from Task 1.

## Task 3: Frontend routing shell

**A. State of the world.** Tasks 1 and 2 are complete: `POST /eoi/fill` is
live and returns a docx plus `X-EOI-Unmatched`. The frontend has no EOI
surface yet, and `/signatures` is a single non-wildcard route whose shell
hardcodes `<SignaturesPage />`. This task is routing only -- it adds the tab
shell and an empty placeholder page, so that Task 4 changes one file.

**B. Files and deliverables.**
- `frontend/src/components/SignaturesTabs.tsx` (new) + test.
- `frontend/src/App.tsx` -- convert `/signatures` to a nested route tree.
- `frontend/src/routes/EoiPage.tsx` (new) -- placeholder in this task.
- Read for reference: `frontend/src/components/SessionManagementTabs.tsx`,
  which is the pattern to follow exactly.

**C. Instructions.**

1. `SignaturesTabs.tsx` mirrors `SessionManagementTabs.tsx`: export
   `SIGNATURES_TABS` (`/signatures` "Signatures", `/signatures/eoi` "Study
   EOI"), `SIGNATURES_PATHS`, the `SignaturesTabs` strip and a
   `SignaturesLayout` rendering the strip plus an `<Outlet />`.
2. In `App.tsx`, `/signatures` is currently `<Route path="/signatures"
   element={<SignaturesShell />} />` (around line 308) and `SignaturesShell`
   renders `<SignaturesPage />` directly in its `<main>` (around line 236).
   Change the route to `path="/signatures/*"`, replace the hardcoded page with
   a nested `<Routes>` containing `<Route element={<SignaturesLayout />}>` with
   an index route for `SignaturesPage` and a `path="eoi"` route for `EoiPage`.
   The index tab's `isActive` check needs to handle the trailing-slash and
   exact-match case -- `SessionManagementTabs` compares `pathname === tab.to`,
   which is fine here as long as the index path is exactly `/signatures`.
3. Rename the shell header string from "Rota Generator - Signatures" to
   something covering both tabs ("Rota Generator - Documents" or similar) and
   update the landing-page link text if it says "Signatures".
4. `EoiPage.tsx` in this task is a heading and a "coming next" line. Task 4
   fills it in.
5. Tests: the tab strip renders both tabs and marks the right one active for
   each path; `/signatures` still renders the existing signatures page (guard
   against the route conversion breaking the bookmark); `/signatures/eoi`
   renders the placeholder.

## Task 4: EOI page and API hook

**A. State of the world.** Tasks 1-3 are complete: the endpoint is live and
`/signatures/eoi` renders a placeholder `EoiPage`. This task makes the page
work.

**B. Files and deliverables.**
- `frontend/src/api/client.ts` -- surface response headers from
  `postFormBlob`.
- `frontend/src/api/eoi.ts` (new) -- `useFillEoi` + test.
- `frontend/src/routes/EoiPage.tsx` -- the real page + test.
- Read for reference: `frontend/src/routes/SignaturesPage.tsx` (drop zone,
  `useWriteGate`, `ToastDisplay`/`useToast`, `downloadBlob`) and
  `frontend/src/api/signatures.ts` (`useApplySignature`).

**C. Instructions.**

1. `postFormBlob` currently returns `{ blob, filename }` and is shared with the
   signature flow. Do **not** add an EOI-specific field to it. Add the raw
   headers instead -- `{ blob, filename, headers: response.headers }` -- and
   let the EOI hook read `X-EOI-Unmatched` itself. Update
   `client.test.ts` for the new shape; `useApplySignature` needs no change.
2. `useFillEoi` posts the file to `/eoi/fill`, then parses the header into a
   `string[]` of ids (empty header -> empty array; a missing header means the
   browser could not see it, which after Task 2's CORS change should not
   happen -- treat it as empty and do not warn). Resolve
   `{ blob, filename, unmatched }`.
3. `EoiPage` is a single drop zone plus file picker, following
   `SignaturesPage`'s drag handlers. On success, `downloadBlob` immediately
   (matching the signature flow -- no preview), then if `unmatched` is
   non-empty show a warning toast naming the labels. Keep the id -> label map
   in `frontend/src/api/eoi.ts` next to the parsing, and note in a comment that
   it must stay in step with `eoi_rules.py`.
4. Gate the drop zone with `useWriteGate()`, as `SignatureRow` does -- the
   endpoint is admin-tier, so a viewer should see it disabled rather than get
   a 403 toast.
5. Client-side pre-checks mirroring the server: `.docx` only, 10 MB. Say the
   server remains authoritative, as `SignaturesPage` does.
6. Tests with msw: a successful fill triggers `downloadBlob` with the
   server-supplied filename; a response with `X-EOI-Unmatched` set shows a
   toast naming those sections; an empty header shows no warning; a 422 shows
   the server's detail; the write gate disables the drop zone. Mock
   `@/lib/downloadBlob` with `vi.mock`, as the signatures tests do.

## Task 5: Documentation

**A. State of the world.** Tasks 1-4 are complete and the feature is live.

**B. Files and deliverables.**
- `documentation/architecture-clinical.md`.
- `documentation/eoi_autofill_plan.md` -- deleted at the end.

**C. Instructions.**

1. Add the EOI fill to the "Signatures and documents" section (or a sibling
   section under the same heading if it reads better), covering: the data flow
   (upload -> snapshot -> rule match -> whole-cell write -> bytes back, nothing
   persisted), and the design decisions from this plan that are not obvious
   from the code -- the pre-write snapshot and why, `id(cell._tc)` dedup and
   why, the header-not-preview reporting choice, and the fact that the rules
   are hardcoded *because* the repo is private and that this is the constraint
   that keeps them there.
2. Add `eoi` to the router list in the "Router surface" section.
3. Record the two follow-ups this plan defers: correcting the stale figures
   (defect 5), and the answer-bank rewrite if they start drifting.
4. Delete this plan file.

## Rejected alternatives

**An editable answer bank** (an `eoi_answers` table plus CRUD UI, so trigger
phrases and answer text are edited in the app). Offered and declined in favour
of a straight port. Recorded here because the trade-off is real: with the
rules hardcoded, every drift in the CQC rating, recruitment totals or ODP
reporting dates needs a code change and a deploy. That is precisely the
failure mode already visible in the macro, where the CQC rating dates from
2016. If those figures start needing frequent updates, revisit this.

**Keeping the repo public and moving the answers to an untracked config file
or the database.** Offered during review as the way to keep practice data out
of a public repo without a UI. Declined in favour of making the repository
private, which preserves the simpler hardcoded design.

**A review-before-download screen** (JSON report plus base64 document).
Declined -- the user edits the filled document in Word afterwards anyway, so
an in-app review step adds a click without removing one. The
`X-EOI-Unmatched` header preserves the one piece of the review that mattered:
knowing when a section did not fill.
