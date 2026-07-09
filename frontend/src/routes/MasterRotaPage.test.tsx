import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";

import { makeMasterRotaSession, makeMasterRotaTemplate } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { MasterRotaPage } from "./MasterRotaPage";

describe("MasterRotaPage", () => {
  it("shows a no-active-template message on a 404", async () => {
    server.use(
      http.get("/api/v1/master-rota/active", () =>
        HttpResponse.json({ detail: "No active master rota template" }, { status: 404 }),
      ),
    );

    renderWithProviders(<MasterRotaPage />);

    expect(await screen.findByText(/No active master rota template/)).toBeInTheDocument();
  });

  it("renders the template name and grid on success", async () => {
    const template = makeMasterRotaTemplate({
      name: "Default",
      sessions: [makeMasterRotaSession({ doctor_id: 1, doctor_code: "AB" })],
    });
    server.use(http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)));

    renderWithProviders(<MasterRotaPage />);

    expect(await screen.findByText("Master Rota - Default")).toBeInTheDocument();
    expect(screen.getByText("AB")).toBeInTheDocument();
  });

  it("shows a generic error message on a non-404 failure", async () => {
    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json({ detail: "boom" }, { status: 500 })),
    );

    renderWithProviders(<MasterRotaPage />);

    expect(await screen.findByText(/Could not load the master rota/)).toBeInTheDocument();
  });
});