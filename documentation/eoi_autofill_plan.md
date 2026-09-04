# Provisional plan: Study EOI autofill

Status: provisional (workflow step 1). To be reviewed and expanded into an
implementation plan in a fresh chat.

## Scope

Add a second tab to the Signatures page that fills the standard sections of an
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

## Background: what the macro does

`FillResearchSite` walks every cell of every table in the document. For each
cell whose text contains a trigger phrase (with, for two sections, an
additional phrase that must be *absent*), it blanks the cell **to the right**
and writes a fixed block of paragraphs into it. Section 4 is the one
exception: it overwrites the matched cell itself.

The rule shape is therefore:

    (required substrings, excluded substrings) -> target -> answer paragraphs

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
row a vertical merge spans. Naive iteration therefore visits these three cells
twice and would fill each target twice. Deduplicating by the underlying `_tc`
element is required, not optional. VBA's `tbl.Range.Cells` already enumerates
distinct cells, which is why the macro does not hit this.

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
   unrelated cell with no error. Fix: no target resolved means no write, and a
   cell this run has already filled is excluded from later matching.

3. **`InStr` is case-sensitive.** A sponsor writing "Research Site" for
   "Research site" silently gets no match. Fix: casefold both sides.

4. **Section 10 never fires on this form.** There is no "Non-Commercial ...
   Studies" cell in it. The macro reports "Form has been filled in
   successfully!" regardless. Fix: report unmatched rules (see below). The
   rule itself is kept -- it presumably matches other variants.

5. **Answers are stale and inconsistent.** "CQC ... rating = Good (September
   2016)", "ODP 2023-04-06", and two different non-commercial study counts
   (32 studies / 960 recruits in Section 10; 13 studies / 840 recruits in
   Section 11). The port copies them verbatim -- correcting them is the user's
   call, not the porter's -- but they should be reviewed before this ships,
   and see "Rejected alternatives" for why they will keep drifting.

## Design decisions

**Rules live in a Python constant, not the database.** User's explicit choice:
a straight port, with the forms being identical every time. One module,
`eoi_rules.py`, holds the eleven rules as a module-level tuple. Updating a
figure is a one-line edit to one file and a deploy. The rule dataclass is
shaped so that moving to a table later is a data-source swap, not a rewrite,
but no such table is built now.

**Report via response header, not a two-step preview.** The user does not want
a review screen. But a silent miss is defect 4 above, so the response carries
an `X-EOI-Unmatched` header listing the labels of any rules that found no
target. The frontend downloads the file and, if that header is non-empty,
shows a warning toast naming the sections. This keeps the existing
`postFormBlob` download flow intact -- no base64, no JSON envelope.

**Output is an unprotected `.docx`.** Unlike the signature flow, the point
here is that the document is still being worked on.

**Nothing is persisted.** Same posture as `POST /signatures/{id}/apply`: read
the upload, transform in memory, return bytes.

## Files

Backend:
- `backend/app/documents/eoi_rules.py` (new) -- `EoiRule` dataclass and the
  eleven rules ported from the macro.
- `backend/app/documents/eoi_fill.py` (new) -- `fill_eoi(docx_bytes, rules)`.
- `backend/app/documents/__init__.py` -- export the new names; extend the
  module docstring, which currently documents the package's contents.
- `backend/app/api/routers/eoi.py` (new) -- `POST /eoi/fill`.
- `backend/app/api/main.py` -- add `eoi` to `_ALL_ROUTERS` (gated: it is not
  one of the three `_UNGATED` routers); add `expose_headers` to the CORS
  middleware for `Content-Disposition` and `X-EOI-Unmatched`.
- `backend/tests/test_documents/test_eoi_fill.py` (new).
- `backend/tests/test_api/test_eoi.py` (new).
- `backend/tests/fixtures/` -- the blank form, committed as a test fixture.

Frontend:
- `frontend/src/components/SignaturesTabs.tsx` (new) -- two-tab shell,
  following the `SessionManagementTabs.tsx` pattern.
- `frontend/src/routes/EoiPage.tsx` (new) -- drop zone plus download.
- `frontend/src/api/eoi.ts` (new) -- `useFillEoi`.
- `frontend/src/api/client.ts` -- `postFormBlob` currently returns
  `{ blob, filename }`; it needs to surface `X-EOI-Unmatched` too.
- `frontend/src/App.tsx` -- register the new route under the tab shell.
- Tests alongside each.

## Task breakdown (provisional)

1. **Rules and fill engine.** `eoi_rules.py` + `eoi_fill.py` + unit tests
   against the committed blank form. Pure, no FastAPI, no DB -- the same
   convention as the rest of `app/documents/` and `app/engine/`. Must cover:
   `_tc` deduplication across the three vertical merges, `right_cell` vs
   `same_cell_line`, the no-target-no-write rule, self-match exclusion,
   case-insensitive matching, the `only_if_shorter_than` guard ported from
   Section 10's `Len(Trim) < 50`, and run-formatting preservation.
2. **Endpoint.** `POST /eoi/fill`, multipart in, `.docx` out plus the
   unmatched header. Reuse the size cap and filename-sanitising helpers from
   `routers/signatures.py` (consider lifting `_safe_filename_stem` and
   `_sniff_format` to a shared module rather than copying). API tests
   including the authorization sweep in `test_authorization.py`.
3. **Frontend tab.** Tab shell, page, api hook, client change, tests.
4. **Documentation.** Update `documentation/architecture-clinical.md` with
   the feature's data flow and the design decisions above, then delete this
   plan file.

## Open questions for the review chat

- The stale figures in defect 5: correct them as part of this work, or port
  verbatim and leave it to a follow-up?
- Should the filled document also be offered as a PDF? Assumed no -- the
  variable sections still need answering in Word.
- Access tier: the whole feature is one person's workflow. Gated at the same
  admin tier as the rest of the non-GET surface, or manager-only?

## Rejected alternatives

**An editable answer bank** (a `eoi_answers` table plus CRUD UI, so trigger
phrases and answer text are edited in the app). Offered and declined in favour
of a straight port. Recorded here because the trade-off is real: with the
rules hardcoded, every drift in the CQC rating, recruitment totals or ODP
reporting dates needs a code change and a deploy. That is precisely the
failure mode already visible in the macro, where the CQC rating dates from
2016. If those figures start needing frequent updates, revisit this.

**A review-before-download screen** (JSON report plus base64 document).
Declined -- the user edits the filled document in Word afterwards anyway, so
an in-app review step adds a click without removing one. The
`X-EOI-Unmatched` header preserves the one piece of the review that mattered:
knowing when a section did not fill.
