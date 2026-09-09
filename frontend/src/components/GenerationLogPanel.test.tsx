import { describe, expect, it } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeGenerationLogEntry } from "@/test/fixtures/rota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { GenerationLogPanel } from "./GenerationLogPanel";

describe("GenerationLogPanel", () => {
  it("is closed by default and shows the entry count on the trigger", async () => {
    server.use(
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([makeGenerationLogEntry(), makeGenerationLogEntry()]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);

    const header = await screen.findByRole("button", { name: /Generation log \(2 entries\)/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Diabetic clinic/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a dialog and closes again", async () => {
    server.use(
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([makeGenerationLogEntry({ message: "Dr AA assigned to Diabetic clinic" })]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(1 entries\)/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Dr AA assigned to Diabetic clinic")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders entry messages and grouping headers once expanded", async () => {
    server.use(
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([
          makeGenerationLogEntry({
            sequence: 0,
            week: 1,
            day: "Monday",
            message: "Dr AA assigned to Diabetic clinic",
          }),
          makeGenerationLogEntry({
            sequence: 1,
            week: 1,
            day: "Tuesday",
            message: "Dr BB assigned to Asthma clinic",
          }),
        ]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(2 entries\)/ }));

    expect(await screen.findByText("Week 1 — Monday")).toBeInTheDocument();
    expect(screen.getByText("Week 1 — Tuesday")).toBeInTheDocument();
    expect(screen.getByText("Dr AA assigned to Diabetic clinic")).toBeInTheDocument();
    expect(screen.getByText("Dr BB assigned to Asthma clinic")).toBeInTheDocument();
  });

  it("groups run-level entries (week null) under a trailing Run-level header", async () => {
    server.use(
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([
          makeGenerationLogEntry({ sequence: 0, week: null, day: null, message: "Run-level note" }),
          makeGenerationLogEntry({ sequence: 1, week: 1, day: "Monday", message: "Week 1 note" }),
        ]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(2 entries\)/ }));

    const headers = await screen.findAllByRole("heading", { level: 3 });
    expect(headers.map((h) => h.textContent)).toEqual(["Week 1 — Monday", "Run-level"]);
    expect(screen.getByText("Run-level note")).toBeInTheDocument();
  });

  it("narrows entries by phase", async () => {
    server.use(
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([
          makeGenerationLogEntry({ sequence: 0, phase: "phase5", message: "Clinic decision" }),
          makeGenerationLogEntry({ sequence: 1, phase: "phase9b", message: "Swap decision" }),
        ]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(2 entries\)/ }));

    expect(await screen.findByText("Clinic decision")).toBeInTheDocument();
    expect(screen.getByText("Swap decision")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Phase"), "phase9b");

    expect(screen.queryByText("Clinic decision")).not.toBeInTheDocument();
    expect(screen.getByText("Swap decision")).toBeInTheDocument();
  });

  it("matches related_doctor_id as well as doctor_id when filtering by doctor", async () => {
    server.use(
      http.get("/api/v1/doctors", () =>
        HttpResponse.json([makeDoctor({ id: 1, code: "AA" }), makeDoctor({ id: 2, code: "BB" })]),
      ),
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([
          makeGenerationLogEntry({
            sequence: 0,
            doctor_id: 1,
            related_doctor_id: null,
            message: "Dr AA decision",
          }),
          makeGenerationLogEntry({
            sequence: 1,
            doctor_id: 3,
            related_doctor_id: 2,
            message: "Dr BB displaced",
          }),
        ]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(2 entries\)/ }));

    const doctorSelect = await screen.findByLabelText("Doctor");
    expect(within(doctorSelect).getByText("BB")).toBeInTheDocument();

    await user.selectOptions(doctorSelect, "2");

    expect(screen.queryByText("Dr AA decision")).not.toBeInTheDocument();
    expect(screen.getByText("Dr BB displaced")).toBeInTheDocument();
  });

  it("hides the rationale behind a per-entry Why disclosure", async () => {
    const rationale =
      "Eligible (2): AA (priority tier 1, raw 1 / 10 sessions per week = 0.100); " +
      "BB (priority tier 2, raw 0 / 10 sessions per week = 0.000)\n" +
      "Top priority tier 1 (1): AA\n" +
      "Decided on: priority tier -- AA is alone in tier 1.";
    server.use(
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([
          makeGenerationLogEntry({ sequence: 0, message: "Dr AA assigned", rationale }),
        ]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(1 entries\)/ }));

    // The rationale is several lines long per entry, so it stays collapsed
    // until asked for - but it is in the DOM verbatim, newlines included.
    const why = await screen.findByText("Why");
    expect(why.closest("details")).not.toHaveAttribute("open");

    await user.click(why);
    expect(why.closest("details")).toHaveAttribute("open");
    // textContent, not getByText: the default matcher collapses whitespace,
    // and the line breaks are the structure here.
    expect(why.closest("details")?.querySelector("pre")?.textContent).toBe(rationale);
  });

  it("renders no Why disclosure for an entry with no rationale", async () => {
    server.use(
      http.get("/api/v1/rota/:id/log", () =>
        HttpResponse.json([
          makeGenerationLogEntry({ sequence: 0, message: "Skipped, practice closed", rationale: null }),
        ]),
      ),
    );

    renderWithProviders(<GenerationLogPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(1 entries\)/ }));

    expect(await screen.findByText("Skipped, practice closed")).toBeInTheDocument();
    expect(screen.queryByText("Why")).not.toBeInTheDocument();
  });

  it("renders an empty state for a rota with no log rows", async () => {
    server.use(http.get("/api/v1/rota/:id/log", () => HttpResponse.json([])));

    renderWithProviders(<GenerationLogPanel rotaId={7} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Generation log \(0 entries\)/ }));

    expect(await screen.findByText("No generation log entries.")).toBeInTheDocument();
  });
});