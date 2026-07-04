"""Counter schemas: live values for the frontend counter panel."""
from pydantic import BaseModel

from ...models.enums import SystemCounterType


class ClinicCounterOut(BaseModel):
    id: int
    doctor_id: int
    doctor_code: str
    clinic_type_id: int
    clinic_type_name: str
    raw_count: int


class SystemCounterOut(BaseModel):
    id: int
    doctor_id: int
    doctor_code: str
    counter_type: SystemCounterType
    raw_count: int
