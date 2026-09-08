"""Plain-English descriptions for audit log rows.

The audit log stores HTTP shape -- method, templated route, path params,
body, status (see models/audit.py) -- because that is what survives
schema churn and needs no per-endpoint bookkeeping. It is also unreadable
to the person the log exists for. This module is the translation layer:
`(method, route)` is a stable key, so a lookup table turns
`PATCH /rota/{rota_id}/sessions/{session_id}` into "Changed a session in
rota 12".

The table lives here, backend-side, for one reason: `test_audit_descriptions
.py` walks the running app's route tree and fails if any non-GET route is
missing an entry. A new endpoint therefore cannot ship a row that reads as
"PATCH /whatever" -- the drift the middleware design exists to prevent,
reintroduced one layer up. Put the table in the frontend and nothing
catches that.

WORDING RULES
-------------
- Use the words the UI uses, not the words the code uses: "Committed",
  "Scrapped", "Rolled back", "Force-deleted" are the button labels on
  RotaDetailPage, so they are what the reader recognises.
- Describe the ATTEMPT, in the past tense, and let `outcome()` say whether
  it worked. "Signed in" beside an outcome of "Not allowed" reads as a
  failed sign-in; a summary that tried to encode success as well would
  need a second table keyed on status.
- Name the thing, not its id, where the sentence can. Ids that do appear
  come from `path_params` via `{placeholder}`; a missing one renders as
  "?" rather than raising.

WHAT THIS CANNOT DO
-------------------
Rows record what was *sent*, never what was there before, so a deletion
can only ever be "Deleted a leave entry" -- by the time anyone reads the
row, the entry naming whose leave it was is gone. Bulk endpoints stay
coarse for the same reason. Fixing either means capturing a summary at
write time in every endpoint, which is a much larger change and one that
can silently rot; this table cannot.
"""
from __future__ import annotations

from typing import Any


class _Params(dict):
    """Format mapping that renders an absent path param as "?"."""

    def __missing__(self, key: str) -> str:
        return "?"


# (method, router-local route) -> sentence template. `route` is what the
# audit row stores: the APIRouter's own prefix, but no /api/v1 (see
# models/audit.py). Keep this grouped by area and alphabetical within it,
# the same order the coverage test reports gaps in.
_DESCRIPTIONS: dict[tuple[str, str], str] = {
    # Sign-in and passwords
    ("POST", "/auth/login"): "Signed in",
    ("POST", "/auth/logout"): "Signed out",
    ("POST", "/auth/forgot-password"): "Asked for a password reset email",
    ("POST", "/auth/reset-password"): "Set a new password from a reset link",

    # Users and access
    ("POST", "/users"): "Added a user account",
    ("PATCH", "/users/me"): "Changed their own account details",
    ("PATCH", "/users/{user_id}"): "Changed a user account",

    # Doctors
    ("POST", "/doctors"): "Added a doctor",
    ("PATCH", "/doctors/{doctor_id}"): "Changed a doctor's details",
    ("DELETE", "/doctors/{doctor_id}"): "Permanently deleted a doctor",
    ("PUT", "/doctors/{doctor_id}/preferred-rooms"):
        "Changed a doctor's preferred rooms",
    ("POST", "/doctors/{doctor_id}/calendar-feed/rotate"):
        "Reissued a doctor's calendar feed link",

    # Clinic types and rooms
    ("POST", "/clinic-types"): "Added a clinic type",
    ("PUT", "/clinic-types/reorder"): "Reordered the clinic types",
    ("PUT", "/clinic-types/{clinic_type_id}"): "Replaced a clinic type",
    ("PATCH", "/clinic-types/{clinic_type_id}"): "Changed a clinic type",
    ("DELETE", "/clinic-types/{clinic_type_id}"): "Deleted a clinic type",

    # Leave
    ("POST", "/leave"): "Added a leave entry",
    ("POST", "/leave/bulk"): "Added leave across a date range",
    ("POST", "/leave/bulk-delete"): "Removed leave across a date range",
    ("DELETE", "/leave/{leave_id}"): "Deleted a leave entry",
    ("PUT", "/leave/entitlement/{doctor_id}"):
        "Set a doctor's leave entitlement",
    ("DELETE", "/leave/entitlement/{doctor_id}"):
        "Cleared a doctor's leave entitlement",
    ("POST", "/leave-planning/bulk"): "Saved changes on the leave planner",

    # Closures, school holidays, duty, extra sessions, notes
    ("POST", "/closures"): "Added a practice closure day",
    ("DELETE", "/closures/{closure_id}"): "Removed a practice closure day",
    ("PUT", "/closures/bank-holidays/{key}"):
        "Changed whether a bank holiday closes the practice",
    ("POST", "/schools"): "Added a school",
    ("PATCH", "/schools/{school_id}"): "Changed a school",
    ("DELETE", "/schools/{school_id}"): "Deleted a school",
    ("POST", "/schools/{school_id}/holidays"): "Added a school holiday",
    ("PATCH", "/schools/{school_id}/holidays/{holiday_id}"):
        "Changed a school holiday",
    ("DELETE", "/schools/{school_id}/holidays/{holiday_id}"):
        "Deleted a school holiday",
    ("POST", "/duty"): "Assigned a duty slot",
    ("DELETE", "/duty/{duty_id}"): "Removed a duty slot",
    ("PUT", "/duty/opening-balance"): "Set a duty opening balance",
    ("POST", "/extra-sessions"): "Added an extra session",
    ("DELETE", "/extra-sessions/{entry_id}"): "Removed an extra session",
    ("POST", "/recurring-notes"): "Added a recurring note",
    ("PUT", "/recurring-notes/{note_id}"): "Changed a recurring note",
    ("DELETE", "/recurring-notes/{note_id}"): "Deleted a recurring note",

    # Master template
    ("POST", "/master-rota/templates/{template_id}/sessions"):
        "Added a session to the master rota",
    ("PATCH", "/master-rota/templates/{template_id}/sessions/{session_id}"):
        "Changed a session on the master rota",
    ("DELETE", "/master-rota/templates/{template_id}/sessions/{session_id}"):
        "Removed a session from the master rota",

    # Staging (the editable copy taken before generating)
    ("POST", "/staging"): "Started a staging copy of the master rota",
    ("POST", "/staging/{staging_id}/complete"):
        "Generated a rota from the staging copy",
    ("POST", "/staging/{staging_id}/sessions"):
        "Added a session to the staging copy",
    ("PATCH", "/staging/{staging_id}/sessions/{session_id}"):
        "Changed a session in the staging copy",
    ("DELETE", "/staging/{staging_id}/sessions/{session_id}"):
        "Removed a session from the staging copy",
    ("POST", "/staging/{staging_id}/notes"):
        "Added a note to this rota run",
    ("PATCH", "/staging/{staging_id}/notes/{note_id}"):
        "Changed a note on this rota run",
    ("DELETE", "/staging/{staging_id}/notes/{note_id}"):
        "Removed a note from this rota run",
    ("DELETE", "/staging/{staging_id}"): "Abandoned the staging copy",

    # Clinical rota lifecycle and editing
    ("POST", "/rota/generate"): "Generated a new rota",
    ("POST", "/rota/{rota_id}/commit"): "Committed rota {rota_id}",
    ("POST", "/rota/{rota_id}/rollback-commit"):
        "Rolled back the commit of rota {rota_id}",
    ("POST", "/rota/{rota_id}/archive"): "Archived rota {rota_id}",
    ("POST", "/rota/{rota_id}/unarchive"): "Unarchived rota {rota_id}",
    ("DELETE", "/rota/{rota_id}"): "Scrapped draft rota {rota_id}",
    ("DELETE", "/rota/{rota_id}/force-delete"):
        "Force-deleted rota {rota_id}",
    ("PATCH", "/rota/{rota_id}/sessions/{session_id}"):
        "Changed a session in rota {rota_id}",
    ("POST", "/rota/{rota_id}/sessions/{session_id}/set-room"):
        "Moved a session to another room in rota {rota_id}",
    ("POST", "/rota/{rota_id}/sessions/{session_id}/set-role"):
        "Changed a session's role in rota {rota_id}",
    ("POST", "/rota/{rota_id}/swap-roles"):
        "Swapped two sessions' roles in rota {rota_id}",
    ("POST", "/rota/{rota_id}/swap-rooms"):
        "Swapped two sessions' rooms in rota {rota_id}",

    # Counters
    ("POST", "/counters/clinic/{counter_id}/reset"):
        "Reset one clinic counter",
    ("POST", "/counters/clinic/reset-all"): "Reset every clinic counter",
    ("POST", "/counters/system/{counter_id}/reset"):
        "Reset one system counter",
    ("POST", "/counters/system/reset-all"): "Reset every system counter",
    ("PUT", "/counters/clinic/opening-balance"):
        "Set a clinic counter opening balance",
    ("PUT", "/counters/system/{counter_id}/opening-balance"):
        "Set a system counter opening balance",

    # Reception
    ("POST", "/reception/staff"): "Added a reception staff member",
    ("PATCH", "/reception/staff/{staff_id}"):
        "Changed a reception staff member's details",
    ("DELETE", "/reception/staff/{staff_id}"):
        "Removed a reception staff member",
    ("POST", "/reception/master/sessions"):
        "Added a slot to the reception master template",
    ("PATCH", "/reception/master/sessions/{session_id}"):
        "Changed a slot on the reception master template",
    ("DELETE", "/reception/master/sessions/{session_id}"):
        "Removed a slot from the reception master template",
    ("POST", "/reception/rota"): "Created a reception day",
    ("POST", "/reception/rota/{rota_id}/assign"):
        "Ran the reception assignment for a day",
    ("POST", "/reception/rota/{rota_id}/sessions"):
        "Added a slot to a reception day",
    ("PATCH", "/reception/rota/{rota_id}/sessions/{session_id}"):
        "Changed a slot on a reception day",
    ("DELETE", "/reception/rota/{rota_id}/sessions/{session_id}"):
        "Removed a slot from a reception day",
    ("DELETE", "/reception/rota/{rota_id}"): "Deleted a reception day",
    ("POST", "/reception/leave"): "Added reception leave",
    ("POST", "/reception/leave/bulk"):
        "Added reception leave across a date range",
    ("POST", "/reception/leave/bulk-delete"):
        "Removed reception leave across a date range",
    ("DELETE", "/reception/leave/{leave_id}"): "Deleted a reception leave entry",

    # Signatures and the EOI tool
    ("POST", "/signatures/{doctor_id}"): "Uploaded a doctor's signature",
    ("DELETE", "/signatures/{doctor_id}"): "Deleted a doctor's signature",
    ("POST", "/signatures/{doctor_id}/apply"):
        "Applied a doctor's signature to a document",
    ("POST", "/eoi/fill"): "Autofilled a study expression-of-interest form",
}


def describe(
    method: str,
    route: str | None,
    path_params: dict[str, Any] | None = None,
) -> str:
    """A plain-English sentence for one audit row.

    Falls back to the raw method and route rather than inventing a
    sentence: an unmapped route means the coverage test was skipped or a
    request matched nothing at all (a 404, where `route` is None), and
    silently rendering "Did something" would hide that.
    """
    template = _DESCRIPTIONS.get((method.upper(), route or ""))
    if template is None:
        return f"{method.upper()} {route}" if route else f"{method.upper()} (unknown page)"
    return template.format_map(_Params(path_params or {}))


def outcome(status_code: int) -> str:
    """The HTTP status as something a non-technical reader can act on.

    Deliberately coarse. The exact code and the server's own message stay
    on the row and are shown in the expanded detail, so nothing is lost by
    the summary being four buckets wide.
    """
    if 200 <= status_code < 400:
        return "Done"
    if status_code in (401, 403):
        return "Not allowed"
    if status_code == 404:
        return "Not found"
    if 400 <= status_code < 500:
        return "Rejected"
    if status_code >= 500:
        return "System error"
    # status_code 0 is the middleware's "no response was started" marker.
    return "Unknown"
