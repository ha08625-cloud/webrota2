import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Permissions } from "@/api/types";

import { PERMISSION_PRESETS } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { StudiesPage } from "./StudiesPage";
import { makeStudy } from "./testFixtures";

function renderPage(permissions: Permissions = PERMISSION_PRESETS.research) {
  return renderWithProviders(<StudiesPage />, {
    area: "research",
    permissions,
    route: "/research",
    path: "/research",
    additionalRoutes: [{ path: "/research/studies/:studyId", element: <p>Study page</p> }],
  });
}

describe("StudiesPage", () => {
  it("shows an empty state when there are no studies", async () => {
    server.use(http.get("/api/v1/research/studies", () => HttpResponse.json([])));
    renderPage();

    expect(await screen.findByText("No studies yet.")).toBeInTheDocument();
  });

  it("groups studies by stage", async () => {
    server.use(
      http.get("/api/v1/research/studies", () =>
        HttpResponse.json([
          makeStudy({ id: 1, name: "ACME-1", stage: "setup" }),
          makeStudy({ id: 2, name: "BETA-2", stage: "recruitment_open" }),
        ]),
      ),
    );
    renderPage();

    const setupGroup = await screen.findByRole("list", { name: "Setup" });
    expect(within(setupGroup).getByRole("link", { name: "ACME-1" })).toBeInTheDocument();
    const openGroup = screen.getByRole("list", { name: "Recruitment open" });
    expect(within(openGroup).getByRole("link", { name: "BETA-2" })).toBeInTheDocument();
  });

  // Closed studies are a record rather than a working list, so the group
  // is counted but not listed until it is asked for (Decision 16).
  it("collapses the Closed group until it is expanded", async () => {
    server.use(
      http.get("/api/v1/research/studies", () =>
        HttpResponse.json([makeStudy({ id: 3, name: "OLD-3", stage: "closed" })]),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole("button", { name: "Show" });
    expect(screen.queryByRole("link", { name: "OLD-3" })).not.toBeInTheDocument();

    await user.click(toggle);

    expect(screen.getByRole("link", { name: "OLD-3" })).toBeInTheDocument();
  });

  it("New study opens the create dialog", async () => {
    server.use(http.get("/api/v1/research/studies", () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "New study" }));

    expect(await screen.findByRole("heading", { name: "New study" })).toBeInTheDocument();
  });

  it("navigates to the new study once it is created", async () => {
    server.use(
      http.get("/api/v1/research/studies", () => HttpResponse.json([])),
      http.post("/api/v1/research/studies", () =>
        HttpResponse.json(makeStudy({ id: 9, name: "ACME-9" }), { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "New study" }));
    await user.type(await screen.findByLabelText("Name"), "ACME-9");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Study page")).toBeInTheDocument();
  });

  it("disables New study for a read-only research login", async () => {
    server.use(http.get("/api/v1/research/studies", () => HttpResponse.json([])));
    renderPage({ ...PERMISSION_PRESETS.research, research: "read" });

    expect(await screen.findByRole("button", { name: "New study" })).toBeDisabled();
  });

  it("carries the standing no-participant-data line", async () => {
    server.use(http.get("/api/v1/research/studies", () => HttpResponse.json([])));
    renderPage();

    expect(
      await screen.findByText(/Never store participant information here/),
    ).toBeInTheDocument();
  });
});
