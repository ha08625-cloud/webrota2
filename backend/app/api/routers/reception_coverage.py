"""Reception coverage-rules router (reception rota, Task 2).

Deliberately no POST and no DELETE: the row set is fixed by the seed at one
row per (day, hour) -- see ReceptionCoverageRule's docstring -- and the only
meaningful edit is the required headcount.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...engine.week_map import DAY_ORDER
from ...models import ReceptionCoverageRule
from ..deps import get_current_user, get_db
from ..schemas import CoverageRuleOut, CoverageRulePatch

router = APIRouter(prefix="/reception/coverage-rules", tags=["reception"])


@router.get("", response_model=list[CoverageRuleOut])
def list_coverage_rules(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ReceptionCoverageRule]:
    rules = db.execute(select(ReceptionCoverageRule)).scalars().all()
    # Ordered in Python, not SQL: Day is stored by value, so ORDER BY day
    # gives alphabetical order ("Friday" first), not weekday order --
    # matching routers/recurring_notes.py's list endpoint.
    return sorted(rules, key=lambda r: (DAY_ORDER[r.day], r.hour))


@router.patch("/{rule_id}", response_model=CoverageRuleOut)
def patch_coverage_rule(
    rule_id: int,
    payload: CoverageRulePatch,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionCoverageRule:
    rule = db.get(ReceptionCoverageRule, rule_id)
    if rule is None:
        raise HTTPException(
            status_code=404, detail=f"Coverage rule {rule_id} not found"
        )
    rule.min_phones_staff = payload.min_phones_staff
    db.commit()
    db.refresh(rule)
    return rule
