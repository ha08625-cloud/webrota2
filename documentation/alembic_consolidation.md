# Plan: Consolidate Alembic migrations into a single pre-live baseline

Provisional plan (workflow step 1). Collapse the 28 accumulated migrations into
one baseline `001`, so that going live starts from a clean, additive-only
history.

## Scope

**In scope**

- Replace `backend/alembic/versions/001..028` with a single hand-finished `001`
  creating the full current schema: 40 tables, 13 Postgres enum types, 82
  indexes.
- Declare in `app/models` the six server-side column defaults that currently
  exist only inside migrations, so the models remain a complete source of truth
  for the schema the baseline generates.
- Restore `backend/alembic/script.py.mako`, which is missing from the repo and
  currently makes `alembic revision` (and therefore `--autogenerate`) fail.
- Reset the Railway database so it can be migrated from the new baseline.
- Update the architecture docs.

**Out of scope**

- Any schema change. This is a pure history rewrite: the schema before and
  after must be byte-identical, and that is the acceptance criterion.
- Changes to seeding, CI job structure, or the test suite's `create_all`
  approach.

## Why now, and what it actually buys

Being honest about the size of the win: 28 migrations is not an operational
problem. Alembic replays them in well under a second, and CI already proves the
whole chain works on Postgres in both directions. Nothing is broken today.

The gains are real but mostly about future cost:

- **One file describes the schema.** Today, answering "when and why did this
  column appear" means reading up to 28 files. The 001 docstring convention in
  this repo is good; there should be one of them, not 28.
- **Six migrations describe data that will never exist again.** 013, 016, 019,
  020, 024 and 027 carry `op.execute` backfills rewriting rows in a database
  that is about to be wiped. Once live, those become permanently dead code that
  nobody dares delete.
- **The downgrade path gets honest.** `downgrade base` currently unwinds 28
  steps of drops and enum juggling that no one will ever run. A single baseline
  has one obvious inverse.
- **This is the cheapest it will ever be.** After go-live the same change costs
  a production data migration; right now it costs a reseed.

Precedent already exists in-repo: `001`'s own docstring records that it was
regenerated repeatedly through M1–M3 for exactly this reason, with "migrations
become additive only from here" as the intent. That line was written one
milestone too early. This plan is that decision, made at the right moment.

**Recommendation: do it, and collapse all the way to a single `001`.** A
partial merge (e.g. keeping the reception migrations separate) keeps the
archaeology problem while adding a second arbitrary boundary, so it gets the
cost without the benefit.

## The risk that matters, and why it is small

The one real failure mode is the new baseline producing a schema that differs
subtly from the current one — a lost default, a dropped index, a renamed
constraint — and nobody noticing until it breaks in production.

That risk has been measured rather than assumed. Running the existing chain
against a real Postgres 16 and comparing the result to `Base.metadata` via
Alembic's `compare_metadata` returns **zero structural differences**. The models
are already an exact description of the migrated schema, so a baseline generated
from them starts correct by construction.

The one gap is server defaults, which `compare_metadata` does not check by
default. Seven columns carry a `DEFAULT` in the migrated schema; only one is
declared in the models:

| Column | Default | Declared in model? |
|---|---|---|
| `rota_stagings.source_template_start_week` | `1` | yes (`staging.py`) |
| `doctors.supervision_preference` | `'normal'` | no |
| `leave_entitlements.carry_over_sessions` | `0` | no |
| `leave_entitlements.adjustment_sessions` | `0` | no |
| `recurring_notes.is_active` | `true` | no |
| `rota_sessions.is_supervising` | `false` | no |
| `users.access_level` | `'nurse'` | no |

All six undeclared ones already have Python-side `default=` in the model, so the
application never depends on the database default — it only matters for direct
SQL inserts (a manual `psql` session, or a raw-SQL seed). Task 1 declares them
in the models rather than hand-patching them into the migration, which both
preserves exact parity and removes the models/migrations split that let them
diverge in the first place.

## Design Decisions

1. **Single baseline, revision id `001`, `down_revision = None`.** Reusing `001`
   rather than inventing `000` or a hash id keeps the numbering convention and
   means the next migration is `002`.
2. **Generate from the models, then hand-finish.** `--autogenerate` gives a
   complete, accurate table and column inventory, but its per-column
   `sa.Enum(...)` output is wrong for this codebase: it emits `CREATE TYPE` once
   per column, which fails with "type already exists" the second time an enum is
   reused across tables. The existing `001` already solves this — create all
   enum types once at the top of `upgrade()`, then reference them with
   `create_type=False`. The generated file gets restructured onto that pattern;
   it is a starting point, not the deliverable.
3. **Server defaults move into the models.** See above. Models stay the single
   source of truth; the migration is derived from them, never the reverse.
4. **Parity is proven by schema diff, not by review.** Two throwaway Postgres
   databases — one migrated by the old chain, one by the new baseline — dumped
   with `pg_dump --schema-only` and diffed. An empty diff is the acceptance
   criterion for Task 2. Reading 350 lines of migration carefully is not a
   substitute, and this check is cheap.
5. **The old chain is deleted, not archived.** Keeping `002..028` in an
   `old/` directory would leave Alembic with two heads or dead files that
   confuse the next reader. Git history is the archive.
6. **`script.py.mako` gets restored and committed.** Its absence is why every
   migration in this repo is hand-authored; this plan needs autogenerate for
   Task 2, and so will future work.
7. **CI is unchanged.** The `migrations-postgres` job's upgrade → downgrade →
   upgrade round trip validates a single baseline exactly as well as a chain.
   Its comment already says it exists to validate "the 001 baseline".

## Task 1: Declare the missing server defaults in the models

*State of the world: nothing done yet. This task changes only `app/models`, and
is independently correct — it can be reviewed and merged on its own merits.*

**Files**

- `backend/app/models/doctor.py` — `supervision_preference`
- `backend/app/models/leave_entitlement.py` — `carry_over_sessions`,
  `adjustment_sessions`
- `backend/app/models/recurring_note.py` — `is_active`
- `backend/app/models/rota.py` — `is_supervising`
- `backend/app/models/user.py` — `access_level`

**Instructions**

Add `server_default=` to each of the six columns, matching the values in the
table above and the existing style in `staging.py:64`. Keep the Python-side
`default=` exactly as it is — it is what the ORM actually uses; the server
default only covers direct SQL inserts. For the two enum columns, the server
default is the enum's **value** string (`"normal"`, `"nurse"`), not the member.
For the two `Numeric(5, 1)` columns, use `"0"`.

No behaviour change is expected: ORM inserts already supply these values, so
tests should pass untouched. Run `uv run pytest tests/test_api/` and the model
tests.

## Task 2: Build and verify the consolidated baseline

*State of the world: Task 1 has declared every server default in the models, so
`app.models` is now a complete description of the target schema.*

**Files**

- `backend/alembic/script.py.mako` — **restore** (take the stock Alembic
  template; it is the standard one, no customisation needed)
- `backend/alembic/versions/001_initial_schema.py` — **rewrite**
- `backend/alembic/versions/002_*.py` … `028_*.py` — **delete all 27**

**Instructions**

1. Restore `script.py.mako` first, or autogenerate cannot run.
2. Stand up a scratch Postgres 16 and migrate it with the *existing* chain
   (`alembic upgrade head`), then `pg_dump --schema-only` it. This is the
   reference schema — capture it before deleting anything.
3. On a second, empty database, autogenerate against the models to get the full
   inventory.
4. Rewrite `001` using the generated output as the checklist, but structured on
   the current `001`'s idiom, which is already correct and should be preserved
   wholesale: the `_ALL_ENUMS` tuple, `_values()`, `_enum()`, `_create_enum_types()`
   and `_drop_enum_types()` helpers, and a `downgrade()` that drops tables in
   reverse-dependency order then drops the enum types. Three enum types have been
   added since the current `001` was written and must join `_ALL_ENUMS`:
   `supervision_preference` (from 012), `reception_role` (018/019/020) and
   `access_level` (028). Expected end state: 40 tables, 13 enum types, 82
   indexes.
5. Rewrite the docstring. It should describe the schema and the consolidation
   decision as of this change — not the M1–M3 history, which is no longer true
   and belongs in git. Say plainly that this is the pre-go-live baseline and
   that migrations are additive from here.
6. Delete `002` through `028`.
7. **Verify.** On a third empty database, `alembic upgrade head` with the new
   baseline, `pg_dump --schema-only`, and diff against the reference dump from
   step 2. The diff must be empty apart from the `alembic_version` row value.
   Then run `downgrade base` and `upgrade head` again to match what CI does.
   Do not proceed past a non-empty diff — investigate it; a difference here is
   the bug this whole task exists to prevent.
8. Confirm the SQLite path still works: delete any local dev `.db` file and run
   `alembic upgrade head` with the default `DATABASE_URL`.

## Task 3: Reset the Railway database

*State of the world: the repo now has a single baseline that provably produces
the same schema as the old chain.*

**This task is only meaningful if the Railway database currently exists with
rows in it — see the open question below.**

The mechanism to understand: Railway's `alembic_version` table holds `'028'`.
The new chain has no revision `028`, so the deploy's `alembic upgrade head` will
fail with `Can't locate revision identified by '028'` and the container will not
start. There is no in-place fix that is honestly simpler than a reset, because
the point of consolidation is that the intermediate revisions no longer exist.

**Instructions**

Drop and recreate the Railway Postgres database (or drop the public schema),
let the next deploy run `alembic upgrade head` from the new baseline, then
re-seed from a local machine against `DATABASE_PUBLIC_URL`, per the Deployment
section of `architecture.md`:

1. `seed/run_all.py` — rooms, doctors, system counters, master template
2. `seed/seed_users.py` — with `SEED_USER_*` set; this is the only way back
   into the app, since every endpoint requires a session and there is no
   fail-open

Clinic types are entered through the frontend and are not seeded, so anything
that was configured there will need re-entering.

**Do this on a deploy you are watching.** A migration failure here takes the
service down until it is fixed, and unlike the CI round trip there is no dry run.

## Task 4: Documentation

*State of the world: consolidation is done and deployed.*

- `documentation/architecture.md` — the Seeding section currently explains that
  "migration 028 backfills every existing user as `nurse`" is why a database
  ends up with a manager in it. Migration 028 will not exist; rewrite that
  sentence to reference the model/schema default instead. Check the CI section's
  description of the migration job still reads correctly for a single baseline.
- Grep the architecture docs for other migration-number references (`0\d\d`)
  and fix or drop each one. Migration numbers were never a good thing to cite
  from prose — the same reasoning as the "do not cite plan documents from code
  comments" rule at the end of `architecture.md`.
- Delete this plan document once the work lands, per the same convention.

## Open question

`architecture.md` line 16 states the app is "deployed to production (Railway,
PostgreSQL), seeded, and verified end to end", while `CLAUDE.md` says the system
is not yet live and no data needs preserving. Those cannot both be fully true,
and which one holds decides whether Task 3 is a five-minute reset or a real
data-loss event. Confirm before starting: is there anything in the Railway
database — configured clinic types, real leave entries, master rota edits — that
would genuinely hurt to lose and re-enter by hand?
