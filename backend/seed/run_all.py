"""Run all seed scripts in dependency order against the configured database.

Usage (from backend/):  uv run python -m seed.run_all
"""
from sqlalchemy.orm import Session

from app.database import SessionLocal
from seed.seed_rooms import seed_rooms
from seed.seed_doctors import seed_doctors
from seed.seed_system_counters import seed_system_counters
from seed.seed_master_rota import seed_master_rota


def run_all(session: Session) -> None:
    seed_rooms(session)
    seed_doctors(session)
    seed_system_counters(session)
    seed_master_rota(session)


def main() -> None:
    session = SessionLocal()
    try:
        run_all(session)
        session.commit()
        print("Seed complete.")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()