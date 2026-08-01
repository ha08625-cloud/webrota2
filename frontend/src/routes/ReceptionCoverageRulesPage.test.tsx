import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { RECEPTION_HOURS } from "@/lib/receptionHours";
import { makeReceptionCoverageRule } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionCoverageRulesPage } from "./ReceptionCoverageRulesPage";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;

function allRules() {
  return DAYS.flatMap((day, dayIndex) =>
    RECEPTION_HOURS.map((hour, hourIndex) =>
      makeReceptionCoverageRule({
        id: dayIndex * RECEPTION_HOURS.length + hourIndex + 1,
        day,
        hour,
        min_phones_staff: hour === 9 || hour === 9.5 || hour === 10 || hour === 10.5 ? 3 : 2,
      }),
    ),
  );
}

describe("ReceptionCoverageRulesPage", () => {
  it("renders a cell per (day, hour) rule with its current minimum", async () => {
    server.use(http.get("/api/v1/reception/coverage-rules", () => HttpResponse.json(allRules())));
    renderWithProviders(<ReceptionCoverageRulesPage />);

    expect(await screen.findByLabelText("Minimum phones staff, Monday 09:00-09:30")).toHaveValue(3);
    expect(screen.getByLabelText("Minimum phones staff, Monday 08:00-08:30")).toHaveValue(2);
    expect(screen.getByLabelText("Minimum phones staff, Friday 17:30-18:00")).toHaveValue(2);
  });

  it("editing a cell fires exactly one PATCH on blur", async () => {
    const rules = allRules();
    server.use(http.get("/api/v1/reception/coverage-rules", () => HttpResponse.json(rules)));
    const target = rules.find((r) => r.day === "Monday" && r.hour === 8)!;
    let patchCount = 0;
    let patchBody: unknown;
    server.use(
      http.patch(`/api/v1/reception/coverage-rules/${target.id}`, async ({ request }) => {
        patchCount += 1;
        patchBody = await request.json();
        return HttpResponse.json({ ...target, min_phones_staff: 4 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionCoverageRulesPage />);
    const input = await screen.findByLabelText("Minimum phones staff, Monday 08:00-08:30");

    await user.clear(input);
    await user.type(input, "4");
    await user.tab();

    await waitFor(() => expect(patchCount).toBe(1));
    expect(patchBody).toEqual({ min_phones_staff: 4 });
  });

  it("blurring without a change does not fire a PATCH", async () => {
    const rules = allRules();
    server.use(http.get("/api/v1/reception/coverage-rules", () => HttpResponse.json(rules)));
    const target = rules.find((r) => r.day === "Monday" && r.hour === 8)!;
    let patchCount = 0;
    server.use(
      http.patch(`/api/v1/reception/coverage-rules/${target.id}`, () => {
        patchCount += 1;
        return HttpResponse.json(target);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionCoverageRulesPage />);
    const input = await screen.findByLabelText("Minimum phones staff, Monday 08:00-08:30");
    await user.click(input);
    await user.tab();

    expect(patchCount).toBe(0);
  });
});
