"""Tests for grid_utils.rebuild_rota_grid.

M3.7: a persisted RotaSession.template_type must survive the active
template being edited after generation - reconstruction judges past edits
against the template as it stood at generation time, not as it stands now.
"""
import datetime

from sqlalchemy import select

from app.engine.generate import generate
from app.engine.grid_utils import rebuild_rota_grid, run_phase12_for_rota
from app.models import GeneratedRota, MasterRotaSession, PracticeClosure, RotaConfig, RotaSession
from app.models.enums import Day, DutyType, MasterSessionType, Period

from .factories import make_closure, make_doctor, make_duty, make_master_session, make_template


def _make_rota(session, config):
    rota = GeneratedRota(config_id=config.id)
    session.add(rota)
    session.flush()
    return rota


class TestRebuildRotaGridTemplateType:
    def test_persisted_template_type_wins_over_current_template(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()
        rota = _make_rota(session, config)
        session.add(RotaSession(
            rota_id=rota.id, doctor_id=d.id, week=1, day=Day.MONDAY, period=Period.AM,
            template_type=MasterSessionType.REQUIRES_ROOM,
        ))
        session.commit()

        # Template edited *after* generation - reconstruction must not
        # pick this up for an already-generated row.
        row = session.execute(
            select(MasterRotaSession).where(MasterRotaSession.doctor_id == d.id)
        ).scalar_one()
        row.session_type = MasterSessionType.NO_SURGERY
        session.commit()

        _ctx, grid = rebuild_rota_grid(session, rota.id)
        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.template_type == MasterSessionType.REQUIRES_ROOM

    def test_legacy_null_row_still_derives_from_current_template(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.NO_SURGERY,
        )
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()
        rota = _make_rota(session, config)
        session.add(RotaSession(
            rota_id=rota.id, doctor_id=d.id, week=1, day=Day.MONDAY, period=Period.AM,
            template_type=None,  # simulates a pre-M3.6 legacy row
        ))
        session.commit()

        _ctx, grid = rebuild_rota_grid(session, rota.id)
        slot = grid.get(d.id, 1, Day.MONDAY, Period.AM)
        assert slot.template_type == MasterSessionType.NO_SURGERY


class TestClosureSnapshotIsolation:
    """M5 plan review note 1: rebuild_rota_grid() must read closed dates
    from the rota's own RotaClosure snapshot, not the current PracticeClosure
    table, so a closure added or removed after generation cannot change how
    an existing rota renders or validates.
    """

    def test_deleting_practice_closure_after_generation_does_not_change_issues(
        self, session, monday
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        closures = make_closure(session, monday)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)
        assert result.rota_id is not None

        issues_before = run_phase12_for_rota(session, result.rota_id)

        # Delete the global closure entirely -- the snapshot must be immune.
        for closure in closures:
            session.delete(session.get(PracticeClosure, closure.id))
        session.flush()

        issues_after = run_phase12_for_rota(session, result.rota_id)

        before_keys = sorted((i.check, i.week, i.day, i.period) for i in issues_before)
        after_keys = sorted((i.check, i.week, i.day, i.period) for i in issues_after)
        assert before_keys == after_keys

    def test_rebuild_uses_rota_closure_snapshot_not_current_practice_closures(
        self, session, monday
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        # Add a brand-new closure to PracticeClosure *after* generation --
        # the reconstructed context must not pick it up.
        new_closure_date = monday + datetime.timedelta(days=1)
        make_closure(session, new_closure_date)

        ctx, _grid = rebuild_rota_grid(session, result.rota_id)

        assert ctx.closed_slots == {(monday, Period.AM), (monday, Period.PM)}
        assert (new_closure_date, Period.AM) not in ctx.closed_slots
        assert (new_closure_date, Period.PM) not in ctx.closed_slots

    def test_duty_on_closed_date_still_blocks_a_later_generation(self, session, monday):
        """Sanity check that the snapshot isolation above does not weaken
        Phase 0's own closure check for a *fresh* generation run, which
        correctly reads the live PracticeClosure table via load_context()."""
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday)
        make_duty(session, monday, Period.AM, d, DutyType.PRIMARY)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)

        assert result.status == "failed"
        assert any(i.check == "duty_on_closed_date" for i in result.issues)

    def test_half_day_closure_snapshots_one_row_and_reproduces_on_rebuild(
        self, session, monday
    ):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_master_session(
            session, t, d, week=1, day=Day.MONDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_closure(session, monday, period=Period.PM)

        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)
        assert result.rota_id is not None

        rows = session.execute(
            select(PracticeClosure)
        ).scalars().all()
        assert len(rows) == 1  # sanity: the fixture wrote a single PM row

        ctx, grid = rebuild_rota_grid(session, result.rota_id)

        assert ctx.closed_slots == {(monday, Period.PM)}
        assert grid.get(d.id, 1, Day.MONDAY, Period.AM) is not None
        assert grid.get(d.id, 1, Day.MONDAY, Period.PM) is None