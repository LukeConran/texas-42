import { describe, expect, it } from "vitest";
import { dominoKey } from "../src/engine/domino";
import { apply, createMatch, defaultSettings, observe, trickPoints } from "../src/engine/game";
import { lessonById, sameLessonAction } from "../src/ui/lessons";

describe("lessons", () => {
  it("makes the learner follow a five when sixes are trump", () => {
    const lesson = lessonById("follow");
    expect(lesson).toBeTruthy();
    let state = createMatch({ ...defaultSettings(lesson!.seed), scoringMode: "marks", target: 7 });
    const follow = lesson!.beats.at(-1)!;
    for (const beat of lesson!.beats.slice(0, -1)) {
      state = apply(state, beat.action);
    }
    expect(state.turn).toBe(0);
    expect(state.currentTrick.map((play) => dominoKey(play.domino))).toEqual(["5-2"]);
    const legal = observe(state, 0).legalPlays.map(dominoKey).sort();
    expect(legal).toEqual(["5-1", "5-3"]);
    expect(follow.kind).toBe("you");
    if (follow.kind === "you") state = apply(state, follow.action);
    expect(dominoKey(state.currentTrick.at(-1)!.domino)).toBe("5-1");
  });

  it("counts a ten, a five, and the trick", () => {
    const lesson = lessonById("count");
    expect(lesson).toBeTruthy();
    let state = createMatch({ ...defaultSettings(lesson!.seed), scoringMode: "marks", target: 7 });
    const lead = lesson!.beats.find((beat) => beat.kind === "you" && beat.action.type === "play");
    for (const beat of lesson!.beats) {
      if (beat === lead) {
        const legal = observe(state, 0).legalPlays.map(dominoKey);
        expect(legal).toContain("5-5");
        expect(legal.length).toBeGreaterThan(1);
      }
      state = apply(state, beat.action);
      if (beat.action.type === "play" && beat.action.domino.hi === 5 && state.currentTrick.length === 4) {
        expect(trickPoints(state.currentTrick)).toBe(16);
      }
    }
    expect(state.completedTricks).toHaveLength(1);
    expect(sameLessonAction({ type: "bid", amount: 30 }, { type: "bid", amount: "pass" })).toBe(false);
  });
});
