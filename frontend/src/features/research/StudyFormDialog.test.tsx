import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Permissions } from "@/api/types";
import { PERMISSION_PRESETS, makeAuthUser } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { StudyFormDialog } from "./StudyFormDialog";
import { makeStudy } from "./testFixtures";
import type { Study } from "./types";

function renderDialog(study?: Study, permissions: Permissions = PERMISSION_PRESETS.research) {
  return renderWithProviders(
    <StudyFormDialog study={study} open onOpenChange={() => {}} />,
    { area: "research", permissions },
  );
}

describe("StudyFormDialog", () => {
  it("refuses to save without a name, without calling the API", async () => {
    let posted = false;
    server.use(
      http.post("/api/v1/research/studies", () => {
        posted = true;
        return HttpResponse.json(makeStudy(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Study name is required")).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it("refuses a website that is not http or https", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "ACME-1");
    await user.type(screen.getByLabelText("Study website"), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Study website must be a full http:// or https:// address"),
    ).toBeInTheDocument();
  });

  it("posts the header and its contacts as one payload", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/v1/research/studies", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeStudy(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "ACME-1");
    await user.type(screen.getByLabelText("CPMS code"), "12345");
    await user.click(screen.getByRole("button", { name: "Add contact" }));
    await user.type(screen.getByLabelText("Name", { selector: "#contact-name-0" }), "Jo Adams");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(body).toEqual({
      name: "ACME-1",
      cpms_code: "12345",
      study_type: null,
      website_url: null,
      owner_user_id: null,
      contacts: [{ name: "Jo Adams", role: null, email: null, phone: null }],
    });
  });

  it("PATCHes an existing study, sending the contacts it was left with", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/v1/research/studies/1", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeStudy());
      }),
    );
    const user = userEvent.setup();
    renderDialog(
      makeStudy({
        contacts: [
          { id: 4, name: "Jo Adams", role: null, email: null, phone: null, display_order: 0 },
        ],
      }),
    );

    // Removing a row here is a row deleted on save: the PATCH carries the
    // whole list and the server reads it as a replace.
    await user.click(screen.getByRole("button", { name: "Remove contact" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const sent = body as Record<string, unknown> | null;
    expect(sent).not.toBeNull();
    expect(sent?.contacts).toEqual([]);
  });

  it("shows the server's message when the CPMS code is taken", async () => {
    server.use(
      http.post("/api/v1/research/studies", () =>
        HttpResponse.json(
          { detail: "CPMS code 12345 is already used by ACME-1" },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "ACME-2");
    await user.type(screen.getByLabelText("CPMS code"), "12345");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("CPMS code 12345 is already used by ACME-1"),
    ).toBeInTheDocument();
  });

  // /users is manager-only, so a research-only login cannot be offered a
  // picker. It keeps whatever owner the study has.
  it("shows the owner as text for a login that cannot read the user list", async () => {
    renderDialog(makeStudy({ owner_user_id: 3, owner_name: "Dr Smith" }));

    expect(screen.getByText("Dr Smith")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("offers a picker to a user administrator", async () => {
    server.use(
      http.get("/api/v1/users", () =>
        HttpResponse.json([makeAuthUser({ id: 3, name: "Dr Smith" })]),
      ),
    );
    renderDialog(makeStudy(), PERMISSION_PRESETS.manager);

    expect(await screen.findByRole("option", { name: "Dr Smith" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "No owner" })).toBeInTheDocument();
  });
});
