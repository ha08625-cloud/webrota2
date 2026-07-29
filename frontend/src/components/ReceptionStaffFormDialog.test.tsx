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
        return HttpResponse.json(makeReceptionStaff({ id: 9, code: "JS", name: "Jo Smith" }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.type(screen.getByLabelText("Code"), "JS");
    await user.type(screen.getByLabelText("Name"), "Jo Smith");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({ code: "JS", name: "Jo Smith" });
  });

  it("does not submit when code is empty - shows a client-side field error", async () => {
    let posted = false;
    server.use(
      http.post("/api/v1/reception/staff", () => {
        posted = true;
        return HttpResponse.json(makeReceptionStaff({ id: 1 }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.type(screen.getByLabelText("Name"), "Jo Smith");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Code is required")).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("a 409 duplicate-code conflict is shown on the code field, not a top-of-form banner", async () => {
    server.use(
      http.post("/api/v1/reception/staff", () =>
        HttpResponse.json({ detail: "Reception staff code 'JS' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("Code");
    await user.type(screen.getByLabelText("Code"), "JS");
    await user.type(screen.getByLabelText("Name"), "Jo Smith");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const message = await screen.findByText("Reception staff code 'JS' already exists");
    expect(message.previousElementSibling).toHaveAttribute("id", "rs-code");
  });
});

describe("ReceptionStaffFormDialog - edit mode", () => {
  it("pre-fills scalar fields and submits a PATCH", async () => {
    const staff = makeReceptionStaff({ id: 5, code: "AB", name: "Ann Brown" });
    let patchBody: unknown;
    server.use(
      http.patch("/api/v1/reception/staff/5", async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json({ ...staff, name: "Ann B" });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReceptionStaffFormDialog staff={staff} open onOpenChange={() => {}} />);

    expect(await screen.findByLabelText("Code")).toHaveValue("AB");
    expect(screen.getByLabelText("Name")).toHaveValue("Ann Brown");

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Ann B");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(patchBody).toEqual({ code: "AB", name: "Ann B" });
  });
});
