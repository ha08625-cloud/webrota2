import datetime as dt

import pytest

from app.engine.week_map import build_date_to_genslot, build_week_dates, template_week
from app.models.enums import Day


class TestTemplateWeek:
    def test_start_week_1_maps_identity(self):
        assert template_week(1, 1) == 1
        assert template_week(2, 1) == 2
        assert template_week(3, 1) == 3
        assert template_week(4, 1) == 4

    def test_wraps_at_4(self):
        # start_week=3: gen weeks 1,2,3,4 -> template weeks 3,4,1,2
        assert template_week(1, 3) == 3
        assert template_week(2, 3) == 4
        assert template_week(3, 3) == 1
        assert template_week(4, 3) == 2

    def test_gen_week_beyond_4_continues_cycle(self):
        # A 4-week run starting at template week 4: gen week 5 would be the
        # next cycle's template week 4 again (not exercised by real configs,
        # since num_weeks is capped at 4, but the arithmetic should still be
        # well-defined for any positive gen_week).
        assert template_week(5, 4) == 4


class TestBuildWeekDates:
    def test_monday_start_single_week(self):
        start = dt.date(2026, 1, 5)  # a Monday
        result = build_week_dates(start, 1)
        assert result[(1, Day.MONDAY)] == dt.date(2026, 1, 5)
        assert result[(1, Day.TUESDAY)] == dt.date(2026, 1, 6)
        assert result[(1, Day.WEDNESDAY)] == dt.date(2026, 1, 7)
        assert result[(1, Day.THURSDAY)] == dt.date(2026, 1, 8)
        assert result[(1, Day.FRIDAY)] == dt.date(2026, 1, 9)
        assert len(result) == 5

    def test_multi_week_advances_by_seven_days(self):
        start = dt.date(2026, 1, 5)
        result = build_week_dates(start, 2)
        assert result[(2, Day.MONDAY)] == dt.date(2026, 1, 12)
        assert result[(2, Day.FRIDAY)] == dt.date(2026, 1, 16)
        assert len(result) == 10

    def test_four_weeks_full_coverage(self):
        start = dt.date(2026, 1, 5)
        result = build_week_dates(start, 4)
        assert len(result) == 20
        assert result[(4, Day.FRIDAY)] == dt.date(2026, 1, 30)


class TestBuildDateToGenslot:
    def test_inverts_week_dates(self):
        start = dt.date(2026, 1, 5)
        week_dates = build_week_dates(start, 2)
        reverse = build_date_to_genslot(week_dates)
        assert reverse[dt.date(2026, 1, 5)] == (1, Day.MONDAY)
        assert reverse[dt.date(2026, 1, 16)] == (2, Day.FRIDAY)
        assert len(reverse) == len(week_dates)