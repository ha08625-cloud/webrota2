"""Decision-log formatting helpers.

Only `score` is covered here: it is the one helper whose output has to stay
arithmetically self-consistent, because the decision log is what a doctor
reads when challenging an allocation. A line stating a numerator and a
denominator that do not produce its stated result is worse than a wrong
one.
"""
import math

from app.engine import rationale as rat


class TestScore:
    def test_plain_division(self):
        assert rat.score(3, 6.0, 0.5) == "raw 3 / 6 sessions per week = 0.500"

    def test_zero_balance_is_omitted(self):
        # Every line written before opening balances existed must be
        # byte-identical, whether the balance is defaulted or passed as 0.0.
        assert rat.score(3, 6.0, 0.5, 0.0) == rat.score(3, 6.0, 0.5)

    def test_positive_balance_is_named_in_the_numerator(self):
        assert (
            rat.score(0, 4.0, 0.8, 3.2)
            == "raw 0 (+3.2 opening balance) / 4 sessions per week = 0.800"
        )

    def test_negative_balance_keeps_its_sign(self):
        assert (
            rat.score(4, 4.0, 0.5, -2.0)
            == "raw 4 (-2 opening balance) / 4 sessions per week = 0.500"
        )

    def test_line_arithmetic_is_self_consistent(self):
        # The property the parenthetical exists for: (raw + balance) / spw
        # equals the number the line reports.
        raw, balance, spw = 2, 1.5, 5.0
        weighted = (raw + balance) / spw
        text = rat.score(raw, spw, weighted, balance)
        assert "raw 2 (+1.5 opening balance) / 5 sessions per week = 0.700" == text

    def test_undefined_score_still_reports_the_balance(self):
        assert (
            rat.score(1, 0.0, math.inf, 2.0)
            == "raw 1 (+2 opening balance), no sessions/week recorded -> score undefined"
        )

    def test_undefined_score_without_a_balance_is_unchanged(self):
        assert (
            rat.score(1, 0.0, math.inf)
            == "raw 1, no sessions/week recorded -> score undefined"
        )
