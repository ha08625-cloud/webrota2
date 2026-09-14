"""DoctorSignature model.

One signature image per Partner/Salaried doctor (though the schema itself
does not restrict doctor_type -- the UI filters to Partner/Salaried, but the
endpoints stay unscoped so an unusual case remains possible without a schema
change). Image bytes live in Postgres as bytea (SQLAlchemy LargeBinary);
there is no object storage, since volumes are small -- one small JPG/PNG per
doctor.

uploaded_at has no default at the model or DB level: it is set explicitly by
the upload router at write time (datetime.now(timezone.utc)), so the value
always comes from the request rather than an implicit default.

No back_populates on Doctor: this is a one-directional, optional attachment,
and Doctor itself is deliberately left untouched by this feature.
"""
import datetime

from sqlalchemy import DateTime, ForeignKey, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base


class DoctorSignature(Base):
    __tablename__ = "doctor_signatures"
    __table_args__ = (
        UniqueConstraint("doctor_id", name="uq_doctor_signatures_doctor_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    doctor_id: Mapped[int] = mapped_column(ForeignKey("doctors.id"), nullable=False)
    image: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    uploaded_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    doctor: Mapped["Doctor"] = relationship()  # type: ignore[name-defined]  # noqa: F821

    def __repr__(self) -> str:  # pragma: no cover
        return f"<DoctorSignature doctor_id={self.doctor_id} ({self.content_type})>"
