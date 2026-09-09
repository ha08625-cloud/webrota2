"""Signature schemas.

Metadata only -- image bytes never travel as JSON. The image itself is
served/accepted as raw bytes via GET .../image and POST multipart, not
through these schemas.

Upload responses use a uniform 200 status for both create and replace, so
the caller does not have to know whether a signature already existed.
"""
import datetime

from pydantic import BaseModel


class SignatureMetaOut(BaseModel):
    doctor_id: int
    content_type: str
    uploaded_at: datetime.datetime
    model_config = {"from_attributes": True}
