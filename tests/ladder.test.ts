import { describe, expect, it } from "vitest";
import { duel, playHands, playMatch, summarize } from "../src/ai/ladder";
import { heuristicPolicy, heuristicTable } from "../src/ai/policy";

describe("bot ladder", () => {
  it("replays a seeded hand exactly", () => {
    const seats = heuristicTable();
    const first = playHands(1, seats, 7);
    const second = playHands(1, seats, 7);
    expect(second).toEqual(first);
    expect(first[0]?.handNumber).toBe(1);
  });

  it("records a legal marks result for every deal", () => {
    const records = playHands(40, heuristicTable(), 1, "marks");
    const summary = summarize(records);
    expect(summary.passes + summary.made + summary.set).toBe(40);
    expect(summary.bands.pass.hands).toBe(summary.passes);
    for (const record of records) {
      if (record.passed) {
        expect(record.awarded).toEqual([0, 0]);
        expect(record.made).toBeNull();
        continue;
      }
      expect(record.captured[0] + record.captured[1]).toBe(42);
      const awards = [...record.awarded].sort((a, b) => a - b);
      expect(awards[0]).toBe(0);
      expect(awards[1]).toBeGreaterThan(0);
      expect(awards[1]! % 1).toBe(0);
    }
  });

  it("gives the same policy the same award from either side of the table", () => {
    const even = heuristicPolicy({ margin: 0 }, "even");
    const seeds = Array.from({ length: 12 }, (_, i) => i + 1);
    const result = duel(seeds, even, even);
    expect(result.hands).toBe(24);
    expect(result.awardA).toBe(result.awardB);
  });

  it("plays a marks match through to a winner", () => {
    const match = playMatch(3, heuristicTable(), "marks");
    expect(match.winner).not.toBeNull();
    expect(Math.max(...match.scores)).toBeGreaterThanOrEqual(7);
    expect(match.hands.length).toBeGreaterThan(0);
    expect(match.hands.every((hand) => hand.matchSeed === 3)).toBe(true);
  });
});
