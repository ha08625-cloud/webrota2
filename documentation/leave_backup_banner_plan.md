# Provisional Plan — Weekly leave-backup banner

Output of the discussion chat. **This is a provisional plan, not an
implementation plan**: it is meant to be pasted into a fresh chat, reviewed,
corrected and expanded before any code is written. Every code fact in "State
of the world" was read off the file it names during this chat; everything in
"Design Decisions" is a proposal.

## Gate before any code is written

Read this section before building anything. Three things are true of this
feature, and the practice manager should hear all three, because the fear
being answered here is "we lose everyone's leave" and this does not fully
answer it.

1. **The banner backs up leave, and only leave.** The Annual Planner export
   is leave, extra sessions, blocked entries and clinical-cover totals for
   one calendar year. If the database is lost, everything else goes with it:
   doctors, the master rota template, clinic types, rooms, duty and duty
   opening balances, closures and bank holidays, school holidays, committed
   and archived rotas, recurring notes, counters, the whole reception
   section, users and permissions, and the stored signature images. The
   practice would keep its leave and rebuild the rest by hand.
2. **The workbook is a report, not a restore path.** There is no importer,
   and none is proposed here. Recovery means a person re-entering the year's
   leave cell by cell into a rebuilt system. That is genuinely better than
   nothing — it is the difference between re-keying from a spreadsheet and
   phoning fifteen doctors — but "we have a backup" should not be heard as
   "we can restore".
3. **Railway takes automated Postgres backups, and turning those on is
   probably an afternoon's work at most, not a ticket.** Check the Railway
   Postgres service's Backups tab before building this. If scheduled dumps
   can be switched on this week, the honest recommendation is to do that
   first and treat this banner as a convenience for the practice manager
   (a spreadsheet they can open in Excel and mail to themselves) rather
   than as the data-loss answer. The two are not alternatives, but only one
   of them is a backup.

A fourth, smaller point: a downloaded file in one person's `Downloads`
folder on one practice laptop shares a failure mode with the server. The
banner text should say where to put it, and that wording is the practice
manager's to write, not ours — see `TODO(decide)` below.

## Plan

A banner across the top of every Clinical Rota page, shown to users with
clinical **write** access when no annual-leave export has been recorded in
the last seven days, linking to the Annual Planner. Exporting from that page
records the fact server-side and the banner goes away for everyone until the
next one is due.

The export itself already exists (`Export to Excel` on `LeavePlanningPage`,
built entirely client-side by `lib/exportLeavePlanning.ts`). Nothing about
the workbook changes. This ticket is only the *prompt*, the *record* that
one was taken, and the *staleness rule*.

## Scope

In:

- One new table and migration recording each export.
- Two endpoints on the existing `/leave-planning` router.
- One `useBackupStatus` query hook and one `useRecordBackup` mutation.
- One `LeaveBackupBanner` component, rendered by `ClinicalShell`.
- A "Last backup: …" line on `LeavePlanningPage` beside the export button.
- Tests on both sides; architecture-clinical.md updated.

Out, deliberately:

- Any change to the workbook's contents.
- Any import or restore path.
- The reception section, which has its own leave page and no export at all.
  A reception-leave export is a separate ticket if anyone wants one.
- Email or push reminders. The banner is in-app only; a user who never opens
  the app is never prompted, and that is accepted.
- Any backend scheduling. There is no cron in this app and this feature does
  not introduce one — "weekly" is a staleness comparison done at read time,
  not a job that fires.

## State of the world

- `LeavePlanningPage.tsx:364` — `handleExport()` fetches twelve months of
  coverage via `fetchYearCoverage`, builds the workbook with
  `buildLeavePlanningWorkbook`, and calls `downloadBlob(blob, "leave-plan-{year}.xlsx")`. A failure sets the page's own error line
  rather than throwing, so a bad export cannot take pending grid edits down.
  The button is at line ~515 and is **not** gated on write access.
- `app/api/main.py:186-229` — every router is gated at registration by
  `Depends(require_access(_AREA[module]))`. `require_access` (`deps.py:203`)
  lets any method in `_SAFE_METHODS` through on `READ`, and requires `WRITE`
  for anything else. So a `GET` added to `leave_planning.py` is readable by
  a clinical reader and a `POST` is automatically write-gated, with no new
  dependency to wire.
- `app/api/routers/leave_planning.py` currently holds `GET /coverage`,
  `GET /blocked` and `POST /bulk`. Its endpoints take `get_current_user`
  directly; the area gate is applied at registration, not per-endpoint.
- `app/models/audit.py` — the audit log records **only non-GET requests that
  reach the API**, written by middleware. The export is entirely
  client-side and issues no request at all, so the audit log cannot be the
  record here; that is the reason for the new table rather than a query
  against `audit_log`.
- `alembic/versions/` — latest is `013_counter_opening_balance.py`. The new
  migration is `014`.
- `src/api/leavePlanning.ts` — `leavePlanningKeys.all` is invalidated after
  every planning bulk save (`:125`). The backup status must therefore **not**
  be keyed under `leavePlanningKeys.all`, or every grid save refetches it.
- `src/App.tsx:212` — `ClinicalShell` computes `canWrite` at :215 already,
  and renders `<main className="flex-1 p-6">` at :255. The banner goes
  immediately inside `<main>`, above the `PermissionAreaProvider`.

## Design Decisions

**Server-side and practice-wide, not `localStorage`.** The question the
practice manager actually has is "did anyone take a copy this week?", and
only the server can answer it. A per-browser record answers "did *this
browser* take a copy", which nags a second admin who has no way of knowing
the first one already did it, and forgets everything when site data is
cleared. It also cannot show the "Last backup: Monday 8 September, by Jane"
line, which is the part of this feature that actually settles the fear —
the banner disappearing is not evidence, a dated record is.

**A new table, not a key-value settings row.** `leave_backup_exports`, one
row per export: `id`, `at` (timezone-aware UTC, set in Python, same
convention as `audit_log.at`), `user_id` (nullable FK to `users.id`),
`user_email` (frozen snapshot, same reasoning as the audit log's), and
`year` (the planner year exported). A row-per-export rather than a single
mutable "last backup" row because the history is worth having and costs
nothing: 52 rows a year, and "we thought we were backing up but the last one
was in March" is exactly the question this table should be able to answer.
No pruning.

**The seven-day rule lives on the server.** `GET
/leave-planning/backup-status` returns `{last_export: {at, user_email,
year} | null, due: bool}`, with `due` computed against a
`BACKUP_INTERVAL_DAYS = 7` constant in the router. Putting the comparison
server-side keeps the client's clock out of it and means the banner, the
"Last backup" line and any future reminder all agree by construction.

**Rolling seven days, not a calendar week.** An export on Sunday should not
be re-prompted on Monday morning. `due` is `last_export is None or now -
last_export.at > 7 days`. A calendar-week rule (nag every Monday until
someone exports) is the obvious alternative and was rejected for that
Sunday-evening case, but it is a one-line change if the practice would
rather have a fixed day.

**No export ever recorded means due.** The banner is on from the day this
ships, which is correct: at that moment no backup exists.

**Only write-holders' exports count, and this is a wart worth stating.**
The export button is deliberately ungated (`architecture-clinical.md`: every
figure in the workbook is already on the screen that offers it), but `POST
/leave-planning/backup` sits on a write-gated router, so a clinical *reader*
who exports will 403 on the recording call. The frontend therefore only
fires the mutation when `useCanWrite()` is true, and a reader's export
silently does not reset the practice-wide clock. The alternative — adding the
POST to `deps.py`'s `_SHARED_READ` so readers can record it — was rejected as
a widening of a security boundary for a case that does not arise: readers are
not who the practice manager is relying on. A reader never sees the banner
either, so nothing about their experience is inconsistent.

**A failed recording call must not fail the export.** The download has
already happened by the time the mutation fires; the backup is real whether
or not the server heard about it. `useRecordBackup` therefore fires
fire-and-forget after `downloadBlob`, and its failure is swallowed rather
than surfaced on the page's error line. The visible consequence is that the
banner stays up — which is the fail-safe direction, and the only direction
this feature is allowed to fail in.

**Dismissal is per-session, not per-week.** The banner gets a dismiss "×"
that hides it for the rest of the browser session (`sessionStorage`, keyed
on nothing more than the fact of dismissal). It deliberately does **not**
suppress the banner for a week: the only thing that clears the week is an
actual export. A dismiss that outlives the session would let someone silence
a backup that never happened, which is the failure mode this whole ticket
exists to prevent.

**The banner is amber, not red.** It follows the existing undated-bank-holiday
banner on the Annual Planner (`architecture-clinical.md:132`) — same amber,
same position, same "this is a warning, not an error" register. Nothing is
broken; a task is overdue.

**Shell-level, with the query fired once.** `LeaveBackupBanner` calls
`useBackupStatus()` itself and renders `null` when `!due`, when the query is
loading or errored (an unreachable status endpoint must not produce a banner
that says nothing), or when dismissed. `ClinicalShell` renders it only when
`canWrite`, so a reader never issues the query at all. React Query dedupes
across clinical page navigations, so this is one request per session plus
refetches, not one per page.

## TODO(decide)

1. **The banner's exact wording, and where the file should be kept.** Draft:
   *"No annual leave backup has been downloaded in the last 7 days. Export
   the Annual Planner and save it to [somewhere]."* The bracketed part is a
   practice decision — a shared drive, a specific folder, emailed to the
   practice manager — and the banner is worth nothing if it says
   "Downloads". This needs the practice manager's answer before the string
   is written.
2. **Seven days, or a fixed weekday?** See "Rolling seven days" above.
3. **Should the "Last backup" line be visible to clinical readers?** The
   proposal shows it on `LeavePlanningPage` to everyone with clinical read
   (it is a `GET`, so the gate allows it) while only prompting writers. The
   alternative is writers-only for both.
4. **Does the year matter?** The proposal records which planner year was
   exported and ignores it in the staleness rule, so exporting 2019 twelve
   times satisfies the banner. Making `due` year-aware ("no backup of the
   *current* year in 7 days") is stricter and closer to the intent, at the
   cost of a rule nobody will be able to predict from the banner text.

## Task breakdown (provisional)

1. **Data model** — `app/models/leave_backup.py`, export from
   `app/models/__init__.py`, migration `014_leave_backup_exports.py`.
2. **API** — `backup-status` and `backup` endpoints in
   `routers/leave_planning.py`, schemas in `schemas/leave_planning.py`,
   `BACKUP_INTERVAL_DAYS`, router tests covering: no rows → `due`, a row
   six days old → not due, a row eight days old → due, reader `GET` 200,
   reader `POST` 403.
3. **Frontend plumbing** — `useBackupStatus` / `useRecordBackup` in
   `src/api/leavePlanning.ts` under their own `leaveBackupKeys` root (not
   `leavePlanningKeys.all`), types in `src/api/types.ts`, the
   fire-and-forget call in `handleExport`, the "Last backup" line, and
   invalidation of the status key on a successful record.
4. **Banner** — `src/components/LeaveBackupBanner.tsx` plus its test, and
   the `ClinicalShell` wiring in `App.tsx` behind `canWrite`.
5. **Review and documentation** — update `documentation/architecture-clinical.md`
   (Annual Planner section: the record table, the staleness rule, the
   reader/writer asymmetry, and the gate section's three caveats in one
   short paragraph), then delete this plan file.
