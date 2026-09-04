"""Shared helpers for the two routers that take a document upload.

Not a router -- the leading underscore marks it as internal to the
routers package, so nothing here is mistaken for a module with a
`router` attribute to register in main.py.

`safe_filename_stem` is the one genuinely shared piece: both
/signatures/{id}/apply and /eoi/fill echo the uploaded filename back in
a Content-Disposition header, and neither may echo a client-supplied
path or quote character while doing it.

The two constants are here for the same reason, though signatures.py
keeps its own copies -- see the note in the EOI endpoint commit.
"""
from __future__ import annotations

import re
from pathlib import Path

MAX_DOCX_BYTES = 10 * 1024 * 1024
DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._ -]")


def safe_filename_stem(filename: str | None) -> str:
    # Basename only -- never a client-supplied path.
    stem = Path(filename or "document").stem
    cleaned = _FILENAME_SAFE.sub("", stem).strip()
    return cleaned or "document"
