import { describe, expect, it } from "vitest";
import { BID_BANDS, chooseAction } from "../src/ai/heuristic";
import { chooseBotAction } from "../src/ai/levels";
import { apply, createMatch, defaultSettings, observe } from "../src/engine/game";

describe("bid bands", () => {
  it("keeps announced bids on 30, 31, 32, 33, and the rare higher calls", () => {
    const counts = new Map<number | "pass", number>();
    for (let seed = 1; seed <= 80; seed++) {
      let state = createMatch({ ...defaultSettings(seed), scoringMode: "marks", target: 7 });
      let guard = 0;
      while (state.phase === "bidding" && guard < 8) {
        guard += 1;
        const seat = state.turn;
        if (seat == null) break;
        const action = chooseAction(observe(state, seat), { margin: 0 });
        expect(action.type).toBe("bid");
        if (action.type !== "bid") break;
        counts.set(action.amount, (counts.get(action.amount) ?? 0) + 1);
        if (action.amount !== "pass") expect(BID_BANDS).toContain(action.amount);
        state = apply(state, action);
      }
    }
    const numeric = [...counts.entries()].filter((entry) => entry[0] !== "pass");
    const low = [30, 31, 32, 33].reduce((sum, amount) => sum + (counts.get(amount) ?? 0), 0);
    const high = [35, 36, 42].reduce((sum, amount) => sum + (counts.get(amount) ?? 0), 0);
    const spoken = low + high;
    expect(spoken).toBeGreaterThan(20);
    expect(low).toBeGreaterThan(high);
    expect(numeric.every(([amount]) => amount === 30 || amount === 31 || amount === 32 || amount === 33 || amount === 35 || amount === 36 || amount === 42)).toBe(true);
  });

  it("lets easy throw low and keeps hard on a legal bid", () => {
    const view = observe(createMatch({ ...defaultSettings(4), scoringMode: "marks", target: 7 }), 0);
    const easy = chooseBotAction({ ...view, turn: view.seat, phase: "bidding" }, "easy");
    expect(easy.type).toBe("bid");
    if (easy.type === "bid" && easy.amount !== "pass") expect(easy.amount).toBeLessThanOrEqual(31);

    let state = createMatch({ ...defaultSettings(8), scoringMode: "marks", target: 7 });
    const seat = state.turn!;
    const hard = chooseBotAction(observe(state, seat), "hard");
    expect(hard.type).toBe("bid");
    if (hard.type === "bid" && hard.amount !== "pass") expect(BID_BANDS).toContain(hard.amount);
    state = apply(state, hard);
    expect(state.bids[seat]).toBeTruthy();
  });
});
