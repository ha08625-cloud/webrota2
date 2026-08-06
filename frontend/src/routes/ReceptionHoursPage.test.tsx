import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeReceptionMasterSession, makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionHoursPage } from "./ReceptionHoursPage";

describe("ReceptionHoursPage", () => {
  it("derives weekly hours from template rows, excluding not_working slots", async () => {
    const jo = makeReceptionStaff({ id: 1, name: "Jo Smith" });
    const alex = makeReceptionStaff({ id: 2, name: "Alex Lee" });

    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json([jo, alex])));
    server.use(
      http.get("/api/v1/reception/master", () =>
        HttpResponse.json([
          makeReceptionMasterSession({ staff_id: 1, role: "phones" }),
          makeReceptionMasterSession({ staff_id: 1, role: "phones" }),
          makeReceptionMasterSession({ staff_id: 1, role: "not_working" }),
          makeReceptionMasterSession({ staff_id: 2, role: "admin" }),
        ]),
      ),
    );

    renderWithProviders(<ReceptionHoursPage />);

    // Jo: 2 phones slots count, 1 not_working slot doesn't -> 1.0h
    expect(await screen.findByText("1")).toBeInTheDocument();
    // Alex: 1 admin slot -> 0.5h
    expect(await screen.findByText("0.5")).toBeInTheDocument();
  });

  it("shows zero hours for a staff member with no template rows", async () => {
    const jo = makeReceptionStaff({ id: 1, name: "Jo Smith" });

    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json([jo])));
    server.use(http.get("/api/v1/reception/master", () => HttpResponse.json([])));

    renderWithProviders(<ReceptionHoursPage />);

    expect(await screen.findByText("Jo Smith")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
