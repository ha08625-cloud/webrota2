"""POST/GET/PATCH/POST/DELETE /staging (staging plan, Task 3).

Covers: create's week-copy math for template_start_week=1 and a
mid-cycle start_week, create's four 409 locks (draft, active staging,
committed overlap, active-template count), GET /staging/active's 404 and
its is_on_leave/closed_slots derivation, PATCH displacement (including
the PRE_ASSIGNED -> REQUIRES_ROOM demotion), the completed-staging 409 on
PATCH/POST/DELETE, session POST's week-range 422 and duplicate-slot 409,
abandon's cascade plus the fresh-create-after-abandon path, and (Task 4)
complete's happy path, its Phase 0 failure-and-retry path, its lock
interactions with the draft/generate lifecycle, and the completed-staging
non-resurrection regression. Annual leave planning (Task 2) adds create's
doctor-employment-window skip, over both the template copy loop and the
extra-session new-row branch. The recurring-notes picker plan (Task 3)
adds the per-run note endpoints at the foot of the file.
"""
import datetime

from sqlalchemy import select

from app.models import (
    Doctor,
    DutyAssignment,
    GeneratedRota,
    LeaveEntry,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
    RotaConfig,
    RotaConfigNote,
    RotaConfigNoteDoctor,
    RotaStaging,
    RotaStagingSession,
)
from app.models.enums import (
    Day,
    DoctorType,
    DutyType,
    MasterSessionType,
    Period,
    RotaStatus,
)

from .conftest import MONDAY, generate_rota


def _create_staging(client, start_date=MONDAY, num_weeks=1, template_start_week=1):
    return client.post("/api/v1/staging", json={
        "start_date": start_date.isoformat(),
        "num_weeks": num_weeks,
        "template_start_week": template_start_week,
    })


def _sessions_by_key(staging_json):
    return {
        (s["doctor_code"], s["week"], s["day"], s["period"]): s
        for s in staging_json["sessions"]
    }


# ---------------------------------------------------------------------------
# create: week-copy math
# ---------------------------------------------------------------------------

def test_create_copies_template_week_1_by_default(client, seeded):
    resp = _create_staging(client, num_weeks=1)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["num_weeks"] == 1
    by_key = _sessions_by_key(body)
    assert ("AA", 1, "Monday", "AM") in by_key
    assert ("BB", 1, "Monday", "PM") in by_key

    active = client.get("/api/v1/staging/active").json()
    assert active["staging_id"] == body["staging_id"]


def test_create_with_mid_cycle_start_week_copies_correct_template_weeks(
    client, db_session, seeded
):
    # Add template rows at week 3 and 4 for doctor AA so a
    # template_start_week=3, num_weeks=2 staging has something distinctive
    # to copy: week 3 -> staging week 1, week 4 -> staging week 2.
    s = db_session
    template_id = seeded["template"]
    s.add(MasterRotaSession(
        template_id=template_id, doctor_id=seeded["doctor_aa"], week=3,
        day=Day.TUESDAY, period=Period.AM,
        session_type=MasterSessionType.REQUIRES_ROOM,
    ))
    s.add(MasterRotaSession(
        template_id=template_id, doctor_id=seeded["doctor_aa"], week=4,
        day=Day.WEDNESDAY, period=Period.AM,
        session_type=MasterSessionType.REQUIRES_ROOM,
    ))
    s.commit()

    resp = _create_staging(client, num_weeks=2, template_start_week=3)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    by_key = _sessions_by_key(body)
    assert ("AA", 1, "Tuesday", "AM") in by_key
    assert ("AA", 2, "Wednesday", "AM") in by_key
    # the original week-3/4 keys must not appear as staging weeks 3/4 --
    # only 1 and 2 exist for a 2-week staging
    assert not any(k[1] > 2 for k in by_key)


def test_create_persists_template_start_week_1_on_config(client, db_session, seeded):
    resp = _create_staging(client, num_weeks=2, template_start_week=3)
    assert resp.status_code == 201, resp.text
    staging_id = resp.json()["staging_id"]
    staging = db_session.get(RotaStaging, staging_id)
    config = db_session.get(RotaConfig, staging.config_id)
    assert config.template_start_week == 1


# ---------------------------------------------------------------------------
# create: locks
# ---------------------------------------------------------------------------

def test_create_409s_with_zero_active_templates(client, db_session, seeded):
    template = db_session.get(MasterRotaTemplate, seeded["template"])
    template.is_active = False
    db_session.commit()

    resp = _create_staging(client)
    assert resp.status_code == 409, resp.text


def test_create_409s_with_two_active_templates(client, db_session, seeded):
    db_session.add(MasterRotaTemplate(name="Second", is_active=True))
    db_session.commit()

    resp = _create_staging(client)
    assert resp.status_code == 409, resp.text


def test_create_409s_when_draft_exists(client, seeded):
    generate_rota(client)
    resp = _create_staging(client, start_date=MONDAY + datetime.timedelta(days=14))
    assert resp.status_code == 409, resp.text


def test_second_create_409s_while_staging_active(client, seeded):
    first = _create_staging(client)
    assert first.status_code == 201, first.text

    second = _create_staging(client, start_date=MONDAY + datetime.timedelta(days=14))
    assert second.status_code == 409, second.text


def test_create_409s_on_committed_overlap(client, db_session, seeded):
    gen = generate_rota(client)
    rota = db_session.get(GeneratedRota, gen["rota_id"])
    rota.status = RotaStatus.COMMITTED
    rota.committed_at = datetime.datetime.now(datetime.timezone.utc)
    db_session.commit()

    resp = _create_staging(client)
    assert resp.status_code == 409, resp.text


# ---------------------------------------------------------------------------
# GET /staging/active
# ---------------------------------------------------------------------------

def test_get_active_404s_when_none(client, seeded):
    resp = client.get("/api/v1/staging/active")
    assert resp.status_code == 404, resp.text


def test_get_active_reports_leave_and_closed_slots(client, db_session, seeded):
    monday = MONDAY
    db_session.add(LeaveEntry(
        doctor_id=seeded["doctor_aa"], date=monday, period=Period.AM,
    ))
    db_session.add(PracticeClosure(date=monday, period=Period.PM, name="Bank holiday"))
    db_session.commit()

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    body = resp.json()

    by_key = _sessions_by_key(body)
    aa_am = by_key[("AA", 1, "Monday", "AM")]
    assert aa_am["is_on_leave"] is True
    bb_pm = by_key[("BB", 1, "Monday", "PM")]
    assert bb_pm["is_on_leave"] is False

    assert body["closed_slots"] == [{"date": monday.isoformat(), "period": "PM"}]


# ---------------------------------------------------------------------------
# create: extra session override table (extra sessions plan, Task 2)
# ---------------------------------------------------------------------------

TUESDAY = MONDAY + datetime.timedelta(days=1)
WEDNESDAY = MONDAY + datetime.timedelta(days=2)


def _plan_extra_session(client, doctor_id, date, period="AM"):
    resp = client.post("/api/v1/extra-sessions", json={
        "doctor_id": doctor_id, "date": date.isoformat(), "period": period,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_override_no_surgery_becomes_requires_room(client, db_session, seeded):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
    ))
    db_session.commit()
    _plan_extra_session(client, seeded["doctor_aa"], TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "requires_room"
    assert row["room_id"] is None
    assert row["is_extra_session"] is True


def test_override_admin_time_without_room_becomes_requires_room(
    client, db_session, seeded
):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM, session_type=MasterSessionType.ADMIN_TIME,
    ))
    db_session.commit()
    _plan_extra_session(client, seeded["doctor_aa"], TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "requires_room"
    assert row["room_id"] is None
    assert row["is_extra_session"] is True


def test_override_admin_time_with_room_becomes_pre_assigned(
    client, db_session, seeded
):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM, session_type=MasterSessionType.ADMIN_TIME,
        room_id=seeded["room_c1"],
    ))
    db_session.commit()
    _plan_extra_session(client, seeded["doctor_aa"], TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "pre_assigned"
    assert row["room_id"] == seeded["room_c1"]
    assert row["is_extra_session"] is True


def test_override_wfh_becomes_requires_room(client, db_session, seeded):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM, session_type=MasterSessionType.WFH,
    ))
    db_session.commit()
    _plan_extra_session(client, seeded["doctor_aa"], TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "requires_room"
    assert row["room_id"] is None
    assert row["is_extra_session"] is True


def test_missing_template_row_creates_new_requires_room_session(
    client, db_session, seeded
):
    # No MasterRotaSession row at all for AA/Wednesday/AM.
    _plan_extra_session(client, seeded["doctor_aa"], WEDNESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Wednesday", "AM")]
    assert row["session_type"] == "requires_room"
    assert row["room_id"] is None
    assert row["is_extra_session"] is True


def test_pre_assigned_template_row_untouched_by_extra_session(
    client, db_session, seeded
):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM, session_type=MasterSessionType.PRE_ASSIGNED,
        room_id=seeded["room_c1"],
    ))
    db_session.commit()
    _plan_extra_session(client, seeded["doctor_aa"], TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "pre_assigned"
    assert row["room_id"] == seeded["room_c1"]
    assert row["is_extra_session"] is True


def test_requires_room_template_row_untouched_by_extra_session(
    client, db_session, seeded
):
    # seeded's AA/Monday/AM row is already REQUIRES_ROOM.
    _plan_extra_session(client, seeded["doctor_aa"], MONDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Monday", "AM")]
    assert row["session_type"] == "requires_room"
    assert row["room_id"] is None
    assert row["is_extra_session"] is True


def test_extra_session_on_leave_slot_leaves_row_untouched(client, db_session, seeded):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
    ))
    db_session.commit()
    # Extra session planned first, leave added afterwards -- the ordering
    # case the /extra-sessions POST's own leave check cannot catch.
    _plan_extra_session(client, seeded["doctor_aa"], TUESDAY)
    db_session.add(LeaveEntry(
        doctor_id=seeded["doctor_aa"], date=TUESDAY, period=Period.AM,
    ))
    db_session.commit()

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    row = _sessions_by_key(resp.json())[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "no_surgery"
    assert row["is_on_leave"] is True


def test_extra_session_with_no_template_row_skipped_when_on_leave(
    client, db_session, seeded
):
    # No template row, and leave supersedes
    # the planned extra session -- no staged row should be created at all.
    _plan_extra_session(client, seeded["doctor_aa"], WEDNESDAY)
    db_session.add(LeaveEntry(
        doctor_id=seeded["doctor_aa"], date=WEDNESDAY, period=Period.AM,
    ))
    db_session.commit()

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    by_key = _sessions_by_key(resp.json())
    assert ("AA", 1, "Wednesday", "AM") not in by_key


def test_extra_session_outside_staging_range_does_not_appear(
    client, db_session, seeded
):
    far_date = MONDAY + datetime.timedelta(days=21)
    _plan_extra_session(client, seeded["doctor_aa"], far_date)

    resp = _create_staging(client, num_weeks=1)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert all(s["is_extra_session"] is False for s in body["sessions"])


# ---------------------------------------------------------------------------
# create: doctor employment window (annual leave planning, Task 2, DD 7)
# ---------------------------------------------------------------------------

def _set_window(db_session, doctor_id, start_date=None, end_date=None):
    doctor = db_session.get(Doctor, doctor_id)
    doctor.start_date = start_date
    doctor.end_date = end_date
    db_session.commit()


def test_out_of_window_doctor_rows_are_not_copied(client, db_session, seeded):
    _set_window(db_session, seeded["doctor_aa"], start_date=TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    by_key = _sessions_by_key(resp.json())
    # AA's only template rows are Monday AM/PM, before their start date.
    assert ("AA", 1, "Monday", "AM") not in by_key
    assert ("AA", 1, "Monday", "PM") not in by_key
    # BB has no window and is untouched.
    assert ("BB", 1, "Monday", "AM") in by_key


def test_window_is_applied_per_date_not_per_doctor(client, db_session, seeded):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM,
        session_type=MasterSessionType.REQUIRES_ROOM,
    ))
    db_session.commit()
    _set_window(db_session, seeded["doctor_aa"], start_date=TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    by_key = _sessions_by_key(resp.json())
    assert ("AA", 1, "Monday", "AM") not in by_key  # before start_date
    assert ("AA", 1, "Tuesday", "AM") in by_key     # on start_date (inclusive)


def test_out_of_window_extra_session_creates_no_row(client, db_session, seeded):
    # Planned while the window still allowed it, then the window narrowed --
    # the ordering the /extra-sessions POST's own 422 cannot catch.
    _plan_extra_session(client, seeded["doctor_aa"], WEDNESDAY)
    _set_window(db_session, seeded["doctor_aa"], end_date=TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    assert ("AA", 1, "Wednesday", "AM") not in _sessions_by_key(resp.json())


def test_out_of_window_extra_session_does_not_resurrect_a_skipped_template_row(
    client, db_session, seeded
):
    # An extra session on a slot whose template row the window skip dropped
    # must not fall through to the no-template-row branch and reinstate it.
    _plan_extra_session(client, seeded["doctor_aa"], MONDAY)
    _set_window(db_session, seeded["doctor_aa"], start_date=TUESDAY)

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    assert ("AA", 1, "Monday", "AM") not in _sessions_by_key(resp.json())


def test_is_extra_session_survives_patch_editing_cell_back(client, db_session, seeded):
    db_session.add(MasterRotaSession(
        template_id=seeded["template"], doctor_id=seeded["doctor_aa"], week=1,
        day=Day.TUESDAY, period=Period.AM, session_type=MasterSessionType.NO_SURGERY,
    ))
    db_session.commit()
    _plan_extra_session(client, seeded["doctor_aa"], TUESDAY)

    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    row = _sessions_by_key(resp.json())[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "requires_room"

    patch = client.patch(
        f"/api/v1/staging/{staging_id}/sessions/{row['session_id']}",
        json={"session_type": "no_surgery", "room_id": None},
    )
    assert patch.status_code == 200, patch.text
    # Looks wrong at a glance -- is_extra_session means "a planned extra
    # session exists here", not "the override produced this row", so it
    # stays True even though the admin edited the cell back to
    # NO_SURGERY.
    assert patch.json()["session"]["is_extra_session"] is True

    active = client.get("/api/v1/staging/active").json()
    row = _sessions_by_key(active)[("AA", 1, "Tuesday", "AM")]
    assert row["session_type"] == "no_surgery"
    assert row["is_extra_session"] is True


# ---------------------------------------------------------------------------
# PATCH: displacement
# ---------------------------------------------------------------------------

def test_patch_displacement_clears_holder_and_demotes_pre_assigned(
    client, db_session, seeded
):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    by_key = _sessions_by_key(resp.json())

    holder = by_key[("AA", 1, "Monday", "AM")]
    target = by_key[("BB", 1, "Monday", "AM")]

    # Give the holder the room via a direct PATCH first, then set it as
    # PRE_ASSIGNED so displacement's demotion path is exercised.
    room_id = seeded["room_c1"]
    patch = client.patch(
        f"/api/v1/staging/{staging_id}/sessions/{holder['session_id']}",
        json={"session_type": "pre_assigned", "room_id": room_id},
    )
    assert patch.status_code == 200, patch.text

    steal = client.patch(
        f"/api/v1/staging/{staging_id}/sessions/{target['session_id']}",
        json={"session_type": "pre_assigned", "room_id": room_id},
    )
    assert steal.status_code == 200, steal.text
    body = steal.json()
    assert body["session"]["room_id"] == room_id
    assert body["displaced_session"]["session_id"] == holder["session_id"]
    assert body["displaced_session"]["room_id"] is None
    assert body["displaced_session"]["session_type"] == "requires_room"


def test_patch_409s_on_completed_staging(client, db_session, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    session_id = resp.json()["sessions"][0]["session_id"]

    staging = db_session.get(RotaStaging, staging_id)
    staging.completed_at = datetime.datetime.now(datetime.timezone.utc)
    db_session.commit()

    patch = client.patch(
        f"/api/v1/staging/{staging_id}/sessions/{session_id}",
        json={"session_type": "no_surgery", "room_id": None},
    )
    assert patch.status_code == 409, patch.text


def test_post_and_delete_409_on_completed_staging(client, db_session, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    session_id = resp.json()["sessions"][0]["session_id"]

    staging = db_session.get(RotaStaging, staging_id)
    staging.completed_at = datetime.datetime.now(datetime.timezone.utc)
    db_session.commit()

    create = client.post(
        f"/api/v1/staging/{staging_id}/sessions",
        json={
            "doctor_id": seeded["doctor_aa"], "week": 1, "day": "Tuesday",
            "period": "AM", "session_type": "no_surgery", "room_id": None,
        },
    )
    assert create.status_code == 409, create.text

    delete = client.delete(f"/api/v1/staging/{staging_id}/sessions/{session_id}")
    assert delete.status_code == 409, delete.text


# ---------------------------------------------------------------------------
# session POST: week range and duplicate slot
# ---------------------------------------------------------------------------

def test_session_post_422s_for_week_exceeding_staging_range(client, seeded):
    resp = _create_staging(client, num_weeks=1)
    staging_id = resp.json()["staging_id"]

    create = client.post(
        f"/api/v1/staging/{staging_id}/sessions",
        json={
            "doctor_id": seeded["doctor_aa"], "week": 2, "day": "Tuesday",
            "period": "AM", "session_type": "no_surgery", "room_id": None,
        },
    )
    assert create.status_code == 422, create.text


def test_session_post_409s_on_duplicate_slot(client, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]

    create = client.post(
        f"/api/v1/staging/{staging_id}/sessions",
        json={
            "doctor_id": seeded["doctor_aa"], "week": 1, "day": "Monday",
            "period": "AM", "session_type": "no_surgery", "room_id": None,
        },
    )
    assert create.status_code == 409, create.text


# ---------------------------------------------------------------------------
# abandon
# ---------------------------------------------------------------------------

def test_abandon_deletes_staging_sessions_and_config_then_allows_recreate(
    client, db_session, seeded
):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    config_id = resp.json()["config_id"]

    delete = client.delete(f"/api/v1/staging/{staging_id}")
    assert delete.status_code == 204, delete.text

    db_session.expire_all()
    assert db_session.get(RotaStaging, staging_id) is None
    assert db_session.get(RotaConfig, config_id) is None
    remaining_sessions = db_session.execute(
        select(RotaStagingSession).where(RotaStagingSession.staging_id == staging_id)
    ).scalars().all()
    assert remaining_sessions == []

    second = _create_staging(client)
    assert second.status_code == 201, second.text


def test_abandon_409s_on_completed_staging(client, db_session, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]

    staging = db_session.get(RotaStaging, staging_id)
    staging.completed_at = datetime.datetime.now(datetime.timezone.utc)
    db_session.commit()

    delete = client.delete(f"/api/v1/staging/{staging_id}")
    assert delete.status_code == 409, delete.text


# ---------------------------------------------------------------------------
# complete: happy path
# ---------------------------------------------------------------------------

def test_complete_happy_path(client, db_session, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    by_key = _sessions_by_key(resp.json())
    target = by_key[("AA", 1, "Monday", "AM")]

    patch = client.patch(
        f"/api/v1/staging/{staging_id}/sessions/{target['session_id']}",
        json={"session_type": "no_surgery", "room_id": None},
    )
    assert patch.status_code == 200, patch.text

    complete = client.post(f"/api/v1/staging/{staging_id}/complete")
    assert complete.status_code == 200, complete.text
    body = complete.json()
    assert body["status"] == "draft"
    rota_id = body["rota_id"]

    rota = client.get(f"/api/v1/rota/{rota_id}").json()
    aa_am = next(
        s for s in rota["sessions"]
        if s["doctor_code"] == "AA" and s["week"] == 1 and s["day"] == "Monday"
        and s["period"] == "AM"
    )
    assert aa_am["template_type"] == "no_surgery"

    db_session.expire_all()
    staging = db_session.get(RotaStaging, staging_id)
    assert staging.completed_at is not None
    still_exists = db_session.execute(
        select(RotaStagingSession).where(RotaStagingSession.staging_id == staging_id)
    ).scalars().all()
    assert still_exists  # staging rows retained, not deleted

    active = client.get("/api/v1/staging/active")
    assert active.status_code == 404, active.text


# ---------------------------------------------------------------------------
# complete: Phase 0 failure and retry
# ---------------------------------------------------------------------------

def test_complete_phase0_failure_survives_and_retry_succeeds(client, db_session, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    config_id = resp.json()["config_id"]
    by_key = _sessions_by_key(resp.json())
    target = by_key[("AA", 1, "Monday", "AM")]

    db_session.add(DutyAssignment(
        date=MONDAY, period=Period.AM, doctor_id=seeded["doctor_aa"],
        duty_type=DutyType.PRIMARY,
    ))
    db_session.commit()

    patch = client.patch(
        f"/api/v1/staging/{staging_id}/sessions/{target['session_id']}",
        json={"session_type": "no_surgery", "room_id": None},
    )
    assert patch.status_code == 200, patch.text

    fail = client.post(f"/api/v1/staging/{staging_id}/complete")
    assert fail.status_code == 422, fail.text
    checks = {i["check"] for i in fail.json()["detail"]}
    assert "duty_on_incompatible_slot" in checks

    db_session.expire_all()
    assert db_session.get(RotaStaging, staging_id) is not None
    assert db_session.get(RotaConfig, config_id) is not None
    active = client.get("/api/v1/staging/active")
    assert active.status_code == 200, active.text
    assert active.json()["staging_id"] == staging_id

    patch_back = client.patch(
        f"/api/v1/staging/{staging_id}/sessions/{target['session_id']}",
        json={"session_type": "requires_room", "room_id": None},
    )
    assert patch_back.status_code == 200, patch_back.text

    retry = client.post(f"/api/v1/staging/{staging_id}/complete")
    assert retry.status_code == 200, retry.text


# ---------------------------------------------------------------------------
# complete / generate: lock interactions
# ---------------------------------------------------------------------------

def test_generate_409s_while_staging_active(client, seeded):
    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text

    gen = client.post("/api/v1/rota/generate", json={
        "start_date": (MONDAY + datetime.timedelta(days=14)).isoformat(),
        "num_weeks": 1, "template_start_week": 1,
    })
    assert gen.status_code == 409, gen.text


def test_complete_409s_when_draft_exists_via_rollback(client, db_session, seeded):
    # Commit a rota on one range, start staging on a non-overlapping range,
    # then roll the committed rota back to draft -- this is the one path
    # that can produce a draft while a staging is in progress (create-time
    # only blocks direct /rota/generate).
    committed = generate_rota(client)
    rota = db_session.get(GeneratedRota, committed["rota_id"])
    rota.status = RotaStatus.COMMITTED
    rota.committed_at = datetime.datetime.now(datetime.timezone.utc)
    db_session.commit()

    staging = _create_staging(client, start_date=MONDAY + datetime.timedelta(days=14))
    assert staging.status_code == 201, staging.text
    staging_id = staging.json()["staging_id"]

    rollback = client.post(f"/api/v1/rota/{committed['rota_id']}/rollback-commit")
    assert rollback.status_code == 200, rollback.text

    complete = client.post(f"/api/v1/staging/{staging_id}/complete")
    assert complete.status_code == 409, complete.text


def test_complete_409s_on_completed_staging(client, db_session, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]

    staging = db_session.get(RotaStaging, staging_id)
    staging.completed_at = datetime.datetime.now(datetime.timezone.utc)
    db_session.commit()

    complete = client.post(f"/api/v1/staging/{staging_id}/complete")
    assert complete.status_code == 409, complete.text


def test_complete_409s_on_overlap_recheck(client, db_session, seeded):
    # Overlap did not exist at create time; a rota is committed into the
    # staging's own range afterwards, so only the complete-time re-check
    # catches it.
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    config_id = resp.json()["config_id"]

    other_config = RotaConfig(start_date=MONDAY, num_weeks=1, template_start_week=1)
    db_session.add(other_config)
    db_session.flush()
    db_session.add(GeneratedRota(
        config_id=other_config.id, status=RotaStatus.COMMITTED,
        committed_at=datetime.datetime.now(datetime.timezone.utc),
    ))
    db_session.commit()
    assert other_config.id != config_id

    complete = client.post(f"/api/v1/staging/{staging_id}/complete")
    assert complete.status_code == 409, complete.text


# ---------------------------------------------------------------------------
# post-complete lifecycle sanity
# ---------------------------------------------------------------------------

def test_scrap_after_complete_does_not_resurrect_staging(client, db_session, seeded):
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]

    complete = client.post(f"/api/v1/staging/{staging_id}/complete")
    assert complete.status_code == 200, complete.text
    rota_id = complete.json()["rota_id"]

    scrap = client.delete(f"/api/v1/rota/{rota_id}")
    assert scrap.status_code == 204, scrap.text

    active = client.get("/api/v1/staging/active")
    assert active.status_code == 404, active.text

    fresh = _create_staging(client, start_date=MONDAY + datetime.timedelta(days=14))
    assert fresh.status_code == 201, fresh.text

# ---------------------------------------------------------------------------
# per-run notes (recurring notes picker plan, Task 3)
# ---------------------------------------------------------------------------

def _make_definition(client, seeded, **overrides):
    payload = {
        "text": "Significant events meeting",
        "day": "Monday",
        "period": "PM",
        "is_active": True,
        "doctor_ids": [seeded["doctor_aa"]],
    }
    payload.update(overrides)
    resp = client.post("/api/v1/recurring-notes", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _note_payload(seeded, **overrides):
    payload = {
        "text": "Significant events meeting",
        "week": 1,
        "day": "Monday",
        "period": "PM",
        "doctor_ids": [seeded["doctor_aa"]],
    }
    payload.update(overrides)
    return payload


def test_note_create_patch_delete_round_trip(client, seeded):
    definition = _make_definition(client, seeded)
    staging_id = _create_staging(client).json()["staging_id"]

    created = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(seeded, source_note_id=definition["id"]),
    )
    assert created.status_code == 201, created.text
    notes = created.json()["notes"]
    assert len(notes) == 1
    note = notes[0]
    assert note["source_note_id"] == definition["id"]
    assert note["text"] == "Significant events meeting"
    assert note["week"] == 1
    assert note["doctor_ids"] == [seeded["doctor_aa"]]

    # The instance diverges from its definition without touching it.
    patched = client.patch(
        f"/api/v1/staging/{staging_id}/notes/{note['id']}",
        json=_note_payload(
            seeded,
            text="Significant events meeting (moved)",
            day="Wednesday",
            period="AM",
            doctor_ids=[seeded["doctor_aa"], seeded["doctor_bb"]],
        ),
    )
    assert patched.status_code == 200, patched.text
    edited = patched.json()["notes"][0]
    assert edited["text"] == "Significant events meeting (moved)"
    assert edited["day"] == "Wednesday"
    assert edited["period"] == "AM"
    assert edited["doctor_ids"] == sorted(
        [seeded["doctor_aa"], seeded["doctor_bb"]]
    )
    assert edited["source_note_id"] == definition["id"]  # provenance survives

    definition_now = client.get("/api/v1/recurring-notes").json()[0]
    assert definition_now["text"] == "Significant events meeting"
    assert definition_now["day"] == "Monday"

    assert client.delete(
        f"/api/v1/staging/{staging_id}/notes/{note['id']}"
    ).status_code == 204
    assert client.get("/api/v1/staging/active").json()["notes"] == []


def test_free_form_note_has_no_source(client, seeded):
    staging_id = _create_staging(client).json()["staging_id"]
    created = client.post(
        f"/api/v1/staging/{staging_id}/notes", json=_note_payload(seeded)
    )
    assert created.status_code == 201, created.text
    assert created.json()["notes"][0]["source_note_id"] is None


def test_notes_ordered_by_id_ascending(client, seeded):
    """Same order the engine concatenates overlapping notes in."""
    staging_id = _create_staging(client).json()["staging_id"]
    for text in ("Meeting A", "Meeting B", "Meeting C"):
        client.post(
            f"/api/v1/staging/{staging_id}/notes",
            json=_note_payload(seeded, text=text),
        )
    notes = client.get("/api/v1/staging/active").json()["notes"]
    assert [n["text"] for n in notes] == ["Meeting A", "Meeting B", "Meeting C"]
    assert [n["id"] for n in notes] == sorted(n["id"] for n in notes)


def test_note_week_beyond_num_weeks_422(client, seeded):
    """The 1..4 schema bound is necessary but not sufficient: week 2 on a
    1-week run is a silently dead note otherwise."""
    staging_id = _create_staging(client, num_weeks=1).json()["staging_id"]
    resp = client.post(
        f"/api/v1/staging/{staging_id}/notes", json=_note_payload(seeded, week=2)
    )
    assert resp.status_code == 422, resp.text
    assert "1-week range" in resp.json()["detail"]

    resp5 = client.post(
        f"/api/v1/staging/{staging_id}/notes", json=_note_payload(seeded, week=5)
    )
    assert resp5.status_code == 422


def test_note_patch_week_beyond_num_weeks_422(client, seeded):
    staging_id = _create_staging(client, num_weeks=1).json()["staging_id"]
    note = client.post(
        f"/api/v1/staging/{staging_id}/notes", json=_note_payload(seeded)
    ).json()["notes"][0]
    resp = client.patch(
        f"/api/v1/staging/{staging_id}/notes/{note['id']}",
        json=_note_payload(seeded, week=2),
    )
    assert resp.status_code == 422, resp.text


def test_note_unknown_and_inactive_doctor_422(client, db_session, seeded):
    inactive = Doctor(
        code="ZZ", doctor_type=DoctorType.PARTNER, sessions_per_week=10,
        active=False,
    )
    db_session.add(inactive)
    db_session.commit()
    inactive_id = inactive.id

    staging_id = _create_staging(client).json()["staging_id"]

    missing = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(seeded, doctor_ids=[999999]),
    )
    assert missing.status_code == 422
    assert "do not exist" in missing.json()["detail"]

    disabled = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(seeded, doctor_ids=[inactive_id]),
    )
    assert disabled.status_code == 422
    assert "not active" in disabled.json()["detail"]


def test_note_empty_and_duplicate_doctor_ids_422(client, seeded):
    staging_id = _create_staging(client).json()["staging_id"]
    empty = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(seeded, doctor_ids=[]),
    )
    assert empty.status_code == 422
    dupe = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(
            seeded, doctor_ids=[seeded["doctor_aa"], seeded["doctor_aa"]]
        ),
    )
    assert dupe.status_code == 422
    blank = client.post(
        f"/api/v1/staging/{staging_id}/notes", json=_note_payload(seeded, text="   ")
    )
    assert blank.status_code == 422


def test_note_unknown_source_note_id_422(client, seeded):
    staging_id = _create_staging(client).json()["staging_id"]
    resp = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(seeded, source_note_id=999999),
    )
    assert resp.status_code == 422, resp.text
    assert "source_note_id" in resp.json()["detail"]


def test_note_from_inactive_definition_is_accepted(client, seeded):
    """A definition deactivated between page load and submit must not fail
    the copy -- the instance never re-reads it."""
    definition = _make_definition(client, seeded, is_active=False)
    staging_id = _create_staging(client).json()["staging_id"]
    resp = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(seeded, source_note_id=definition["id"]),
    )
    assert resp.status_code == 201, resp.text


def test_note_from_another_staging_404s(client, seeded):
    first = _create_staging(client).json()["staging_id"]
    note = client.post(
        f"/api/v1/staging/{first}/notes", json=_note_payload(seeded)
    ).json()["notes"][0]
    client.delete(f"/api/v1/staging/{first}")

    second = _create_staging(client).json()["staging_id"]
    patch = client.patch(
        f"/api/v1/staging/{second}/notes/{note['id']}", json=_note_payload(seeded)
    )
    assert patch.status_code == 404, patch.text
    delete = client.delete(f"/api/v1/staging/{second}/notes/{note['id']}")
    assert delete.status_code == 404, delete.text


def test_note_writes_409_on_completed_staging(client, db_session, seeded):
    staging_id = _create_staging(client).json()["staging_id"]
    note = client.post(
        f"/api/v1/staging/{staging_id}/notes", json=_note_payload(seeded)
    ).json()["notes"][0]

    staging = db_session.get(RotaStaging, staging_id)
    staging.completed_at = datetime.datetime.now(datetime.timezone.utc)
    db_session.commit()

    assert client.post(
        f"/api/v1/staging/{staging_id}/notes", json=_note_payload(seeded)
    ).status_code == 409
    assert client.patch(
        f"/api/v1/staging/{staging_id}/notes/{note['id']}",
        json=_note_payload(seeded),
    ).status_code == 409
    assert client.delete(
        f"/api/v1/staging/{staging_id}/notes/{note['id']}"
    ).status_code == 409


def test_abandon_with_notes_cascades(client, db_session, seeded):
    """abandon_staging hard-deletes the RotaConfig; without the ORM cascade
    a picked note would make that an IntegrityError."""
    definition = _make_definition(client, seeded)
    resp = _create_staging(client)
    staging_id = resp.json()["staging_id"]
    config_id = resp.json()["config_id"]
    note = client.post(
        f"/api/v1/staging/{staging_id}/notes",
        json=_note_payload(seeded, source_note_id=definition["id"]),
    ).json()["notes"][0]

    delete = client.delete(f"/api/v1/staging/{staging_id}")
    assert delete.status_code == 204, delete.text

    db_session.expire_all()
    assert db_session.get(RotaConfig, config_id) is None
    assert db_session.get(RotaConfigNote, note["id"]) is None
    assert db_session.execute(
        select(RotaConfigNoteDoctor).where(
            RotaConfigNoteDoctor.config_note_id == note["id"]
        )
    ).scalars().all() == []
