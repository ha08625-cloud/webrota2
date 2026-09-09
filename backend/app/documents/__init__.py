"""Document manipulation package: signature insertion, PDF conversion and
the Site Identification (EOI) form autofill.

Pure logic, framework-free -- bytes in, bytes out, no FastAPI and no DB
access, the same convention as app.engine. pdf_convert is the exception:
it shells out to LibreOffice, so it needs libreoffice-writer installed
(see nixpacks.toml and the CI test job).

The .docx signing path, in the order the router composes it:

    document = insert_signature(docx_bytes, image_bytes)
    insert_date(document, date_text)
    apply_read_only_protection(document, password)
    output_bytes = save_docx(document)

The .rtf path is separate and does not use protection -- the deliverable
there is a PDF, which is a stronger "do not edit this" than the Word
password:

    rtf_bytes = insert_signature_rtf(rtf_bytes, image_bytes, content_type)
    rtf_bytes = insert_date_rtf(rtf_bytes, date_text)
    pdf_bytes = convert_to_pdf(rtf_bytes, ".rtf")
"""
from .eoi_fill import fill_eoi
from .eoi_rules import EOI_RULES, EoiRule
from .errors import ConversionError, DocumentFormatError
from .pdf_convert import convert_to_pdf
from .restrict_editing import (
    DEFAULT_LOCK_PASSWORD,
    apply_read_only_protection,
    save_docx,
)
from .rtf_signature_insert import insert_date_rtf, insert_signature_rtf
from .signature_insert import insert_date, insert_signature

__all__ = [
    "DocumentFormatError",
    "ConversionError",
    "insert_signature",
    "insert_date",
    "insert_signature_rtf",
    "insert_date_rtf",
    "convert_to_pdf",
    "apply_read_only_protection",
    "save_docx",
    "DEFAULT_LOCK_PASSWORD",
    "EoiRule",
    "EOI_RULES",
    "fill_eoi",
]
