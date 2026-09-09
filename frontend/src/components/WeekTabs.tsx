interface WeekTabsProps {
  weeks: number[];
  activeWeek: number;
  onWeekChange: (week: number) => void;
  /**
   * The generation week covering today, marked with a "(this week)"
   * suffix so it stays identifiable even when another week is selected.
   * Only the committed-rota view passes it; everywhere else the rota on
   * screen is a draft being built for a future week, where the marker
   * would be noise.
   */
  currentWeek?: number | null;
}

/**
 * Week tab strip, shared by RotaGrid (doctor view) and RoomRotaGrid (room
 * view) so both grids select from the same week state when toggled in
 * RotaDetailPage. Moved verbatim out of RotaGrid - same classes, same
 * aria wiring, same "always render even for one week" behaviour.
 */
export function WeekTabs({ weeks, activeWeek, onWeekChange, currentWeek = null }: WeekTabsProps) {
  return (
    // Week tabs always render, even for a single-week rota - keeps the
    // tab UI consistent rather than conditionally reshaping around
    // num_weeks.
    <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Week">
      {weeks.map((week) => (
        <button
          key={week}
          type="button"
          role="tab"
          aria-selected={week === activeWeek}
          onClick={() => onWeekChange(week)}
          className={`px-4 py-2 text-sm font-medium ${
            week === activeWeek
              ? "border-b-2 border-accent text-accent"
              : "text-ink/60 hover:text-ink"
          }`}
        >
          Week {week}
          {week === currentWeek ? <span className="ml-1 font-normal text-ink/60">(this week)</span> : null}
        </button>
      ))}
    </div>
  );
}
