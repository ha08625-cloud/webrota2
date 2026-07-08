import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeClinicCounter, makeDoctor, makeSystemCounter } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { CountersPage } from "./CountersPage";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", sessions_per_week: "10.0" })],
  clinicCounters = [] as ReturnType<typeof makeClinicCounter>[],
  systemCounters = [] as ReturnType<typeof makeSystemCounter>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/counters/clinic", () => HttpResponse.json(clinicCounters)),
    http.get("/api/v1/counters/system", () => HttpResponse.json(systemCounters)),
  );
}

describe("CountersPage", () => {
  it("shows an empty-state message for each table when there are no counters", async () => {
    setUpServer();
    renderWithProviders(<CountersPage />);

    expect(await screen.findByText("No clinic counters yet.")).toBeInTheDocument();
    expect(await screen.findByText("No system counters yet.")).toBeInTheDocument();
  });

  it("renders a row per clinic counter and a row per system counter", async () => {
    setUpServer({
      clinicCounters: [
        makeClinicCounter({ id: 1, doctor_id: 1, doctor_code: "AB", clinic_type_name: "Diabetic clinic", raw_count: 3 }),
      ],
      systemCounters: [
        makeSystemCounter({ id: 1, doctor_id: 1, doctor_code: "AB", counter_type: "room_move", raw_count: 2 }),
      ],
    });
    renderWithProviders(<CountersPage />);

    const clinicTable = await screen.findByRole("table", { name: "Clinic counters" });
    expect(within(clinicTable).getByText("Diabetic clinic")).toBeInTheDocument();
    expect(within(clinicTable).getByText("3")).toBeInTheDocument();

    const systemTable = await screen.findByRole("table", { name: "System counters" });
    expect(within(systemTable).getByText("room_move")).toBeInTheDocument();
    expect(within(systemTable).getByText("2")).toBeInTheDocument();
  });

  it("computes the weighted score as raw_count / sessions_per_week, to two decimal places", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "8.0" })],
      clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, raw_count: 4 })],
    });
    renderWithProviders(<CountersPage />);

    const clinicTable = await screen.findByRole("table", { name: "Clinic counters" });
    // 4 / 8 = 0.50 - only settles once both the counters and doctors
    // queries have resolved (the table itself renders as soon as the
    // counters query resolves, independently of the doctors query the
    // weighted-score column also depends on), so this must be a
    // findByText scoped to the table, not a synchronous getByText.
    expect(await within(clinicTable).findByText("0.50")).toBeInTheDocument();
  });

  it("shows the infinity symbol, not a dash, for a doctor with sessions_per_week of 0", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "0.0" })],
      clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, raw_count: 4 })],
    });
    renderWithProviders(<CountersPage />);

    const clinicTable = await screen.findByRole("table", { name: "Clinic counters" });
    expect(await within(clinicTable).findByText("\u221e")).toBeInTheDocument();
  });

  it("falls back to a dash, not a crash, when a counter's doctor_id has no matching doctor", async () => {
    setUpServer({
      doctors: [],
      clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 999, doctor_code: "ZZ", raw_count: 4 })],
    });
    renderWithProviders(<CountersPage />);

    const clinicTable = await screen.findByRole("table", { name: "Clinic counters" });
    expect(within(clinicTable).getByText("ZZ")).toBeInTheDocument();
    expect(await within(clinicTable).findByText("-")).toBeInTheDocument();
  });

  it("shows the live-values note", async () => {
    setUpServer();
    renderWithProviders(<CountersPage />);

    expect(await screen.findByText(/committed baseline plus any in-progress draft/)).toBeInTheDocument();
  });
});