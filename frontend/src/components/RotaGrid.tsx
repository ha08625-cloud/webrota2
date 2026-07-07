import { useMemo, useState } from "react";

import { useClinicTypes } from "@/api/clinicTypes";
import { useDoctors } from "@/api/doctors";
import { useRooms } from "@/api/rooms";
import type { ClinicType, Day, Period, Room, Rota } from "@/api/types";
import { type CellBackground, type FontColor, cellStyle } from "@/lib/cellStyle";
import { DAYS, PERIODS, getCell, pivotRota, weekNumbers } from "@/lib/pivot";

const BACKGROUND_CLASS: Record<CellBackground, string> = {
  leave: "bg-gray-200",
  wfh: "bg-white",
  duty: "bg-red-100",
  duty_helper: "bg-blue-100",
  clinic: "bg-green-100",
  no_surgery: "bg-gray-200",
  default: "bg-white",
};

const FONT_CLASS: Record<FontColor, string> = {
  black: "text-ink",
  red: "text-red-700",
  blue: "text-blue-700",
};

interface RotaGridProps {
  rota: Rota;
}

/**
 * Read-only rota grid: week tabs, pivoted doctor x (day, period) table,
 * full Q13 cell colouring. Used both for draft rotas (this task) and
 * committed rotas (Q10 for free - no separate read-only variant needed).
 * Drag-and-drop, WFH toggling, and notes editing are Task 4's job; this
 * component renders state, it does not mutate it.
 */
export function RotaGrid({ rota }: RotaGridProps) {
  const { data: doctors, isLoading: doctorsLoading } = useDoctors(false);
  const { data: rooms, isLoading: roomsLoading } = useRooms();
  const { data: clinicTypes, isLoading: clinicTypesLoading } = useClinicTypes();

  const weeks = useMemo(() => weekNumbers(rota.num_weeks), [rota.num_weeks]);
  const [activeWeek, setActiveWeek] = useState(weeks[0] ?? 1);

  const roomsById = useMemo(() => toIdMap(rooms), [rooms]);
  const clinicTypesById = useMemo(() => toIdMap(clinicTypes), [clinicTypes]);
  const grid = useMemo(
    () => pivotRota(rota.sessions, doctors ?? []),
    [rota.sessions, doctors],
  );

  if (doctorsLoading || roomsLoading || clinicTypesLoading) {
    return <p className="text-sm text-ink/70">Loading grid...</p>;
  }

  return (
    <div>
      {/* Week tabs always render, even for a single-week rota - keeps the
          tab UI consistent rather than conditionally reshaping around
          num_weeks. */}
      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Week">
        {weeks.map((week) => (
          <button
            key={week}
            type="button"
            role="tab"
            aria-selected={week === activeWeek}
            onClick={() => setActiveWeek(week)}
            className={`px-4 py-2 text-sm font-medium ${
              week === activeWeek
                ? "border-b-2 border-accent text-accent"
                : "text-ink/60 hover:text-ink"
            }`}
          >
            Week {week}
          </button>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 bg-background px-2 py-1 text-left font-medium text-ink/70">
                Doctor
              </th>
              {DAYS.map((day) =>
                PERIODS.map((period) => (
                  <th
                    key={`${day}-${period}`}
                    data-week-day-period={`${activeWeek}-${day}-${period}`}
                    className="border-b border-border px-2 py-1 text-center font-medium text-ink/70"
                  >
                    {day.slice(0, 3)} {period}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map(({ doctor, inactiveWithSessions }) => (
              <tr key={doctor.id}>
                <td className="sticky left-0 whitespace-nowrap bg-background px-2 py-1 font-medium">
                  {doctor.code}
                  {inactiveWithSessions ? (
                    <span className="ml-1 text-xs text-ink/50">(inactive)</span>
                  ) : null}
                </td>
                {DAYS.map((day) =>
                  PERIODS.map((period) => (
                    <GridCell
                      key={`${day}-${period}`}
                      doctorId={doctor.id}
                      week={activeWeek}
                      day={day}
                      period={period}
                      grid={grid}
                      roomsById={roomsById}
                      clinicTypesById={clinicTypesById}
                    />
                  )),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface GridCellProps {
  doctorId: number;
  week: number;
  day: Day;
  period: Period;
  grid: ReturnType<typeof pivotRota>;
  roomsById: Map<number, Room>;
  clinicTypesById: Map<number, ClinicType>;
}

function GridCell({ doctorId, week, day, period, grid, roomsById, clinicTypesById }: GridCellProps) {
  const session = getCell(grid, doctorId, week, day, period);
  const style = cellStyle(session, roomsById, clinicTypesById);

  if (session === undefined) {
    return <td className="border border-border bg-gray-100" aria-label="Absent" />;
  }

  return (
    <td
      className={`border border-border px-2 py-1 text-center ${BACKGROUND_CLASS[style.background]}`}
      data-testid={`cell-${doctorId}-${week}-${day}-${period}`}
    >
      {session.is_on_leave ? <span className="text-xs font-medium text-ink/70">LEAVE</span> : null}
      {!session.is_on_leave && session.is_wfh ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">WFH</span>
      ) : null}
      {!session.is_on_leave ? <RoleChip role={session.role} clinicName={session.clinic_type_name} /> : null}
      {!session.is_on_leave && !session.is_wfh && session.room_code ? (
        <div className={`text-xs font-medium ${FONT_CLASS[style.fontColor]}`}>{session.room_code}</div>
      ) : null}
    </td>
  );
}

function RoleChip({ role, clinicName }: { role: string | null; clinicName: string | null }) {
  if (role === "duty_primary") return <div className="text-xs font-medium">Duty</div>;
  if (role === "duty_secondary") return <div className="text-xs font-medium">Duty (2nd)</div>;
  if (role === "clinic") return <div className="text-xs font-medium">{clinicName ?? "Clinic"}</div>;
  return null;
}

function toIdMap<T extends { id: number }>(items: T[] | undefined): Map<number, T> {
  const map = new Map<number, T>();
  for (const item of items ?? []) {
    map.set(item.id, item);
  }
  return map;
}