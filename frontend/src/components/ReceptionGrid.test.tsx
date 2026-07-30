import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ValidationIssue } from "@/api/types";
import { makeReceptionMasterSession, makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";

import { ReceptionGrid, selectedRangeHours } from "./ReceptionGrid";

/** Resolves true, matching the "save succeeded" contract used to clear the selection. */
function resolvedOnSave() {
  return vi.fn().mockResolvedValue(true);
}

function resolvedOnDelete() {
  return vi.fn().mockResolvedValue(true);
}

describe("ReceptionGrid: rows", () => {
  it("gives an active staff member a row with zero sessions", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.getByText("AB")).toBeInTheDocument();
    expect(screen.queryByText("(inactive)")).not.toBeInTheDocument();
  });

  it("flags an inactive staff member who still has sessions rather than dropping the row", () => {
    const session = makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.getByText("AB")).toBeInTheDocument();
    expect(screen.getByText("(inactive)")).toBeInTheDocument();
  });

  it("drops an inactive staff member with no sessions", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.queryByText("AB")).not.toBeInTheDocument();
  });

  it("renders an absent cell on an inactive staff row with no add affordance", () => {
    const session = makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const absentCell = screen.getByTestId("reception-cell-1-10");
    expect(absentCell).toBeEmptyDOMElement();
  });
});

describe("ReceptionGrid: cell content", () => {
  it("renders the role badge and note for an existing session", () => {
    const session = makeReceptionMasterSession({
      session_id: 1, staff_id: 1, hour: 9, role: "other", note: "Filing",
    });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    expect(within(cell).getByText("Other")).toBeInTheDocument();
    expect(within(cell).getByText("Filing")).toBeInTheDocument();
  });

  it("renders an add affordance on an absent cell for an active staff member", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-8");
    expect(within(cell).getByLabelText("Add session for AB 08:00-09:00")).toHaveTextContent("+");
  });
});

describe("ReceptionGrid: create", () => {
  it("clicking the add affordance and saving calls onSave with one payload: staffId, hour, and no session", async () => {
    const onSave = resolvedOnSave();
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-8");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB 08:00-09:00"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([{ staffId: 1, hour: 8, session: null, role: "phones", note: null }]);
  });
});

describe("ReceptionGrid: edit and delete", () => {
  it("editing an existing cell calls onSave with one payload carrying the session and the new values", async () => {
    const onSave = resolvedOnSave();
    const session = makeReceptionMasterSession({
      session_id: 5, staff_id: 1, hour: 9, role: "phones", note: null,
    });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.selectOptions(await screen.findByLabelText("Role"), "other");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([{ staffId: 1, hour: 9, session, role: "other", note: null }]);
  });

  it("Remove calls onDelete with an array containing the session", async () => {
    const onDelete = resolvedOnDelete();
    const session = makeReceptionMasterSession({ session_id: 5, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={resolvedOnSave()}
        onDelete={onDelete}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onDelete).toHaveBeenCalledWith([session]);
  });
});

describe("ReceptionGrid: coverage warnings", () => {
  function shortfall(hour: number): ValidationIssue {
    const pad = (h: number) => h.toString().padStart(2, "0");
    return {
      severity: "warning",
      phase: "coverage",
      check: "phones_shortfall",
      message: `${pad(hour)}:00-${pad(hour + 1)}:00: 1 staff on phones, 2 required`,
      week: null,
      day: "Monday",
      period: null,
    };
  }

  it("renders a marker on the hour column with a matching shortfall, and none elsewhere", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[]}
        sessions={[]}
        issues={[shortfall(9)]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    expect(screen.getByLabelText("Coverage shortfall at 09:00-10:00")).toBeInTheDocument();
    expect(screen.queryByLabelText("Coverage shortfall at 08:00-09:00")).not.toBeInTheDocument();
  });

  it("renders no markers when issues is absent (master template page)", () => {
    renderWithProviders(
      <ReceptionGrid staff={[]} sessions={[]} onSave={resolvedOnSave()} onDelete={resolvedOnDelete()} saving={false} />,
    );
    expect(screen.queryByLabelText(/Coverage shortfall/)).not.toBeInTheDocument();
  });
});

describe("selectedRangeHours", () => {
  it("returns the forward range between anchor and focus, inclusive", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 9, focusHour: 11 }, 1)).toEqual([9, 10, 11]);
  });

  it("returns the same range when focus precedes anchor", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 11, focusHour: 9 }, 1)).toEqual([9, 10, 11]);
  });

  it("returns a single hour when anchor and focus match", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 9, focusHour: 9 }, 1)).toEqual([9]);
  });

  it("returns an empty range when the selection belongs to a different staff row", () => {
    expect(selectedRangeHours({ staffId: 1, anchorHour: 9, focusHour: 11 }, 2)).toEqual([]);
  });

  it("returns an empty range when there is no selection", () => {
    expect(selectedRangeHours(null, 1)).toEqual([]);
  });
});

async function shiftClick(user: ReturnType<typeof userEvent.setup>, element: HTMLElement) {
  await user.keyboard("{Shift>}");
  await user.click(element);
  await user.keyboard("{/Shift}");
}

describe("ReceptionGrid: shift-click range select", () => {
  it("highlights every cell between anchor and focus, endpoints included", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-12:00"));

    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-10")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-11")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-8")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-12")).not.toHaveAttribute("data-selected", "true");
  });

  it("shift-click on a different row starts a fresh single-cell selection there", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[
          makeReceptionStaff({ id: 1, code: "AB", active: true }),
          makeReceptionStaff({ id: 2, code: "CD", active: true }),
        ]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-2-10")).getByLabelText("Add session for CD 10:00-11:00"));

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-2-10")).toHaveAttribute("data-selected", "true");
  });

  it("a plain click after a range collapses the selection back to one cell", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-12:00"));
    await user.click(within(screen.getByTestId("reception-cell-1-10")).getByLabelText("Add session for AB 10:00-11:00"));

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-11")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-10")).toHaveAttribute("data-selected", "true");
  });

  it("Escape clears the selection", async () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={resolvedOnSave()}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");

    await user.keyboard("{Escape}");

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
  });

  it("saving a 3-hour range calls onSave once with three payloads, ascending by hour, mixing filled and empty hours", async () => {
    const onSave = resolvedOnSave();
    const session = makeReceptionMasterSession({ session_id: 5, staff_id: 1, hour: 10, role: "phones", note: null });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-12:00"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith([
      { staffId: 1, hour: 9, session: null, role: "phones", note: null },
      { staffId: 1, hour: 10, session, role: "phones", note: null },
      { staffId: 1, hour: 11, session: null, role: "phones", note: null },
    ]);
  });

  it("on an inactive staff row, a range spanning an empty hour omits it from both the highlight and the payload", async () => {
    const onSave = resolvedOnSave();
    const session9 = makeReceptionMasterSession({ session_id: 1, staff_id: 1, hour: 9, role: "phones", note: null });
    const session11 = makeReceptionMasterSession({ session_id: 2, staff_id: 1, hour: 11, role: "phones", note: null });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: false })]}
        sessions={[session9, session11]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByText("Phones"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByText("Phones"));

    expect(screen.getByTestId("reception-cell-1-10")).not.toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-10")).toBeEmptyDOMElement();

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([
      { staffId: 1, hour: 9, session: session9, role: "phones", note: null },
      { staffId: 1, hour: 11, session: session11, role: "phones", note: null },
    ]);
  });

  it("changing the role dropdown mid-range does not collapse the selection back to one cell", async () => {
    const onSave = resolvedOnSave();
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    await shiftClick(user, within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-12:00"));

    await user.selectOptions(await screen.findByLabelText("Role"), "prescriptions");
    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("reception-cell-1-11")).toHaveAttribute("data-selected", "true");

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith([
      { staffId: 1, hour: 9, session: null, role: "prescriptions", note: null },
      { staffId: 1, hour: 10, session: null, role: "prescriptions", note: null },
      { staffId: 1, hour: 11, session: null, role: "prescriptions", note: null },
    ]);
  });

  it("keeps the highlight when onSave resolves false, and clears it when onSave resolves true", async () => {
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={resolvedOnDelete()}
        saving={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(screen.getByTestId("reception-cell-1-9")).toHaveAttribute("data-selected", "true");

    await user.click(within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-10:00"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(screen.getByTestId("reception-cell-1-9")).not.toHaveAttribute("data-selected", "true");
  });
});
