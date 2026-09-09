"""One-off, idempotent backfill: insert any missing SystemCounter rows.

Repairs a database where doctors were created (or retyped) through the API
before create_doctor maintained the counter invariant -- the cause of the
NoResultFound 500 in generate._write_counters. Unlike seed_system_counters
(fresh-database only, not idempotent), this script reads the existing
(doctor_id, counter_type) pairs first and inserts only what is missing, so
it is safe to run repeatedly and never touches existing raw_count values.

Usage (from backend/, against the live database):
    DATABASE_URL=<Railway DATABASE_PUBLIC_URL> uv run python -m seed.backfill_system_counters
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import Doctor, SystemCounter
from app.models.enums import SystemCounterType

_ALL_TYPES = (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION)


def backfill_system_counters(session: Session) -> list[SystemCounter]:
    """Insert a zero-count row for every (doctor, counter_type) pair that
    does not already exist. Returns the rows added (empty list if the
    invariant already holds).
    """
    doctor_ids = session.execute(select(Doctor.id)).scalars().all()
    existing = set(
        session.execute(
            select(SystemCounter.doctor_id, SystemCounter.counter_type)
        ).all()
    )

    added: list[SystemCounter] = []
    for did in doctor_ids:
        for ct in _ALL_TYPES:
            if (did, ct) in existing:
                continue
            row = SystemCounter(doctor_id=did, counter_type=ct, raw_count=0)
            session.add(row)
            added.append(row)

    session.flush()
    return added


def main() -> None:
    session = SessionLocal()
    try:
        added = backfill_system_counters(session)
        session.commit()
        if added:
            print(f"Backfilled {len(added)} missing system counter row(s):")
            for row in added:
                print(f"  doctor_id={row.doctor_id} counter_type={row.counter_type.value}")
        else:
            print("No missing rows; counter invariant already holds.")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
