import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ValidationIssue } from "@/api/types";
import { makeReceptionMasterSession, makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";

import { ReceptionGrid } from "./ReceptionGrid";

describe("ReceptionGrid: rows", () => {
  it("gives an active staff member a row with zero sessions", () => {
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
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
        onSave={vi.fn()}
        onDelete={vi.fn()}
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
        onSave={vi.fn()}
        onDelete={vi.fn()}
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
        onSave={vi.fn()}
        onDelete={vi.fn()}
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
        onSave={vi.fn()}
        onDelete={vi.fn()}
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
        onSave={vi.fn()}
        onDelete={vi.fn()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-8");
    expect(within(cell).getByLabelText("Add session for AB 08:00-09:00")).toHaveTextContent("+");
  });
});

describe("ReceptionGrid: create", () => {
  it("clicking the add affordance and saving calls onSave with staffId, hour, and no session", async () => {
    const onSave = vi.fn();
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[]}
        onSave={onSave}
        onDelete={vi.fn()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-8");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB 08:00-09:00"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ staffId: 1, hour: 8, session: null, role: "phones", note: null });
  });
});

describe("ReceptionGrid: edit and delete", () => {
  it("editing an existing cell calls onSave with the session and the new values", async () => {
    const onSave = vi.fn();
    const session = makeReceptionMasterSession({
      session_id: 5, staff_id: 1, hour: 9, role: "phones", note: null,
    });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={onSave}
        onDelete={vi.fn()}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.click(await screen.findByRole("radio", { name: "Other" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ staffId: 1, hour: 9, session, role: "other", note: null });
  });

  it("Remove calls onDelete with the session", async () => {
    const onDelete = vi.fn();
    const session = makeReceptionMasterSession({ session_id: 5, staff_id: 1, hour: 9 });
    renderWithProviders(
      <ReceptionGrid
        staff={[makeReceptionStaff({ id: 1, code: "AB", active: true })]}
        sessions={[session]}
        onSave={vi.fn()}
        onDelete={onDelete}
        saving={false}
      />,
    );
    const cell = screen.getByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onDelete).toHaveBeenCalledWith(session);
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
        onSave={vi.fn()}
        onDelete={vi.fn()}
        saving={false}
      />,
    );
    expect(screen.getByLabelText("Coverage shortfall at 09:00-10:00")).toBeInTheDocument();
    expect(screen.queryByLabelText("Coverage shortfall at 08:00-09:00")).not.toBeInTheDocument();
  });

  it("renders no markers when issues is absent (master template page)", () => {
    renderWithProviders(
      <ReceptionGrid staff={[]} sessions={[]} onSave={vi.fn()} onDelete={vi.fn()} saving={false} />,
    );
    expect(screen.queryByLabelText(/Coverage shortfall/)).not.toBeInTheDocument();
  });
});
