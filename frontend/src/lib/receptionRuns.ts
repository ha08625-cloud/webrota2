import type { ReceptionCellData } from "@/lib/pivotReception";

/**
 * One flag per slot, in the order given (always RECEPTION_HOURS order):
 * true when the slot repeats the previous slot's (role, note) pair and
 * should therefore render no visible chip. Both slots must have a
 * session - an absent cell is data ("not expected this slot"), never a
 * run member, so it neither continues a run nor is continued by one.
 */
export function receptionRunContinuations<T extends ReceptionCellData>(
  rowCells: readonly (T | undefined)[],
): boolean[] {
  return rowCells.map((cell, index) => {
    const previous = index === 0 ? undefined : rowCells[index - 1];
    if (cell === undefined || previous === undefined) return false;
    return cell.role === previous.role && (cell.note ?? "") === (previous.note ?? "");
  });
}
