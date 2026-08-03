# Test fixtures

## certificate_sample.rtf

**Synthetic, not a real EMIS Web export.** The rtf/pdf plan asks for the real
`Certificates_administration_DUCK_Donald_Ms_0907_20Jul2026.rtf` to be
committed here; that file was not available to the implementation chat, so
this is a structural stand-in built to reproduce the features the RTF splice
actually depends on:

- an RTF header, font table and colour table
- a `\stylesheet` defining styles literally named `Signature;` and
  `E-mail Signature;`, plus a `\*\latentstyles` table repeating both names --
  these are the decoys that make the bare string "Signature" match three
  times, and are what the anchor regex's `\par` exists to skip
- one pre-existing `\pngblip` (standing in for the Oxford crest), so tests
  can assert the splice takes the blip count from one to two
- `FORMCHECKBOX` form fields
- a two-column signature table whose left cell holds the `Signature` label,
  with a cosmetic line break between the label and its `\par` (Word wraps RTF
  output at ~255 columns, so the break's position is not stable across
  exports and the anchor must tolerate it)

It was verified to convert cleanly through `soffice --headless --convert-to
pdf`, both before and after splicing, with the signature rendering inside the
Signature cell.

**Replace it with a real export when one is available**, and re-run
`tests/test_documents/test_rtf_signature_insert.py`. The tests are written
against structure rather than exact offsets, so a real file should drop in.
Two things to confirm on the real file: that the anchor regex still matches
exactly once, and that the checked-in copy carries no patient data beyond a
synthetic test record.
