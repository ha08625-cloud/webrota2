import { describe, expect, it } from "vitest";

import { makeClinicType, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";

import { buildRotaPdf } from "./exportRotaPdf";

/**
 * **This suite is deliberately thin, and that is not an oversight**.
 * `exportRota.test.ts` can round-trip its Blob back through ExcelJS and
 * assert on real cell values, fills and merges; there is no equivalent
 * for PDF. The honest ceiling on asserting against PDF bytes is
 * "non-empty, starts with %PDF", which is worth almost nothing on its
 * own.
 *
 * So the real coverage of this feature lives in `rotaPdfModel.test.ts`,
 * which tests row order, cell text, colour and the fitted font size
 * against plain objects. What is left for *this* layer is only whether
 * pdfmake can be loaded and driven at all - i.e. whether the docDefinition
 * this file builds is one pdfmake accepts. That is a genuine risk (a bad
 * `rowSpan` placeholder, an unregistered font, a malformed colour all
 * throw at render time), and rendering a realistic rota end-to-end is
 * what catches it. Do not invest in PDF text extraction here; add
 * assertions to the model suite instead.
 */

const CLOSURE_NAMES = new Map<string, string | null>([["2026-07-08", "Staff training"]]);

/** jsdom's Blob has no arrayBuffer()/text(), so read the magic number via
 * FileReader, which jsdom does implement. */
function readMagic(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).slice(0, 5));
    reader.readAsText(blob.slice(0, 5));
  });
}

describe("buildRotaPdf", () => {
  it("renders a rota exercising every drawing feature into a PDF Blob", async () => {
    // A Wolvercote room, so the blue font colour is drawn as well as the
    // role background fills.
    const room = makeRoom({ id: 1, code: "W1", room_type: "W" });
    const clinicType = makeClinicType({ id: 1, name: "Diabetic clinic" });
    const doctors = [makeDoctor({ id: 1, code: "AA" }), makeDoctor({ id: 2, code: "BB" })];

    const rota = makeRota({
      num_weeks: 2,
      start_date: "2026-07-06",
      // A Wednesday closure, so the greyed column, the greyed day header
      // and the closure-named title all get drawn.
      closed_slots: [
        { date: "2026-07-08", period: "AM" },
        { date: "2026-07-08", period: "PM" },
      ],
      sessions: [
        // Coloured fill + coloured font + a trailing note (the unbold run).
        makeRotaSession({
          doctor_id: 1,
          week: 1,
          day: "Monday",
          period: "AM",
          role: "duty_primary",
          room_id: room.id,
          notes: "back at 11",
        }),
        // Multi-line clinic cell.
        makeRotaSession({
          doctor_id: 1,
          week: 1,
          day: "Tuesday",
          period: "PM",
          role: "clinic",
          clinic_type_id: clinicType.id,
          room_id: room.id,
        }),
        // Second week, so the page break is exercised.
        makeRotaSession({ doctor_id: 2, week: 2, day: "Friday", period: "AM", room_id: room.id }),
      ],
    });

    // Room pages are always on, so passing a room here also draws the
    // occupied / available / closed room cells and the room pages' own
    // fitted font size.
    const blob = await buildRotaPdf(rota, doctors, [room], [clinicType], CLOSURE_NAMES);

    expect(blob.size).toBeGreaterThan(0);
    await expect(readMagic(blob)).resolves.toBe("%PDF-");
  });

  // Also the degenerate room page: no rooms means a table with nothing
  // but its header row.
  it("renders a rota with no doctors and no sessions", async () => {
    const blob = await buildRotaPdf(makeRota({ num_weeks: 1 }), [], [], [], new Map());

    expect(blob.size).toBeGreaterThan(0);
  });
});
