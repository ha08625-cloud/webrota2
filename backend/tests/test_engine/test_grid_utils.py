"""Tests for grid_utils.rebuild_rota_grid.

M3.7: a persisted RotaSession.template_type must survive the active
template being edited after generation - reconstruction judges past edits
against the template as it stood at generation time, not as it stands now.
"""
from sqlalchemy import select

from app.engine.grid_utils import rebuild_rota_grid
from app.models import GeneratedRota, MasterRotaSession, RotaConfig, RotaSession
from app.models.enums import Day, MasterSessionType, Period

from .factories import make_doctor, make_master_session, make_template


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