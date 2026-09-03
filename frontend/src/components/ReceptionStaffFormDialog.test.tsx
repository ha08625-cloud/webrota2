import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionStaffFormDialog } from "./ReceptionStaffFormDialog";

// The single field is labelled "Name" but posts as `code`, the only
// identifier the record has - so every assertion below reads the label and
// asserts the wire key.
describe("ReceptionStaffFormDialog - create mode", () => {
  it("renders an empty form", async () => {
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);

    expect(await screen.findByRole("heading", { name: "New Reception Staff" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
  });

  it("submits a create payload via POST /reception/staff", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/reception/staff", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeReceptionStaff({ id: 9, code: "Jo S" }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");
    await user.type(screen.getByLabelText("Name"), "Jo S");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({ code: "Jo S" });
  });

  it("does not submit when the name is empty - shows a client-side field error", async () => {
    let posted = false;
    server.use(
      http.post("/api/v1/reception/staff", () => {
        posted = true;
        return HttpResponse.json(makeReceptionStaff({ id: 1 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("a 409 duplicate conflict is shown on the name field, not a top-of-form banner", async () => {
    server.use(
      http.post("/api/v1/reception/staff", () =>
        HttpResponse.json({ detail: "Reception staff name 'JS' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Name");
    await user.type(screen.getByLabelText("Name"), "JS");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const message = await screen.findByText("Reception staff name 'JS' already exists");
    expect(message.previousElementSibling).toHaveAttribute("id", "rs-name");
  });
});

describe("ReceptionStaffFormDialog - edit mode", () => {
  it("pre-fills the name and submits a PATCH", async () => {
    const staff = makeReceptionStaff({ id: 5, code: "AB" });
    let patchBody: unknown;
    server.use(
      http.patch("/api/v1/reception/staff/5", async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json({ ...staff, code: "Ann B" });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog staff={staff} open onOpenChange={() => {}} />);

    expect(await screen.findByLabelText("Name")).toHaveValue("AB");

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Ann B");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(patchBody).toEqual({ code: "Ann B" });
  });
});
