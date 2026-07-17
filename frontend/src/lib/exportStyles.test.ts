import { describe, expect, it } from "vitest";

import { BACKGROUND_HEX, CLOSED_COLUMN_HEX, FONT_HEX, argb } from "./exportStyles";

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
