"""The fixed, system-wide list of named bank holidays.

Each entry's `key` tags the `PracticeClosure` rows for that holiday's
observed date in a given year (see `PracticeClosure.bank_holiday_key`); the
date itself is set per year by an admin on the Bank Holidays section of the
Closures page rather than computed, since the actual (in-lieu-adjusted)
observed date is a business decision, not purely a calendar calculation.
"""
from typing import NamedTuple


class BankHoliday(NamedTuple):
    key: str
    name: str


BANK_HOLIDAYS: list[BankHoliday] = [
    BankHoliday("new_year", "New Year's Day"),
    BankHoliday("good_friday", "Good Friday"),
    BankHoliday("easter_monday", "Easter Monday"),
    BankHoliday("early_may", "Early May bank holiday"),
    BankHoliday("spring", "Spring bank holiday"),
    BankHoliday("summer", "Summer bank holiday"),
    BankHoliday("christmas_day", "Christmas Day bank holiday"),
    BankHoliday("boxing_day", "Boxing Day bank holiday"),
]

BANK_HOLIDAYS_BY_KEY: dict[str, BankHoliday] = {h.key: h for h in BANK_HOLIDAYS}
