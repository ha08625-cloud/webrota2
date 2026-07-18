"""Signatures router (signatures feature, Task 3).

Endpoints are deliberately unscoped by doctor_type -- any doctor_id is
accepted; the Partner/Salaried filter is frontend-only (signatures feature
plan, Decision 9). No processed document is ever persisted: /apply reads
the upload, transforms it in memory via app.documents, and returns bytes
(Decision 13).
"""
from __future__ import annotations

import datetime
import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...documents import (
    DEFAULT_LOCK_PASSWORD,
    DocumentFormatError,
    apply_read_only_protection,
    insert_signature,
    save_docx,
)
from ...models import Doctor, DoctorSignature
from ..deps import get_current_user, get_db
from ..schemas import SignatureMetaOut

router = APIRouter(prefix="/signatures", tags=["signatures"])

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png"}
_MAX_IMAGE_BYTES = 5 * 1024 * 1024
_MAX_DOCX_BYTES = 10 * 1024 * 1024
_DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._ -]")


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


def _safe_filename_stem(filename: str | None) -> str:
    # Basename only -- never a client-supplied path.
    stem = Path(filename or "document").stem
    cleaned = _FILENAME_SAFE.sub("", stem).strip()
    return cleaned or "document"


@router.get("", response_model=list[SignatureMetaOut])
def list_signatures(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[DoctorSignature]:
    return db.execute(
        select(DoctorSignature).order_by(DoctorSignature.doctor_id)
    ).scalars().all()


@router.get("/{doctor_id}/image")
def get_signature_image(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
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
    # about docx MIME types; DocumentFormatError from actually opening the
    # file is the real validation (signatures feature plan, Task 3).
    docx_bytes = file.file.read()
    if len(docx_bytes) > _MAX_DOCX_BYTES:
        raise HTTPException(status_code=413, detail="Document exceeds 10 MB")

    try:
        document = insert_signature(docx_bytes, signature.image)
        apply_read_only_protection(
            document, os.environ.get("DOC_LOCK_PASSWORD", DEFAULT_LOCK_PASSWORD)
        )
        out_bytes = save_docx(document)
    except DocumentFormatError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    filename = f"{_safe_filename_stem(file.filename)}-signed.docx"
    return Response(
        content=out_bytes,
        media_type=_DOCX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
