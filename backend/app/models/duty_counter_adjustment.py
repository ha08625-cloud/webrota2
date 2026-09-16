"""DutyCounterAdjustment model.

One optional row per (doctor, year), the sibling of `LeaveEntitlement` and
keyed the same way for the same reason: the duty count the annual weighted
score divides is derived per calendar year (`GET /duty/counts` over a
`from_date`/`to_date` range), so an adjustment that outlived its year would
keep nudging someone whose count has since restarted -- and by the next 1
January every doctor is genuinely level again, because the count itself
restarts.

`adjustment` is a signed nudge in duty sessions, added to the counted duty
total before it is divided by `Doctor.sessions_per_week`. It exists for any
exceptional reason the raw count misrepresents a fair share: a doctor who
joins part-way through the year otherwise starts at zero, which reads as
"maximally under-loaded" and makes them the grid's suggested pick for weeks,
and a doctor returning from compassionate or long-term absence is in the
same position through no choice of their own. Ordinary annual leave is not
such a reason -- everyone has the same entitlement, so a heavy leave month
genuinely does leave a doctor under-loaded.

The figure that puts a joiner level with the group is
`peer_weighted_score x their_sessions_per_week` -- i.e. start them at the
group's current score rather than at zero -- which is why the nudge is
denominated in *duty* sessions rather than in the working sessions they
would have done: every counter in the system counts something far rarer
than the whole working week.

No row means a zero adjustment, so nothing has to be seeded and the common
case (a doctor who was here on 1 January and has had no exceptional absence)
carries no row at all. Negative values are allowed and deliberately not
constrained: the mirror case -- a doctor who was over-allocated earlier in
the year, or a leaver whose count should read as already served -- is real.
"""
from decimal import Decimal

from sqlalchemy import ForeignKey, Integer, Numeric, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class DutyCounterAdjustment(Base):
    __tablename__ = "duty_counter_adjustments"
    __table_args__ = (
        UniqueConstraint(
            "doctor_id", "year", name="uq_duty_counter_adjustment_doctor_year"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    # Calendar year the adjustment applies to. The duty count runs 1 Jan to
    # 31 Dec, so a bare year is a complete key -- no start/end columns to
    # keep consistent with each other.
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    adjustment: Mapped[Decimal] = mapped_column(
        Numeric(5, 1), nullable=False, default=Decimal("0.0"), server_default="0"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<DutyCounterAdjustment doctor={self.doctor_id} year={self.year}>"
