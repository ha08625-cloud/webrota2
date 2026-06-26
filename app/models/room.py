"""Room model: the 14 physical consulting rooms across the three sites."""
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .enums import RoomType, Site, enum_col


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    room_type: Mapped[RoomType] = mapped_column(enum_col(RoomType), nullable=False)
    site: Mapped[Site] = mapped_column(enum_col(Site), nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Room {self.code} ({self.room_type.value}/{self.site.value})>""""Room model: the 14 physical consulting rooms across the three sites."""
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base
from .enums import RoomType, Site, enum_col


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    room_type: Mapped[RoomType] = mapped_column(enum_col(RoomType), nullable=False)
    site: Mapped[Site] = mapped_column(enum_col(Site), nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Room {self.code} ({self.room_type.value}/{self.site.value})>"
