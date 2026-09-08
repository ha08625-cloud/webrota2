"""Per-run notes: engine-level tests.

Covers context.load_context()'s resolution of `rota_config_notes` into
`recurring_notes_by_slot`, Phase 2's stamping of `SessionSlot.notes`, and
the full pipeline through generate()/rebuild_rota_grid(), proving a stamped
note is a default value only -- never re-derived on rebuild.

The engine reads *instances* (`RotaConfigNote`, hanging off the run's
`RotaConfig`) and never the library *definitions* (`RecurringNote`); a tick
on the staging page copies one to the other. Definition CRUD and the
copy-at-pick-time behaviour are covered by test_api/; this file is
engine-only.
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
    make_config_note,
    make_doctor,
    make_leave,
    make_master_session,
    make_recurring_note,
    make_template,
)


def _config(session, monday, num_weeks=1) -> RotaConfig:
    """A *persisted* config -- note instances hang off `config_id`, so
    unlike most engine fixtures these tests need a real id."""
    config = RotaConfig(start_date=monday, num_weeks=num_weeks, template_start_week=1)
    session.add(config)
    session.flush()
    return config


def _build(session, config):
    ctx = load_context(session, config)
    grid, counters = run_phase2(ctx, config, session)
    return ctx, grid, counters


class TestContextResolution:
    def test_note_resolved_for_its_own_generation_week_only(self, session, monday):
        d = make_doctor(session, code="AA")
        config = _config(session, monday, num_weeks=4)
        make_config_note(
            session, config, text="Partners meeting", week=3,
            day=Day.TUESDAY, period=Period.PM, doctor_ids=[d.id],
        )

        ctx = load_context(session, config)

        assert ctx.recurring_notes_by_slot[(d.id, 3, Day.TUESDAY, Period.PM)] == (
            "Partners meeting"
        )
        assert (d.id, 1, Day.TUESDAY, Period.PM) not in ctx.recurring_notes_by_slot

    def test_one_meeting_picked_for_several_weeks_is_several_instances(
        self, session, monday
    ):
        """A tick spanning weeks 1 and 3 writes two independent rows; the
        engine does no recurrence mapping of its own."""
        d = make_doctor(session, code="AA")
        config = _config(session, monday, num_weeks=4)
        for week in (1, 3):
            make_config_note(session, config, week=week, doctor_ids=[d.id])

        ctx = load_context(session, config)

        hit_weeks = {
            gw for (doc, gw, _day, _period) in ctx.recurring_notes_by_slot
            if doc == d.id
        }
        assert hit_weeks == {1, 3}

    def test_note_applies_to_every_doctor_on_it(self, session, monday):
        d1 = make_doctor(session, code="AA")
        d2 = make_doctor(session, code="BB")
        config = _config(session, monday)
        make_config_note(
            session, config, text="Partners meeting", doctor_ids=[d1.id, d2.id]
        )

        ctx = load_context(session, config)

        assert ctx.recurring_notes_by_slot == {
            (d1.id, 1, Day.TUESDAY, Period.PM): "Partners meeting",
            (d2.id, 1, Day.TUESDAY, Period.PM): "Partners meeting",
        }

    def test_overlapping_notes_concatenate_in_ascending_id_order(self, session, monday):
        d = make_doctor(session, code="AA")
        config = _config(session, monday)
        first = make_config_note(
            session, config, text="Partners meeting", doctor_ids=[d.id]
        )
        second = make_config_note(
            session, config, text="Bring laptop", doctor_ids=[d.id]
        )
        assert first.id < second.id

        ctx = load_context(session, config)

        key = (d.id, 1, Day.TUESDAY, Period.PM)
        assert ctx.recurring_notes_by_slot[key] == "Partners meeting\nBring laptop"

    def test_note_on_another_config_is_not_picked_up(self, session, monday):
        d = make_doctor(session, code="AA")
        other = _config(session, monday)
        make_config_note(session, other, doctor_ids=[d.id])
        config = _config(session, monday)

        ctx = load_context(session, config)

        assert ctx.recurring_notes_by_slot == {}

    def test_week_beyond_num_weeks_is_a_dead_key_not_an_error(self, session, monday):
        """The CHECK constraint bounds `week` to 1-4 and the router bounds it
        again against the run's num_weeks. If one slips through anyway it
        resolves to a key Phase 2 never looks up -- no exception, no slot."""
        d = make_doctor(session, code="AA")
        config = _config(session, monday, num_weeks=2)
        make_config_note(session, config, week=4, doctor_ids=[d.id])

        ctx = load_context(session, config)

        assert (d.id, 4, Day.TUESDAY, Period.PM) in ctx.recurring_notes_by_slot
        assert all(gw == 4 for (_doc, gw, _day, _period) in ctx.recurring_notes_by_slot)

    def test_definition_alone_stamps_nothing(self, session, monday):
        """The library schedules nothing: only a picked instance reaches the
        engine, and an instance never re-reads its definition."""
        d = make_doctor(session, code="AA")
        make_recurring_note(session, doctor_ids=[d.id])
        config = _config(session, monday)

        ctx = load_context(session, config)

        assert ctx.recurring_notes_by_slot == {}

    def test_instance_survives_its_definition_being_deactivated(self, session, monday):
        d = make_doctor(session, code="AA")
        definition = make_recurring_note(session, doctor_ids=[d.id])
        config = _config(session, monday)
        make_config_note(
            session, config, text="Partners meeting", doctor_ids=[d.id],
            source_note_id=definition.id,
        )
        definition.is_active = False
        session.flush()

        ctx = load_context(session, config)

        assert ctx.recurring_notes_by_slot[(d.id, 1, Day.TUESDAY, Period.PM)] == (
            "Partners meeting"
        )


class TestPhase2Stamping:
    def test_note_stamped_onto_matching_slot(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        config = _config(session, monday)
        make_config_note(
            session, config, text="Partners meeting",
            day=Day.TUESDAY, period=Period.PM, doctor_ids=[d.id],
        )

        _ctx, grid, _counters = _build(session, config)

        slot = grid.get(d.id, 1, Day.TUESDAY, Period.PM)
        assert slot is not None
        assert slot.notes == "Partners meeting"

    def test_adjacent_slot_has_no_note(self, session, monday):
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
        config = _config(session, monday)
        make_config_note(
            session, config, day=Day.TUESDAY, period=Period.PM, doctor_ids=[d.id]
        )

        _ctx, grid, _counters = _build(session, config)

        am_slot = grid.get(d.id, 1, Day.TUESDAY, Period.AM)
        assert am_slot is not None
        assert am_slot.notes is None

    def test_doctor_on_leave_still_gets_note(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        tuesday = monday + datetime.timedelta(days=1)
        make_leave(session, d, tuesday, Period.PM)
        config = _config(session, monday)
        make_config_note(
            session, config, text="Partners meeting",
            day=Day.TUESDAY, period=Period.PM, doctor_ids=[d.id],
        )

        _ctx, grid, _counters = _build(session, config)

        slot = grid.get(d.id, 1, Day.TUESDAY, Period.PM)
        assert slot is not None
        assert slot.is_on_leave is True
        assert slot.notes == "Partners meeting"

    def test_no_template_row_means_no_slot_and_no_note(self, session, monday):
        """The staging picker warns about this case live; the engine itself
        drops the note silently, because cell absence is data."""
        make_template(session, is_active=True)  # active, but no session rows
        d = make_doctor(session, code="AA")
        config = _config(session, monday)
        make_config_note(
            session, config, day=Day.TUESDAY, period=Period.PM, doctor_ids=[d.id]
        )

        _ctx, grid, _counters = _build(session, config)

        assert grid.get(d.id, 1, Day.TUESDAY, Period.PM) is None


class TestEndToEndPersistence:
    def test_note_persists_and_survives_rebuild(self, session, monday):
        t = make_template(session, is_active=True)
        d = make_doctor(session, code="AA")
        make_master_session(
            session, t, d, week=1, day=Day.TUESDAY, period=Period.PM,
            session_type=MasterSessionType.REQUIRES_ROOM,
        )
        config = _config(session, monday)
        make_config_note(
            session, config, text="Partners meeting",
            day=Day.TUESDAY, period=Period.PM, doctor_ids=[d.id],
        )

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
        # never re-derives it from the config's notes.
        row.notes = None
        session.flush()

        _ctx, grid = rebuild_rota_grid(session, result.rota_id)
        rebuilt_slot = grid.get(d.id, 1, Day.TUESDAY, Period.PM)
        assert rebuilt_slot is not None
        assert rebuilt_slot.notes is None
