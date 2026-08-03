"""Document manipulation package (signatures feature, Task 2).

Pure logic, framework-free -- bytes in, bytes out, no FastAPI and no DB
access, the same convention as app.engine.

  errors.py               DocumentFormatError (the file is wrong) and
                           ConversionError (our converter failed)
  signature_insert.py     insert_signature(): insert a signature image
                           into the bottom-left cell of a docx's first
                           table
  rtf_signature_insert.py insert_signature_rtf(): splice a signature
                           image into RTF bytes, beneath the "Signature"
                           label
  pdf_convert.py          convert_to_pdf(): render RTF/DOCX bytes to PDF
                           via a headless LibreOffice subprocess
  restrict_editing.py     apply_read_only_protection(): Word Restrict
                           Editing (read-only, fixed password);
                           save_docx(): save an open Document to bytes

Usage (the router, Task 3, composes these three calls in order):

    document = insert_signature(docx_bytes, image_bytes)
    apply_read_only_protection(document, password)
    output_bytes = save_docx(document)

The .rtf path is separate and does not use protection -- the deliverable
there is a PDF, which is a stronger "do not edit this" than the Word
password (rtf/pdf plan, Decision 11):

    rtf_bytes = insert_signature_rtf(rtf_bytes, image_bytes, content_type)
    pdf_bytes = convert_to_pdf(rtf_bytes, ".rtf")

convert_to_pdf shells out to LibreOffice, so unlike the rest of this
package it is not pure -- it needs libreoffice-writer installed (see
nixpacks.toml and the CI test job).
"""
from .errors import ConversionError, DocumentFormatError
from .pdf_convert import convert_to_pdf
from .restrict_editing import (
    DEFAULT_LOCK_PASSWORD,
    apply_read_only_protection,
    save_docx,
)
from .rtf_signature_insert import insert_signature_rtf
from .signature_insert import insert_signature

__all__ = [
    "DocumentFormatError",
    "ConversionError",
    "insert_signature",
    "insert_signature_rtf",
    "convert_to_pdf",
    "apply_read_only_protection",
    "save_docx",
    "DEFAULT_LOCK_PASSWORD",
]
