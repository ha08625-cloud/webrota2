"""BlockedEntry schema.

Read-only from the API's point of view -- the only write path is
`POST /leave-planning/bulk` (see leave_planning.py), so there is no
`BlockedIn`, matching the read/write split `ExtraSessionOut` has with the
ad-hoc `/extra-sessions` router but without a create/delete surface of its
own, since Blocked has no ad-hoc page.
"""
import datetime

from pydantic import BaseModel

from ...models.enums import Period


class BlockedOut(BaseModel):
    id: int
    doctor_id: int
    date: datetime.date
    period: Period
    notes: str | None = None
    model_config = {"from_attributes": True}
