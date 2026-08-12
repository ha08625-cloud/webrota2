import type { Day, Doctor, Period, RotaSession } from "@/api/types";
import { formatDate, parseLocalDate } from "@/lib/date";
import { isDayFullyClosed, isDayPartlyClosed, partlyClosedPeriod } from "@/lib/closedSlots";
import { DAYS, PERIODS } from "@/lib/pivot";
import { countSupervisableTrainees } from "@/lib/superviseeCount";

/**
 * Shared, library-agnostic cell-content logic for the rota exports.
 * Everything here is pure text/data: no exceljs, no pdfmake, no React,
 * no DOM.
 *
 * This module is the single authority for *what a cell says*; each export
 * module owns only *how it is drawn*. The functions below were originally
 * duplicated out of RotaGrid.tsx's CellContent into exportRota.ts, and
 * their docstrings carry the mirroring rules that make that duplication
 * trustworthy - a third copy for the PDF export would have guaranteed
 * drift on the next content change, hence the extraction. (exportStyles.ts
 * plays the same role for colour, and still carries its own
 * "KEPT IN SYNC MANUALLY" warning against cellStyle.ts.)
 */

export function supervisedCountKey(week: number, day: Day, period: Period): string {
  return `${week}:${day}:${period}`;
}

/**
 * Mirrors RotaGrid.tsx's RoleLabel exactly: duty_primary -> "Duty",
 * duty_secondary -> "Duty (2nd)", clinic -> clinic name (or "Clinic"),
 * anything else (including null) -> nothing.
 */
export function roleLabelText(role: RotaSession["role"], clinicName: string | null): string | null {
  if (role === "duty_primary") return "Duty";
  if (role === "duty_secondary") return "Duty (2nd)";
  if (role === "clinic") return clinicName ?? "Clinic";
  return null;
}

/**
 * Mirrors RotaGrid.tsx's CellContent line-for-line: LEAVE suppresses
 * everything else except notes; otherwise WFH, then Supervising, then
 * No surgery/Admin, then the role label (shown regardless of WFH, same
 * as the UI), then the room code (suppressed by WFH, same as the UI -
 * is_on_leave already returned above by that point). Notes, when
 * present, are always the trailing line - shown regardless of leave/WFH
 * state, same as the grid's third-row note.
 */
export function cellLines(session: RotaSession, supervisedCount: number): string[] {
  if (session.is_on_leave) {
    const leaveLines = ["LEAVE"];
    if (session.notes !== null && session.notes.trim().length > 0) {
      leaveLines.push(session.notes);
    }
    return leaveLines;
  }

  const lines: string[] = [];

  if (session.is_wfh) {
    lines.push("WFH");
  }

  if (session.is_supervising) {
    lines.push(supervisedCount > 0 ? `Supervising x ${supervisedCount}` : "Supervising");
  }

  if (session.role === null && session.template_type === "no_surgery") {
    lines.push("No surgery");
  }
  if (session.role === null && session.template_type === "admin_time") {
    lines.push("Admin");
  }

  const roleLabel = roleLabelText(session.role, session.clinic_type_name);
  if (roleLabel !== null) {
    lines.push(roleLabel);
  }

  if (!session.is_wfh && session.room_code) {
    lines.push(session.room_code);
  }

  if (session.notes !== null && session.notes.trim().length > 0) {
    lines.push(session.notes);
  }

  return lines;
}

/**
 * Mirrors RoomRotaGrid.tsx's RoomCell content for an occupied room
 * exactly: occupying
 * doctor's code first, then LEAVE (suppressing the role label, same as
 * the on-screen LEAVE-badge branch - a leave holder still occupies the
 * room, it just isn't doing the role), otherwise the role label, then
 * "Supervising" if flagged. The on-screen view never shows a supervised
 * trainee count on the room sheet (unlike the doctor sheet's
 * cellLines/supervisedCounts), so neither does this.
 */
export function roomCellLines(session: RotaSession): string[] {
  const lines = [session.doctor_code];

  if (session.is_on_leave) {
    lines.push("LEAVE");
    return lines;
  }

  const roleLabel = roleLabelText(session.role, session.clinic_type_name);
  if (roleLabel !== null) {
    lines.push(roleLabel);
  }

  if (session.is_supervising) {
    lines.push("Supervising");
  }

  return lines;
}

export function dayHeaderText(
  day: Day,
  date: string,
  closedSlotSet: Set<string>,
  closureNameByDate: Map<string, string | null>,
): string {
  const base = `${day} ${formatDate(date)}`;
  return withClosureSuffix(base, date, closedSlotSet, closureNameByDate);
}

/**
 * The closure suffix shared by dayHeaderText and compactDayHeaderText: a
 * second line naming the closure (or a bare "closed" when the live
 * closures list has no cosmetic name for that date), qualified with the
 * period when only one of AM/PM is closed.
 */
function withClosureSuffix(
  base: string,
  date: string,
  closedSlotSet: Set<string>,
  closureNameByDate: Map<string, string | null>,
): string {
  if (isDayFullyClosed(closedSlotSet, date)) {
    return `${base}\n${closureNameByDate.get(date) ?? "closed"}`;
  }
  if (isDayPartlyClosed(closedSlotSet, date)) {
    const period = partlyClosedPeriod(closedSlotSet, date);
    return `${base}\n${closureNameByDate.get(date) ?? "closed"} (${period})`;
  }
  return base;
}

/** English ordinal suffix for a day-of-month: 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinalSuffix(dayOfMonth: number): string {
  // 11/12/13 are "th" despite ending in 1/2/3, so the teens are checked first.
  if (dayOfMonth >= 11 && dayOfMonth <= 13) return "th";
  const lastDigit = dayOfMonth % 10;
  if (lastDigit === 1) return "st";
  if (lastDigit === 2) return "nd";
  if (lastDigit === 3) return "rd";
  return "th";
}

/**
 * The compact day header used by the PDF export only: "MON 10th" - an
 * uppercase day abbreviation plus the ordinal day of month, matching the
 * practice's printed rota and saving horizontal space on a very tight A4
 * portrait page. The closure suffix behaviour is identical to
 * dayHeaderText's.
 *
 * The abbreviation is sliced from the `day` name rather than derived from
 * `date` via a locale, so the header can never disagree with the column it
 * labels.
 */
export function compactDayHeaderText(
  day: Day,
  date: string,
  closedSlotSet: Set<string>,
  closureNameByDate: Map<string, string | null>,
): string {
  const dayOfMonth = parseLocalDate(date).getDate();
  const base = `${day.slice(0, 3).toUpperCase()} ${dayOfMonth}${ordinalSuffix(dayOfMonth)}`;
  return withClosureSuffix(base, date, closedSlotSet, closureNameByDate);
}

export function toIdMap<T extends { id: number }>(items: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

/**
 * Replicates RotaGrid.tsx's supervisedCounts memo: one
 * countSupervisableTrainees call per (week, day, period), keyed for O(1)
 * lookup in the render loop below. Kept identical to the memo's own
 * iteration (weeks x DAYS x PERIODS) so a future change to that memo is
 * easy to spot as drift here too.
 */
export function buildSupervisedCounts(
  sessions: RotaSession[],
  doctors: Doctor[],
  weeks: number[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const week of weeks) {
    for (const day of DAYS) {
      for (const period of PERIODS) {
        map.set(supervisedCountKey(week, day, period), countSupervisableTrainees(sessions, doctors, week, day, period));
      }
    }
  }
  return map;
}
