"""Document manipulation package (signatures feature, Task 2).

Pure logic, framework-free -- bytes in, bytes out, no FastAPI and no DB
access, the same convention as app.engine.

  errors.py               DocumentFormatError (the only exception type
                           this package raises)
  signature_insert.py     insert_signature(): insert a signature image
                           into the bottom-left cell of a docx's first
                           table
  rtf_signature_insert.py insert_signature_rtf(): splice a signature
                           image into RTF bytes, beneath the "Signature"
                           label
  restrict_editing.py     apply_read_only_protection(): Word Restrict
                           Editing (read-only, fixed password);
                           save_docx(): save an open Document to bytes

Usage (the router, Task 3, composes these three calls in order):

    document = insert_signature(docx_bytes, image_bytes)
    apply_read_only_protection(document, password)
    output_bytes = save_docx(document)

The .rtf path is separate and does not use protection -- the deliverable
there is a PDF (rtf/pdf plan, Decision 11):

    rtf_bytes = insert_signature_rtf(rtf_bytes, image_bytes, content_type)
"""
from .errors import DocumentFormatError
from .restrict_editing import (
    DEFAULT_LOCK_PASSWORD,
    apply_read_only_protection,
    save_docx,
)
from .rtf_signature_insert import insert_signature_rtf
from .signature_insert import insert_signature

__all__ = [
    "DocumentFormatError",
    "insert_signature",
    "insert_signature_rtf",
    "apply_read_only_protection",
    "save_docx",
    "DEFAULT_LOCK_PASSWORD",
]
