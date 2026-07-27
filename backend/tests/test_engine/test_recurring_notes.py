"""Recurring notes: engine-level tests for the Task 3 wiring.

Covers context.load_context()'s week resolution (including the staging
anchor fix, Design Decision 5) and multi-note concatenation, Phase 2's
stamping of SessionSlot.notes, and the full pipeline through generate()/
rebuild_rota_grid(), proving a stamped note is a default value only --
never re-derived on rebuild (recurring notes plan, Design Decisions 6-10).

Tasks 1 and 2 (models, schemas, API) are covered by
test_api/test_recurring_notes.py; this file is engine-only.
"""
import datetime

from sqlalchemy import select

from app.engine.context import load_context
from app.engine.generate import generate
from app.engine.grid_utils import rebuild_rota_grid
from app.engine.phases.phase2 import run_phase2
from app.models import RotaConfig, RotaSession
from app.models.enums import Day, MasterSessionType, Period

from .factories import (
    make_doctor,
    make_leave,
    make_master_session,
    make_recurring_note,
    make_staging,
    make_template,
)


def _build(session, config):
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid, counters


class TestContextWeekResolution:
    def test_note_resolved_for_matching_generation_week_only(self, session, monday):
        d = make_doctor(session, code="AA")
        make_recurring_note(
            session, text="Partners meeting", day=Day.TUESDAY, period=Period.PM,
            doctor_ids=[d.id], template_weeks=[1],
        )
        config = RotaConfig(start_date=monday, num_weeks=4, template_start_week=1)

        ctx = load_context(session, config)

        assert ctx.recurring_notes_by_slot[(d.id, 1, Day.TUESDAY, Period.PM)] == (
            "Partners meeting"
        )
        assert (d.id, 2, Day.TUESDAY, Period.PM) not in ctx.recurring_notes_by_slot

    def test_fortnightly_note_start_week_1_lands_on_gen_weeks_1_and_3(
        self, session, monday
    ):
        d = make_doctor(session, code="AA")
        make_recurring_note(session, doctor_ids=[d.id], template_weeks=[1, 3])
        config = RotaConfig(start_date=monday, num_weeks=4, template_start_week=1)

        ctx = load_context(session, config)

        hit_weeks = {
            gw for (doc, gw, _day, _period) in ctx.recurring_notes_by_slot
            if doc == d.id
        }
        assert hit_weeks == {1, 3}

    def test_fortnightly_note_start_week_2_shifts_to_gen_weeks_2_and_4(
        self, session, monday
    ):
        d = make_doctor(session, code="AA")
        make_recurring_note(session, doctor_ids=[d.id], template_weeks=[1, 3])
        config = RotaConfig(start_date=monday, num_weeks=4, template_start_week=2)

        ctx = load_context(session, config)

        hit_weeks = {
            gw for (doc, gw, _day, _period) in ctx.recurring_notes_by_slot
            if doc == d.id
        }
        assert hit_weeks == {2, 4}

    def test_overlapping_notes_concatenate_in_ascending_id_order(self, session, monday):
        d = make_doctor(session, code="AA")
        first = make_recurring_note(session, text="Partners meeting", doctor_ids=[d.id])
        second = make_recurring_note(session, text="Bring laptop", doctor_ids=[d.id])
        assert first.id < second.id
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)

        ctx = load_context(session, config)

        key = (d.id, 1, Day.TUESDAY, Period.PM)
        assert ctx.recurring_notes_by_slot[key] == "Partners meeting\nBring laptop"

    def test_inactive_note_stamps_nothing(self, session, monday):
        d = make_doctor(session, code="AA")
        make_recurring_note(session, doctor_ids=[d.id], is_active=False)
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)

        ctx = load_context(session, config)

        assert ctx.recurring_notes_by_slot == {}

    def test_staged_run_resolves_weeks_against_source_template_start_week(
        self, session, monday
    ):
        """A staged config always persists template_start_week=1 (staging
        plan, Design Decision 4), so week resolution must use
        RotaStaging.source_template_start_week instead (recurring notes
        plan, Design Decision 5) -- otherwise a fortnightly note would land
        on the wrong real-world fortnight during holiday cover."""
        d = make_doctor(session, code="AA")
        make_recurring_note(session, doctor_ids=[d.id], template_weeks=[1, 3])
        t = make_template(session, is_active=True)

        config = RotaConfig(start_date=monday, num_weeks=4, template_start_week=1)
        session.add(config)
        session.flush()
        make_staging(session, config, t, source_template_start_week=2)

        ctx = load_context(session, config)

        hit_weeks = {
            gw for (doc, gw, _day, _period) in ctx.recurring_notes_by_slot
            if doc == d.id
        }
        assert hit_weeks == {2, 4}


class TestPhase2Stamping:
    def test_note_stamped_onto_matching_slot(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_recurring_note(
            session, text="Partners meeting", day=Day.TUESDAY, period=Period.PM,
            doctor_ids=[d.id], template_weeks=[1],
        )

        _ctx, grid, _counters = _build(session, config_1wk)

        slot = grid.get(d.id, 1, Day.TUESDAY, Period.PM)
        assert slot is not None
        assert slot.notes == "Partners meeting"

    def test_adjacent_slot_has_no_note(self, session, config_1wk):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.AM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_recurring_note(
            session, day=Day.TUESDAY, period=Period.PM,
            doctor_ids=[d.id], template_weeks=[1],
        )

        _ctx, grid, _counters = _build(session, config_1wk)

        am_slot = grid.get(d.id, 1, Day.TUESDAY, Period.AM)
        assert am_slot is not None
        assert am_slot.notes is None

    def test_doctor_on_leave_still_gets_note(self, session, config_1wk, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        tuesday = monday + datetime.timedelta(days=1)
        make_leave(session, d, tuesday, Period.PM)
        make_recurring_note(
            session, text="Partners meeting", day=Day.TUESDAY, period=Period.PM,
            doctor_ids=[d.id], template_weeks=[1],
        )

        _ctx, grid, _counters = _build(session, config_1wk)

        slot = grid.get(d.id, 1, Day.TUESDAY, Period.PM)
        assert slot is not None
        assert slot.is_on_leave is True
        assert slot.notes == "Partners meeting"

    def test_no_template_row_means_no_slot_and_no_note(self, session, config_1wk):
        make_template(session, is_active=True)  # active, but no session rows
        d = make_doctor(session, code="AA")
        make_recurring_note(
            session, day=Day.TUESDAY, period=Period.PM,
            doctor_ids=[d.id], template_weeks=[1],
        )

        _ctx, grid, _counters = _build(session, config_1wk)

        assert grid.get(d.id, 1, Day.TUESDAY, Period.PM) is None


class TestEndToEndPersistence:
    def test_note_persists_and_survives_rebuild(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        make_recurring_note(
            session, text="Partners meeting", day=Day.TUESDAY, period=Period.PM,
            doctor_ids=[d.id], template_weeks=[1],
        )
        config = RotaConfig(start_date=monday, num_weeks=1, template_start_week=1)
        session.add(config)
        session.flush()

        result = generate(session, config.id)
        assert result.status in ("success", "partial")

        row = session.execute(
            select(RotaSession).where(
                RotaSession.rota_id == result.rota_id,
                RotaSession.doctor_id == d.id,
                RotaSession.day == Day.TUESDAY,
                RotaSession.period == Period.PM,
            )
        ).scalar_one()
        assert row.notes == "Partners meeting"

        # Clearing the note on the draft grid and rebuilding must not
        # restore it -- rebuild_rota_grid() trusts the persisted value and
        # never re-derives it from recurring notes (Design Decision 7).
        row.notes = None
        session.flush()

        _ctx, grid = rebuild_rota_grid(session, result.rota_id)
        rebuilt_slot = grid.get(d.id, 1, Day.TUESDAY, Period.PM)
        assert rebuilt_slot is not None
        assert rebuilt_slot.notes is None