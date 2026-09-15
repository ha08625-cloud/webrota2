"""Study documents: upload into a named slot, download, delete.

**Every file is in a slot, and there is no "general" one.** `slot` is a
required form field on the upload, validated against
`research/catalogue.py`. A file that fits no slot belongs on the practice
intranet, which holds the full site pack and remains the record -- this
section is a signpost to the handful of documents the team actually opens,
and a general slot is exactly how it would stop being one.

**The three key slots hold one file; the three setup-step slots hold many.**
Uploading to a key slot replaces what is there, in one transaction, so the
page cannot show a superseded patient information leaflet: it does not keep
one. The superseded copy is not lost -- the intranet has it. A setup-step
slot appends, because a re-signed mNCA arriving beside the original is
normal and neither is "superseded" in a way this page can judge.
`catalogue.slot_holds_one` is the switch, and it is not a partial unique
index for the reason given there.

**No participant-identifiable data.** The blank, current leaflet and consent
form are study templates and are two of the three reasons this section
exists; anything filled in about a real person -- a screening log, a
*signed* consent form, a participant list -- never belongs here. Nothing in
this file can enforce that. The controls are the narrow `research`
permission and the standing copy on the study page, and saying so plainly is
better than pretending a check exists.

**Downloads are hardened per response, because there is no shared layer to
forget it in** -- this app registers CORS and the audit middleware and no
security-headers middleware at all. Every download therefore sets
`Content-Disposition: attachment` with a filename rebuilt from a sanitised
stem, `X-Content-Type-Options: nosniff`, and a content type echoed back only
while it is still in the upload allowlist. These files are served from the
app's own origin, so a stored HTML or SVG served inline under its own type
would be script execution on that origin; those three headers are what close
it.

**The 5 MB cap is about intent, not memory.** It comfortably holds a flow
chart, a leaflet, a consent form and a signed mNCA, and does not hold a site
pack -- which is the point. Be clear about what it does and does not do:
like the two existing upload routes, this one reads the whole body and then
measures it, so the cap bounds what is *stored*, not what is *buffered*.

**Uploads are audited as an event, not as content.** `AuditMiddleware`
parses a body only when the content type is `application/json`, so a
multipart upload records who uploaded to which study and nothing of the
file. The metadata PATCHes next door are recorded in full. Both halves are
pinned by tests.
"""
from __future__ import annotations

import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ....models.user import User
from ....research.catalogue import is_valid_slot, slot_holds_one
from ....research.models import Study, StudyDocument
from ....research.schemas import StudyDocumentOut
from ...deps import get_current_user, get_db
from .._uploads import safe_filename_stem

router = APIRouter(prefix="/research/studies", tags=["research"])

# 5 MB, both sides. The frontend pre-checks the same number to give a faster
# message; this one is authoritative.
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

# Declared content type -> the extensions that may carry it. Both halves are
# checked on upload: `content_type` is client-supplied and is not evidence
# of anything, so the extension has to agree with it, and the real
# protection remains the response headers on the way back out.
ALLOWED_TYPES: dict[str, frozenset[str]] = {
    "application/pdf": frozenset({".pdf"}),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        frozenset({".docx"}),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        frozenset({".xlsx"}),
    "image/png": frozenset({".png"}),
    "image/jpeg": frozenset({".jpg", ".jpeg"}),
}

ALLOWED_EXTENSIONS: frozenset[str] = frozenset(
    extension for extensions in ALLOWED_TYPES.values() for extension in extensions
)

_ACCEPTED_TEXT = "PDF, Word (.docx), Excel (.xlsx), PNG or JPEG"

_FALLBACK_MEDIA_TYPE = "application/octet-stream"


def _study_or_404(db: Session, study_id: int) -> Study:
    study = db.get(Study, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail=f"Study {study_id} not found")
    return study


def _document_or_404(db: Session, study_id: int, document_id: int) -> StudyDocument:
    """Scoped to the study in the path, not looked up by id alone -- a
    document id from another study must 404 here rather than being served
    because it happens to exist."""
    document = db.execute(
        select(StudyDocument).where(
            StudyDocument.id == document_id,
            StudyDocument.study_id == study_id,
        )
    ).scalar_one_or_none()
    if document is None:
        raise HTTPException(
            status_code=404,
            detail=f"Document {document_id} not found on study {study_id}",
        )
    return document


def _extension(filename: str | None) -> str:
    return Path(filename or "").suffix.lower()


@router.post("/{study_id}/documents", response_model=StudyDocumentOut, status_code=201)
def upload_document(
    study_id: int,
    slot: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyDocument:
    _study_or_404(db, study_id)

    if not is_valid_slot(slot):
        raise HTTPException(status_code=422, detail=f"{slot} is not a document slot")

    extension = _extension(file.filename)
    allowed_extensions = ALLOWED_TYPES.get(file.content_type or "")
    if allowed_extensions is None or extension not in allowed_extensions:
        raise HTTPException(
            status_code=422,
            detail=f"This file type is not accepted. Upload a {_ACCEPTED_TEXT} file.",
        )

    # Read then measure, as the two existing upload routes do. See the
    # module docstring: this bounds what is stored, not what is buffered.
    data = file.file.read()
    if len(data) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 5 MB")

    if slot_holds_one(slot):
        # Replace, in the same transaction as the insert: a key slot that
        # briefly held nothing, or briefly held two files, is a page that
        # briefly lied about which leaflet is current.
        for existing in db.execute(
            select(StudyDocument).where(
                StudyDocument.study_id == study_id,
                StudyDocument.slot == slot,
            )
        ).scalars().all():
            db.delete(existing)

    document = StudyDocument(
        study_id=study_id,
        slot=slot,
        filename=Path(file.filename or "document").name,
        content_type=file.content_type,
        size_bytes=len(data),
        data=data,
        uploaded_at=datetime.datetime.now(datetime.timezone.utc),
        uploaded_by_user_id=getattr(user, "id", None),
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


@router.get("/{study_id}/documents/{document_id}")
def download_document(
    study_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """The hardened download -- see the module docstring for why all three
    headers are set here rather than by a middleware."""
    document = _document_or_404(db, study_id, document_id)

    stem = safe_filename_stem(document.filename)
    extension = _extension(document.filename)
    if extension not in ALLOWED_EXTENSIONS:
        extension = ""

    media_type = (
        document.content_type
        if document.content_type in ALLOWED_TYPES
        else _FALLBACK_MEDIA_TYPE
    )

    return Response(
        content=document.data,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{stem}{extension}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.delete("/{study_id}/documents/{document_id}", status_code=204)
def delete_document(
    study_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    document = _document_or_404(db, study_id, document_id)
    db.delete(document)
    db.commit()
