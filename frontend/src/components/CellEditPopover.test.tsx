import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeClinicType, makeRoom } from "@/test/fixtures/reference";
import { makeRotaSession } from "@/test/fixtures/rota";
import type { RotaSession } from "@/api/types";

import { CellEditPopover } from "./CellEditPopover";

function renderPopover(overrides: {
  session?: RotaSession;
  sessions?: RotaSession[];
  rooms?: ReturnType<typeof makeRoom>[];
  clinicTypes?: ReturnType<typeof makeClinicType>[];
  onSave?: ReturnType<typeof vi.fn>;
  onSetRoom?: ReturnType<typeof vi.fn>;
  onSetRole?: ReturnType<typeof vi.fn>;
  saving?: boolean;
} = {}) {
  const session = overrides.session ?? makeRotaSession();
  const onSave = overrides.onSave ?? vi.fn();
  const onSetRoom = overrides.onSetRoom ?? vi.fn();
  const onSetRole = overrides.onSetRole ?? vi.fn();

  render(
    <CellEditPopover
      session={session}
      sessions={overrides.sessions ?? [session]}
      rooms={overrides.rooms ?? []}
      clinicTypes={overrides.clinicTypes ?? []}
      onSave={onSave}
      onSetRoom={onSetRoom}
      onSetRole={onSetRole}
      saving={overrides.saving ?? false}
    >
      <div>Cell content</div>
    </CellEditPopover>,
  );

  return { session, onSave, onSetRoom, onSetRole };
}

describe("CellEditPopover", () => {
  // --- Main view: WFH/notes save path (unchanged from M4) ---

  it("opens on click and shows the current WFH/notes values", async () => {
    const user = userEvent.setup();
    renderPopover({ session: makeRotaSession({ is_wfh: true, notes: "Covering for AB" }) });

    await user.click(screen.getByText("Cell content"));

    expect(await screen.findByLabelText("Working from home")).toBeChecked();
    expect(screen.getByLabelText("Notes")).toHaveValue("Covering for AB");
  });

  it("Save sends both fields explicitly, matching the edited form state", async () => {
    const user = userEvent.setup();
    const { onSave } = renderPopover({ session: makeRotaSession({ is_wfh: false, notes: null }) });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.type(screen.getByLabelText("Notes"), "Back from leave");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(true, "Back from leave");
  });

  it("an emptied notes field is sent as null, not an empty string", async () => {
    const user = userEvent.setup();
    const { onSave } = renderPopover({ session: makeRotaSession({ is_wfh: false, notes: "Old note" }) });

    await user.click(screen.getByText("Cell content"));
    const notesField = await screen.findByLabelText("Notes");
    await user.clear(notesField);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(false, null);
  });

  it("Cancel closes the popover without calling onSave", async () => {
    const user = userEvent.setup();
    const { onSave } = renderPopover();

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onSave).not.toHaveBeenCalled();
  });

  // --- View navigation ---

  it("navigates to the rooms submenu and back to main", async () => {
    const user = userEvent.setup();
    renderPopover({ rooms: [makeRoom({ id: 1, code: "D1" })] });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change room..."));
    expect(await screen.findByText("D1")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Back"));
    expect(await screen.findByLabelText("Working from home")).toBeInTheDocument();
  });

  it("navigates to the roles submenu and back to main", async () => {
    const user = userEvent.setup();
    renderPopover();

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change role..."));
    expect(await screen.findByText("Duty (primary)")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Back"));
    expect(await screen.findByLabelText("Working from home")).toBeInTheDocument();
  });

  it("Clear room and Unassign are present in their respective submenus", async () => {
    const user = userEvent.setup();
    renderPopover({ rooms: [makeRoom({ id: 1, code: "D1" })] });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change room..."));
    expect(await screen.findByText("Clear room")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Back"));
    await user.click(await screen.findByText("Change role..."));
    expect(await screen.findByText("Unassign")).toBeInTheDocument();
  });

  // --- Direct assign (no confirm) ---

  it("picking a free room assigns directly, with no confirm panel, and closes the popover", async () => {
    const user = userEvent.setup();
    const session = makeRotaSession({ session_id: 1, room_id: null });
    const { onSetRoom } = renderPopover({
      session,
      sessions: [session],
      rooms: [makeRoom({ id: 5, code: "D1" })],
    });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change room..."));
    await user.click(await screen.findByText("D1"));

    expect(onSetRoom).toHaveBeenCalledWith(5, null);
    expect(screen.queryByText(/reassign/)).not.toBeInTheDocument();
  });

  it("clearing a room never shows a confirm panel", async () => {
    const user = userEvent.setup();
    const session = makeRotaSession({ session_id: 1, room_id: 5 });
    const { onSetRoom } = renderPopover({
      session,
      sessions: [session],
      rooms: [makeRoom({ id: 5, code: "D1" })],
    });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change room..."));
    await user.click(await screen.findByText("Clear room"));

    expect(onSetRoom).toHaveBeenCalledWith(null, null);
  });

  it("picking Normal clinic assigns directly with no confirm, even with other clinic sessions in the slot", async () => {
    const user = userEvent.setup();
    const session = makeRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM" });
    const other = makeRotaSession({
      session_id: 2, week: 1, day: "Monday", period: "AM", role: "clinic", clinic_type_id: 9,
    });
    const { onSetRole } = renderPopover({ session, sessions: [session, other] });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change role..."));
    await user.click(await screen.findByText("Normal clinic"));

    expect(onSetRole).toHaveBeenCalledWith(
      { role: "clinic", clinicTypeId: null, templateType: session.template_type },
      null,
    );
  });

  it("picking No surgery sends the override template_type directly, no confirm", async () => {
    const user = userEvent.setup();
    const session = makeRotaSession({ session_id: 1 });
    const { onSetRole } = renderPopover({ session, sessions: [session] });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change role..."));
    await user.click(await screen.findByText("No surgery"));

    expect(onSetRole).toHaveBeenCalledWith(
      { role: null, clinicTypeId: null, templateType: "no_surgery" },
      null,
    );
  });

  // --- Confirm-before-steal (steal-class only, and names the holder) ---

  it("picking a held room shows the confirm panel naming the holder, and Reassign fires onSetRoom with it", async () => {
    const user = userEvent.setup();
    const session = makeRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM", room_id: null });
    const holder = makeRotaSession({
      session_id: 2, week: 1, day: "Monday", period: "AM", room_id: 5, doctor_code: "CD",
    });
    const { onSetRoom } = renderPopover({
      session,
      sessions: [session, holder],
      rooms: [makeRoom({ id: 5, code: "D1" })],
    });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change room..."));
    await user.click(await screen.findByText("D1"));

    expect(await screen.findByText(/CD/)).toBeInTheDocument();
    expect(onSetRoom).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reassign" }));
    expect(onSetRoom).toHaveBeenCalledWith(5, holder);
  });

  it("picking a held duty role shows the confirm panel, and Cancel returns to the roles submenu without calling onSetRole", async () => {
    const user = userEvent.setup();
    const session = makeRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM" });
    const holder = makeRotaSession({
      session_id: 2, week: 1, day: "Monday", period: "AM", role: "duty_primary", doctor_code: "CD",
    });
    const { onSetRole } = renderPopover({ session, sessions: [session, holder] });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change role..."));
    await user.click(await screen.findByText("Duty (primary)"));

    expect(await screen.findByText(/CD/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("Duty (primary)")).toBeInTheDocument();
    expect(onSetRole).not.toHaveBeenCalled();
  });

  it("picking a held clinic type shows the confirm panel and Reassign fires onSetRole with the holder", async () => {
    const user = userEvent.setup();
    const ct = makeClinicType({ id: 9, name: "Dragon" });
    const session = makeRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM" });
    const holder = makeRotaSession({
      session_id: 2, week: 1, day: "Monday", period: "AM", role: "clinic", clinic_type_id: 9, doctor_code: "CD",
    });
    const { onSetRole } = renderPopover({ session, sessions: [session, holder], clinicTypes: [ct] });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change role..."));
    await user.click(await screen.findByText("Dragon"));
    expect(await screen.findByText(/CD/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reassign" }));
    expect(onSetRole).toHaveBeenCalledWith(
      { role: "clinic", clinicTypeId: 9, templateType: session.template_type },
      holder,
    );
  });

  it("a duty role with no current holder assigns directly, no confirm", async () => {
    const user = userEvent.setup();
    const session = makeRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM" });
    const { onSetRole } = renderPopover({ session, sessions: [session] });

    await user.click(screen.getByText("Cell content"));
    await user.click(await screen.findByText("Change role..."));
    await user.click(await screen.findByText("Duty (primary)"));

    expect(onSetRole).toHaveBeenCalledWith(
      { role: "duty_primary", clinicTypeId: null, templateType: session.template_type },
      null,
    );
  });
});