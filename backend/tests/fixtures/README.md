# Test fixtures

## certificate_sample.rtf

**Synthetic, not a real EMIS Web export**, but its signature table is now
copied verbatim from one. The first version of this file was written without
a real export to hand and guessed that table's markup; the guess was wrong in
a way that shipped a bug (see "Date" below), so the parts the splice actually
reads are no longer invented.

It is deliberately not the real export. `Certificates_administration_DUCK_
Donald_Ms_0907_20Jul2026.rtf` carries no patient data -- the record is a
dummy -- but it does carry the practice's letterhead, address, phone and NHS
e-mail, and this repository is public. The structure below is what the tests
need; the rest of the export is not.

Features reproduced:

- an RTF header, font table and colour table
- a `\stylesheet` defining styles literally named `Signature;`,
  `E-mail Signature;` and `Date;`, plus a `\*\latentstyles` table repeating
  them -- these are the decoys that make a bare string search for either
  label hit the style tables before the document body
- the phrase "Date of birth" in the body, a second decoy for the Date anchor
- one pre-existing `\pngblip` (standing in for the Oxford crest), so tests
  can assert the splice takes the blip count from one to two
- `FORMCHECKBOX` form fields
- the two-column signature table, run for run as Word writes it:

  ```
  {FMT Signature\par }{FMT \cell }{FMT Date\cell }
  ```

  Three things here are load-bearing. The cosmetic line break between
  `Signature` and its `\par` (Word wraps RTF output at ~255 columns, so the
  break's position is not stable across exports and the anchor must tolerate
  it). The bold `\b` on both labels, which the inserted date must *not*
  inherit. And the asymmetry between the two labels: the Signature cell holds
  a second, empty paragraph so its label ends with an explicit `\par`, while
  the Date cell holds one paragraph only and `\cell` terminates it directly
  with no `\par` anywhere. The original fixture gave Date a `\par` by analogy
  with Signature, the Date anchor was written to match, and the feature failed
  on every real certificate with "Could not find the Date label in this
  document" while the tests passed.

It was verified to convert cleanly through `soffice --headless --convert-to
pdf`, both before and after splicing, with the signature rendering inside the
Signature cell and the date beneath the Date label. The same check was run
against the real export.

**If a real export is ever committed here**, confirm both anchors still match
exactly once, and that it carries no patient data and nothing about the
practice that should not be public.

## site_id_form_blank.docx

The NIHR Site Identification / Expression of Interest form, used by
`test_eoi_fill.py` as the document `fill_eoi` was ported against.

**Sanitised, and it had to be.** The source file supplied for this ticket
(`76021_Blank_site_ID_form`) was blank of *practice* content -- no
Summertown details anywhere -- but it was not blank of *sponsor* content:
it carried a named commercial study in its header table (title and CPMS
ID) and four sponsor-specific questions in rows 21-24, all naming that
sponsor's device and patient group. Those were replaced with `[insert
study title]`, `[insert CPMS ID]` and `[sponsor-specific question N]`;
everything else is untouched, and `word/document.xml` was re-checked
afterwards for the sponsor's and the practice's names. The rest of the
package (headers, footers, styles, media) never mentioned either.

Nothing the tests assert on was touched. What they need is the structure,
which is intact:

- two tables -- the covering note, then the 25-row x 2-column form
- 38 distinct cells in the form table across 12 merged regions, so a walk
  that does not deduplicate sees 50
- the three merged labels the rules depend on: "Main contact for
  feasibility discussions / Research Setting" (rows 3-4, column 0 only,
  so the two answer cells stay separate), "other infrastructure" (rows
  12-13) and "unique elements of Network" (rows 18-19)
- the run-split labels ("Name and " / "R" / "ole:" / " [insert here]")
  that make whole-cell replacement the right approach
- empty answer cells for the staff-resource and sponsor questions, which
  is what exercises the fall back to the trigger cell's formatting

**If the real form is ever re-committed here**, check it the same way: the
answer cells must be empty, and no sponsor should be identifiable from it.
