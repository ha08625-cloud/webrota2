import { describe, expect, it } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useParams } from "react-router-dom";

import { makeRotaSummary } from "@/test/fixtures/rota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { RotaPage } from "./RotaPage";

function DetailProbe() {
  const params = useParams<{ id: string }>();
  return <div data-testid="detail-probe">detail:{params.id}</div>;
}

describe("RotaPage", () => {
  it("shows the generate form when there is no active draft", async () => {
    server.use(
      http.get("/api/v1/rota", () =>
        HttpResponse.json([makeRotaSummary({ rota_id: 1, status: "committed" })]),
      ),
    );

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText("Generate a rota")).toBeInTheDocument();
    expect(screen.getByText("Committed history")).toBeInTheDocument();
  });

  it("shows the active draft card, not the generate form, when a draft exists", async () => {
    server.use(
      http.get("/api/v1/rota", () => HttpResponse.json([makeRotaSummary({ rota_id: 5, status: "draft" })])),
    );

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText(/Draft in progress/)).toBeInTheDocument();
    expect(screen.queryByText("Generate a rota")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open draft" })).toHaveAttribute("href", "/rota/5");
  });

  it("shows the empty state when there are no committed rotas", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText("No committed rotas yet.")).toBeInTheDocument();
  });

  it("renders a week selector with the next 12 upcoming Mondays as options", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const select = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options).toHaveLength(12);
    // "w/c 13 Jul 2026" shape - exact date depends on today, so only the
    // format is asserted here (see date_test.ts for the date arithmetic
    // itself, which is tested against fixed dates).
    expect(options[0].textContent).toMatch(/^w\/c \d{1,2} \w{3} \d{4}$/);
  });

  it("sends the correct payload, including the hidden template_start_week", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    let capturedBody: unknown = null;
    server.use(
      http.post("/api/v1/rota/generate", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ rota_id: 42, status: "draft", issues: [] });
      }),
    );

    renderWithProviders(<RotaPage />, { additionalRoutes: [{ path: "/rota/:id", element: <DetailProbe /> }] });
    await screen.findByText("Generate a rota");

    const weekSelect = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;
    const weekOptions = within(weekSelect).getAllByRole("option") as HTMLOptionElement[];
    const chosenWeek = weekOptions[2].value; // a week other than the default, to prove selection is wired up

    const user = userEvent.setup();
    await user.selectOptions(weekSelect, chosenWeek);
    await user.selectOptions(screen.getByLabelText("Number of weeks"), "2");
    await user.click(screen.getByRole("button", { name: "Generate rota" }));

    await waitFor(() => {
      expect(capturedBody).toEqual({
        start_date: chosenWeek,
        num_weeks: 2,
        template_start_week: 1,
      });
    });
  });

  it("navigates to /rota/{rota_id} using the server's rota_id on success", async () => {
    // Guards against reading data.id instead of data.rota_id: that bug
    // would navigate to "/rota/undefined" and this probe would show
    // "detail:undefined", not "detail:42".
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/rota/generate", () => HttpResponse.json({ rota_id: 42, status: "draft", issues: [] })),
    );

    renderWithProviders(<RotaPage />, { additionalRoutes: [{ path: "/rota/:id", element: <DetailProbe /> }] });
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate rota" }));

    expect(await screen.findByTestId("detail-probe")).toHaveTextContent("detail:42");
  });

  it("renders a 409 (draft already exists) as a plain error message", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/rota/generate", () =>
        HttpResponse.json({ detail: "A draft rota already exists; commit or scrap it first" }, { status: 409 }),
      ),
    );

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate rota" }));

    expect(await screen.findByText("A draft rota already exists; commit or scrap it first")).toBeInTheDocument();
  });

  it("renders a Phase 0 validation-issue list on 422", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/rota/generate", () =>
        HttpResponse.json(
          {
            detail: [
              {
                severity: "error",
                phase: "phase0",
                check: "duty_on_leave",
                message: "Duty doctor is on leave",
                week: 1,
                day: "Monday",
                period: "AM",
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate rota" }));

    expect(await screen.findByText(/Duty doctor is on leave/)).toBeInTheDocument();
  });

  it("renders a standard FastAPI request-validation error list on 422", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/rota/generate", () =>
        HttpResponse.json(
          { detail: [{ loc: ["body", "start_date"], msg: "field required", type: "missing" }] },
          { status: 422 },
        ),
      ),
    );

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate rota" }));

    expect(await screen.findByText("field required")).toBeInTheDocument();
  });
});