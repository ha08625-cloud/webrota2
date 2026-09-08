"""Counter schemas: live values for the frontend counter panel.

`opening_balance` is a credit in sessions added to `raw_count` before the
weighted score is computed (see `app/models/counter.py`). Like every other
session quantity crossing this API -- `DoctorOut.sessions_per_week`, the
leave entitlement figures -- it is a `Decimal` and therefore serialises as a
JSON string: these are numbers an admin types into a box and reconciles by
eye, and a float would eventually render one of them as 3.1999999999999997.
"""
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from ...models.enums import SystemCounterType

# Matches the Numeric(5,1) columns behind both balances.
_BALANCE_LIMIT = 9999


class ClinicCounterOut(BaseModel):
    """One (doctor, clinic type) pair.

    `id` is null for a pair with no `clinic_counters` row yet. Those rows are
    created lazily -- on first allocation, or by the opening-balance upsert --
    so the list endpoint returns the full cross-product rather than only the
    rows that exist; without that, a doctor who has never been allocated a
    clinic type could not be given an opening balance for it, which is
    exactly the doctor the balance exists for.
    """

    id: int | None
    doctor_id: int
    doctor_code: str
    clinic_type_id: int
    clinic_type_name: str
    raw_count: int
    opening_balance: Decimal


class SystemCounterOut(BaseModel):
    id: int
    doctor_id: int
    doctor_code: str
    counter_type: SystemCounterType
    raw_count: int
    opening_balance: Decimal


class _OpeningBalanceBase(BaseModel):
    sessions: Decimal = Field(ge=-_BALANCE_LIMIT, le=_BALANCE_LIMIT)

    @model_validator(mode="after")
    def _one_decimal_place(self) -> "_OpeningBalanceBase":
        """Reject more than one decimal place, then normalise to exactly one.

        The normalisation matters for the response, not the storage: the
        column quantises anyway, so without it `{"sessions": "3"}` would echo
        back "3" while the same value re-read from the DB is "3.0", and a
        client comparing the two would see a change that did not happen.
        """
        quantized = self.sessions.quantize(Decimal("0.1"))
        if self.sessions != quantized:
            raise ValueError("sessions must have at most one decimal place")
        self.sessions = quantized
        return self


class ClinicOpeningBalanceIn(_OpeningBalanceBase):
    """Upsert body, keyed on (doctor, clinic type) rather than on a counter
    id: the counter row may not exist yet, and the upsert creates it."""

    doctor_id: int
    clinic_type_id: int


class SystemOpeningBalanceIn(_OpeningBalanceBase):
    """Upsert body for a system counter. Keyed on the counter id in the path,
    which is always available -- `create_doctor` seeds a ROOM_MOVE and a
    SUPERVISION row for every doctor."""
