import { describe, expect, it } from "vitest";
import { teamOf } from "../src/engine/domino";
import { decode } from "../src/net/messages";
import { claimSeat, emptyPlan, guestSeats, swapSeats } from "../src/net/seats";

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

  it("tells a guest which chair they got", () => {
    expect(decode(JSON.stringify({ type: "seated", seat: 2, names: ["Luke", null, "Ada", null] }))).toEqual({
      type: "seated",
      seat: 2,
      names: ["Luke", null, "Ada", null],
    });
    expect(decode('{"type":"seated","seat":4,"names":[]}')).toBeNull();
  });
});
