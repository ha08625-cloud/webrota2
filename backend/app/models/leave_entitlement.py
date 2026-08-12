"""LeaveEntitlement model (leave entitlement and balances plan).

One optional row per (doctor, leave year). The *rules* -- 7 weeks for a
partner, 6 for salaried and trainee doctors, weighted by
`Doctor.sessions_per_week` and pro-rated by the employment window -- live in
`app/leave_entitlement.py` and need no row at all: a doctor with no row for a
year gets exactly the rule figure. A row exists only to record a deviation
from the rules, which is why every column on it is optional or defaults to
zero:

- `entitlement_sessions` **overrides** the rule figure outright. Null (the
  common case) means "use the rule", so a row created purely to carry leave
  over does not accidentally freeze the entitlement at whatever the rule
  happened to say on the day it was written.
- `carry_over_sessions` and `adjustment_sessions` are **added** to whichever
  base applies. Separate columns rather than one signed total because they
  answer different questions -- "how much came from last year" vs. "what was
  granted or docked this year" -- and an admin looking at a balance needs to
  see which. Both may be negative (leave taken in advance, or an over-carry
  clawed back).

No `used` or `remaining` column. Used leave is counted at read time from
`LeaveEntry` against the master template (`app/leave_charging.py`), and the
cost of that -- a historical total moves when the template is edited -- is
accepted. Storing an
override here does not change that; it is the *entitlement* side that is now
pinnable, which is what an admin needs to correct a wrong figure.
"""
from decimal import Decimal

from sqlalchemy import ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base

NOTES_MAX_LENGTH = 200


class LeaveEntitlement(Base):
    __tablename__ = "leave_entitlements"
    __table_args__ = (
        UniqueConstraint("doctor_id", "year", name="uq_leave_entitlement_doctor_year"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    # Calendar year the entitlement applies to. The leave year is 1 Jan to
    # 31 Dec, so a bare year is a complete key -- no start/end columns to
    # keep consistent with each other.
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    entitlement_sessions: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 1), nullable=True
    )
    carry_over_sessions: Mapped[Decimal] = mapped_column(
        Numeric(5, 1), nullable=False, default=Decimal("0.0")
    )
    adjustment_sessions: Mapped[Decimal] = mapped_column(
        Numeric(5, 1), nullable=False, default=Decimal("0.0")
    )
    notes: Mapped[str | None] = mapped_column(String(NOTES_MAX_LENGTH), nullable=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<LeaveEntitlement doctor={self.doctor_id} year={self.year}>"
