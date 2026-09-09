import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeReceptionLeaveEntry, makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionLeavePage } from "./ReceptionLeavePage";

const STAFF = [
  makeReceptionStaff({ id: 1, code: "RA" }),
  makeReceptionStaff({ id: 2, code: "RB" }),
  makeReceptionStaff({ id: 3, code: "RC", active: false }),
];

function setUpServer(entries: ReturnType<typeof makeReceptionLeaveEntry>[] = []) {
  server.use(
    http.get("/api/v1/reception/staff", () => HttpResponse.json(STAFF)),
    http.get("/api/v1/reception/leave", () => HttpResponse.json(entries)),
  );
}

async function fillRange(user: ReturnType<typeof userEvent.setup>, start: string, end: string) {
  await user.selectOptions(screen.getByLabelText("Staff member", { selector: "#reception-leave-staff" }), "1");
  await user.type(screen.getByLabelText("Start date"), start);
  await user.type(screen.getByLabelText("End date"), end);
}

describe("ReceptionLeavePage", () => {
  it("shows an empty state when nobody has leave recorded", async () => {
    setUpServer([]);
    renderWithProviders(<ReceptionLeavePage />);

    expect(await screen.findByText("No leave entries.")).toBeInTheDocument();
  });

  it("lists entries with the staff code", async () => {
    setUpServer([
      makeReceptionLeaveEntry({ id: 10, staff_id: 1, date: "2026-08-03" }),
      makeReceptionLeaveEntry({ id: 11, staff_id: 2, date: "2026-08-04" }),
    ]);
    renderWithProviders(<ReceptionLeavePage />);

    const rows = await screen.findAllByRole("row");
    // Header plus two entries.
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("RA")).toBeInTheDocument();
    expect(within(rows[2]).getByText("RB")).toBeInTheDocument();
  });

  it("the range form only offers active staff, the filter offers everyone", async () => {
    setUpServer([]);
    renderWithProviders(<ReceptionLeavePage />);
    await screen.findByText("No leave entries.");

    const form = screen.getByLabelText("Staff member", { selector: "#reception-leave-staff" });
    expect(within(form).queryByText("RC")).not.toBeInTheDocument();

    const filter = screen.getByLabelText("Staff member", { selector: "#reception-leave-filter" });
    expect(within(filter).getByText(/RC/)).toBeInTheDocument();
  });

  it("adding a range posts to bulk and reports the counts, weekend skips included", async () => {
    setUpServer([]);
    let body: unknown;
    server.use(
      http.post("/api/v1/reception/leave/bulk", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ created: 5, skipped_existing: 1, skipped_weekend: 2 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ReceptionLeavePage />);
    await screen.findByText("No leave entries.");

    await fillRange(user, "2026-08-03", "2026-08-10");
    await user.click(screen.getByRole("button", { name: "Add leave" }));

    expect(
      await screen.findByText("5 days added, 1 already recorded, 2 weekend days skipped."),
    ).toBeInTheDocument();
    expect(body).toEqual({ staff_id: 1, start_date: "2026-08-03", end_date: "2026-08-10" });
  });

  it("omits the skip counts when there were none", async () => {
    setUpServer([]);
    server.use(
      http.post("/api/v1/reception/leave/bulk", () =>
        HttpResponse.json({ created: 1, skipped_existing: 0, skipped_weekend: 0 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ReceptionLeavePage />);
    await screen.findByText("No leave entries.");

    await fillRange(user, "2026-08-03", "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add leave" }));

    expect(await screen.findByText("1 day added.")).toBeInTheDocument();
  });

  it("rejects an end date before the start date without calling the API", async () => {
    setUpServer([]);
    const bulk = vi.fn(() => HttpResponse.json({ created: 0, skipped_existing: 0, skipped_weekend: 0 }));
    server.use(http.post("/api/v1/reception/leave/bulk", bulk));
    const user = userEvent.setup();
    renderWithProviders(<ReceptionLeavePage />);
    await screen.findByText("No leave entries.");

    await fillRange(user, "2026-08-10", "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add leave" }));

    expect(await screen.findByText("End date must not be before start date.")).toBeInTheDocument();
    expect(bulk).not.toHaveBeenCalled();
  });

  it("surfaces a failed add", async () => {
    setUpServer([]);
    server.use(
      http.post("/api/v1/reception/leave/bulk", () =>
        HttpResponse.json({ detail: "Reception staff 1 not found" }, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ReceptionLeavePage />);
    await screen.findByText("No leave entries.");

    await fillRange(user, "2026-08-03", "2026-08-04");
    await user.click(screen.getByRole("button", { name: "Add leave" }));

    expect(await screen.findByText("Reception staff 1 not found")).toBeInTheDocument();
  });

  it("remove mode confirms before calling bulk-delete", async () => {
    setUpServer([]);
    let called = false;
    server.use(
      http.post("/api/v1/reception/leave/bulk-delete", () => {
        called = true;
        return HttpResponse.json({ deleted_count: 3 });
      }),
    );
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderWithProviders(<ReceptionLeavePage />);
    await screen.findByText("No leave entries.");

    await user.click(screen.getByLabelText("Remove leave"));
    await fillRange(user, "2026-08-03", "2026-08-05");
    await user.click(screen.getByRole("button", { name: "Remove leave" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(called).toBe(false);
    // A cancelled confirm must leave the range intact so the second click
    // has something to submit.
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-08-03");

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Remove leave" }));
    expect(await screen.findByText("3 days removed.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("per-row delete calls DELETE with the entry id", async () => {
    setUpServer([makeReceptionLeaveEntry({ id: 42, staff_id: 1, date: "2026-08-03" })]);
    let deletedId: string | undefined;
    server.use(
      http.delete("/api/v1/reception/leave/:id", ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ReceptionLeavePage />);

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(deletedId).toBe("42");
  });
});
