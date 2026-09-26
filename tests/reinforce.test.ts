import { describe, expect, it } from "vitest";
import { listChoices, modelFromJson, modelToJson, reinforceUpdate, type WeightVector } from "../src/ai/imitate";
import { benchSettings } from "../src/ai/ladder";
import { reinforce } from "../src/ai/reinforce";
import { createMatch, observe } from "../src/engine/game";

function blankModel() {
  return modelFromJson(
    JSON.stringify({
      bid: { in: 15, w: new Array<number>(15).fill(0) },
      trump: { in: 10, w: new Array<number>(10).fill(0) },
      play: { in: 19, w: new Array<number>(19).fill(0) },
    }),
  );
}

describe("reinforce", () => {
  it("moves the chosen feature with the hand's marks", () => {
    const rows = [
      [1, 0],
      [1, 1],
    ];
    const up: WeightVector = { in: 2, w: [0, 0] };
    reinforceUpdate(up, rows, 1, 1, 0.5);
    expect(up.w[1]).toBeGreaterThan(0);

    const down: WeightVector = { in: 2, w: [0, 0] };
    reinforceUpdate(down, rows, 0, 1, 0.5);
    expect(down.w[1]).toBeLessThan(0);

    const still: WeightVector = { in: 2, w: [0, 1] };
    reinforceUpdate(still, rows, 1, 0, 0.5);
    expect(still.w).toEqual([0, 1]);
  });

  it("lists fifteen facts for the opening bid", () => {
    const state = createMatch(benchSettings(11, "marks"));
    const seat = state.turn;
    if (seat == null) throw new Error("no bidder");
    const choices = listChoices(observe(state, seat));
    expect(choices.head).toBe("bid");
    expect(choices.rows[0]?.length).toBe(15);
    expect(choices.rows.length).toBeGreaterThan(1);
  });

  it("finishes a short run with finite weights", () => {
    const start = blankModel();
    const result = reinforce(start, { hands: 2, lr: 0.02, evalDeals: 1, seed: 21000 });
    const again = reinforce(modelFromJson(modelToJson(start)), { hands: 2, lr: 0.02, evalDeals: 1, seed: 21000 });
    expect(again.model).toEqual(result.model);
    expect(result.versusHeuristic.hands).toBe(2);
    for (const head of [result.model.bid, result.model.trump, result.model.play]) {
      expect(head.w.length).toBe(head.in);
      for (const weight of head.w) expect(Number.isFinite(weight)).toBe(true);
    }
  });
});
