import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeClinicCounter, makeClinicType, makeDoctor, makeSystemCounter } from "@/test/fixtures/reference";
import { makeRotaSummary } from "@/test/fixtures/rota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { CountersPage } from "./CountersPage";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", sessions_per_week: "10.0" })],
  clinicTypes = [] as ReturnType<typeof makeClinicType>[],
  clinicCounters = [] as ReturnType<typeof makeClinicCounter>[],
  systemCounters = [] as ReturnType<typeof makeSystemCounter>[],
  rotas = [] as ReturnType<typeof makeRotaSummary>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/clinic-types", () => HttpResponse.json(clinicTypes)),
    http.get("/api/v1/counters/clinic", () => HttpResponse.json(clinicCounters)),
    http.get("/api/v1/counters/system", () => HttpResponse.json(systemCounters)),
    http.get("/api/v1/rota", () => HttpResponse.json(rotas)),
  );
}

const DRAFT_WARNING_FRAGMENT = "this reset will be undone";
const NOT_SHOWN_FRAGMENT = "including counters for doctors not shown on this page";

describe("CountersPage", () => {
  it("shows an empty-state message for each section when there are no clinic types and no system counters", async () => {
    setUpServer();
    renderWithProviders(<CountersPage />);

    expect(await screen.findByText("No clinic counters yet.")).toBeInTheDocument();
    expect(await screen.findByText("No system counters yet.")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("renders a tab per clinic type, ordered by clinic_priority ascending", async () => {
    setUpServer({
      clinicTypes: [
        makeClinicType({ id: 1, name: "Diabetic clinic", clinic_priority: 20 }),
        makeClinicType({ id: 2, name: "Antenatal clinic", clinic_priority: 10 }),
      ],
    });
    renderWithProviders(<CountersPage />);

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Antenatal clinic", "Diabetic clinic"]);
  });

  it("shows a tab even for a clinic type with no counters yet, with its own empty message", async () => {
    setUpServer({
      clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
    });
    renderWithProviders(<CountersPage />);

    expect(await screen.findByRole("tab", { name: "Diabetic clinic" })).toBeInTheDocument();
    expect(await screen.findByText("No counters yet for this clinic.")).toBeInTheDocument();
  });

  it("shows the first tab's counters by default and switches on click", async () => {
    setUpServer({
      clinicTypes: [
        makeClinicType({ id: 1, name: "Antenatal clinic", clinic_priority: 10 }),
        makeClinicType({ id: 2, name: "Diabetic clinic", clinic_priority: 20 }),
      ],
      clinicCounters: [
        makeClinicCounter({ id: 1, doctor_id: 1, doctor_code: "AB", clinic_type_id: 1, clinic_type_name: "Antenatal clinic", raw_count: 3 }),
        makeClinicCounter({ id: 2, doctor_id: 1, doctor_code: "AB", clinic_type_id: 2, clinic_type_name: "Diabetic clinic", raw_count: 7 }),
      ],
    });
    renderWithProviders(<CountersPage />);

    let panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("3")).toBeInTheDocument();
    expect(within(panel).queryByText("7")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Diabetic clinic" }));

    panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("7")).toBeInTheDocument();
    expect(within(panel).queryByText("3")).not.toBeInTheDocument();
  });

  it("computes the weighted score as raw_count / sessions_per_week, to two decimal places", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "8.0" })],
      clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
      clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, raw_count: 4 })],
    });
    renderWithProviders(<CountersPage />);

    const panel = await screen.findByRole("tabpanel");
    // 4 / 8 = 0.50 - only settles once both the counters and doctors
    // queries have resolved (the table itself renders as soon as the
    // counters query resolves, independently of the doctors query the
    // weighted-score column also depends on), so this must be a
    // findByText scoped to the panel, not a synchronous getByText.
    expect(await within(panel).findByText("0.50")).toBeInTheDocument();
  });

  it("shows the infinity symbol, not a dash, for a doctor with sessions_per_week of 0", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "0.0" })],
      clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
      clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, raw_count: 4 })],
    });
    renderWithProviders(<CountersPage />);

    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText("\u221e")).toBeInTheDocument();
  });

  it("falls back to a dash, not a crash, when a counter's doctor_id has no matching doctor", async () => {
    setUpServer({
      doctors: [],
      clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
      clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 999, clinic_type_id: 1, doctor_code: "ZZ", raw_count: 4 })],
    });
    renderWithProviders(<CountersPage />);

    const panel = await screen.findByRole("tabpanel");
    expect(within(panel).getByText("ZZ")).toBeInTheDocument();
    expect(await within(panel).findByText("-")).toBeInTheDocument();
  });

  it("shows the live-values note", async () => {
    setUpServer();
    renderWithProviders(<CountersPage />);

    expect(await screen.findByText(/committed baseline plus any in-progress draft/)).toBeInTheDocument();
  });

  describe("resetting a single counter", () => {
    it("fires the reset request when the confirmation is accepted", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      let resetId: number | null = null;
      setUpServer({
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [makeClinicCounter({ id: 5, doctor_id: 1, clinic_type_id: 1, doctor_code: "AB", raw_count: 3 })],
      });
      server.use(
        http.post("/api/v1/counters/clinic/:id/reset", ({ params }) => {
          resetId = Number(params.id);
          return HttpResponse.json(makeClinicCounter({ id: 5, doctor_id: 1, doctor_code: "AB", raw_count: 0 }));
        }),
      );
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      const user = userEvent.setup();
      await user.click(within(panel).getByRole("button", { name: "Reset" }));

      expect(resetId).toBe(5);
    });

    it("does not fire the reset request when the confirmation is declined", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      let resetFired = false;
      setUpServer({
        systemCounters: [makeSystemCounter({ id: 5, doctor_id: 1, doctor_code: "AB", raw_count: 3 })],
      });
      server.use(
        http.post("/api/v1/counters/system/:id/reset", () => {
          resetFired = true;
          return HttpResponse.json(makeSystemCounter({ id: 5, doctor_id: 1, doctor_code: "AB", raw_count: 0 }));
        }),
      );
      renderWithProviders(<CountersPage />);

      const systemTable = await screen.findByRole("table", { name: "System counters" });
      const user = userEvent.setup();
      await user.click(within(systemTable).getByRole("button", { name: "Reset" }));

      expect(resetFired).toBe(false);
    });
  });

  describe("resetting all counters", () => {
    it("fires the bulk reset request on confirmation", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      let resetAllFired = false;
      setUpServer({
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, doctor_code: "AB", raw_count: 3 })],
      });
      server.use(
        http.post("/api/v1/counters/clinic/reset-all", () => {
          resetAllFired = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      renderWithProviders(<CountersPage />);

      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Reset all clinic counters" }));

      expect(resetAllFired).toBe(true);
    });

    it("includes the not-shown-on-this-page wording in the reset-all confirmation", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      setUpServer({
        systemCounters: [makeSystemCounter({ id: 1, doctor_id: 1, doctor_code: "AB", raw_count: 3 })],
      });
      renderWithProviders(<CountersPage />);

      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Reset all system counters" }));

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining(NOT_SHOWN_FRAGMENT));
    });
  });

  describe("draft-aware confirmation wording", () => {
    it("includes the draft warning when a draft rota is active", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      setUpServer({
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, doctor_code: "AB", raw_count: 3 })],
        rotas: [makeRotaSummary({ rota_id: 1, status: "draft" })],
      });
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      const user = userEvent.setup();
      await user.click(within(panel).getByRole("button", { name: "Reset" }));

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining(DRAFT_WARNING_FRAGMENT));
    });

    it("excludes the draft warning when there is no draft rota", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      setUpServer({
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, doctor_code: "AB", raw_count: 3 })],
        rotas: [makeRotaSummary({ rota_id: 1, status: "committed" })],
      });
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      const user = userEvent.setup();
      await user.click(within(panel).getByRole("button", { name: "Reset" }));

      expect(confirmSpy).toHaveBeenCalledWith(expect.not.stringContaining(DRAFT_WARNING_FRAGMENT));
    });
  });
});