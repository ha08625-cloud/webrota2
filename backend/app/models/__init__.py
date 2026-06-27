"""Model package: re-exports every ORM class and the enums.

Importing this package ensures all mappers are registered on Base.metadata,
which Alembic autogenerate and the seed scripts rely on.
"""
from .enums import (
    ClinicCounterMode,
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    RoomType,
    RotaStatus,
    SessionRole,
    Site,
    SystemCounterType,
)
from .room import Room
from .doctor import Doctor, DoctorPreferredRoom
from .clinic_type import (
    ClinicType,
    ClinicTypeSchedule,
    ClinicTypeDoctorEligibility,
    ClinicTypeRoomEligibility,
)
from .counter import ClinicCounter, SystemCounter
from .leave import LeaveEntry
from .duty import DutyAssignment
from .master_rota import MasterRotaTemplate, MasterRotaSession
from .rota import RotaConfig, GeneratedRota, RotaSession

__all__ = [
    # enums
    "DoctorType", "RoomType", "Site", "Day", "Period", "DutyType",
    "RotaStatus", "SystemCounterType", "ClinicCounterMode", "MasterSessionType",
    "SessionRole",
    # models
    "Room", "Doctor", "DoctorPreferredRoom", "ClinicType", "ClinicTypeSchedule",
    "ClinicTypeDoctorEligibility", "ClinicTypeRoomEligibility", "ClinicCounter",
    "SystemCounter", "LeaveEntry", "DutyAssignment", "MasterRotaTemplate",
    "MasterRotaSession", "RotaConfig", "GeneratedRota", "RotaSession",
]
