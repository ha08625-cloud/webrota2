import { describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { rotaKeys } from "@/api/rota";
import { makeRota } from "@/test/fixtures/rota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { RotaDetailPage } from "./RotaDetailPage";

describe("RotaDetailPage", () => {
  it("shows a not-found message on a 404 (e.g. after scrap, or a stale link)", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json({ detail: "Rota 99 not found" }, { status: 404 })),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/99", path: "/rota/:id" });

    expect(await screen.findByText(/Rota not found/)).toBeInTheDocument();
  });

  it("shows Commit and Scrap for a draft rota", async () => {
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

    expect(await screen.findByRole("button", { name: "Commit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scrap" })).toBeInTheDocument();
  });

  it("hides action buttons and shows a read-only note for a committed rota", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

    await screen.findByText(/read-only/);
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scrap" })).not.toBeInTheDocument();
  });

  it("commits after confirmation, seeds the detail cache with the response, and navigates to /", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let committed = false;
    server.use(
      http.post("/api/v1/rota/:id/commit", () => {
        committed = true;
        return HttpResponse.json(makeRota({ rota_id: 7, status: "committed" }));
      }),
    );

    const { queryClient } = renderWithProviders(<RotaDetailPage />, {
      route: "/rota/7",
      path: "/rota/:id",
      additionalRoutes: [{ path: "/", element: <div data-testid="home-probe">home</div> }],
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Commit" }));

    expect(committed).toBe(true);
    expect(await screen.findByTestId("home-probe")).toBeInTheDocument();
    expect(queryClient.getQueryData(rotaKeys.detail(7))).toMatchObject({ rota_id: 7, status: "committed" });
  });

  it("does not commit when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let committed = false;
    server.use(
      http.post("/api/v1/rota/:id/commit", () => {
        committed = true;
        return HttpResponse.json(makeRota({ rota_id: 7, status: "committed" }));
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Commit" }));

    expect(committed).toBe(false);
  });

  it("scraps after confirmation and navigates to /", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let scrapped = false;
    server.use(
      http.delete("/api/v1/rota/:id", () => {
        scrapped = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<RotaDetailPage />, {
      route: "/rota/7",
      path: "/rota/:id",
      additionalRoutes: [{ path: "/", element: <div data-testid="home-probe">home</div> }],
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Scrap" }));

    expect(scrapped).toBe(true);
    expect(await screen.findByTestId("home-probe")).toBeInTheDocument();
  });

  it("does not scrap when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let scrapped = false;
    server.use(
      http.delete("/api/v1/rota/:id", () => {
        scrapped = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Scrap" }));

    expect(scrapped).toBe(false);
  });
});