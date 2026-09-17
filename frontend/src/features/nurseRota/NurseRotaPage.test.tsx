import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PERMISSION_PRESETS, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { NurseRotaPage } from "./NurseRotaPage";

function renderPage() {
  return renderWithProviders(<NurseRotaPage />, {
    area: "nurse_rota",
    permissions: PERMISSION_PRESETS.nurseRota,
  });
}

describe("NurseRotaPage", () => {
  it("feeds the grid from one /nurse-rota/active fetch, rooms included", async () => {
    server.use(
      http.get("/api/v1/doctors", () =>
        HttpResponse.json([makeDoctor({ id: 1, code: "NA", doctor_type: "Nurse", active: true })]),
      ),
      // Deliberately 403: the page must not need GET /rooms, which is
      // clinical-gated and unreachable for a nurse_rota-only login.
      http.get("/api/v1/rooms", () => HttpResponse.json({ detail: "Forbidden" }, { status: 403 })),
      http.get("/api/v1/nurse-rota/active", () =>
        HttpResponse.json({
          template_id: 3,
          name: "Default",
          sessions: [
            makeMasterRotaSession({
              session_id: 1, doctor_id: 1, doctor_code: "NA", doctor_type: "Nurse",
              week: 1, day: "Monday", period: "AM", session_type: "pre_assigned",
              room_id: 5, room_code: "TR1",
            }),
          ],
          rooms: [makeRoom({ id: 5, code: "TR1", room_type: "TR" })],
          occupancy: [],
        }),
      ),
    );
    renderPage();

    expect(await screen.findByRole("heading", { name: "Nurse Rota - Default" })).toBeInTheDocument();
    expect(screen.getByText("Changes apply to future generated rotas only.")).toBeInTheDocument();
    expect(await screen.findByText("NA")).toBeInTheDocument();
    expect(screen.getByText("TR1")).toBeInTheDocument();
  });

  it("says so when there is no active template rather than rendering an empty grid", async () => {
    server.use(
      http.get("/api/v1/nurse-rota/active", () =>
        HttpResponse.json({ detail: "No active master rota template" }, { status: 404 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("No active master rota template.")).toBeInTheDocument();
  });

  it("reports any other failure rather than showing a blank page", async () => {
    server.use(
      http.get("/api/v1/nurse-rota/active", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Could not load the nurse rota.")).toBeInTheDocument();
  });
});
