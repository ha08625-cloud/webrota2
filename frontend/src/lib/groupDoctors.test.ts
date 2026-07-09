import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";

import { groupDoctorsByType } from "./groupDoctors";

describe("groupDoctorsByType", () => {
  it("groups doctors by type in Partner, Salaried, Trainee, AHP order", () => {
    const doctors = [
      makeDoctor({ code: "TR1", doctor_type: "Trainee" }),
      makeDoctor({ code: "AH1", doctor_type: "AHP" }),
      makeDoctor({ code: "SA1", doctor_type: "Salaried" }),
      makeDoctor({ code: "PA1", doctor_type: "Partner" }),
    ];

    const groups = groupDoctorsByType(doctors);

    expect(groups.map((g) => g.type)).toEqual(["Partner", "Salaried", "Trainee", "AHP"]);
  });

  it("sorts doctors alphabetically by code within each group", () => {
    const doctors = [
      makeDoctor({ code: "LFM", doctor_type: "Partner" }),
      makeDoctor({ code: "CL", doctor_type: "Partner" }),
      makeDoctor({ code: "DT", doctor_type: "Partner" }),
    ];

    const groups = groupDoctorsByType(doctors);

    expect(groups).toHaveLength(1);
    expect(groups[0].doctors.map((d) => d.code)).toEqual(["CL", "DT", "LFM"]);
  });

  it("omits a type entirely when the input has no doctors of that type", () => {
    const doctors = [makeDoctor({ code: "AB", doctor_type: "Partner" })];

    const groups = groupDoctorsByType(doctors);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("Partner");
  });

  it("returns an empty array for an empty input list", () => {
    expect(groupDoctorsByType([])).toEqual([]);
  });

  it("uses human-readable plural labels", () => {
    const doctors = [
      makeDoctor({ code: "PA1", doctor_type: "Partner" }),
      makeDoctor({ code: "SA1", doctor_type: "Salaried" }),
      makeDoctor({ code: "TR1", doctor_type: "Trainee" }),
      makeDoctor({ code: "AH1", doctor_type: "AHP" }),
    ];

    const groups = groupDoctorsByType(doctors);

    expect(groups.map((g) => g.label)).toEqual(["Partners", "Salaried", "Trainees", "AHP"]);
  });

  it("does not apply any active/eligibility filtering of its own - callers pre-filter", () => {
    // Grouping is purely presentational: an inactive doctor passed in is
    // grouped and sorted the same as any other. Whether inactive doctors
    // belong in the list at all is the caller's decision.
    const doctors = [makeDoctor({ code: "ZZ", doctor_type: "Partner", active: false })];

    const groups = groupDoctorsByType(doctors);

    expect(groups[0].doctors.map((d) => d.code)).toEqual(["ZZ"]);
  });
});