import { describe, expect, it } from "vitest";
import { chooseBotAction } from "../src/ai/levels";
import type { Seat } from "../src/engine/domino";
import { createMatch, defaultSettings, observe } from "../src/engine/game";

describe("bot levels", () => {
  it("has hard bid more openings than easy", () => {
    let easyBids = 0;
    let hardBids = 0;
    for (let seed = 1; seed <= 48; seed += 1) {
      const state = createMatch({
        ...defaultSettings(seed),
        scoringMode: "marks",
        target: 7,
        openingLeadMustBeTrump: false,
      });
      const seat = state.turn;
      if (seat == null) continue;
      const view = observe(state, seat);
      const easy = chooseBotAction(view, "easy");
      const hard = chooseBotAction(view, "hard");
      if (easy.type === "bid" && easy.amount !== "pass") easyBids += 1;
      if (hard.type === "bid" && hard.amount !== "pass") hardBids += 1;
    }
    expect(hardBids).toBeGreaterThan(easyBids);
  });

  it("lets medium keep the current seat style", () => {
    const state = createMatch({
      ...defaultSettings(4),
      scoringMode: "marks",
      target: 7,
      openingLeadMustBeTrump: false,
    });
    const seat = state.turn as Seat;
    const view = observe(state, seat);
    const medium = chooseBotAction(view, "medium");
    expect(medium.type === "bid" || medium.type === "declareTrump" || medium.type === "play").toBe(true);
  });
});
