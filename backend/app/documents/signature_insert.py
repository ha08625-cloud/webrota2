"""Inserts a signature image into a docx's signature table cell.

Table targeting is positional and deliberately brittle: document.tables[0],
last row, cell index 0. Every assumption is asserted explicitly and a
violation raises DocumentFormatError with a message aimed at a non-technical
admin -- there is no content scanning or heuristic fallback, on the view
that a wrong-but-silent insertion into an unrelated cell is worse than a
loud failure.

The target cell is confirmed empty in the real documents: the image is
added to the cell's existing first paragraph via add_run(), with no
clearing or paragraph creation.
"""
import io
import zipfile

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from docx.shared import Cm

from .errors import DocumentFormatError


def insert_signature(docx_bytes: bytes, image_bytes: bytes) -> Document:
    """Open docx_bytes as a Word document, insert image_bytes into the
    bottom-left cell of its first table, and return the open Document
    (not bytes) so the caller can apply protection before a single save.

    Raises DocumentFormatError if docx_bytes is not a valid .docx package,
    or if the first table does not have exactly two columns.
    """
    try:
        document = Document(io.BytesIO(docx_bytes))
    except (PackageNotFoundError, zipfile.BadZipFile):
        # This is the path a legacy .doc (binary, pre-OOXML) upload takes.
        raise DocumentFormatError("File is not a valid .docx document")

    if len(document.tables) < 1:
        raise DocumentFormatError("Document contains no table")

    table = document.tables[0]
    if len(table.columns) != 2:
        raise DocumentFormatError(
            f"Expected the first table to have 2 columns, found {len(table.columns)}"
        )

    cell = table.rows[-1].cells[0]
    cell.paragraphs[0].add_run().add_picture(io.BytesIO(image_bytes), width=Cm(4))

    return document


def insert_date(document: Document, date_text: str) -> None:
    """Insert date_text into the cell to the right of the signature cell
    (bottom row, second column of the first table), as a new paragraph.

    Must be called on a document that has already been through
    insert_signature, which validates the table exists and has exactly two
    columns -- this function relies on that, rather than re-checking, since
    the two are always used together. A new paragraph is appended rather
    than writing into the existing first paragraph, because unlike the
    signature cell (confirmed empty), this cell commonly already carries a
    "Date" label.
    """
    cell = document.tables[0].rows[-1].cells[1]
    cell.add_paragraph(date_text)
