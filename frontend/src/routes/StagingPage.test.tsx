import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useParams } from "react-router-dom";

import { makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeStaging, makeStagingSession } from "@/test/fixtures/staging";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { StagingPage } from "./StagingPage";

function DetailProbe() {
  const params = useParams<{ id: string }>();
  return <div data-testid="detail-probe">detail:{params.id}</div>;
}

function RotaListProbe() {
  return <div data-testid="rota-list-probe">rota list</div>;
}

function setUpServer({
  rooms = [makeRoom({ id: 5, code: "D1" })],
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
} = {}) {
  server.use(
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
  );
}

describe("StagingPage", () => {
  it("shows a null-state message and a link back to Rota when there is no active staging", async () => {
    server.use(http.get("/api/v1/staging/active", () => HttpResponse.json({ detail: "No active staging" }, { status: 404 })));

    renderWithProviders(<StagingPage />);

    expect(await screen.findByText("No staging is in progress.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Rota" })).toHaveAttribute("href", "/clinical");
  });

  it("renders the date range, week count, and grid when a staging is active", async () => {
    setUpServer();
    const session = makeStagingSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    server.use(
      http.get("/api/v1/staging/active", () =>
        HttpResponse.json(makeStaging({ staging_id: 3, start_date: "2026-08-03", num_weeks: 2, sessions: [session] })),
      ),
    );

    renderWithProviders(<StagingPage />);

    expect(await screen.findByText(/Staging for/)).toHaveTextContent("2 weeks");
    expect(screen.getByText("Changes here apply to this rota only; the master rota is unchanged.")).toBeInTheDocument();
    await screen.findByRole("tab", { name: "Week 1" });
  });

  it("navigates to /clinical/rota/{rota_id} on a successful complete", async () => {
    setUpServer();
    server.use(
      http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging({ staging_id: 3 }))),
      http.post("/api/v1/staging/:stagingId/complete", () =>
        HttpResponse.json({ rota_id: 88, status: "draft", issues: [] }),
      ),
    );

    renderWithProviders(<StagingPage />, {
      additionalRoutes: [{ path: "/clinical/rota/:id", element: <DetailProbe /> }],
    });
    await screen.findByText(/Staging for/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Complete and generate" }));

    expect(await screen.findByTestId("detail-probe")).toHaveTextContent("detail:88");
  });

  it("renders a Phase 0 validation-issue list when complete returns 422", async () => {
    setUpServer();
    server.use(
      http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging({ staging_id: 3 }))),
      http.post("/api/v1/staging/:stagingId/complete", () =>
        HttpResponse.json(
          {
            detail: [
              {
                severity: "error", phase: "phase0", check: "duty_on_leave",
                message: "Duty doctor is on leave", week: 1, day: "Monday", period: "AM",
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    renderWithProviders(<StagingPage />);
    await screen.findByText(/Staging for/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Complete and generate" }));

    expect(await screen.findByText(/Duty doctor is on leave/)).toBeInTheDocument();
  });

  describe("abandon", () => {
    beforeEach(() => {
      vi.spyOn(window, "confirm");
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does nothing when the confirm dialog is declined", async () => {
      setUpServer();
      vi.mocked(window.confirm).mockReturnValue(false);
      let deleteWasCalled = false;
      server.use(
        http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging({ staging_id: 3 }))),
        http.delete("/api/v1/staging/:stagingId", () => {
          deleteWasCalled = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      renderWithProviders(<StagingPage />);
      await screen.findByText(/Staging for/);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Abandon" }));

      expect(window.confirm).toHaveBeenCalled();
      expect(deleteWasCalled).toBe(false);
    });

    it("deletes the staging and navigates to /clinical once confirmed", async () => {
      setUpServer();
      vi.mocked(window.confirm).mockReturnValue(true);
      let capturedUrl = "";
      server.use(
        http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging({ staging_id: 3 }))),
        http.delete("/api/v1/staging/:stagingId", ({ request }) => {
          capturedUrl = request.url;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      renderWithProviders(<StagingPage />, {
        additionalRoutes: [{ path: "/clinical", element: <RotaListProbe /> }],
      });
      await screen.findByText(/Staging for/);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Abandon" }));

      await waitFor(() => expect(capturedUrl).toContain("/api/v1/staging/3"));
      expect(await screen.findByTestId("rota-list-probe")).toBeInTheDocument();
    });
  });
});