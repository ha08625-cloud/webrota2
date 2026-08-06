import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { formatDate } from "@/lib/date";
import { makeDoctor } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DoctorsPage } from "./DoctorsPage";

function setUpServer({ doctors }: { doctors: ReturnType<typeof makeDoctor>[] }) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/rooms", () => HttpResponse.json([])),
  );
}

describe("DoctorsPage", () => {
  it("shows an empty-state message when there are no active doctors", async () => {
    setUpServer({ doctors: [] });
    renderWithProviders(<DoctorsPage />);

    expect(await screen.findByText(/No active doctors yet/)).toBeInTheDocument();
  });

  it("renders a row per doctor", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    renderWithProviders(<DoctorsPage />);

    expect(await screen.findByText("AB")).toBeInTheDocument();
  });

  it("shows the doctor's supervision preference in the inline dropdown", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", supervision_preference: "more" })] });
    renderWithProviders(<DoctorsPage />);

    await screen.findByText("AB");
    expect(screen.getByLabelText("Supervision preference for AB")).toHaveValue("more");
  });

  it("changing the supervision preference dropdown sends a PATCH with only that field", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", supervision_preference: "normal" })] });
    let patchBody: unknown;
    server.use(
      http.patch("/api/v1/doctors/1", async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json(makeDoctor({ id: 1, code: "AB", supervision_preference: "less" }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");

    await user.selectOptions(screen.getByLabelText("Supervision preference for AB"), "less");

    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody).toEqual({ supervision_preference: "less" });
  });

  it("shows the sessions/week stepper for a Trainee but not the supervision dropdown", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "TR", doctor_type: "Trainee", sessions_per_week: "6.0" })],
    });
    renderWithProviders(<DoctorsPage />);

    await screen.findByText("TR");
    expect(screen.getByLabelText("Increase sessions per week for TR")).toBeInTheDocument();
    expect(screen.queryByLabelText("Supervision preference for TR")).not.toBeInTheDocument();
  });

  it("hides the sessions/week stepper for a Locum", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "LC", doctor_type: "Locum" })] });
    renderWithProviders(<DoctorsPage />);

    await screen.findByText("LC");
    expect(screen.queryByLabelText("Increase sessions per week for LC")).not.toBeInTheDocument();
  });

  it("shows a dash in the Works column for a doctor with no employment window", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", start_date: null, end_date: null })] });
    renderWithProviders(<DoctorsPage />);

    await screen.findByText("AB");
    expect(screen.getByLabelText("Employment window for AB")).toHaveTextContent("—");
  });

  it("shows an open-ended 'from' for a joiner with only a start date", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", start_date: "2026-09-01", end_date: null })] });
    renderWithProviders(<DoctorsPage />);

    await screen.findByText("AB");
    const cell = screen.getByLabelText("Employment window for AB");
    expect(cell).toHaveTextContent(/^from /);
    expect(cell).toHaveTextContent(formatDate("2026-09-01"));
  });

  it("shows an open-ended 'until' for a leaver with only an end date", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", start_date: null, end_date: "2027-03-31" })] });
    renderWithProviders(<DoctorsPage />);

    await screen.findByText("AB");
    const cell = screen.getByLabelText("Employment window for AB");
    expect(cell).toHaveTextContent(/^until /);
    expect(cell).toHaveTextContent(formatDate("2027-03-31"));
  });

  it("shows both bounds for a doctor with a closed employment window", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", start_date: "2026-09-01", end_date: "2027-03-31" })],
    });
    renderWithProviders(<DoctorsPage />);

    await screen.findByText("AB");
    const cell = screen.getByLabelText("Employment window for AB");
    expect(cell).toHaveTextContent(formatDate("2026-09-01"));
    expect(cell).toHaveTextContent(formatDate("2027-03-31"));
  });

  it("still lists a doctor whose end date has passed - the window is not the soft-delete flag", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", start_date: null, end_date: "2020-01-31", active: true })],
    });
    renderWithProviders(<DoctorsPage />);

    expect(await screen.findByText("AB")).toBeInTheDocument();
  });

  it("New Doctor opens the dialog in create mode", async () => {
    setUpServer({ doctors: [] });
    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByRole("button", { name: "New Doctor" });

    await user.click(screen.getByRole("button", { name: "New Doctor" }));

    expect(await screen.findByRole("heading", { name: "New Doctor" })).toBeInTheDocument();
  });

  it("Edit opens the dialog pre-filled for that doctor", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(await screen.findByRole("heading", { name: "Edit AB" })).toBeInTheDocument();
  });

  it("Delete confirms, calls the endpoint (200 with the updated doctor, not 204), and the row disappears", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/doctors/1", () => {
        deleted = true;
        return HttpResponse.json(makeDoctor({ id: 1, code: "AB", active: false }));
      }),
      http.get("/api/v1/doctors", () => HttpResponse.json(deleted ? [] : [makeDoctor({ id: 1, code: "AB" })])),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText(/No active doctors yet/)).toBeInTheDocument();
  });

  it("does not delete when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/doctors/1", () => {
        deleted = true;
        return HttpResponse.json(makeDoctor({ id: 1, code: "AB", active: false }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(false);
    expect(screen.getByText("AB")).toBeInTheDocument();
  });

  it("a 409 (committed sessions) shows the server's message and a working 'Deactivate instead' action", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    let patchedActiveFalse = false;
    server.use(
      http.delete("/api/v1/doctors/1", () =>
        HttpResponse.json(
          { detail: "Doctor 1 has sessions on a committed rota; set active=false via PATCH instead" },
          { status: 409 },
        ),
      ),
      http.patch("/api/v1/doctors/1", async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        patchedActiveFalse = body.active === false;
        return HttpResponse.json(makeDoctor({ id: 1, code: "AB", active: false }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/has sessions on a committed rota/)).toBeInTheDocument();
    const deactivateButton = screen.getByRole("button", { name: "Deactivate instead" });

    await user.click(deactivateButton);

    expect(patchedActiveFalse).toBe(true);
  });

  it("a non-409 delete error does not offer 'Deactivate instead'", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    server.use(
      http.delete("/api/v1/doctors/1", () => HttpResponse.json({ detail: "Server error" }, { status: 500 })),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Server error")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate instead" })).not.toBeInTheDocument();
  });
});