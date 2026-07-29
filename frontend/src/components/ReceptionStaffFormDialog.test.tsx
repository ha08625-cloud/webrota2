import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionStaffFormDialog } from "./ReceptionStaffFormDialog";

describe("ReceptionStaffFormDialog - create mode", () => {
  it("renders an empty form", async () => {
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);

    expect(await screen.findByRole("heading", { name: "New Reception Staff" })).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveValue("");
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("submits a create payload via POST /reception/staff", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/reception/staff", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeReceptionStaff({ id: 9, code: "PQ", name: "Pat Quinn" }), {
          status: 201,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Code"), "PQ");
    await user.type(screen.getByLabelText("Name"), "Pat Quinn");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({ code: "PQ", name: "Pat Quinn" });
  });

  it("does not submit with a blank code - shows a client-side field error", async () => {
    let posted = false;
    server.use(
      http.post("/api/v1/reception/staff", () => {
        posted = true;
        return HttpResponse.json(makeReceptionStaff(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Name"), "Pat Quinn");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Code is required")).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("a duplicate-code 409 is shown on the code field, not as a form-level banner", async () => {
    server.use(
      http.post("/api/v1/reception/staff", () =>
        HttpResponse.json({ detail: "Reception staff code 'PQ' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Code"), "PQ");
    await user.type(screen.getByLabelText("Name"), "Pat Quinn");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const message = await screen.findByText("Reception staff code 'PQ' already exists");
    expect(message).toBeInTheDocument();
    expect(screen.getByLabelText("Code").closest("div")).toContainElement(message);
  });
});

describe("ReceptionStaffFormDialog - edit mode", () => {
  it("pre-fills code/name", async () => {
    const existingStaff = makeReceptionStaff({ id: 5, code: "JS", name: "Jo Smith" });

    renderWithProviders(<ReceptionStaffFormDialog staff={existingStaff} open onOpenChange={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Edit Jo Smith" })).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveValue("JS");
    expect(screen.getByLabelText("Name")).toHaveValue("Jo Smith");
  });

  it("submits a PATCH with the edited values", async () => {
    const existingStaff = makeReceptionStaff({ id: 5, code: "JS", name: "Jo Smith" });
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/reception/staff/5", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(existingStaff);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog staff={existingStaff} open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Jo Smyth");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({ code: "JS", name: "Jo Smyth" });
  });
});
