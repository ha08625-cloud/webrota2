import { useEffect, useMemo, useState } from "react";

import { useRota, useRotaList } from "@/api/rota";
import type { RotaSummary } from "@/api/types";
import { RoomRotaGrid } from "@/components/RoomRotaGrid";
import { RotaGrid } from "@/components/RotaGrid";
import { addDays, formatDate, getCurrentRotaMonday, rotaWeekForMonday } from "@/lib/date";

/**
 * The published-rota view: every committed, unarchived rota in one list,
 * with the one covering this week picked out and opened by default, and
 * its grid rendered underneath.
 *
 * This exists because the clinical section's index page is a generation
 * console - staging form, duty staffing preview, clinic enable
 * checkboxes, commit history - none of which means anything to someone
 * who only needs to know where they are working this week. A read-only
 * clinical login is sent here instead (App.tsx's CLINICAL_READER_HOME).
 *
 * It is a reader's page only: the nav entry is hidden from a login that can
 * write in the clinical section, and App.tsx bounces such a login off the
 * route, because the generate console's commit history and the rota detail
 * page behind it already cover committed rotas with the lifecycle controls a
 * writer needs.
 *
 * Deliberately not a variant of RotaDetailPage: that page is the editing
 * and lifecycle surface (commit, scrap, archive, rollback, force delete,
 * issues panel, generation log) and would need most of itself
 * conditioned away to serve as a reader's landing page. The two grids are
 * already read-only for a committed rota, so the whole page is those two
 * plus a picker.
 *
 * Archived rotas are excluded rather than shown behind a second tab: the
 * generate page's committed history still lists them, and archiving is
 * precisely the action that says a rota should stop appearing in the
 * everyday view.
 */
export function CommittedRotasPage() {
  const { data: rotas, isLoading, isError } = useRotaList();
  const [view, setView] = useState<"doctor" | "room">("doctor");
  const [selectedRotaId, setSelectedRotaId] = useState<number | null>(null);
  const [activeWeek, setActiveWeek] = useState(1);

  // Recomputed per render rather than held in state: a session left open
  // across midnight should roll onto the new week on its next render, not
  // keep pointing at a stale "today".
  const currentMonday = getCurrentRotaMonday();

  // Newest first - the rota someone wants is nearly always the latest
  // one, and a practice accumulates these indefinitely.
  const committed = useMemo(
    () =>
      (rotas ?? [])
        .filter((rota) => rota.status === "committed" && rota.archived_at === null)
        .sort((a, b) => b.start_date.localeCompare(a.start_date)),
    [rotas],
  );

  const currentRota = useMemo(
    () => committed.find((rota) => rotaWeekForMonday(rota.start_date, rota.num_weeks, currentMonday) !== null) ?? null,
    [committed, currentMonday],
  );

  // Default selection: the rota covering this week, else the most recent
  // one. Applied in an effect keyed on the resolved default so that a
  // list arriving after first paint still lands on the right rota, while
  // a user's own click is never overridden (the effect only fires when
  // the default itself changes).
  const defaultRotaId = currentRota?.rota_id ?? committed[0]?.rota_id ?? null;
  useEffect(() => {
    setSelectedRotaId(defaultRotaId);
  }, [defaultRotaId]);

  const selected = committed.find((rota) => rota.rota_id === selectedRotaId) ?? null;

  // Which week of the *selected* rota is the current one - null whenever
  // the selection is a past or future rota, which is also what suppresses
  // the "(this week)" tab marker there.
  const selectedCurrentWeek = selected
    ? rotaWeekForMonday(selected.start_date, selected.num_weeks, currentMonday)
    : null;

  // Open on the current week when the selected rota has one; otherwise
  // week 1. Same effect shape as the selection default above.
  useEffect(() => {
    setActiveWeek(selectedCurrentWeek ?? 1);
  }, [selectedRotaId, selectedCurrentWeek]);

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading rotas...</p>;
  }

  if (isError || !rotas) {
    return <p className="text-sm text-red-700">Could not load rotas.</p>;
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Committed rotas</h1>

      {committed.length === 0 ? (
        <p className="mt-2 text-sm text-ink/70">No committed rotas yet.</p>
      ) : (
        <>
          {currentRota === null ? (
            <p className="mt-2 text-sm text-amber-800" data-testid="committed-no-current-week">
              No committed rota covers the week starting {formatDate(currentMonday)}.
            </p>
          ) : null}

          <ul className="mt-3 divide-y divide-border rounded border border-border" data-testid="committed-rota-list">
            {committed.map((rota) => (
              <RotaListRow
                key={rota.rota_id}
                rota={rota}
                isSelected={rota.rota_id === selectedRotaId}
                isCurrent={rota.rota_id === currentRota?.rota_id}
                onSelect={() => setSelectedRotaId(rota.rota_id)}
              />
            ))}
          </ul>

          {selected ? (
            <SelectedRota
              rotaId={selected.rota_id}
              view={view}
              onViewChange={setView}
              activeWeek={activeWeek}
              onWeekChange={setActiveWeek}
              currentWeek={selectedCurrentWeek}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Inclusive "Mon 6 Jul - Fri 17 Jul 2026" span of a rota. The last day is
 * the Friday of the final week, not the Sunday: the clinical rota is a
 * Mon-Fri grid, so a weekend end date would claim coverage the rota does
 * not have. Same `num_weeks * 7 - 3` arithmetic RotaDetailPage's export
 * filename uses.
 */
function rotaRangeLabel(rota: RotaSummary): string {
  return `${formatDate(rota.start_date)} - ${formatDate(addDays(rota.start_date, rota.num_weeks * 7 - 3))}`;
}

interface RotaListRowProps {
  rota: RotaSummary;
  isSelected: boolean;
  isCurrent: boolean;
  onSelect: () => void;
}

/**
 * One row of the picker. A button rather than a Link: selecting a rota
 * swaps the grid below in place, so there is nowhere to navigate to.
 * "Selected" and "current week" are shown differently on purpose - the
 * two coincide on arrival but come apart as soon as the user clicks
 * another rota, and the current-week marker has to survive that.
 */
function RotaListRow({ rota, isSelected, isCurrent, onSelect }: RotaListRowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
        data-testid={`committed-rota-row-${rota.rota_id}`}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
          isSelected ? "bg-accent/10 font-medium text-accent" : "text-ink/80 hover:bg-accent/5"
        }`}
      >
        <span>{rotaRangeLabel(rota)}</span>
        <span className="text-ink/50">
          {rota.num_weeks} week{rota.num_weeks > 1 ? "s" : ""}
        </span>
        {isCurrent ? (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-900">This week</span>
        ) : null}
      </button>
    </li>
  );
}

interface SelectedRotaProps {
  rotaId: number;
  view: "doctor" | "room";
  onViewChange: (view: "doctor" | "room") => void;
  activeWeek: number;
  onWeekChange: (week: number) => void;
  currentWeek: number | null;
}

/**
 * The grid for whichever rota is selected. Split out so the full rota
 * fetch is keyed on the selection and remounts cleanly when it changes,
 * rather than the list page having to hold a possibly-stale detail
 * payload. No mutation callbacks are passed: RotaGrid derives
 * `editable` from rota.status, and every rota reachable from this page
 * is committed, so it renders read-only with no drag sources and no
 * edit popover.
 */
function SelectedRota({ rotaId, view, onViewChange, activeWeek, onWeekChange, currentWeek }: SelectedRotaProps) {
  const { data: rota, isLoading, isError } = useRota(rotaId);

  if (isLoading) {
    return <p className="mt-4 text-sm text-ink/70">Loading rota...</p>;
  }

  if (isError || !rota) {
    return <p className="mt-4 text-sm text-red-700">Could not load this rota.</p>;
  }

  return (
    <div className="mt-6">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onViewChange("doctor")}
          aria-pressed={view === "doctor"}
          className={`rounded border px-3 py-1.5 text-sm font-medium ${
            view === "doctor" ? "border-accent bg-accent text-white" : "border-border text-ink"
          }`}
        >
          Doctor view
        </button>
        <button
          type="button"
          onClick={() => onViewChange("room")}
          aria-pressed={view === "room"}
          className={`rounded border px-3 py-1.5 text-sm font-medium ${
            view === "room" ? "border-accent bg-accent text-white" : "border-border text-ink"
          }`}
        >
          Room view
        </button>
      </div>

      <div className="mt-3 overflow-x-auto">
        {view === "doctor" ? (
          <RotaGrid rota={rota} activeWeek={activeWeek} onWeekChange={onWeekChange} currentWeek={currentWeek} />
        ) : (
          <RoomRotaGrid rota={rota} activeWeek={activeWeek} onWeekChange={onWeekChange} currentWeek={currentWeek} />
        )}
      </div>
    </div>
  );
}
