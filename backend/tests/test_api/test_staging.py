"""POST/GET/PATCH/POST/DELETE /staging (staging plan, Task 3).

Covers: create's week-copy math for template_start_week=1 and a
mid-cycle start_week, create's four 409 locks (draft, active staging,
committed overlap, active-template count), GET /staging/active's 404 and
its is_on_leave/closed_dates derivation, PATCH displacement (including
the PRE_ASSIGNED -> REQUIRES_ROOM demotion), the completed-staging 409 on
PATCH/POST/DELETE, session POST's week-range 422 and duplicate-slot 409,
abandon's cascade plus the fresh-create-after-abandon path, and (Task 4)
complete's happy path, its Phase 0 failure-and-retry path, its lock
interactions with the draft/generate lifecycle, and the completed-staging
non-resurrection regression.
"""
import datetime

from sqlalchemy import select

from app.models import (
    DutyAssignment,
    GeneratedRota,
    LeaveEntry,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
    RotaConfig,
    RotaStaging,
    RotaStagingSession,
)
from app.models.enums import (
    Day,
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


def test_get_active_reports_leave_and_closed_dates(client, db_session, seeded):
    monday = MONDAY
    db_session.add(LeaveEntry(
        doctor_id=seeded["doctor_aa"], date=monday, period=Period.AM,
    ))
    db_session.add(PracticeClosure(date=monday, name="Bank holiday"))
    db_session.commit()

    resp = _create_staging(client)
    assert resp.status_code == 201, resp.text
    body = resp.json()

    by_key = _sessions_by_key(body)
    aa_am = by_key[("AA", 1, "Monday", "AM")]
    assert aa_am["is_on_leave"] is True
    bb_pm = by_key[("BB", 1, "Monday", "PM")]
    assert bb_pm["is_on_leave"] is False

    assert body["closed_dates"] == [monday.isoformat()]


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