import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeReceptionCoverageRule } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionCoverageRulesPage } from "./ReceptionCoverageRulesPage";

function setUpServer(rules: ReturnType<typeof makeReceptionCoverageRule>[]) {
  server.use(http.get("/api/v1/reception/coverage-rules", () => HttpResponse.json(rules)));
}

describe("ReceptionCoverageRulesPage", () => {
  it("renders a 5 x 10 grid of weekdays x hours", async () => {
    setUpServer([makeReceptionCoverageRule({ id: 1, day: "Monday", hour: 9, min_phones_staff: 3 })]);
    renderWithProviders(<ReceptionCoverageRulesPage />);

    expect(await screen.findByRole("columnheader", { name: "Monday" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Friday" })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum phones staff for Monday 09:00-10:00")).toHaveValue(3);
  });

  it("shows a dash for a (day, hour) combination with no rule", async () => {
    setUpServer([]);
    renderWithProviders(<ReceptionCoverageRulesPage />);

    await screen.findByRole("columnheader", { name: "Monday" });
    expect(
      screen.queryByLabelText("Minimum phones staff for Monday 09:00-10:00"),
    ).not.toBeInTheDocument();
  });

  it("fires exactly one PATCH on blur, not on keystroke", async () => {
    setUpServer([makeReceptionCoverageRule({ id: 1, day: "Monday", hour: 9, min_phones_staff: 2 })]);
    let patchCount = 0;
    let lastBody: unknown;
    server.use(
      http.patch("/api/v1/reception/coverage-rules/1", async ({ request }) => {
        patchCount += 1;
        lastBody = await request.json();
        return HttpResponse.json(makeReceptionCoverageRule({ id: 1, day: "Monday", hour: 9, min_phones_staff: 4 }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionCoverageRulesPage />);
    const input = await screen.findByLabelText("Minimum phones staff for Monday 09:00-10:00");

    await user.clear(input);
    await user.type(input, "4");
    expect(patchCount).toBe(0);

    await user.tab();

    expect(patchCount).toBe(1);
    expect(lastBody).toEqual({ min_phones_staff: 4 });
  });
});
