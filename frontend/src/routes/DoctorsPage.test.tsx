import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { formatDate } from "@/lib/date";
import {
  PERMISSION_PRESETS,
  makeDoctor,
  makeLeaveEntitlement,
} from "@/test/fixtures/reference";
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
  it("shows an empty-state message when there are no doctors at all", async () => {
    setUpServer({ doctors: [] });
    renderWithProviders(<DoctorsPage />);

    expect(await screen.findByText(/No doctors yet/)).toBeInTheDocument();
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

  it("Deactivate confirms and PATCHes active:false - it is not the DELETE any more", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    let patchBody: unknown;
    let deleted = false;
    server.use(
      http.patch("/api/v1/doctors/1", async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json(makeDoctor({ id: 1, code: "AB", active: false }));
      }),
      http.delete("/api/v1/doctors/1", () => {
        deleted = true;
        return HttpResponse.json({ deleted: {} });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");

    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(patchBody).toEqual({ active: false }));
    expect(deleted).toBe(false);
  });

  it("does not deactivate when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    let patched = false;
    server.use(
      http.patch("/api/v1/doctors/1", () => {
        patched = true;
        return HttpResponse.json(makeDoctor({ id: 1, code: "AB", active: false }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");
    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    expect(patched).toBe(false);
    expect(screen.getByText("AB")).toBeInTheDocument();
  });

  it("lists an inactive doctor in its own section, with a reactivate action", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: false })] });
    renderWithProviders(<DoctorsPage />);

    expect(await screen.findByRole("heading", { name: "Inactive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
  });

  it("Reactivate PATCHes active:true without confirming", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: false })] });
    let patchBody: unknown;
    server.use(
      http.patch("/api/v1/doctors/1", async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json(makeDoctor({ id: 1, code: "AB" }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DoctorsPage />);
    await screen.findByText("AB");
    // Cleared here rather than asserted from zero: spies on window.confirm
    // are shared across this file's tests, so the earlier ones' calls are
    // still on it.
    confirmSpy.mockClear();

    await user.click(screen.getByRole("button", { name: "Reactivate" }));

    await waitFor(() => expect(patchBody).toEqual({ active: true }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  describe("permanent delete", () => {
    // Only offered on an inactive row: the backend 409s on an active
    // doctor (deactivate first, delete later).
    it("offers no Delete on an active doctor", async () => {
      setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
      renderWithProviders(<DoctorsPage />);

      await screen.findByText("AB");
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });

    it("offers no Delete without the user administration permission", async () => {
      setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: false })] });
      renderWithProviders(<DoctorsPage />, { permissions: PERMISSION_PRESETS.rotaAdmin });

      await screen.findByText("AB");
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });

    it("purges the doctor once the code is typed, and the row disappears", async () => {
      setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: false })] });
      let deleted = false;
      server.use(
        http.get("/api/v1/doctors/1/usage", () =>
          HttpResponse.json({
            master_sessions: 4,
            rota_sessions: 40,
            committed_rotas: 2,
            staging_sessions: 0,
            leave_entries: 3,
            duty_assignments: 1,
            extra_sessions: 0,
            blocked_entries: 0,
          }),
        ),
        http.delete("/api/v1/doctors/1", () => {
          deleted = true;
          return HttpResponse.json({ deleted: { rota_sessions: 40 } });
        }),
        http.get("/api/v1/doctors", () =>
          HttpResponse.json(deleted ? [] : [makeDoctor({ id: 1, code: "AB", active: false })]),
        ),
      );

      const user = userEvent.setup();
      renderWithProviders(<DoctorsPage />);
      await screen.findByText("AB");
      await user.click(screen.getByRole("button", { name: "Delete" }));

      // The confirm button stays disabled until the code is typed exactly.
      const confirmButton = await screen.findByRole("button", { name: "Permanently delete" });
      expect(confirmButton).toBeDisabled();
      // A near-miss is still disabled: the typed code proves *which* row.
      await user.type(screen.getByLabelText("Type AB to confirm"), "ab");
      expect(confirmButton).toBeDisabled();
      await user.clear(screen.getByLabelText("Type AB to confirm"));
      expect(await screen.findByText(/2 of them committed/)).toBeInTheDocument();

      await user.type(screen.getByLabelText("Type AB to confirm"), "AB");
      await user.click(confirmButton);

      await waitFor(() => expect(deleted).toBe(true));
      expect(await screen.findByText(/No doctors yet/)).toBeInTheDocument();
    });

    it("surfaces a delete failure in the dialog", async () => {
      setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: false })] });
      server.use(
        http.get("/api/v1/doctors/1/usage", () => HttpResponse.json({}, { status: 500 })),
        http.delete("/api/v1/doctors/1", () =>
          HttpResponse.json({ detail: "Server error" }, { status: 500 }),
        ),
      );

      const user = userEvent.setup();
      renderWithProviders(<DoctorsPage />);
      await screen.findByText("AB");
      await user.click(screen.getByRole("button", { name: "Delete" }));

      // A failed usage read is reported but does not block the delete.
      expect(await screen.findByText(/Could not load what this would delete/)).toBeInTheDocument();
      await user.type(screen.getByLabelText("Type AB to confirm"), "AB");
      await user.click(screen.getByRole("button", { name: "Permanently delete" }));

      expect(await screen.findByText("Server error")).toBeInTheDocument();
    });
  });

  // The warning moved here from the Individual Leave tab: it is about the
  // sessions/week field, which is edited here and nowhere else.
  describe("sessions/week mismatch flag", () => {
    function stubEntitlement(rows: ReturnType<typeof makeLeaveEntitlement>[]) {
      server.use(
        http.get("/api/v1/leave/entitlement", () =>
          HttpResponse.json({
            year: 2026,
            from_date: "2026-01-01",
            to_date: "2026-12-31",
            doctors: rows,
          }),
        ),
      );
    }

    it("flags a doctor whose master template disagrees with their sessions/week", async () => {
      setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "6.0" })] });
      stubEntitlement([
        makeLeaveEntitlement({
          doctor_id: 1,
          doctor_code: "AB",
          sessions_per_week: "6.0",
          template_sessions_per_week: 8,
          sessions_mismatch: true,
        }),
      ]);
      renderWithProviders(<DoctorsPage />);

      expect(await screen.findByTestId("sessions-mismatch-AB")).toHaveTextContent(
        "Template implies 8",
      );
      expect(screen.getByText(/accrues and is spent in different units/)).toBeInTheDocument();
    });

    it("says nothing when the template and sessions/week agree", async () => {
      setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", sessions_per_week: "6.0" })] });
      stubEntitlement([makeLeaveEntitlement({ doctor_id: 1, doctor_code: "AB" })]);
      renderWithProviders(<DoctorsPage />);

      await screen.findByText("AB");
      expect(screen.queryByTestId("sessions-mismatch-AB")).not.toBeInTheDocument();
      expect(screen.queryByText(/different units/)).not.toBeInTheDocument();
    });
  });
});

describe("DoctorsPage for a read-only user", () => {
  // Belt to the backend's braces: the 403 is the boundary, this just
  // stops offering buttons that only ever fail.
  it("disables every write control and says why", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    renderWithProviders(<DoctorsPage />, { permissions: PERMISSION_PRESETS.readOnly });
    await screen.findByText("AB");

    const newDoctor = screen.getByRole("button", { name: "New Doctor" });
    expect(newDoctor).toBeDisabled();
    expect(newDoctor).toHaveAttribute("title", expect.stringContaining("do not allow changes"));
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeDisabled();
    expect(screen.getByLabelText("Supervision preference for AB")).toBeDisabled();
  });

  it("leaves them enabled for a rota administrator, who may write both rotas", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB" })] });
    renderWithProviders(<DoctorsPage />, { permissions: PERMISSION_PRESETS.rotaAdmin });
    await screen.findByText("AB");

    expect(screen.getByRole("button", { name: "New Doctor" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeEnabled();
  });
});
