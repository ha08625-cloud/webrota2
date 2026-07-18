"""Signature schemas.

Metadata only -- image bytes never travel as JSON (signatures feature plan,
Task 3 instructions). The image itself is served/accepted as raw bytes via
GET .../image and POST multipart, not through these schemas.

Upload responses use a uniform 200 status for both create and replace
(implementer's choice per the Task 3 instructions).
"""
import datetime

from pydantic import BaseModel


class SignatureMetaOut(BaseModel):
    doctor_id: int
    content_type: str
    uploaded_at: datetime.datetime
    model_config = {"from_attributes": True}
