"""Exception types for the documents package.

DocumentFormatError is the only exception type this package raises for
validation failures (an unreadable file, a table layout that does not match
the expected template shape). The router (Task 3) catches this type and
maps it to a 422 with the message as-is -- so every message here is written
to be read directly by a non-technical admin, not just logged.
"""


class DocumentFormatError(ValueError):
    """A .docx file could not be processed because it does not match the
    expected shape (not a valid OOXML package, no table, wrong column
    count, ...). Carries a human-readable message intended for display."""
