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
from .extra_session import ExtraSessionIn, ExtraSessionOut
from .blocked import BlockedOut
from .leave import (
    LeaveBulkDeleteIn,
    LeaveBulkDeleteOut,
    LeaveBulkIn,
    LeaveBulkOut,
    LeaveBulkSkippedOut,
    LeaveChargeableCountOut,
    LeaveExemptionsOut,
    LeaveIn,
    LeaveOut,
)
from .leave_entitlement import (
    LeaveEntitlementIn,
    LeaveEntitlementOut,
    LeaveEntitlementYearOut,
)
from .leave_planning import (
    CoverageSlotOut,
    PlanningActionIn,
    PlanningBulkIn,
    PlanningBulkOut,
    PlanningSkippedOut,
)
from .duty import DutyIn, DutyOut, DutyCountOut
from .closure import BankHolidayOut, BankHolidaySetIn, ClosedSlotOut, ClosureIn, ClosureOut
from .room import RoomOut
from .counter import ClinicCounterOut, SystemCounterOut
from .master_rota import (
    MasterRotaSessionOut,
    MasterRotaTemplateOut,
    MasterSessionCreateIn,
    MasterSessionPatchIn,
    MasterSessionWriteOut,
)
from .staging import (
    StagingCreateIn,
    StagingOut,
    StagingSessionCreateIn,
    StagingSessionOut,
    StagingSessionPatchIn,
    StagingSessionWriteOut,
)
from .school import SchoolHolidayIn, SchoolHolidayOut, SchoolIn, SchoolOut
from .signature import SignatureMetaOut
from .auth import LoginIn, LoginOut, UserIn, UserOut, UserPatch, UserSelfPatch
from .audit import AuditLogEntryOut, AuditLogListOut
from .recurring_note import RecurringNoteIn, RecurringNoteOut
from .reception import (
    ReceptionCounterRowOut,
    ReceptionCountersOut,
    ReceptionLeaveBulkDeleteIn,
    ReceptionLeaveBulkDeleteOut,
    ReceptionLeaveBulkIn,
    ReceptionLeaveBulkOut,
    ReceptionLeaveIn,
    ReceptionLeaveOut,
    ReceptionMasterSessionCreateIn,
    ReceptionMasterSessionOut,
    ReceptionMasterSessionPatchIn,
    ReceptionRotaGenerateIn,
    ReceptionRotaOut,
    ReceptionRotaSessionIn,
    ReceptionRotaSessionOut,
    ReceptionRotaSessionPatchIn,
    ReceptionSessionWriteOut,
    ReceptionStaffDeletedCounts,
    ReceptionStaffDeleteOut,
    ReceptionStaffIn,
    ReceptionStaffOut,
    ReceptionStaffPatch,
    ReceptionStaffUsageOut,
)

__all__ = [
    "ValidationIssueOut",
    "GenerateRotaIn", "GenerateRotaOut", "GenerationLogEntryOut", "RotaOut", "RotaSessionOut",
    "RotaSummaryOut", "SessionPatchIn", "SessionPatchOut",
    "SwapIn", "SwapOut", "SetRoomIn", "SetRoomOut", "SetRoleIn", "SetRoleOut",
    "ClinicTypeIn", "ClinicTypeOut", "ClinicTypePatch", "ClinicTypeReorderIn", "DoctorEligIn", "DoctorEligOut",
    "RoomEligIn", "RoomEligOut", "ScheduleIn", "ScheduleOut",
    "DoctorDetailOut", "DoctorIn", "DoctorOut", "DoctorPatch",
    "PreferredRoomIn", "PreferredRoomOut",
    "ExtraSessionIn", "ExtraSessionOut", "BlockedOut",
    "LeaveIn", "LeaveOut",
    "LeaveEntitlementIn", "LeaveEntitlementOut", "LeaveEntitlementYearOut",
    "LeaveBulkIn", "LeaveBulkOut", "LeaveBulkSkippedOut",
    "LeaveBulkDeleteIn", "LeaveBulkDeleteOut",
    "LeaveChargeableCountOut", "LeaveExemptionsOut",
    "CoverageSlotOut", "PlanningActionIn", "PlanningBulkIn", "PlanningBulkOut",
    "PlanningSkippedOut",
    "DutyIn", "DutyOut", "DutyCountOut",
    "ClosureIn", "ClosureOut", "ClosedSlotOut", "BankHolidayOut", "BankHolidaySetIn",
    "RoomOut", "ClinicCounterOut", "SystemCounterOut",
    "MasterRotaSessionOut", "MasterRotaTemplateOut",
    "MasterSessionPatchIn", "MasterSessionCreateIn", "MasterSessionWriteOut",
    "StagingCreateIn", "StagingOut", "StagingSessionOut",
    "StagingSessionPatchIn", "StagingSessionCreateIn", "StagingSessionWriteOut",
    "SignatureMetaOut",
    "SchoolIn", "SchoolOut", "SchoolHolidayIn", "SchoolHolidayOut",
    "LoginIn", "LoginOut", "UserOut", "UserIn", "UserPatch", "UserSelfPatch",
    "AuditLogEntryOut", "AuditLogListOut",
    "RecurringNoteIn", "RecurringNoteOut",
    "ReceptionStaffIn", "ReceptionStaffOut", "ReceptionStaffPatch",
    "ReceptionStaffUsageOut", "ReceptionStaffDeleteOut",
    "ReceptionStaffDeletedCounts",
    "ReceptionMasterSessionOut", "ReceptionMasterSessionCreateIn",
    "ReceptionMasterSessionPatchIn",
    "ReceptionRotaGenerateIn", "ReceptionRotaOut", "ReceptionRotaSessionIn",
    "ReceptionRotaSessionOut", "ReceptionRotaSessionPatchIn",
    "ReceptionSessionWriteOut",
    "ReceptionLeaveIn", "ReceptionLeaveOut", "ReceptionLeaveBulkIn",
    "ReceptionLeaveBulkOut", "ReceptionLeaveBulkDeleteIn",
    "ReceptionLeaveBulkDeleteOut",
    "ReceptionCounterRowOut", "ReceptionCountersOut",
]