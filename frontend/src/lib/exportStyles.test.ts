import { describe, expect, it } from "vitest";

import {
  BACKGROUND_HEX,
  CLOSED_COLUMN_HEX,
  FONT_HEX,
  LEAVE_CELL_FONT_HEX,
  LEAVE_CELL_HEX,
  LEAVE_MUTED_FONT_HEX,
  NO_SURGERY_HEX,
  OUT_OF_MONTH_HEX,
  OUT_OF_WINDOW_HEX,
  ROOM_OCCUPIED_HEX,
  SCHOOL_HOLIDAY_HEX,
  argb,
  coverageFillHex,
} from "./exportStyles";

const HEX6 = /^[0-9A-F]{6}$/;

describe("exportStyles", () => {
  it("argb prefixes a 6-digit hex with full opacity (FF)", () => {
    expect(argb("E5E7EB")).toBe("FFE5E7EB");
  });

  it("every non-null BACKGROUND_HEX entry is a plain 6-digit hex string", () => {
    for (const [key, value] of Object.entries(BACKGROUND_HEX)) {
      if (value === null) continue;
      expect(value, `BACKGROUND_HEX.${key}`).toMatch(HEX6);
    }
  });

  it("wfh and default carry no fill (null), matching the UI's unstyled/white cell", () => {
    expect(BACKGROUND_HEX.wfh).toBeNull();
    expect(BACKGROUND_HEX.default).toBeNull();
  });

  it("every FONT_HEX entry is a plain 6-digit hex string", () => {
    for (const [key, value] of Object.entries(FONT_HEX)) {
      expect(value, `FONT_HEX.${key}`).toMatch(HEX6);
    }
  });

  it("CLOSED_COLUMN_HEX is a plain 6-digit hex string", () => {
    expect(CLOSED_COLUMN_HEX).toMatch(HEX6);
  });
});

describe("exportStyles - leave planner", () => {
  it("every non-null LEAVE_CELL_HEX entry is a plain 6-digit hex string", () => {
    for (const [key, value] of Object.entries(LEAVE_CELL_HEX)) {
      if (value === null) continue;
      expect(value, `LEAVE_CELL_HEX.${key}`).toMatch(HEX6);
    }
  });

  it("a normal cell carries no fill, matching the grid's bg-surface", () => {
    expect(LEAVE_CELL_HEX.normal).toBeNull();
  });

  it("every LEAVE_CELL_FONT_HEX entry is a plain 6-digit hex string", () => {
    for (const [key, value] of Object.entries(LEAVE_CELL_FONT_HEX)) {
      expect(value, `LEAVE_CELL_FONT_HEX.${key}`).toMatch(HEX6);
    }
  });

  it("the standalone leave fills are plain 6-digit hex strings", () => {
    for (const [name, value] of Object.entries({
      NO_SURGERY_HEX,
      SCHOOL_HOLIDAY_HEX,
      OUT_OF_WINDOW_HEX,
      OUT_OF_MONTH_HEX,
      LEAVE_MUTED_FONT_HEX,
    })) {
      expect(value, name).toMatch(HEX6);
    }
  });

  it("the three pinned ink-derived greys stay distinct from each other and from white", () => {
    const greys = [OUT_OF_WINDOW_HEX, OUT_OF_MONTH_HEX, NO_SURGERY_HEX, "FFFFFF"];
    expect(new Set(greys).size).toBe(greys.length);
  });

  it("the leave export's greys do not collide with the rota export's", () => {
    expect(NO_SURGERY_HEX).not.toBe(CLOSED_COLUMN_HEX);
    expect(NO_SURGERY_HEX).not.toBe(ROOM_OCCUPIED_HEX);
  });

  it("coverageFillHex flags thin cover at the grid's thresholds", () => {
    expect(coverageFillHex(0)).toBe("FECACA");
    expect(coverageFillHex(2)).toBe("FECACA");
    expect(coverageFillHex(3)).toBe("FED7AA");
    expect(coverageFillHex(4)).toBe("FEF08A");
  });

  it("coverageFillHex leaves adequate cover, closed and unfetched slots unfilled", () => {
    expect(coverageFillHex(5)).toBeNull();
    expect(coverageFillHex(12)).toBeNull();
    expect(coverageFillHex(null)).toBeNull();
    expect(coverageFillHex(undefined)).toBeNull();
  });

  it("every coverageFillHex fill is a plain 6-digit hex string", () => {
    for (const total of [0, 1, 2, 3, 4]) {
      expect(coverageFillHex(total), `coverageFillHex(${total})`).toMatch(HEX6);
    }
  });
});
