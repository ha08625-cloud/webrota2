import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeLeaveEntry } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { LeavePage } from "./LeavePage";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
  leave = [] as ReturnType<typeof makeLeaveEntry>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/leave", () => HttpResponse.json(leave)),
  );
}

describe("LeavePage", () => {
  it("shows an empty-state message when there are no entries", async () => {
    setUpServer();
    renderWithProviders(<LeavePage />);

    expect(await screen.findByText("No leave entries.")).toBeInTheDocument();
  });

  it("renders a row per leave entry", async () => {
    setUpServer({ leave: [makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" })] });
    renderWithProviders(<LeavePage />);

    expect(await screen.findByText("2026-08-03")).toBeInTheDocument();
    expect(screen.getByText("AB")).toBeInTheDocument();
  });

  it("the doctor filter select includes inactive doctors", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 2, code: "ZZ", active: false })] });
    renderWithProviders(<LeavePage />);

    const filter = await screen.findByLabelText("Doctor");
    expect(within(filter).getByRole("option", { name: "ZZ (inactive)" })).toBeInTheDocument();
  });

  it("the add-row doctor select excludes inactive doctors", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", active: true }), makeDoctor({ id: 2, code: "ZZ", active: false })],
    });
    renderWithProviders(<LeavePage />);

    const addSelect = await screen.findByLabelText("Doctor", { selector: "#leave-add-doctor" });
    expect(within(addSelect).getByRole("option", { name: "AB" })).toBeInTheDocument();
    expect(within(addSelect).queryByRole("option", { name: /ZZ/ })).not.toBeInTheDocument();
  });

  it("selecting a doctor in the filter refetches with doctor_id", async () => {
    setUpServer();
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/leave", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    const filter = await screen.findByLabelText("Doctor", { selector: "#leave-filter" });

    await user.selectOptions(filter, "1");

    await waitFor(() => expect(capturedUrl).toContain("doctor_id=1"));
  });

  it("both-periods add-row posts two entries, one AM and one PM, for the selected doctor and date", async () => {
    setUpServer();
    const postedBodies: unknown[] = [];
    server.use(
      http.post("/api/v1/leave", async ({ request }) => {
        const body = await request.json();
        postedBodies.push(body);
        return HttpResponse.json(makeLeaveEntry(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    await screen.findByLabelText("Doctor", { selector: "#leave-add-doctor" });

    await user.selectOptions(screen.getByLabelText("Doctor", { selector: "#leave-add-doctor" }), "1");
    await user.type(screen.getByLabelText("Date"), "2026-08-03");
    await user.selectOptions(screen.getByLabelText("Period"), "BOTH");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(postedBodies).toHaveLength(2));
    expect(postedBodies).toContainEqual({ doctor_id: 1, date: "2026-08-03", period: "AM" });
    expect(postedBodies).toContainEqual({ doctor_id: 1, date: "2026-08-03", period: "PM" });
  });

  it("a single-period add-row posts exactly one entry", async () => {
    setUpServer();
    const postedBodies: unknown[] = [];
    server.use(
      http.post("/api/v1/leave", async ({ request }) => {
        postedBodies.push(await request.json());
        return HttpResponse.json(makeLeaveEntry(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    await screen.findByLabelText("Doctor", { selector: "#leave-add-doctor" });

    await user.selectOptions(screen.getByLabelText("Doctor", { selector: "#leave-add-doctor" }), "1");
    await user.type(screen.getByLabelText("Date"), "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(postedBodies).toHaveLength(1));
    expect(postedBodies[0]).toEqual({ doctor_id: 1, date: "2026-08-03", period: "AM" });
  });

  it("a partial failure in the both-periods case reports which period failed, not a generic error", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/leave", async ({ request }) => {
        const body = (await request.json()) as { period: string };
        if (body.period === "PM") {
          return HttpResponse.json(
            { detail: "Leave entry already exists for this doctor/date/period" },
            { status: 409 },
          );
        }
        return HttpResponse.json(makeLeaveEntry(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    await screen.findByLabelText("Doctor", { selector: "#leave-add-doctor" });

    await user.selectOptions(screen.getByLabelText("Doctor", { selector: "#leave-add-doctor" }), "1");
    await user.type(screen.getByLabelText("Date"), "2026-08-03");
    await user.selectOptions(screen.getByLabelText("Period"), "BOTH");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/PM:.*already exists/)).toBeInTheDocument();
  });

  it("delete removes an entry", async () => {
    setUpServer({ leave: [makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-08-03" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/leave/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/leave", () =>
        HttpResponse.json(deleted ? [] : [makeLeaveEntry({ id: 1, doctor_id: 1, date: "2026-08-03" })]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<LeavePage />);
    await screen.findByText("2026-08-03");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("No leave entries.")).toBeInTheDocument();
  });
});