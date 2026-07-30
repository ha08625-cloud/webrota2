"""Model package: re-exports every ORM class and the enums.

Importing this package ensures all mappers are registered on Base.metadata,
which Alembic autogenerate and the seed scripts rely on.
"""
from .enums import (
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    ReceptionRole,
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
from .counter_snapshot import RotaClinicCounterSnapshot, RotaSystemCounterSnapshot
from .leave import LeaveEntry
from .extra_session import ExtraSessionEntry
from .duty import DutyAssignment
from .master_rota import MasterRotaTemplate, MasterRotaSession
from .staging import RotaStaging, RotaStagingSession
from .rota import RotaConfig, GeneratedRota, RotaSession
from .closure import PracticeClosure, RotaClosure
from .school import School, SchoolHoliday
from .bank_holidays import BANK_HOLIDAYS, BANK_HOLIDAYS_BY_KEY, BankHoliday
from .recurring_note import RecurringNote, RecurringNoteDoctor, RecurringNoteWeek
from .generation_log import RotaGenerationLogEntry
from .signature import DoctorSignature
from .user import User, UserSession
from .reception import (
    ReceptionStaff,
    ReceptionMasterSession,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionCoverageRule,
)

__all__ = [
    # enums
    "DoctorType", "RoomType", "Site", "Day", "Period", "DutyType",
    "RotaStatus", "SystemCounterType", "MasterSessionType",
    "SessionRole", "ReceptionRole",
    # models
    "Room", "Doctor", "DoctorPreferredRoom", "ClinicType", "ClinicTypeSchedule",
    "ClinicTypeDoctorEligibility", "ClinicTypeRoomEligibility", "ClinicCounter",
    "SystemCounter", "LeaveEntry", "ExtraSessionEntry", "DutyAssignment", "MasterRotaTemplate",
    "MasterRotaSession", "RotaStaging", "RotaStagingSession", "RotaConfig",
    "GeneratedRota", "RotaSession",
    "RotaClinicCounterSnapshot", "RotaSystemCounterSnapshot",
    "PracticeClosure", "RotaClosure", "RotaGenerationLogEntry",
    "School", "SchoolHoliday",
    "BANK_HOLIDAYS", "BANK_HOLIDAYS_BY_KEY", "BankHoliday",
    "RecurringNote", "RecurringNoteDoctor", "RecurringNoteWeek",
    "DoctorSignature", "User", "UserSession",
    "ReceptionStaff", "ReceptionMasterSession", "ReceptionRota",
    "ReceptionRotaSession", "ReceptionCoverageRule",
]