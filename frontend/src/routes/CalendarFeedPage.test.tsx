import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Permissions } from "@/api/types";
import { PERMISSION_PRESETS, makeDoctor } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { CalendarFeedPage } from "./CalendarFeedPage";

const DOCTORS = [
  makeDoctor({ id: 1, code: "AB" }),
  makeDoctor({ id: 2, code: "CD" }),
];

function setUpServer(doctors = DOCTORS) {
  server.use(http.get("/api/v1/doctors", () => HttpResponse.json(doctors)));
}

function render(permissions: Permissions = PERMISSION_PRESETS.manager) {
  return renderWithProviders(<CalendarFeedPage />, { permissions });
}

/** Logged in as the user linked to doctor 1 ("AB"). */
function renderLinked() {
  return renderWithProviders(<CalendarFeedPage />, {
    authUser: { linked_doctor: { id: 1, code: "AB", active: true } },
  });
}

async function pickDoctor(code: string) {
  // Wait for the options to arrive before selecting: the <select> renders
  // immediately with only the placeholder, so selecting straight away
  // races the doctors fetch.
  const option = await screen.findByRole("option", { name: code });
  await userEvent.selectOptions(screen.getByLabelText("Doctor"), option);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CalendarFeedPage", () => {
  it("shows no link until a doctor is picked", async () => {
    setUpServer();
    render();

    expect(await screen.findByRole("option", { name: "AB" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\.ics$/)).not.toBeInTheDocument();
  });

  it("builds the absolute URL from window.location.origin", async () => {
    setUpServer();
    server.use(
      http.get("/api/v1/doctors/1/calendar-feed", () =>
        HttpResponse.json({ doctor_id: 1, token: "tok", feed_path: "/api/v1/calendar/tok.ics" }),
      ),
    );
    render();

    await pickDoctor("AB");

    expect(
      await screen.findByText(`${window.location.origin}/api/v1/calendar/tok.ics`),
    ).toBeInTheDocument();
  });

  it("only offers active doctors", async () => {
    setUpServer();
    let activeOnly: string | null = null;
    server.use(
      http.get("/api/v1/doctors", ({ request }) => {
        activeOnly = new URL(request.url).searchParams.get("active_only");
        return HttpResponse.json(DOCTORS);
      }),
    );
    render();

    await screen.findByRole("option", { name: "AB" });
    expect(activeOnly).toBe("true");
  });

  it("copies the URL to the clipboard", async () => {
    setUpServer();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render();

    await pickDoctor("AB");
    await userEvent.click(await screen.findByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/api/v1/calendar/feed-token.ics`,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Link copied");
  });

  it("tells the user to copy by hand when the clipboard is refused", async () => {
    setUpServer();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render();

    await pickDoctor("AB");
    await userEvent.click(await screen.findByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/select the link/i);
  });

  it("renders subscription instructions for each calendar app", async () => {
    setUpServer();
    render();

    await pickDoctor("AB");

    expect(await screen.findByText("Google Calendar")).toBeInTheDocument();
    expect(screen.getByText("Apple Calendar")).toBeInTheDocument();
    expect(screen.getByText("Outlook")).toBeInTheDocument();
  });

  // The backend puts require_capability("user_admin") on the rotate
  // endpoint on top of the clinical gate: reissuing revokes someone's live
  // subscription, so writing the clinical rota is not enough.
  it.each(["rotaAdmin", "receptionAdmin", "readOnly"] as const)(
    "disables the rotate control without the user administration permission (%s)",
    async (presetName) => {
      setUpServer();
      render(PERMISSION_PRESETS[presetName]);

      await pickDoctor("AB");

      expect(await screen.findByRole("button", { name: "Issue a new link" })).toBeDisabled();
    },
  );

  it("rotates the token for a user administrator who confirms", async () => {
    setUpServer();
    let rotatedId = "";
    server.use(
      http.post("/api/v1/doctors/:doctorId/calendar-feed/rotate", ({ params }) => {
        rotatedId = params.doctorId as string;
        return HttpResponse.json({
          doctor_id: Number(params.doctorId),
          token: "fresh",
          feed_path: "/api/v1/calendar/fresh.ics",
        });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render();

    await pickDoctor("CD");
    await userEvent.click(await screen.findByRole("button", { name: "Issue a new link" }));

    expect(await screen.findByRole("status")).toHaveTextContent("New link issued");
    expect(rotatedId).toBe("2");
  });

  it("opens on the linked doctor and marks them as you", async () => {
    setUpServer();
    server.use(
      http.get("/api/v1/doctors/1/calendar-feed", () =>
        HttpResponse.json({ doctor_id: 1, token: "mine", feed_path: "/api/v1/calendar/mine.ics" }),
      ),
    );
    renderLinked();

    expect(
      await screen.findByText(`${window.location.origin}/api/v1/calendar/mine.ics`),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "AB (you)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your calendar link" })).toBeInTheDocument();
  });

  it("shows no link and no (you) marker for an unlinked user", async () => {
    setUpServer();
    render();

    expect(await screen.findByRole("option", { name: "AB" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /\(you\)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("keeps a linked user's own choice of another doctor across a re-render", async () => {
    setUpServer();
    renderLinked();

    await pickDoctor("CD");

    expect(
      await screen.findByRole("heading", { name: "Calendar link for CD" }),
    ).toBeInTheDocument();

    // A re-render (the toast state changing) must not re-apply the link
    // default over the user's own pick.
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Link copied");
    expect(screen.getByRole("heading", { name: "Calendar link for CD" })).toBeInTheDocument();
  });

  it("does not rotate when the confirm is declined", async () => {
    setUpServer();
    let rotateCalls = 0;
    server.use(
      http.post("/api/v1/doctors/:doctorId/calendar-feed/rotate", () => {
        rotateCalls += 1;
        return HttpResponse.json({ doctor_id: 1, token: "x", feed_path: "/api/v1/calendar/x.ics" });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render();

    await pickDoctor("AB");
    await userEvent.click(await screen.findByRole("button", { name: "Issue a new link" }));

    expect(rotateCalls).toBe(0);
  });
});
