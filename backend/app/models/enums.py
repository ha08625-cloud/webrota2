"""Enumerations shared across the data layer.

These are plain Python str-enums. `enum_col()` wraps one for use as a SQLAlchemy
column type, storing the enum *value* (e.g. "Partner", "AM", "shared") rather
than the member name, so the database holds the documented strings.
"""
import enum
import re

from sqlalchemy import Enum as SAEnum


class DoctorType(str, enum.Enum):
    PARTNER = "Partner"
    SALARIED = "Salaried"
    TRAINEE = "Trainee"
    AHP = "AHP"


class RoomType(str, enum.Enum):
    D = "D"
    C = "C"
    W = "W"
    SR = "SR"


class Site(str, enum.Enum):
    SHC = "SHC"
    CUTTESLOWE = "Cutteslowe"
    WOLVERCOTE = "Wolvercote"


class Day(str, enum.Enum):
    MONDAY = "Monday"
    TUESDAY = "Tuesday"
    WEDNESDAY = "Wednesday"
    THURSDAY = "Thursday"
    FRIDAY = "Friday"


class Period(str, enum.Enum):
    AM = "AM"
    PM = "PM"


class DutyType(str, enum.Enum):
    PRIMARY = "primary"
    SECONDARY = "secondary"


class RotaStatus(str, enum.Enum):
    DRAFT = "draft"
    COMMITTED = "committed"


class SystemCounterType(str, enum.Enum):
    ROOM_MOVE = "room_move"
    SUPERVISION = "supervision"


class MasterSessionType(str, enum.Enum):
    REQUIRES_ROOM = "requires_room"
    NO_SURGERY = "no_surgery"
    ADMIN_TIME = "admin_time"
    PRE_ASSIGNED = "pre_assigned"
    WFH = "wfh"


class SessionRole(str, enum.Enum):
    DUTY_PRIMARY = "duty_primary"
    DUTY_SECONDARY = "duty_secondary"
    CLINIC = "clinic"


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def enum_col(py_enum: type[enum.Enum]) -> SAEnum:
    """Build a SQLAlchemy Enum column type that stores enum values.

    Uses a stable lowercase type name (matters for the Postgres native enum
    type; ignored by SQLite, which renders a VARCHAR + CHECK).
    """
    return SAEnum(
        py_enum,
        name=_snake(py_enum.__name__),
        values_callable=lambda e: [member.value for member in e],
    )