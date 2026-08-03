"""Exception types for the documents package.

Two types, and the split is deliberate (rtf/pdf plan, Decision 10): they
answer "whose fault is it?" and the router maps them to different statuses,
so a broken converter is never reported to an admin as a bad upload.

  DocumentFormatError  the file is wrong          -> 422
  ConversionError      our converter failed       -> 502

Every message in this package is written to be read directly by a
non-technical admin, not just logged.
"""


class DocumentFormatError(ValueError):
    """A document could not be processed because it does not match the
    expected shape (not a valid OOXML package or RTF, no table, wrong column
    count, missing Signature anchor, ...). Carries a human-readable message
    intended for display."""


class ConversionError(RuntimeError):
    """PDF conversion failed for a reason on our side: LibreOffice missing,
    exiting non-zero, timing out, or producing no output. Distinct from
    DocumentFormatError so the two are not conflated in logs or in the
    message the admin sees."""
