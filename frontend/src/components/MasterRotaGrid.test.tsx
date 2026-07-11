import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { useActiveMasterRota } from "@/api/masterRota";
import { makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession, makeMasterRotaTemplate } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { MasterRotaGrid } from "./MasterRotaGrid";

function setUpServer({ rooms = [makeRoom({ id: 5, code: "D1" })] } = {}) {
  server.use(http.get("/api/v1/rooms", () => HttpResponse.json(rooms)));
}

describe("MasterRotaGrid", () => {
  it("renders an absent cell (day/period with no session for that doctor) with no popover trigger", async () => {
    setUpServer();
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    renderWithProviders(<MasterRotaGrid sessions={[session]} templateId={5} />);

    // Tuesday AM has no MasterRotaSession for doctor AB at all - the cell
    // renders but with nothing inside to click.
    const absentCell = await screen.findByTestId("master-cell-1-1-Tuesday-AM");
    expect(absentCell).toBeEmptyDOMElement();

    const user = userEvent.setup();
    await user.click(absentCell);
    expect(screen.queryByText("Normal clinic")).not.toBeInTheDocument();
  });

  it("clicking a session cell opens the MasterCellEditPopover menu", async () => {
    setUpServer();
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "pre_assigned", room_id: 5, room_code: "D1",
    });
    renderWithProviders(<MasterRotaGrid sessions={[session]} templateId={5} />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("D1"));

    expect(await screen.findByText("Normal clinic")).toBeInTheDocument();
    expect(screen.getByText("No surgery")).toBeInTheDocument();
    expect(screen.getByText("WFH")).toBeInTheDocument();
  });

  it("a successful edit reflects in the grid, driven by the live query cache update", async () => {
    setUpServer();
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null,
    });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [session] });

    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    // MasterRotaGrid takes `sessions` as a prop rather than subscribing
    // itself - in production, MasterRotaPage's useActiveMasterRota() is
    // what re-renders it with fresh data after a mutation's setQueryData
    // call. Same harness technique as RotaGrid_test.tsx's PATCH test.
    function Harness() {
      const { data } = useActiveMasterRota();
      if (!data) return null;
      return <MasterRotaGrid sessions={data.sessions} templateId={data.template_id} />;
    }

    renderWithProviders(<Harness />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    // requires_room + no room renders no visible badge/room text, so the
    // trigger div itself is the only thing to click.
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));

    expect(await within(cell).findByText("No surgery")).toBeInTheDocument();
  });

  it("calls onMutationApplied with the toast message and the undo entry on a successful edit", async () => {
    setUpServer();
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null,
    });

    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    let capturedEntry: unknown;
    let capturedMessage: string | undefined;
    renderWithProviders(
      <MasterRotaGrid
        sessions={[session]}
        templateId={5}
        onMutationApplied={(entry, message) => {
          capturedEntry = entry;
          capturedMessage = message;
        }}
      />,
    );
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));

    expect(capturedMessage).toBe("AB Monday AM set to No surgery");
    expect(capturedEntry).toEqual({
      sessionId: 1,
      previous: { sessionType: "requires_room", roomId: null },
      displaced: null,
    });
  });
});
