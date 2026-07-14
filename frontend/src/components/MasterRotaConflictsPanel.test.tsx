import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MasterRotaSession } from "@/api/types";

import { MasterRotaConflictsPanel } from "./MasterRotaConflictsPanel";

function makeSession(overrides: Partial<MasterRotaSession> = {}): MasterRotaSession {
  return {
    session_id: 1,
    doctor_id: 1,
    doctor_code: "AA",
    doctor_type: "Partner",
    week: 1,
    day: "Monday",
    period: "AM",
    session_type: "pre_assigned",
    room_id: 1,
    room_code: "D1",
    ...overrides,
  };
}

describe("MasterRotaConflictsPanel", () => {
  it("shows no-conflicts message when nothing is double-booked", () => {
    render(
      <MasterRotaConflictsPanel
        sessions={[
          makeSession({ session_id: 1, doctor_id: 1, room_id: 1, room_code: "D1" }),
          makeSession({ session_id: 2, doctor_id: 2, room_id: 2, room_code: "D2" }),
        ]}
      />,
    );

    expect(screen.getByText("No room conflicts.")).toBeInTheDocument();
  });

  it("lists a room double-booking with both doctor codes and the slot", () => {
    render(
      <MasterRotaConflictsPanel
        sessions={[
          makeSession({ session_id: 1, doctor_id: 1, doctor_code: "AA", week: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
          makeSession({ session_id: 2, doctor_id: 2, doctor_code: "BB", week: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
        ]}
      />,
    );

    expect(screen.queryByText("No room conflicts.")).not.toBeInTheDocument();
    expect(
      screen.getByText("Room D1 is assigned to AA and BB (Week 1, Monday AM)"),
    ).toBeInTheDocument();
  });

  it("lists multiple independent conflicts", () => {
    render(
      <MasterRotaConflictsPanel
        sessions={[
          makeSession({ session_id: 1, doctor_id: 1, doctor_code: "AA", room_id: 1, room_code: "D1" }),
          makeSession({ session_id: 2, doctor_id: 2, doctor_code: "BB", room_id: 1, room_code: "D1" }),
          makeSession({ session_id: 3, doctor_id: 3, doctor_code: "CC", week: 2, room_id: 2, room_code: "D2" }),
          makeSession({ session_id: 4, doctor_id: 4, doctor_code: "DD", week: 2, room_id: 2, room_code: "D2" }),
        ]}
      />,
    );

    expect(screen.getByText(/Room D1 is assigned to AA and BB/)).toBeInTheDocument();
    expect(screen.getByText(/Room D2 is assigned to CC and DD/)).toBeInTheDocument();
  });
});