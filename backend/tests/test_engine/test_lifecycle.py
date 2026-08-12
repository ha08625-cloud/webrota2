"""Lifecycle tests for the M3 / M3.7 counter snapshot / commit / scrap /
rollback mechanics.

Engine-level (no API): these verify the engine functions independently of
the routers. The API tests in tests/test_api/ later exercise the same
paths via HTTP, including the swap-then-scrap restoration case and the
rollback-commit endpoint end to end.
"""
import datetime

from sqlalchemy import select

from app.engine.generate import (
    commit_rota,
    force_delete_rota,
    generate,
    get_active_draft,
    rollback_commit,
    scrap_rota,
)
from app.models import (
    ClinicCounter,
    GeneratedRota,
    RotaClinicCounterSnapshot,
    RotaConfig,
    RotaGenerationLogEntry,
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

    config = _make_config(session, monday)
    return config, a, b, ct


def _make_config(session, start_date, num_weeks=1, template_start_week=1):
    config = RotaConfig(
        start_date=start_date, num_weeks=num_weeks,
        template_start_week=template_start_week,
    )
    session.add(config)
    session.flush()
    return config


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
    def test_commit_preserves_snapshots_and_sets_committed_at(self, session, monday):
        """M3.7: commit no longer deletes the counter snapshot -- it
        persists as the permanent audit record rollback_commit() restores
        from. This inverts the pre-M3.7 assertion that snapshots were
        deleted on commit."""
        config, a, b, ct = _build_fixture(session, monday)
        result = generate(session, config.id)

        rota = commit_rota(session, result.rota_id)
        assert rota.status == RotaStatus.COMMITTED
        assert rota.committed_at is not None

        assert session.execute(
            select(RotaClinicCounterSnapshot).where(
                RotaClinicCounterSnapshot.rota_id == result.rota_id)
        ).scalars().first() is not None
        assert session.execute(
            select(RotaSystemCounterSnapshot).where(
                RotaSystemCounterSnapshot.rota_id == result.rota_id)
        ).scalars().first() is not None
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
        # Note: not asserting second.rota_id != first.rota_id here. Scrap
        # deletes the first row outright, and GeneratedRota.id has no
        # sqlite_autoincrement flag, so SQLite is free to recycle the
        # deleted rowid for the next insert -- the two ids can legitimately
        # collide. Counter equivalence is the guarantee under test, not id
        # distinctness.


class TestActiveDraft:
    def test_get_active_draft(self, session, monday):
        assert get_active_draft(session) is None
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        draft = get_active_draft(session)
        assert draft is not None and draft.id == result.rota_id
        commit_rota(session, result.rota_id)
        assert get_active_draft(session) is None


class TestRollbackCommit:
    """M3.7: rollback_commit() undoes a commit one step at a time."""

    def test_rollback_happy_path_restores_counters_and_flips_status(
        self, session, monday
    ):
        config, a, b, ct = _build_fixture(session, monday)
        result = generate(session, config.id)
        assert _clinic_count(session, a.id, ct.id) == 4
        commit_rota(session, result.rota_id)

        # Snapshot survives commit (M3.7).
        assert session.execute(
            select(RotaClinicCounterSnapshot).where(
                RotaClinicCounterSnapshot.rota_id == result.rota_id)
        ).scalars().first() is not None

        rolled = rollback_commit(session, result.rota_id)
        assert rolled.status == RotaStatus.DRAFT
        assert rolled.committed_at is None
        # Restored to the pre-generation snapshot value.
        assert _clinic_count(session, a.id, ct.id) == 3

        # Rollback does not delete the snapshot -- only scrap does.
        assert session.execute(
            select(RotaClinicCounterSnapshot).where(
                RotaClinicCounterSnapshot.rota_id == result.rota_id)
        ).scalars().first() is not None

    def test_rollback_restore_deletes_new_rows_and_recreates_deleted_rows(
        self, session, monday
    ):
        """Exercises the shared _restore_counters_from_snapshot() helper
        via rollback rather than scrap: a counter row created after the
        snapshot is deleted, and a snapshotted row deleted after commit is
        recreated at its pre-generation value."""
        config, a, b, ct = _build_fixture(session, monday)
        result = generate(session, config.id)
        commit_rota(session, result.rota_id)

        session.add(ClinicCounter(doctor_id=b.id, clinic_type_id=ct.id, raw_count=5))
        a_row = session.execute(
            select(ClinicCounter).where(ClinicCounter.doctor_id == a.id)
        ).scalar_one()
        session.delete(a_row)
        session.flush()

        rollback_commit(session, result.rota_id)

        assert _clinic_count(session, a.id, ct.id) == 3  # recreated at snapshot value
        assert _clinic_count(session, b.id, ct.id) is None  # absent from snapshot, deleted

    def test_rollback_not_found_raises(self, session, monday):
        try:
            rollback_commit(session, 999999)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "not found" in str(exc)

    def test_rollback_not_committed_raises(self, session, monday):
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        try:
            rollback_commit(session, result.rota_id)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "not committed" in str(exc)

    def test_rollback_committed_at_null_raises(self, session, monday):
        """A rota committed before rollback support existed has
        committed_at = NULL and had its snapshots deleted at commit time
        under the old lifecycle -- restoring against it would be unsafe,
        so it must be hard-blocked regardless of anything else."""
        config = _make_config(session, monday)
        rota = GeneratedRota(config_id=config.id, status=RotaStatus.COMMITTED)
        session.add(rota)
        session.flush()
        assert rota.committed_at is None

        try:
            rollback_commit(session, rota.id)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "rollback support" in str(exc)

    def test_rollback_active_draft_blocks(self, session, monday):
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        commit_rota(session, result.rota_id)

        # A second generation run creates a new draft, which must be
        # resolved before the first commit can be rolled back.
        config2 = _make_config(session, monday + datetime.timedelta(days=7))
        generate(session, config2.id)

        try:
            rollback_commit(session, result.rota_id)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "draft" in str(exc).lower()

    def test_rollback_not_most_recent_names_blocker(self, session, monday):
        config, *_ = _build_fixture(session, monday)
        result_a = generate(session, config.id)
        commit_rota(session, result_a.rota_id)

        config2 = _make_config(session, monday + datetime.timedelta(days=7))
        result_b = generate(session, config2.id)
        commit_rota(session, result_b.rota_id)

        try:
            rollback_commit(session, result_a.rota_id)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert str(result_b.rota_id) in str(exc)

    def test_rollback_zero_snapshot_rows_raises(self, session, monday):
        """Belt-and-braces companion to the committed_at check: a committed
        rota with committed_at set but no snapshot rows at all should never
        happen in a seeded system, and must also be refused."""
        config = _make_config(session, monday)
        rota = GeneratedRota(
            config_id=config.id, status=RotaStatus.COMMITTED,
            committed_at=datetime.datetime.now(datetime.timezone.utc),
        )
        session.add(rota)
        session.flush()

        try:
            rollback_commit(session, rota.id)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "snapshot" in str(exc)

    def test_rolled_back_rota_is_recommitable_and_becomes_most_recent(
        self, session, monday
    ):
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        commit_rota(session, result.rota_id)

        rolled = rollback_commit(session, result.rota_id)
        assert rolled.status == RotaStatus.DRAFT

        recommitted = commit_rota(session, result.rota_id)
        assert recommitted.status == RotaStatus.COMMITTED
        assert recommitted.committed_at is not None

        most_recent = session.execute(
            select(GeneratedRota)
            .where(GeneratedRota.status == RotaStatus.COMMITTED)
            .order_by(GeneratedRota.committed_at.desc().nullslast(), GeneratedRota.id.desc())
        ).scalars().first()
        assert most_recent.id == result.rota_id

    def test_rolled_back_rota_is_scrappable(self, session, monday):
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        commit_rota(session, result.rota_id)
        rollback_commit(session, result.rota_id)

        scrap_rota(session, result.rota_id)
        assert session.get(GeneratedRota, result.rota_id) is None
        assert session.execute(
            select(RotaClinicCounterSnapshot).where(
                RotaClinicCounterSnapshot.rota_id == result.rota_id)
        ).scalars().first() is None

    def test_rollback_full_chain_interleaved_with_scraps(self, session, monday):
        """Roll back C, then B, then A -- in strict reverse order, each
        requiring the previous rollback to be scrapped first. Verifies the
        chain both restores counters correctly at each step and enforces
        strict ordering throughout."""
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

        config_a = _make_config(session, monday)
        result_a = generate(session, config_a.id)
        commit_rota(session, result_a.rota_id)

        config_b = _make_config(session, monday + datetime.timedelta(days=7))
        result_b = generate(session, config_b.id)
        commit_rota(session, result_b.rota_id)

        config_c = _make_config(session, monday + datetime.timedelta(days=14))
        result_c = generate(session, config_c.id)
        commit_rota(session, result_c.rota_id)

        # No pre-existing counter row in this fixture: A -> 1, B -> 2, C -> 3.
        assert _clinic_count(session, a.id, ct.id) == 3

        # Roll back C: restored to the value immediately before C's
        # generation, i.e. after A and B.
        rolled_c = rollback_commit(session, result_c.rota_id)
        assert rolled_c.status == RotaStatus.DRAFT
        assert _clinic_count(session, a.id, ct.id) == 2

        # B cannot be rolled back yet: C is sitting as an unresolved draft.
        try:
            rollback_commit(session, result_b.rota_id)
            assert False, "expected ValueError"
        except ValueError:
            pass

        # Scrap C to free the draft slot, then roll back B.
        scrap_rota(session, result_c.rota_id)
        rolled_b = rollback_commit(session, result_b.rota_id)
        assert rolled_b.status == RotaStatus.DRAFT
        assert _clinic_count(session, a.id, ct.id) == 1

        scrap_rota(session, result_b.rota_id)
        rolled_a = rollback_commit(session, result_a.rota_id)
        assert rolled_a.status == RotaStatus.DRAFT
        # A's snapshot predates any (a, ct) counter row existing at all --
        # absent from the snapshot means "created after it", so restore
        # deletes the row outright rather than zeroing it.
        assert _clinic_count(session, a.id, ct.id) is None

        # A is now a plain draft again -- normal draft lifecycle applies.
        scrap_rota(session, result_a.rota_id)
        assert session.execute(select(GeneratedRota)).scalars().first() is None


class TestForceDelete:
    """force_delete_rota(): the software-bug escape hatch. Deletes a
    committed rota outright and leaves live counters untouched -- see the
    function's docstring for why this is not a substitute for rollback."""

    def test_force_delete_removes_rota_and_leaves_counters_live(
        self, session, monday
    ):
        config, a, b, ct = _build_fixture(session, monday)
        result = generate(session, config.id)
        commit_rota(session, result.rota_id)
        assert _clinic_count(session, a.id, ct.id) == 4

        force_delete_rota(session, result.rota_id)

        # Rota, its session(s), snapshot, and generation log entries gone.
        assert session.get(GeneratedRota, result.rota_id) is None
        assert session.execute(select(RotaSession)).scalars().first() is None
        assert session.execute(
            select(RotaClinicCounterSnapshot).where(
                RotaClinicCounterSnapshot.rota_id == result.rota_id)
        ).scalars().first() is None
        assert session.execute(
            select(RotaGenerationLogEntry).where(
                RotaGenerationLogEntry.rota_id == result.rota_id)
        ).scalars().first() is None

        # Counters stay exactly as generation left them -- not restored.
        assert _clinic_count(session, a.id, ct.id) == 4

        # The orphaned RotaConfig row is left behind, same as scrap.
        assert session.get(RotaConfig, config.id) is not None

    def test_force_delete_draft_raises(self, session, monday):
        config, *_ = _build_fixture(session, monday)
        result = generate(session, config.id)
        try:
            force_delete_rota(session, result.rota_id)
            assert False, "expected ValueError"
        except ValueError as exc:
            message = str(exc).lower()
            assert "draft" in message
            assert "scrap" in message

    def test_force_delete_not_found_raises(self, session, monday):
        try:
            force_delete_rota(session, 999999)
            assert False, "expected ValueError"
        except ValueError as exc:
            assert "not found" in str(exc)

    def test_force_delete_legacy_committed_at_null_succeeds(self, session, monday):
        """The primary real-world trigger: a legacy commit with
        committed_at=None and no snapshot rows, which rollback_commit()
        can never touch. force_delete_rota() has no committed_at check and
        must succeed regardless."""
        config = _make_config(session, monday)
        rota = GeneratedRota(config_id=config.id, status=RotaStatus.COMMITTED)
        session.add(rota)
        session.flush()
        assert rota.committed_at is None

        force_delete_rota(session, rota.id)

        assert session.get(GeneratedRota, rota.id) is None

    def test_force_delete_any_chain_position(self, session, monday):
        """Unlike rollback, force-delete carries no ordering restriction --
        the older of two committed rotas can be deleted while the newer
        one is left untouched."""
        config_a, a, b, ct = _build_fixture(session, monday)
        result_a = generate(session, config_a.id)
        commit_rota(session, result_a.rota_id)

        config_b = _make_config(session, monday + datetime.timedelta(days=7))
        result_b = generate(session, config_b.id)
        commit_rota(session, result_b.rota_id)

        force_delete_rota(session, result_a.rota_id)

        assert session.get(GeneratedRota, result_a.rota_id) is None
        assert session.get(GeneratedRota, result_b.rota_id) is not None
        assert session.get(GeneratedRota, result_b.rota_id).status == RotaStatus.COMMITTED

    def test_force_delete_then_rollback_discards_contribution(self, session, monday):
        """The stated caveat, proven rather than just documented:
        force-deleting the most recent commit (B) makes A the new most
        recent commit. Rolling A back restores counters to A's own
        snapshot -- silently discarding B's baked-in contribution along
        with everything the rollback itself undoes."""
        config_a, a, b, ct = _build_fixture(session, monday)
        result_a = generate(session, config_a.id)
        commit_rota(session, result_a.rota_id)
        # a's counter: 3 (pre-existing) -> 4 after A's generation.
        assert _clinic_count(session, a.id, ct.id) == 4

        config_b = _make_config(session, monday + datetime.timedelta(days=7))
        result_b = generate(session, config_b.id)
        commit_rota(session, result_b.rota_id)
        # a's counter: 4 -> 5 after B's generation.
        assert _clinic_count(session, a.id, ct.id) == 5

        force_delete_rota(session, result_b.rota_id)
        # Counter is untouched by the force-delete itself.
        assert _clinic_count(session, a.id, ct.id) == 5

        rollback_commit(session, result_a.rota_id)
        # A's snapshot value: 3. B's contribution (and A's own generation
        # increment) is gone from the live counter -- discarded, not just
        # B's part of it.
        assert _clinic_count(session, a.id, ct.id) == 3