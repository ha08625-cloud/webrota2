"""EOI router (study EOI autofill, Task 2).

One endpoint: POST /eoi/fill takes an NIHR Site Identification form as a
.docx and returns the same document with its eleven standard sections
filled in. Nothing is persisted -- the upload is read, transformed in
memory via app.documents, and returned as bytes, the same posture as
POST /signatures/{id}/apply.

The output is a plain, unprotected .docx: unlike the signature flow, the
point here is that the user still has to answer the sponsor-specific
questions in Word afterwards.

A rule that matches nothing is not an error. The response is a 200
whatever happens, and the ids of the rules that found no target come
back in the X-EOI-Unmatched header (the empty string when every rule
matched), so the frontend can name the misses. An unrelated .docx
therefore returns unchanged with all eleven ids listed, which is a
clearer message than a rejection would be. The header carries ids
rather than the human labels because header values are latin-1 and
comma-separated, and ids keep it short and encodable; the frontend maps
them back to labels.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response

from ...documents import DocumentFormatError, fill_eoi
from ..deps import get_current_user
from ._uploads import DOCX_MEDIA_TYPE, MAX_DOCX_BYTES, safe_filename_stem

router = APIRouter(prefix="/eoi", tags=["eoi"])


@router.post("/fill")
def fill_form(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
) -> Response:
    # The declared content type is not checked -- browsers are inconsistent
    # about document MIME types, and a renamed file would sail past it
    # anyway. The leading-bytes check plus the DocumentFormatError raised
    # by actually opening the package is the real validation.
    #
    # _sniff_format from signatures.py is deliberately not reused: it
    # returns "rtf" or "docx", and this endpoint accepts docx only, so an
    # .rtf upload needs a message that names .docx specifically.
    document_bytes = file.file.read()
    if len(document_bytes) > MAX_DOCX_BYTES:
        raise HTTPException(status_code=413, detail="Document exceeds 10 MB")

    if not document_bytes.startswith(b"PK"):
        raise HTTPException(
            status_code=422,
            detail=(
                "File is not a .docx document. Word's .doc format and .rtf "
                "are not supported here -- save the form as .docx and try "
                "again."
            ),
        )

    try:
        out_bytes, unmatched = fill_eoi(document_bytes)
    except DocumentFormatError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    filename = f"{safe_filename_stem(file.filename)}-filled.docx"
    return Response(
        content=out_bytes,
        media_type=DOCX_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-EOI-Unmatched": ",".join(unmatched),
        },
    )
