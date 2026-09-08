import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
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

const DRAFT_WARNING_FRAGMENT = "part of this reset will be undone";
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

  it("computes the weighted score as (raw_count / sessions_per_week) * 10, to two decimal places", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "8.0" })],
      clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
      clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, raw_count: 4 })],
    });
    renderWithProviders(<CountersPage />);

    const panel = await screen.findByRole("tabpanel");
    // 4 / 8 * 10 = 5.00 - only settles once both the counters and doctors
    // queries have resolved (the table itself renders as soon as the
    // counters query resolves, independently of the doctors query the
    // weighted-score column also depends on), so this must be a
    // findByText scoped to the panel, not a synchronous getByText.
    expect(await within(panel).findByText("5.00")).toBeInTheDocument();
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

  describe("opening balances", () => {
    it("adds the balance to the raw count before scoring, without inflating the raw count itself", async () => {
      setUpServer({
        doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "4.0" })],
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [
          makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, raw_count: 1, opening_balance: "3.2" }),
        ],
      });
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      // (1 + 3.2) / 4 * 10 = 10.50, with the credit shown beside the
      // count rather than folded into it.
      expect(await within(panel).findByText("10.50")).toBeInTheDocument();
      expect(within(panel).getByText("1")).toBeInTheDocument();
      expect(within(panel).getByText("(+3.2)")).toBeInTheDocument();
    });

    it("marks no credit on a row whose balance is zero", async () => {
      setUpServer({
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [
          makeClinicCounter({ id: 1, doctor_id: 1, clinic_type_id: 1, raw_count: 3, opening_balance: "0.0" }),
        ],
      });
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      expect(await within(panel).findByText("3")).toBeInTheDocument();
      expect(within(panel).queryByText(/\(\+0/)).not.toBeInTheDocument();
    });

    it("saves a clinic balance keyed on (doctor, clinic type), not on a counter id", async () => {
      let body: unknown = null;
      setUpServer({
        clinicTypes: [makeClinicType({ id: 7, name: "Diabetic clinic" })],
        clinicCounters: [
          makeClinicCounter({ id: null, doctor_id: 4, doctor_code: "AB", clinic_type_id: 7, raw_count: 0 }),
        ],
      });
      server.use(
        http.put("/api/v1/counters/clinic/opening-balance", async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(
            makeClinicCounter({ id: 1, doctor_id: 4, clinic_type_id: 7, raw_count: 0, opening_balance: "3.2" }),
          );
        }),
      );
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      const user = userEvent.setup();
      const input = within(panel).getByLabelText("Opening balance for AB");
      await user.clear(input);
      await user.type(input, "3.2");
      await user.click(within(panel).getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(body).toEqual({ doctor_id: 4, clinic_type_id: 7, sessions: "3.2" }),
      );
    });

    it("saves a system balance against the counter id", async () => {
      let putId: number | null = null;
      let body: unknown = null;
      setUpServer({
        systemCounters: [makeSystemCounter({ id: 9, doctor_id: 1, doctor_code: "AB", raw_count: 2 })],
      });
      server.use(
        http.put("/api/v1/counters/system/:id/opening-balance", async ({ params, request }) => {
          putId = Number(params.id);
          body = await request.json();
          return HttpResponse.json(
            makeSystemCounter({ id: 9, doctor_id: 1, doctor_code: "AB", raw_count: 2, opening_balance: "-1.5" }),
          );
        }),
      );
      renderWithProviders(<CountersPage />);

      const table = await screen.findByRole("table", { name: "System counters" });
      const user = userEvent.setup();
      const input = within(table).getByLabelText("Opening balance for AB room_move");
      await user.clear(input);
      // Negative balances are allowed - a returner, or a leaver whose
      // count should be treated as already served.
      await user.type(input, "-1.5");
      await user.click(within(table).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(putId).toBe(9));
      expect(body).toEqual({ sessions: "-1.5" });
    });

    it("disables reset on a (doctor, clinic type) pair with no counter row, but still allows a balance", async () => {
      setUpServer({
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [
          makeClinicCounter({ id: null, doctor_id: 1, doctor_code: "AB", clinic_type_id: 1, raw_count: 0 }),
        ],
      });
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      expect(within(panel).getByRole("button", { name: "Reset" })).toBeDisabled();
      expect(within(panel).getByLabelText("Opening balance for AB")).toBeEnabled();
    });

    it("rejects more than one decimal place before sending it, and keeps Save inert", async () => {
      let putFired = false;
      setUpServer({
        clinicTypes: [makeClinicType({ id: 1, name: "Diabetic clinic" })],
        clinicCounters: [makeClinicCounter({ id: 1, doctor_id: 1, doctor_code: "AB", clinic_type_id: 1 })],
      });
      server.use(
        http.put("/api/v1/counters/clinic/opening-balance", () => {
          putFired = true;
          return HttpResponse.json(makeClinicCounter({ id: 1 }));
        }),
      );
      renderWithProviders(<CountersPage />);

      const panel = await screen.findByRole("tabpanel");
      const user = userEvent.setup();
      const input = within(panel).getByLabelText("Opening balance for AB");
      await user.clear(input);
      await user.type(input, "3.25");

      expect(within(panel).getByRole("button", { name: "Save" })).toBeDisabled();
      expect(within(panel).getByText("One decimal place max")).toBeInTheDocument();
      expect(putFired).toBe(false);
    });

    it("shows the levelling hint next to the tables", async () => {
      setUpServer();
      renderWithProviders(<CountersPage />);

      expect(
        await screen.findByText(/peer score ÷ 10 × sessions per week/),
      ).toBeInTheDocument();
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
      // Only the raw counts are snapshotted at generation, so only they are
      // restored by a scrap; saying the whole reset is undone would be false
      // of the opening balances it also clears.
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringContaining("Opening balances are not restored by a scrap"),
      );
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