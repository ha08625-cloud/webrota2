import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";

import { MasterRotaGrid } from "./MasterRotaGrid";

describe("MasterRotaGrid", () => {
  it("renders a column per day and AM/PM sub-rows per doctor", () => {
    const sessions = [makeMasterRotaSession({ doctor_id: 1, doctor_code: "AB" })];

    renderWithProviders(<MasterRotaGrid sessions={sessions} />);

    expect(screen.getByText("AB")).toBeInTheDocument();
    expect(screen.getByText("Monday")).toBeInTheDocument();
    expect(screen.getByText("Friday")).toBeInTheDocument();
    expect(screen.getAllByText("AM")).toHaveLength(1);
    expect(screen.getAllByText("PM")).toHaveLength(1);
  });

  it("groups rows by doctor type before alphabetising by code", () => {
    const sessions = [
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "ZZ", doctor_type: "AHP" }),
      makeMasterRotaSession({ doctor_id: 2, doctor_code: "YY", doctor_type: "Partner" }),
    ];

    renderWithProviders(<MasterRotaGrid sessions={sessions} />);

    const codeCells = screen.getAllByText(/^(YY|ZZ)$/);
    expect(codeCells.map((el) => el.textContent)).toEqual(["YY", "ZZ"]);
  });

  it("spans the doctor code cell across both AM and PM rows", () => {
    const sessions = [makeMasterRotaSession({ doctor_id: 1, doctor_code: "AB" })];

    renderWithProviders(<MasterRotaGrid sessions={sessions} />);
    const doctorCell = screen.getByText("AB").closest("td");

    expect(doctorCell).toHaveAttribute("rowspan", "2");
  });

  it("renders a blank cell (no badge) for REQUIRES_ROOM with just the room code", () => {
    const sessions = [
      makeMasterRotaSession({
        doctor_id: 1, doctor_code: "AB", session_type: "requires_room", room_code: "D1",
      }),
    ];

    renderWithProviders(<MasterRotaGrid sessions={sessions} />);

    expect(screen.getByText("D1")).toBeInTheDocument();
    expect(screen.queryByText("No surgery")).not.toBeInTheDocument();
  });

  it("renders the No surgery badge for NO_SURGERY", () => {
    const sessions = [makeMasterRotaSession({ session_type: "no_surgery" })];
    renderWithProviders(<MasterRotaGrid sessions={sessions} />);
    expect(screen.getByText("No surgery")).toBeInTheDocument();
  });

  it("renders the Admin badge for ADMIN_TIME", () => {
    const sessions = [makeMasterRotaSession({ session_type: "admin_time" })];
    renderWithProviders(<MasterRotaGrid sessions={sessions} />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("renders the WFH badge for WFH", () => {
    const sessions = [makeMasterRotaSession({ session_type: "wfh" })];
    renderWithProviders(<MasterRotaGrid sessions={sessions} />);
    expect(screen.getByText("WFH")).toBeInTheDocument();
  });

  it("does not render an empty week tab when the template has only one week", () => {
    const sessions = [makeMasterRotaSession({ week: 1 })];
    renderWithProviders(<MasterRotaGrid sessions={sessions} />);
    expect(screen.getByText("Week 1")).toBeInTheDocument();
    expect(screen.queryByText("Week 2")).not.toBeInTheDocument();
  });
});