import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Permissions } from "@/api/types";
import { PERMISSION_PRESETS } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { StudyPage } from "./StudyPage";
import { makeDocument, makeSetupStep, makeStudy } from "./testFixtures";
import type { Study } from "./types";

function renderStudy(study: Study, permissions: Permissions = PERMISSION_PRESETS.research) {
  server.use(
    http.get(`/api/v1/research/studies/${study.id}`, () => HttpResponse.json(study)),
  );
  return renderWithProviders(<StudyPage />, {
    area: "research",
    permissions,
    route: `/research/studies/${study.id}`,
    path: "/research/studies/:studyId",
    additionalRoutes: [{ path: "/research", element: <p>Studies list</p> }],
  });
}

describe("StudyPage header", () => {
  it("shows the persistent details in every stage", async () => {
    renderStudy(
      makeStudy({
        stage: "recruitment_closed",
        cpms_code: "54321",
        study_type: "Observational",
        owner_name: "Dr Smith",
      }),
    );

    expect(await screen.findByRole("heading", { name: "ACME-1" })).toBeInTheDocument();
    expect(screen.getByText("54321")).toBeInTheDocument();
    expect(screen.getByText("Observational")).toBeInTheDocument();
    expect(screen.getByText("Dr Smith")).toBeInTheDocument();
  });

  // A link out of the app, from a value another user typed: the http/https
  // rule keeps a javascript: URL out of the href, and these two attributes
  // keep the opened tab from reaching back.
  it("renders the website link with rel=noopener noreferrer", async () => {
    renderStudy(makeStudy({ website_url: "https://example.test/acme" }));

    const link = await screen.findByRole("link", { name: "https://example.test/acme" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("lists the contacts", async () => {
    renderStudy(
      makeStudy({
        contacts: [
          {
            id: 1,
            name: "Jo Adams",
            role: "CRA",
            email: "jo@example.test",
            phone: "01234 567890",
            display_order: 0,
          },
        ],
      }),
    );

    const table = await screen.findByRole("table", { name: "Contacts" });
    expect(within(table).getByText("Jo Adams")).toBeInTheDocument();
    expect(within(table).getByText("01234 567890")).toBeInTheDocument();
  });

  it("shows the three key document slots, filled or empty", async () => {
    renderStudy(
      makeStudy({
        documents: [makeDocument({ id: 10, slot: "consent_form", filename: "consent-v2.pdf" })],
      }),
    );

    // Scoped to the header's section: the Setup body below draws slots of
    // its own, and this is the assertion that there are three key ones.
    const keyDocuments = (await screen.findByText("Key documents")).closest(
      "section",
    ) as HTMLElement;
    expect(within(keyDocuments).getByText("Flow chart")).toBeInTheDocument();
    expect(within(keyDocuments).getByText("Patient information leaflet")).toBeInTheDocument();
    expect(
      within(keyDocuments).getByRole("button", { name: "consent-v2.pdf" }),
    ).toBeInTheDocument();
    // The two empty slots say so rather than disappearing.
    expect(within(keyDocuments).getAllByText("Nothing uploaded.")).toHaveLength(2);
  });

  it("marks the current stage on the indicator", async () => {
    renderStudy(makeStudy({ stage: "recruitment_open" }));

    const stages = await screen.findByRole("list", { name: "Stage" });
    expect(within(stages).getByText("Recruitment open")).toHaveAttribute("aria-current", "step");
  });
});

describe("StudyPage transitions", () => {
  it("names the outstanding setup steps before opening recruitment, without blocking", async () => {
    const study = makeStudy({
      stage: "setup",
      setup_steps: [
        makeSetupStep({ step_key: "mnca", done: true }),
        makeSetupStep({ step_key: "siv_booked", done: false }),
      ],
    });
    let advanced = false;
    server.use(
      http.post("/api/v1/research/studies/1/advance", () => {
        advanced = true;
        return HttpResponse.json({ ...study, stage: "recruitment_open" });
      }),
    );
    const user = userEvent.setup();
    renderStudy(study);

    await user.click(await screen.findByRole("button", { name: "Open recruitment" }));

    const dialog = await screen.findByRole("dialog");
    // Ticked steps drop off the list; a step with no row at all is "not
    // done" and stays on it.
    expect(within(dialog).queryByText("Sign mNCA")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Book Site Initiation Visit")).toBeInTheDocument();
    expect(within(dialog).getByText("Complete training log")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Move on" }));

    expect(advanced).toBe(true);
  });

  it("offers different copy for moving back a stage", async () => {
    const user = userEvent.setup();
    renderStudy(makeStudy({ stage: "recruitment_open" }));

    await user.click(await screen.findByRole("button", { name: "Move back a stage" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move back" })).toBeInTheDocument();
  });

  it("offers no revert in setup and no advance once closed", async () => {
    renderStudy(makeStudy({ stage: "setup" }));

    await screen.findByRole("heading", { name: "ACME-1" });
    expect(screen.queryByRole("button", { name: "Move back a stage" })).not.toBeInTheDocument();
  });

  it("offers no advance on a closed study", async () => {
    renderStudy(makeStudy({ id: 2, stage: "closed" }));

    await screen.findByRole("heading", { name: "ACME-1" });
    expect(screen.queryByRole("button", { name: "Move on a stage" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move back a stage" })).toBeInTheDocument();
  });
});

describe("StudyPage stage bodies", () => {
  it("swaps the setup checklist for the stub on advancing, keeping the key documents", async () => {
    const study = makeStudy({
      documents: [makeDocument({ id: 10, slot: "consent_form", filename: "consent-v2.pdf" })],
    });
    let stage: Study["stage"] = "setup";
    server.use(
      http.get("/api/v1/research/studies/1", () => HttpResponse.json({ ...study, stage })),
      http.post("/api/v1/research/studies/1/advance", () => {
        stage = "recruitment_open";
        return HttpResponse.json({ ...study, stage });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<StudyPage />, {
      area: "research",
      permissions: PERMISSION_PRESETS.research,
      route: "/research/studies/1",
      path: "/research/studies/:studyId",
      additionalRoutes: [{ path: "/research", element: <p>Studies list</p> }],
    });

    expect(await screen.findByLabelText("Sign mNCA date")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Open recruitment" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Move on" }));

    // The checklist is Setup's, and it goes with Setup - hidden, not
    // deleted, so moving back a stage brings it straight back.
    expect(await screen.findByText("More to come here.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Sign mNCA date")).not.toBeInTheDocument();

    // The header outlives the stage: the three key documents are still
    // there, which is the whole point of drawing them above the body.
    const keyDocuments = screen.getByText("Key documents").closest("section") as HTMLElement;
    expect(
      within(keyDocuments).getByRole("button", { name: "consent-v2.pdf" }),
    ).toBeInTheDocument();
    expect(within(keyDocuments).getByText("Flow chart")).toBeInTheDocument();
  });
});

describe("StudyPage delete", () => {
  it("deletes a study still in setup and returns to the list", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let deleted = false;
    server.use(
      http.delete("/api/v1/research/studies/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderStudy(makeStudy({ stage: "setup" }));

    await user.click(await screen.findByRole("button", { name: "Delete this study" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("Studies list")).toBeInTheDocument();
  });

  // Deletion is reachable only in setup; afterwards a study is a record
  // and is closed instead.
  it("does not offer deletion once a study has left setup", async () => {
    renderStudy(makeStudy({ stage: "recruitment_open" }));

    await screen.findByRole("heading", { name: "ACME-1" });
    expect(screen.queryByRole("button", { name: "Delete this study" })).not.toBeInTheDocument();
  });
});

describe("StudyPage read-only", () => {
  it("shows the page with its write controls disabled", async () => {
    renderStudy(makeStudy({ documents: [makeDocument()] }), {
      ...PERMISSION_PRESETS.research,
      research: "read",
    });

    expect(await screen.findByRole("heading", { name: "ACME-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit details" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open recruitment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete this study" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replace consent form" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    // Reading is not writing: the download still works.
    expect(screen.getByRole("button", { name: "consent-v2.pdf" })).toBeEnabled();
  });
});

describe("StudyPage when the study is gone", () => {
  it("says so rather than showing an empty header", async () => {
    server.use(
      http.get("/api/v1/research/studies/99", () =>
        HttpResponse.json({ detail: "Study 99 not found" }, { status: 404 }),
      ),
    );
    renderWithProviders(<StudyPage />, {
      area: "research",
      permissions: PERMISSION_PRESETS.research,
      route: "/research/studies/99",
      path: "/research/studies/:studyId",
    });

    expect(await screen.findByText("That study no longer exists.")).toBeInTheDocument();
  });
});
