import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeDutyAssignment } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DutyPage } from "./DutyPage";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
  duty = [] as ReturnType<typeof makeDutyAssignment>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/duty", () => HttpResponse.json(duty)),
  );
}

describe("DutyPage", () => {
  it("shows an empty-state message when there are no assignments", async () => {
    setUpServer();
    renderWithProviders(<DutyPage />);

    expect(await screen.findByText("No duty assignments.")).toBeInTheDocument();
  });

  it("renders a row per assignment", async () => {
    setUpServer({ duty: [makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-08-03", duty_type: "primary" })] });
    renderWithProviders(<DutyPage />);

    expect(await screen.findByText("2026-08-03")).toBeInTheDocument();
    expect(screen.getByText("AB")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
  });

  it("adding an assignment posts the selected fields", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/duty", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeDutyAssignment(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);
    await screen.findByLabelText("Doctor");

    await user.selectOptions(screen.getByLabelText("Doctor"), "1");
    await user.type(screen.getByLabelText("Date"), "2026-08-03");
    await user.selectOptions(screen.getByLabelText("Duty type"), "secondary");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({ date: "2026-08-03", period: "AM", doctor_id: 1, duty_type: "secondary" }),
    );
  });

  it("a 409 duplicate-slot conflict is shown next to the form", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/duty", () =>
        HttpResponse.json(
          { detail: "A duty assignment already exists for this date/period/type" },
          { status: 409 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);
    await screen.findByLabelText("Doctor");
    await user.selectOptions(screen.getByLabelText("Doctor"), "1");
    await user.type(screen.getByLabelText("Date"), "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/already exists for this date\/period\/type/)).toBeInTheDocument();
  });

  it("delete removes an assignment", async () => {
    setUpServer({ duty: [makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-08-03" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/duty/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/duty", () =>
        HttpResponse.json(deleted ? [] : [makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-08-03" })]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);
    await screen.findByText("2026-08-03");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("No duty assignments.")).toBeInTheDocument();
  });
});