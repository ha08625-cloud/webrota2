import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ValidationIssue } from "@/api/types";
import {
  makeReceptionRota,
  makeReceptionRotaSession,
  makeReceptionStaff,
} from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionDayPage } from "./ReceptionDayPage";

async function pickDate(user: ReturnType<typeof userEvent.setup>, dateString: string) {
  await user.type(screen.getByLabelText("Date"), dateString);
}

describe("ReceptionDayPage", () => {
  it("offers Generate from template for an ungenerated weekday, and generating renders the grid", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    const generated = makeReceptionRota({
      rota_id: 7,
      date: "2026-08-03",
      sessions: [makeReceptionRotaSession({ session_id: 1, staff_id: 1, hour: 9, role: "phones" })],
      issues: [],
    });
    let capturedBody: unknown;
    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)),
      // No override for GET /reception/rota - the default handler 404s,
      // which is the "never generated" steady state this test starts from.
      http.post("/api/v1/reception/rota", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(generated, { status: 201 });
      }),
    );

    renderWithProviders(<ReceptionDayPage />);
    const user = userEvent.setup();
    await pickDate(user, "2026-08-03");

    const generateButton = await screen.findByRole("button", { name: "Generate from template" });
    await user.click(generateButton);

    expect(capturedBody).toEqual({ date: "2026-08-03" });
    expect(await screen.findByTestId("reception-cell-1-9")).toBeInTheDocument();
  });

  it("splices a patched cell and its recomputed issues from one PATCH response", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    const session = makeReceptionRotaSession({
      session_id: 5, staff_id: 1, hour: 9, role: "phones", note: null,
    });
    const rota = makeReceptionRota({ rota_id: 7, date: "2026-08-03", sessions: [session], issues: [] });

    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)),
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.patch("/api/v1/reception/rota/7/sessions/5", () =>
        HttpResponse.json({
          session: { ...session, role: "other", note: "Training" },
          issues: [
            {
              severity: "warning",
              phase: "coverage",
              check: "phones_shortfall",
              message: "09:00-10:00: 0 staff on phones, 1 required",
              week: null,
              day: "Monday",
              period: null,
            },
          ],
        }),
      ),
    );

    renderWithProviders(<ReceptionDayPage />);
    const user = userEvent.setup();
    await pickDate(user, "2026-08-03");

    const cell = await screen.findByTestId("reception-cell-1-9");
    await user.click(within(cell).getByText("Phones"));
    await user.click(await screen.findByRole("radio", { name: "Other" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(cell).findByText("Training")).toBeInTheDocument();
    expect(await screen.findByText("09:00-10:00: 0 staff on phones, 1 required")).toBeInTheDocument();
  });

  it("regenerating confirms, then DELETEs the day before POSTing a fresh one", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    const rota = makeReceptionRota({ rota_id: 7, date: "2026-08-03", sessions: [], issues: [] });
    const regenerated = makeReceptionRota({ rota_id: 8, date: "2026-08-03", sessions: [], issues: [] });

    const calls: string[] = [];
    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)),
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.delete("/api/v1/reception/rota/7", () => {
        calls.push("DELETE");
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("/api/v1/reception/rota", () => {
        calls.push("POST");
        return HttpResponse.json(regenerated, { status: 201 });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithProviders(<ReceptionDayPage />);
    const user = userEvent.setup();
    await pickDate(user, "2026-08-03");

    const regenerateButton = await screen.findByRole("button", { name: "Regenerate" });
    await user.click(regenerateButton);

    await waitFor(() => expect(calls).toEqual(["DELETE", "POST"]));
  });

  it("does not regenerate when the confirm is dismissed", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    const rota = makeReceptionRota({ rota_id: 7, date: "2026-08-03", sessions: [], issues: [] });

    let deleteWasCalled = false;
    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)),
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.delete("/api/v1/reception/rota/7", () => {
        deleteWasCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);

    renderWithProviders(<ReceptionDayPage />);
    const user = userEvent.setup();
    await pickDate(user, "2026-08-03");

    const regenerateButton = await screen.findByRole("button", { name: "Regenerate" });
    await user.click(regenerateButton);

    expect(deleteWasCalled).toBe(false);
  });

  it("a shortfall warning clears once a staff member is added to the short hour", async () => {
    const staff = [
      makeReceptionStaff({ id: 1, code: "AB", active: true }),
      makeReceptionStaff({ id: 2, code: "CD", active: true }),
    ];
    const existing = makeReceptionRotaSession({ session_id: 1, staff_id: 1, hour: 9, role: "phones" });
    const shortfall: ValidationIssue = {
      severity: "warning",
      phase: "coverage",
      check: "phones_shortfall",
      message: "09:00-10:00: 1 staff on phones, 2 required",
      week: null,
      day: "Monday",
      period: null,
    };
    const rota = makeReceptionRota({ rota_id: 7, date: "2026-08-03", sessions: [existing], issues: [shortfall] });
    const created = makeReceptionRotaSession({ session_id: 2, staff_id: 2, hour: 9, role: "phones" });

    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)),
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.post("/api/v1/reception/rota/7/sessions", () =>
        HttpResponse.json({ session: created, issues: [] }, { status: 201 }),
      ),
    );

    renderWithProviders(<ReceptionDayPage />);
    const user = userEvent.setup();
    await pickDate(user, "2026-08-03");

    expect(await screen.findByText("09:00-10:00: 1 staff on phones, 2 required")).toBeInTheDocument();

    const emptyCell = await screen.findByTestId("reception-cell-2-9");
    await user.click(within(emptyCell).getByLabelText("Add session for CD 09:00-10:00"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByText("09:00-10:00: 1 staff on phones, 2 required")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No coverage shortfalls.")).toBeInTheDocument();
  });

  it("flags a weekend date instead of querying the rota", async () => {
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json([])));
    renderWithProviders(<ReceptionDayPage />);
    const user = userEvent.setup();
    // 2026-08-08 is a Saturday.
    await pickDate(user, "2026-08-08");

    expect(
      await screen.findByText("2026-08-08 is a weekend; the day rota only runs Monday to Friday."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate from template" })).not.toBeInTheDocument();
  });
});
