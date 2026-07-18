"""Pydantic schemas for the M3 API."""
from .common import ValidationIssueOut
from .rota import (
    GenerateRotaIn,
    GenerateRotaOut,
    GenerationLogEntryOut,
    RotaOut,
    RotaSessionOut,
    RotaSummaryOut,
    SessionPatchIn,
    SessionPatchOut,
    SetRoleIn,
    SetRoleOut,
    SetRoomIn,
    SetRoomOut,
    SwapIn,
    SwapOut,
)
from .clinic_type import (
    ClinicTypeIn,
    ClinicTypeOut,
    ClinicTypePatch,
    ClinicTypeReorderIn,
    DoctorEligIn,
    DoctorEligOut,
    RoomEligIn,
    RoomEligOut,
    ScheduleIn,
    ScheduleOut,
)
from .doctor import (
    DoctorDetailOut,
    DoctorIn,
    DoctorOut,
    DoctorPatch,
    PreferredRoomIn,
    PreferredRoomOut,
)
from .leave import (
    LeaveBulkDeleteIn,
    LeaveBulkDeleteOut,
    LeaveBulkIn,
    LeaveBulkOut,
    LeaveBulkSkippedOut,
    LeaveIn,
    LeaveOut,
)
from .duty import DutyIn, DutyOut, DutyCountOut
from .closure import ClosureIn, ClosureOut
from .room import RoomOut
from .counter import ClinicCounterOut, SystemCounterOut
from .master_rota import (
    MasterRotaSessionOut,
    MasterRotaTemplateOut,
    MasterSessionCreateIn,
    MasterSessionPatchIn,
    MasterSessionWriteOut,
)
from .signature import SignatureMetaOut
from .auth import LoginIn, LoginOut, UserOut

__all__ = [
    "ValidationIssueOut",
    "GenerateRotaIn", "GenerateRotaOut", "GenerationLogEntryOut", "RotaOut", "RotaSessionOut",
    "RotaSummaryOut", "SessionPatchIn", "SessionPatchOut",
    "SwapIn", "SwapOut", "SetRoomIn", "SetRoomOut", "SetRoleIn", "SetRoleOut",
    "ClinicTypeIn", "ClinicTypeOut", "ClinicTypePatch", "ClinicTypeReorderIn", "DoctorEligIn", "DoctorEligOut",
    "RoomEligIn", "RoomEligOut", "ScheduleIn", "ScheduleOut",
    "DoctorDetailOut", "DoctorIn", "DoctorOut", "DoctorPatch",
    "PreferredRoomIn", "PreferredRoomOut",
    "LeaveIn", "LeaveOut",
    "LeaveBulkIn", "LeaveBulkOut", "LeaveBulkSkippedOut",
    "LeaveBulkDeleteIn", "LeaveBulkDeleteOut",
    "DutyIn", "DutyOut", "DutyCountOut",
    "ClosureIn", "ClosureOut",
    "RoomOut", "ClinicCounterOut", "SystemCounterOut",
    "MasterRotaSessionOut", "MasterRotaTemplateOut",
    "MasterSessionPatchIn", "MasterSessionCreateIn", "MasterSessionWriteOut",
    "SignatureMetaOut",
    "LoginIn", "LoginOut", "UserOut",
]
