import { describe, expect, it } from "vitest";
import { teamOf } from "../src/engine/domino";
import { decode } from "../src/net/messages";
import { claimSeat, emptyPlan, guestSeats, placeGuest, swapSeats, syncRoster } from "../src/net/seats";

describe("choosing seats", () => {
  it("starts the host in South and the first friend on the left", () => {
    let plan = emptyPlan();
    expect(plan.host).toBe(0);
    const ada = claimSeat(plan, "ada");
    plan = ada!.plan;
    const bo = claimSeat(plan, "bo");
    plan = bo!.plan;
    const cy = claimSeat(plan, "cy");
    expect([ada!.seat, bo!.seat, cy!.seat]).toEqual([1, 2, 3]);
    expect(claimSeat(cy!.plan, "dee")).toBeNull();
  });

  it("puts two people on one team or across from each other", () => {
    let plan = emptyPlan();
    plan = claimSeat(plan, "ada")!.plan;
    expect(teamOf(plan.host)).not.toBe(teamOf(1));
    plan = swapSeats(plan, 1, 2);
    expect(plan.guests[2]).toBe("ada");
    expect(plan.guests[1]).toBeNull();
    expect(teamOf(plan.host)).toBe(teamOf(2));
  });

  it("lets the host leave South and still partners the chair across", () => {
    let plan = swapSeats(emptyPlan(), 0, 1);
    expect(plan.host).toBe(1);
    const ada = claimSeat(plan, "ada")!;
    expect(ada.seat).toBe(0);
    plan = swapSeats(ada.plan, 0, 3);
    expect(plan.host).toBe(1);
    expect(plan.guests[3]).toBe("ada");
    expect(teamOf(plan.host)).toBe(teamOf(3));
    expect(guestSeats(plan.host, new Set([plan.host, 3]))).toEqual([3]);
  });

  it("puts a returning player back in their own chair", () => {
    const open = emptyPlan();
    const ada = placeGuest(open, "ada", 3);
    expect(ada!.seat).toBe(3);
    expect(ada!.plan.guests).toEqual([null, null, null, "ada"]);
    expect(placeGuest(ada!.plan, "ada", 1)!.seat).toBe(3);
    const taken = placeGuest(ada!.plan, "bo", 3);
    expect(taken!.seat).toBe(1);
  });

  it("keeps a quiet guest in their chair while a new player takes an empty one", () => {
    let plan = emptyPlan();
    plan = claimSeat(plan, "ada")!.plan;
    plan = claimSeat(plan, "bo")!.plan;
    plan = swapSeats(plan, 1, 3);
    expect(plan.guests[3]).toBe("ada");
    const stale = syncRoster(
      { plan, away: [] },
      [
        { id: "ada", name: "Ada", lastSeen: 0, enteredAt: 1 },
        { id: "bo", name: "Bo", lastSeen: 1_000, enteredAt: 2 },
      ],
      180_001,
      180_000,
    );
    expect(stale.events).toEqual([{ type: "left", seat: 3, id: "ada", name: "Ada" }]);
    expect(stale.state.plan.guests[3]).toBe("ada");
    expect(stale.state.plan.guests[1]).toBeNull();
    const returned = syncRoster(
      stale.state,
      [
        { id: "ada", name: "Ada", lastSeen: 200_000, enteredAt: 1 },
        { id: "bo", name: "Bo", lastSeen: 200_000, enteredAt: 2 },
        { id: "cy", name: "Cy", lastSeen: 200_000, enteredAt: 3 },
      ],
      200_000,
      180_000,
      { ada: 3 },
    );
    expect(returned.state.plan.guests).toEqual([null, "cy", "bo", "ada"]);
    expect(returned.events.map((event) => event.type)).toEqual(["back", "joined"]);
    expect(returned.events.find((event) => event.id === "ada")?.seat).toBe(3);
  });

  it("sits a remembered guest in the old chair after the plan lost them", () => {
    const returned = syncRoster(
      { plan: emptyPlan(), away: [] },
      [{ id: "ada", name: "Ada", lastSeen: 10, enteredAt: 1 }],
      10,
      180_000,
      { ada: 3 },
    );
    expect(returned.state.plan.guests[3]).toBe("ada");
    expect(returned.events).toEqual([{ type: "back", seat: 3, id: "ada", name: "Ada" }]);
  });

  it("tells a guest which chair they got", () => {
    expect(decode(JSON.stringify({ type: "seated", seat: 2, names: ["Luke", null, "Ada", null] }))).toEqual({
      type: "seated",
      seat: 2,
      names: ["Luke", null, "Ada", null],
    });
    expect(decode('{"type":"seated","seat":4,"names":[]}')).toBeNull();
  });
});
