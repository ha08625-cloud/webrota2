import { describe, expect, it } from "vitest";

import { argb } from "@/lib/exportStyles";

// SCRATCH SPIKE - proves exceljs works in this Vite + Vitest setup before
// Tasks 2-4 build on it. Delete this file (or fold it into Task 4's real
// export tests) once it passes. Do not commit as-is.
describe("exceljs spike", () => {
  it("builds a workbook with a fill, font colour, column width, and a note, then round-trips through a buffer", async () => {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Week 1");

    sheet.getColumn(1).width = 20;
    const cell = sheet.getCell("A1");
    cell.value = "Test";
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: argb("E5E7EB") },
    };
    cell.font = { color: { argb: argb("B91C1C") } };
    cell.note = "spike note";

    const buffer = await workbook.xlsx.writeBuffer();
    expect(buffer.byteLength).toBeGreaterThan(0);

    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer as ExcelJS.Buffer);
    const reloadedSheet = reloaded.getWorksheet("Week 1");
    expect(reloadedSheet).toBeDefined();
    const reloadedCell = reloadedSheet!.getCell("A1");
    expect(reloadedCell.value).toBe("Test");
    expect(reloadedCell.note).toBeDefined();
  });
});
