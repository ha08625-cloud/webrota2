import { useMemo } from "react";

import { useClosures } from "@/api/closures";
import { useRooms } from "@/api/rooms";
import type { Day, Period, Rota } from "@/api/types";
import { RoleLabel } from "@/components/RotaGrid";
import { WeekTabs } from "@/components/WeekTabs";
import { isDayFullyClosed, isDayPartlyClosed, isSlotClosed, partlyClosedPeriod, toClosedSlotSet } from "@/lib/closedSlots";
import { DAYS, weekNumbers } from "@/lib/pivot";
import { getRoomCell, pivotRoomRota } from "@/lib/pivotRoomRota";
import { rotaDate } from "@/lib/weekDates";

interface RoomRotaGridProps {
  rota: Rota;
  activeWeek: number;
  onWeekChange: (week: number) => void;
}

/**
 * Read-only room-occupancy view of a generated rota: which rooms are
 * free this session, and who is in the occupied ones. Pure frontend
 * transformation of data already fetched by the caller via useRota - no
 * mutation callbacks, no dnd-kit, no popover. Structurally closer to
 * RotaGrid's ReadOnlyGridCell than to its editable counterpart, and that
 * holds regardless of rota.status.
 */
export function RoomRotaGrid({ rota, activeWeek, onWeekChange }: RoomRotaGridProps) {
  const { data: rooms, isLoading: roomsLoading } = useRooms();
  const { data: closures } = useClosures(null);

  const weeks = useMemo(() => weekNumbers(rota.num_weeks), [rota.num_weeks]);
  const grid = useMemo(() => pivotRoomRota(rota.sessions, rooms ?? []), [rota.sessions, rooms]);

  /**
   * (date, period) closed-slot lookup for this rota - authoritative from
   * rota.closed_slots, the RotaClosure snapshot taken at generation time.
   * Copied verbatim from RotaGrid: a closure added or removed afterwards
   * must not change how an already-generated rota renders, and a
   * closed-slot check must run before the occupancy lookup below -
   * otherwise a closed day, which has no sessions at all, renders as a
   * full column of false "Available" cells.
   */
  const closedSlotSet = useMemo(() => toClosedSlotSet(rota.closed_slots), [rota.closed_slots]);

  /**
   * Closure name lookup, purely cosmetic - copied verbatim from RotaGrid.
   * Deliberately sourced from the *live* closures list, unlike
   * closedSlotSet above: a closure's name is display-only trivia, not
   * part of what makes a date "closed" for this rota, so falling back to
   * no name if the closure is later renamed or deleted is an acceptable,
   * low-risk cosmetic gap.
   */
  const closureNameByDate = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const c of closures ?? []) map.set(c.date, c.name);
    return map;
  }, [closures]);

  // Heavier divider under the last row of each room_type group, mirroring
  // RotaGrid's per-doctor group dividers - computed as a Set of row
  // indices from consecutive rows' room_type, since grid.rows is already
  // in ROOM_TYPE_ORDER order (pivotRoomRota's compareRoomDisplayOrder).
  const groupEndIndices = useMemo(() => {
    const ends = new Set<number>();
    for (let i = 0; i < grid.rows.length - 1; i++) {
      if (grid.rows[i].room_type !== grid.rows[i + 1].room_type) ends.add(i);
    }
    return ends;
  }, [grid.rows]);

  if (roomsLoading) {
    return <p className="text-sm text-ink/70">Loading grid...</p>;
  }

  function renderDayHeaderRow() {
    return (
      <tr>
        <th className="sticky left-0 z-10 w-24 border-b-2 border-r-2 border-ink/40 bg-background px-2 py-1 text-left font-medium text-ink/70">
          Room
        </th>
        {DAYS.map((day, dayIndex) => {
          const date = rotaDate(rota.start_date, activeWeek, day);
          const fullyClosed = isDayFullyClosed(closedSlotSet, date);
          const partlyClosed = isDayPartlyClosed(closedSlotSet, date);
          const closureName = closureNameByDate.get(date);
          const closedPeriod = partlyClosedPeriod(closedSlotSet, date);
          return (
            <th
              key={day}
              data-testid={`room-day-header-${day}`}
              className={`border-b-2 border-ink/40 px-2 py-1 text-center font-medium ${
                fullyClosed ? "bg-gray-200 text-ink/40" : "text-ink/70"
              } ${dayIndex === DAYS.length - 1 ? "" : "border-r-2"}`}
            >
              {day}
              {fullyClosed ? (
                <div className="text-[10px] font-normal">{closureName ? closureName : "closed"}</div>
              ) : null}
              {partlyClosed ? (
                <div className="text-[10px] font-normal">{`${closureName ? closureName : "closed"} (${closedPeriod})`}</div>
              ) : null}
            </th>
          );
        })}
      </tr>
    );
  }

  function renderBlock(heading: string, period: Period) {
    return (
      <div className="mt-4">
        <h3 className="mb-1 text-sm font-medium text-ink/70">{heading}</h3>
        <table className="min-w-full border-collapse text-sm">
          <thead>{renderDayHeaderRow()}</thead>
          <tbody>
            {grid.rows.map((room, rowIndex) => {
              const groupDividerClass = groupEndIndices.has(rowIndex) ? "border-b-2 border-ink/40" : "";
              return (
                <tr key={room.id}>
                  <td
                    className={`sticky left-0 z-10 whitespace-nowrap border-r-2 border-ink/40 bg-background px-2 py-1 align-top font-medium ${groupDividerClass}`}
                  >
                    {room.code}
                  </td>
                  {DAYS.map((day, dayIndex) => {
                    const dividerClassName = `${dayIndex === DAYS.length - 1 ? "" : "border-r-2 border-ink/40"} ${groupDividerClass}`;
                    return (
                      <RoomCell
                        key={day}
                        roomId={room.id}
                        week={activeWeek}
                        day={day}
                        period={period}
                        closed={isSlotClosed(closedSlotSet, rotaDate(rota.start_date, activeWeek, day), period)}
                        grid={grid}
                        dividerClassName={dividerClassName}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <WeekTabs weeks={weeks} activeWeek={activeWeek} onWeekChange={onWeekChange} />
      {renderBlock("Morning", "AM")}
      {renderBlock("Afternoon", "PM")}
    </div>
  );
}

interface RoomCellProps {
  roomId: number;
  week: number;
  day: Day;
  period: Period;
  closed: boolean;
  grid: ReturnType<typeof pivotRoomRota>;
  dividerClassName: string;
}

/**
 * Cell logic, in order (M4.x room-view plan, Task 3): closed date first
 * (must precede the occupancy lookup - see closedSlotSet above),
 * then occupied (a session holds this room this slot), then available.
 * Every branch carries data-week-day-period so IssuesPanel navigation
 * (which queries for the first DOM match of that attribute) keeps
 * working in room view with zero IssuesPanel changes.
 */
function RoomCell({ roomId, week, day, period, closed, grid, dividerClassName }: RoomCellProps) {
  const weekDayPeriod = `${week}-${day}-${period}`;

  if (closed) {
    return (
      <td
        className={`border border-border bg-gray-200 ${dividerClassName}`}
        data-week-day-period={weekDayPeriod}
      />
    );
  }

  const session = getRoomCell(grid, roomId, week, day, period);

  if (session === undefined) {
    return (
      <td
        className={`border border-border bg-green-100 px-2 py-1 text-center ${dividerClassName}`}
        data-testid={`room-cell-${roomId}-${week}-${day}-${period}`}
        data-week-day-period={weekDayPeriod}
      >
        <div className="text-xs font-medium text-ink/60">Available</div>
      </td>
    );
  }

  return (
    <td
      className={`border border-border bg-red-100 px-2 py-1 text-center ${dividerClassName}`}
      data-testid={`room-cell-${roomId}-${week}-${day}-${period}`}
      data-week-day-period={weekDayPeriod}
    >
      <div className="text-xs font-medium">{session.doctor_code}</div>
      {/* Leave holders render as occupants with a LEAVE badge rather than
          as available: reachable on committed rotas
          where leave was added post-commit, since nothing can be
          reassigned there anyway, so "available" would be a false
          promise. WFH-with-room is unreachable by construction (PATCH
          clears the room, set-room clears the flag, generation never
          rooms a WFH slot) - no is_wfh branch is needed here. */}
      {session.is_on_leave ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">LEAVE</span>
      ) : (
        <RoleLabel role={session.role} clinicName={session.clinic_type_name} />
      )}
      {session.is_supervising ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">Supervising</span>
      ) : null}
    </td>
  );
}