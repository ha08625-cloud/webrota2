import { describe, expect, it } from "vitest";

import {
  describeAuditBody,
  humaniseKey,
  humaniseValue,
  outcomeClass,
  summariseAuditBody,
} from "./auditDetails";

describe("humaniseKey", () => {
  it("turns snake_case into a sentence", () => {
    expect(humaniseKey("sessions_per_week")).toBe("Sessions per week");
    expect(humaniseKey("name")).toBe("Name");
  });

  it("drops a trailing _id, since the value beside it reads as the thing", () => {
    expect(humaniseKey("room_id")).toBe("Room");
    expect(humaniseKey("template_id")).toBe("Template");
  });

  it("prefers an explicit label where the derived one would be wrong", () => {
    expect(humaniseKey("clinic_type_id")).toBe("Clinic type");
    expect(humaniseKey("a_session_id")).toBe("First session");
  });

  it("leaves a key it cannot split alone", () => {
    expect(humaniseKey("")).toBe("");
  });
});

describe("humaniseValue", () => {
  it("renders booleans and nulls as words", () => {
    expect(humaniseValue("active", true)).toBe("Yes");
    expect(humaniseValue("active", false)).toBe("No");
    expect(humaniseValue("doctor_id", null)).toBe("(none)");
  });

  it("resolves an id against its lookup", () => {
    const lookups = { doctorCodes: new Map([[7, "AB"]]) };
    expect(humaniseValue("doctor_id", 7, lookups)).toBe("AB");
  });

  it("resolves an id that arrived as a string, as path params do", () => {
    const lookups = { doctorCodes: new Map([[7, "AB"]]) };
    expect(humaniseValue("doctor_id", "7", lookups)).toBe("AB");
  });

  it("falls back to #id when the record is gone rather than hiding the change", () => {
    expect(humaniseValue("doctor_id", 34, { doctorCodes: new Map() })).toBe("#34");
  });

  it("leaves ids with no lookup as they are", () => {
    expect(humaniseValue("room_id", 5)).toBe("5");
  });

  it("joins a list of primitives and keeps JSON for anything structured", () => {
    expect(humaniseValue("days", ["Mon", "Tue"])).toBe("Mon, Tue");
    expect(humaniseValue("days", [])).toBe("(empty)");
    expect(humaniseValue("rows", [{ a: 1 }])).toBe('[{"a":1}]');
    expect(humaniseValue("permissions", { clinical: "write" })).toBe('{"clinical":"write"}');
  });
});

describe("describeAuditBody", () => {
  it("is empty for a row with no body, so the cell stays blank", () => {
    expect(describeAuditBody(null)).toEqual([]);
  });

  it("keeps the order the API sent", () => {
    expect(describeAuditBody({ room_id: 5, sessions_per_week: 8 })).toEqual([
      { label: "Room", value: "5" },
      { label: "Sessions per week", value: "8" },
    ]);
  });

  it("renders the backend's marker for a body it could not store", () => {
    expect(describeAuditBody({ _audit: "body too large", bytes: 99999 })).toEqual([
      { label: "Note", value: "body too large" },
      { label: "Bytes", value: "99999" },
    ]);
  });

  it("passes a redacted value straight through", () => {
    // The backend has already replaced it; the page must not un-redact or
    // dress it up as anything other than withheld.
    expect(describeAuditBody({ password: "[redacted]" })).toEqual([
      { label: "Password", value: "[redacted]" },
    ]);
  });
});

describe("summariseAuditBody", () => {
  it("joins the fields onto one line", () => {
    expect(summariseAuditBody({ room_id: 5, is_am: true })).toBe("Room: 5, Morning: Yes");
  });

  it("truncates rather than wrapping every row", () => {
    const long = summariseAuditBody({ note: "x".repeat(200) });
    expect(long).toHaveLength(73);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("outcomeClass", () => {
  it("marks anything that is not Done, so problems are visible while scanning", () => {
    expect(outcomeClass("Done")).toBe("text-ink/70");
    expect(outcomeClass("Rejected")).toBe("text-red-700");
    expect(outcomeClass("System error")).toBe("text-red-700");
  });
});
