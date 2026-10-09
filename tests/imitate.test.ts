import { describe, expect, it } from "vitest";
import { collectSearchLessons, imitationPolicy, modelFromJson, modelToJson, trainImitation } from "../src/ai/imitate";
import { playHands } from "../src/ai/ladder";
import { heuristicPolicy } from "../src/ai/policy";

describe("imitation weights", () => {
  it("moves weight toward the labeled play", () => {
    const plays = Array.from({ length: 40 }, () => ({
      rows: [
        [1, 0],
        [1, 1],
      ],
      label: 1,
    }));
    const model = trainImitation({ bids: [], trumps: [], plays }, { epochs: 30, lr: 0.4, seed: 2 });
    const again = trainImitation({ bids: [], trumps: [], plays }, { epochs: 30, lr: 0.4, seed: 2 });
    expect(again).toEqual(model);
    expect(model.play.w[1]).toBeGreaterThan(0);
    expect(modelFromJson(modelToJson(model))).toEqual(model);
  });

  it("plays a legal marks hand after fitting a tiny search lesson", () => {
    const lesson = collectSearchLessons(1, 1, 3);
    const model = trainImitation(lesson, { epochs: 5, lr: 0.1, seed: 1 });
    const even = heuristicPolicy({ margin: 0 }, "even");
    const records = playHands(1, [imitationPolicy(model), even, even, even], 9, "marks");
    const hand = records[0]!;
    if (!hand.passed) expect(hand.captured[0] + hand.captured[1]).toBe(42);
    expect(lesson.bids.length + lesson.plays.length).toBeGreaterThan(0);
  });
});
