import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRun, describeHand, sampleHand, WEIGHT_FACTS, type RunRecord } from "../src/ai/history";
import { benchSettings, playHand } from "../src/ai/ladder";
import { heuristicTable } from "../src/ai/policy";
import { createMatch } from "../src/engine/game";

describe("training history", () => {
  it("names one fact per weight", () => {
    expect(WEIGHT_FACTS.bid).toHaveLength(15);
    expect(WEIGHT_FACTS.trump).toHaveLength(10);
    expect(WEIGHT_FACTS.play).toHaveLength(19);
  });

  it("keeps every trick from a finished hand", () => {
    const names = ["heuristic", "heuristic", "heuristic", "heuristic"] as [string, string, string, string];
    const hand = sampleHand(4, heuristicTable(), names);
    expect(hand.bids).toHaveLength(4);
    expect(hand.seed).toBe(4);
    if (!hand.passed) {
      expect(hand.tricks).toHaveLength(7);
      expect(hand.tricks[0]?.plays).toHaveLength(4);
      expect(hand.captured[0] + hand.captured[1]).toBe(42);
    } else {
      expect(hand.tricks).toHaveLength(0);
      expect(hand.bids.every((bid) => bid.amount === "pass")).toBe(true);
    }
    const again = describeHand(playHand(createMatch(benchSettings(4, "marks")), heuristicTable()), names);
    expect(again).toEqual(hand);
  });

  it("appends one json line per run", () => {
    const dir = mkdtempSync(join(tmpdir(), "texas42-runs-"));
    const runsPath = join(dir, "runs.jsonl");
    const factsPath = join(dir, "facts.json");
    const record = {
      at: "2026-09-26T00:00:00.000Z",
      kind: "score",
      hands: 2,
      lr: 0,
      seed: 1,
      seconds: 0.1,
      accepted: true,
      versusHeuristic: { hands: 2, awardA: 1, awardB: 0, passes: 0 },
      bands: {
        hands: 1,
        passes: 0,
        made: 1,
        set: 0,
        awarded: [1, 0],
        bands: { pass: { hands: 0, made: 0 } },
      },
      weightL1: { bid: 0, trump: 0, play: 0 },
      weights: {
        bid: { in: 15, w: [1] },
        trump: { in: 10, w: [1] },
        play: { in: 19, w: [1] },
      },
    } satisfies RunRecord;
    appendRun(record, runsPath, factsPath);
    appendRun(record, runsPath, factsPath);
    const lines = readFileSync(runsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").kind).toBe("score");
    expect(JSON.parse(readFileSync(factsPath, "utf8")).play).toHaveLength(19);
  });
});
