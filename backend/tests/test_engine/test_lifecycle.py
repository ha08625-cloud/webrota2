"""Lifecycle tests for the M3 counter snapshot / commit / scrap mechanics.

Engine-level (no API): these verify Task 1 independently before the routers
exist. The API tests in tests/test_api/ later exercise the same paths via
HTTP, including the swap-then-scrap restoration case end to end.
"""
from sqlalchemy import select

from app.engine.generate import commit_rota, generate, get_active_draft, scrap_rota
from app.models import (
    ClinicCounter,
    GeneratedRota,
    RotaClinicCounterSnapshot,
    RotaConfig,
    RotaSession,
    RotaSystemCounterSnapshot,
    SystemCounter,
)
from app.models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    RotaStatus,
    SystemCounterType,
)

from .factories import (
    make_clinic_counter,
    make_clinic_type,
    make_doctor,
    make_master_session,
    make_room,
    make_system_counter,
    make_template,
)


def _build_fixture(session, monday):
    """Minimal generating fixture: two doctors, one clinic type scheduled
    Monday AM with one eligible doctor holding a pre-existing counter row.
    Returns (config, doctor_a, doctor_b, clinic_type).
    """
    t = make_template(session, is_active=True)
    a = make_doctor(session, code="AA", doctor_type=DoctorType.PARTNER)
    b = make_doctor(session, code="BB", doctor_type=DoctorType.SALARIED)
    room = make_room(session, code="C1", room_type=RoomType.C)

    for doc in (a, b):
        make_system_counter(session, doc, SystemCounterType.ROOM_MOVE)
        make_system_counter(session, doc, SystemCounterType.SUPERVISION)
        make_master_session(
            session, t, doc, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )

    ct = make_clinic_type(
        session, name="Dragon", clinic_priority=10, room_required=True,
        schedules=[(Day.MONDAY, Period.AM)],
        doctor_eligibilities=[(a.id, 1)], room_ids=[room.id],
    )
    # Pre-existing counter with a non-zero value: raw_count=3 before generation.
    make_clinic_counter(session, a, ct, raw_count=3)

    config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
    session.add(config)
    session.flush()
    return config, a, b, ct


def _clinic_count(session, doctor_id, clinic_type_id):
    return session.execute(
        select(ClinicCounter.raw_count).where(
            ClinicCounter.doctor_id == doctor_id,
            ClinicCounter.clinic_type_id == clinic_type_id,
        )
    ).scalar_one_or_none()


class TestSnapshotOnGenerate:
    def test_generate_snapshots_pre_generation_values(self, session, monday):
        config, a, b, ct = _build_fixture(session, monday)

        result = generate(session, config.id)
        assert result.rota_id is not None

        clinic_snaps = session.execute(
            select(RotaClinicCounterSnapshot).where(
                RotaClinicCounterSnapshot.rota_id == result.rota_id)
        ).scalars().all()
        system_snaps = session.execute(
            select(RotaSystemCounterSnapshot).where(
                RotaSystemCounterSnapshot.rota_id == result.rota_id)
        ).scalars().all()

        # One clinic counter row existed pre-generation, at value 3.
        assert len(clinic_snaps) == 1
        snap = clinic_snaps[0]
        assert (snap.doctor_id, snap.clinic_type_id) == (a.id, ct.id)
        assert snap.value_before == 3
        # But the live counter has been incremented past the snapshot value.
        assert _clinic_count(session, a.id, ct.id) == 4

        # Both system counters per doctor snapshotted at 0.
        assert len(system_snaps) == 4
        assert all(s.value_before == 0 for s in system_snaps)


class TestCommit:
    def test_commit_sets_status_and_deletes_snapshots(self, session, monday):
        config, a, b, ct = _build_fixture(session, monday)
        result = generate(session, config.id)

        rota = commit_rota(session, result.rota_id)
        assert rota.status == RotaStatus.COMMITTED

        assert session.execute(select(RotaClinicCounterSnapshot)).scalars().first() is None
        assert session.execute(select(RotaSystemCounterSnapshot)).scalars().first() is None
        # Committed values stay live: baseline for the next generation.
        assert _clinic_count(session, a.id, ct.id) == 4

    def test_commit_twice_raises(self, session, monday):
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        commit_rota(session, result.rota_id)
        try:
            commit_rota(session, result.rota_id)
            assert False, "expected ValueError"
        except ValueError:
            pass


class TestScrap:
    def test_scrap_restores_counters_and_deletes_everything(self, session, monday):
        config, a, b, ct = _build_fixture(session, monday)
        result = generate(session, config.id)
        assert _clinic_count(session, a.id, ct.id) == 4

        # Simulate a manual swap edit during the draft period: a counter row
        # is created for doctor b (previously untracked) and a's is bumped.
        session.add(ClinicCounter(doctor_id=b.id, clinic_type_id=ct.id, raw_count=1))
        session.execute(
            select(ClinicCounter).where(ClinicCounter.doctor_id == a.id)
        ).scalar_one().raw_count = 7
        session.flush()

        scrap_rota(session, result.rota_id)

        # Pre-generation value restored, draft-period row deleted.
        assert _clinic_count(session, a.id, ct.id) == 3
        assert _clinic_count(session, b.id, ct.id) is None
        # Rota, sessions, and snapshots all gone.
        assert session.get(GeneratedRota, result.rota_id) is None
        assert session.execute(select(RotaSession)).scalars().first() is None
        assert session.execute(select(RotaClinicCounterSnapshot)).scalars().first() is None
        assert session.execute(select(RotaSystemCounterSnapshot)).scalars().first() is None
        # System counters restored to 0 and still present.
        rows = session.execute(select(SystemCounter)).scalars().all()
        assert len(rows) == 4
        assert all(r.raw_count == 0 for r in rows)

    def test_scrap_committed_raises(self, session, monday):
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        commit_rota(session, result.rota_id)
        try:
            scrap_rota(session, result.rota_id)
            assert False, "expected ValueError"
        except ValueError:
            pass

    def test_scrap_then_regenerate_produces_identical_counters(self, session, monday):
        """The core lifecycle guarantee: scrap + regenerate is equivalent to
        having generated once from the original baseline."""
        config, a, b, ct = _build_fixture(session, monday)
        first = generate(session, config.id)
        scrap_rota(session, first.rota_id)

        second = generate(session, config.id)
        assert _clinic_count(session, a.id, ct.id) == 4
        assert second.rota_id != first.rota_id


class TestActiveDraft:
    def test_get_active_draft(self, session, monday):
        assert get_active_draft(session) is None
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        draft = get_active_draft(session)
        assert draft is not None and draft.id == result.rota_id
        commit_rota(session, result.rota_id)
        assert get_active_draft(session) is None
