import { describe, expect, it } from "vitest";

import { mapValidationErrors } from "./mapValidationErrors";

describe("mapValidationErrors", () => {
  it("strips the leading 'body' segment and maps a top-level scalar field", () => {
    const result = mapValidationErrors([{ loc: ["body", "name"], msg: "Field required", type: "missing" }]);
    expect(result.fieldErrors.name).toBe("Field required");
    expect(result.formErrors).toEqual([]);
  });

  it("puts an unrecognised top-level field into formErrors rather than guessing", () => {
    const result = mapValidationErrors([
      { loc: ["body", "some_unknown_field"], msg: "Unexpected", type: "value_error" },
    ]);
    expect(result.fieldErrors).toEqual({});
    expect(result.formErrors).toEqual(["Unexpected"]);
  });

  it("puts a nested path (e.g. a room_eligibilities row error) into formErrors, not a guessed field", () => {
    const result = mapValidationErrors([
      { loc: ["body", "room_eligibilities", 2], msg: "exactly one of room_id / room_type must be set", type: "value_error" },
    ]);
    expect(result.fieldErrors).toEqual({});
    expect(result.formErrors).toEqual(["exactly one of room_id / room_type must be set"]);
  });

  it("handles a loc without a leading 'body' segment (e.g. a query/path param error) without stripping anything real", () => {
    const result = mapValidationErrors([{ loc: ["name"], msg: "Field required", type: "missing" }]);
    expect(result.fieldErrors.name).toBe("Field required");
  });

  it("maps multiple errors independently", () => {
    const result = mapValidationErrors([
      { loc: ["body", "name"], msg: "Field required", type: "missing" },
      { loc: ["body", "some_unknown_field"], msg: "Unexpected", type: "value_error" },
    ]);
    expect(result.fieldErrors.name).toBe("Field required");
    expect(result.formErrors).toEqual(["Unexpected"]);
  });
});
