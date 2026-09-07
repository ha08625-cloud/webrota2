"""Signatures router (signatures feature, Task 3).

Endpoints are deliberately unscoped by doctor_type -- any doctor_id is
accepted; the Partner/Salaried filter is frontend-only. No processed
document is ever persisted: /apply reads the upload, transforms it in
memory via app.documents, and returns bytes.

/apply serves two document formats, distinguished by sniffing the uploaded
bytes rather than the extension or the declared MIME type:

  .docx -> signed .docx, Restrict Editing applied .rtf -> signed .pdf; the
  spliced RTF is an intermediate LibreOffice reads and nobody else sees,
  and the PDF is a stronger "do not edit this" than the Word password

Every endpoint here, the two reads included, needs the `signatures`
permission -- and that is the whole of the gating: main.py registers this
router in the `signatures` area, and because that permission is a boolean
rather than a level there is no read exemption to carve out. An image of
somebody's handwritten signature is the one thing in this API worth more
outside it than in, so the people who may read one are exactly the people
who may upload one. Nothing in this file gates itself; the two GETs
carried an explicit dependency while the gates still ran off access_level,
and it came off when they moved to the permission set.
"""
from __future__ import annotations

import datetime
import logging
import os

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...documents import (
    DEFAULT_LOCK_PASSWORD,
    ConversionError,
    DocumentFormatError,
    apply_read_only_protection,
    convert_to_pdf,
    insert_date,
    insert_date_rtf,
    insert_signature,
    insert_signature_rtf,
    save_docx,
)
from ...models import Doctor, DoctorSignature, User
from ..deps import get_current_user, get_db
from ..schemas import SignatureMetaOut
from ._uploads import safe_filename_stem

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/signatures", tags=["signatures"])

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png"}
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_MAX_DOCX_BYTES = 10 * 1024 * 1024
_DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
_PDF_MEDIA_TYPE = "application/pdf"

# What the admin sees when LibreOffice is missing, wedged, or fails. The real
# reason is logged; it names temp paths and soffice internals, neither of
# which belongs in a response body.
_CONVERSION_FAILED_MESSAGE = (
    "Could not convert this document to PDF. Please try again, and contact "
    "support if it keeps happening."
)


def _get_doctor_or_404(db: Session, doctor_id: int) -> Doctor:
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail=f"Doctor {doctor_id} not found")
    return doctor


def _get_signature_or_404(db: Session, doctor_id: int) -> DoctorSignature:
    signature = db.execute(
        select(DoctorSignature).where(DoctorSignature.doctor_id == doctor_id)
    ).scalar_one_or_none()
    if signature is None:
        raise HTTPException(
            status_code=404, detail=f"No signature stored for doctor {doctor_id}"
        )
    return signature


def _sniff_format(data: bytes) -> str:
    """Return "rtf" or "docx" from the leading bytes.

    Neither the extension nor the declared content type is consulted:
    browsers are inconsistent about both, and a renamed file would sail past
    either. Some producers emit a UTF-8 BOM or leading whitespace before the
    opening group, so the RTF check runs against a stripped copy.

    Raises DocumentFormatError for anything else, which the caller maps to
    422 -- this is where a legacy .doc, a PDF, or a stray image lands.
    """
    head = data[:64]
    if head.startswith(b"\xef\xbb\xbf"):
        head = head[3:]
    if head.lstrip().startswith(rb"{\rtf1"):
        return "rtf"
    # Any zip is treated as a docx here; python-docx rejects a zip that is
    # not an OOXML package, with its own DocumentFormatError.
    if head.startswith(b"PK"):
        return "docx"
    raise DocumentFormatError(
        "File is not a valid .docx or .rtf document. Word's .doc format is "
        "not supported -- save it as .docx or .rtf and try again."
    )


@router.get("", response_model=list[SignatureMetaOut])
def list_signatures(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[DoctorSignature]:
    return db.execute(
        select(DoctorSignature).order_by(DoctorSignature.doctor_id)
    ).scalars().all()


@router.get("/{doctor_id}/image")
def get_signature_image(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    signature = _get_signature_or_404(db, doctor_id)
    return Response(content=signature.image, media_type=signature.content_type)


@router.post("/{doctor_id}", response_model=SignatureMetaOut)
def upload_signature(
    doctor_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> DoctorSignature:
    _get_doctor_or_404(db, doctor_id)

    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=422,
            detail="Signature image must be image/jpeg or image/png",
        )

    image_bytes = file.file.read()
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Signature image exceeds 5 MB")

    existing = db.execute(
        select(DoctorSignature).where(DoctorSignature.doctor_id == doctor_id)
    ).scalar_one_or_none()

    now = datetime.datetime.now(datetime.timezone.utc)
    if existing is not None:
        existing.image = image_bytes
        existing.content_type = file.content_type
        existing.uploaded_at = now
        signature = existing
    else:
        signature = DoctorSignature(
            doctor_id=doctor_id,
            image=image_bytes,
            content_type=file.content_type,
            uploaded_at=now,
        )
        db.add(signature)

    db.commit()
    db.refresh(signature)
    return signature


@router.delete("/{doctor_id}", status_code=204)
def delete_signature(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    signature = _get_signature_or_404(db, doctor_id)
    db.delete(signature)
    db.commit()


@router.post("/{doctor_id}/apply")
def apply_signature(
    doctor_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> Response:
    _get_doctor_or_404(db, doctor_id)

    signature = db.execute(
        select(DoctorSignature).where(DoctorSignature.doctor_id == doctor_id)
    ).scalar_one_or_none()
    if signature is None:
        raise HTTPException(
            status_code=409, detail="No signature stored for this doctor"
        )

    # Declared content type is not checked here -- browsers are inconsistent
    # about document MIME types; _sniff_format plus the DocumentFormatError
    # raised by actually opening the file is the real validation.
    document_bytes = file.file.read()
    if len(document_bytes) > _MAX_DOCX_BYTES:
        raise HTTPException(status_code=413, detail="Document exceeds 10 MB")

    # UK date format, matching the certificate template's day-month-year
    # convention (documentation/architecture-clinical.md's other en-GB date
    # helpers use the same order).
    date_text = datetime.date.today().strftime("%d/%m/%Y")

    # The size cap applies to the upload only. The spliced RTF is larger --
    # hex encoding doubles the image's contribution -- but it is never
    # returned or stored, so it only affects peak memory.
    try:
        if _sniff_format(document_bytes) == "rtf":
            spliced = insert_signature_rtf(
                document_bytes, signature.image, signature.content_type
            )
            spliced = insert_date_rtf(spliced, date_text)
            out_bytes = convert_to_pdf(spliced, ".rtf")
            media_type, extension = _PDF_MEDIA_TYPE, "pdf"
        else:
            document = insert_signature(document_bytes, signature.image)
            insert_date(document, date_text)
            apply_read_only_protection(
                document, os.environ.get("DOC_LOCK_PASSWORD", DEFAULT_LOCK_PASSWORD)
            )
            out_bytes = save_docx(document)
            media_type, extension = _DOCX_MEDIA_TYPE, "docx"
    except DocumentFormatError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ConversionError as exc:
        # Ours, not theirs: 502, and the detail from the converter
        # goes to the log rather than the response.
        logger.exception("PDF conversion failed for doctor %s", doctor_id)
        raise HTTPException(status_code=502, detail=_CONVERSION_FAILED_MESSAGE) from exc

    filename = f"{safe_filename_stem(file.filename)}-signed.{extension}"
    return Response(
        content=out_bytes,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
