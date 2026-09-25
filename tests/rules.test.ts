import { describe, expect, it } from "vitest";
import { BOT_STYLES, chooseAction } from "../src/ai/heuristic";
import { countValue, createDeck, dominoKey, type Domino } from "../src/engine/domino";
import {
  apply,
  createMatch,
  defaultSettings,
  legalBidAmounts,
  observe,
  scoreContract,
  trickPoints,
  type GameState,
} from "../src/engine/game";
import { classify, legalPlays, trumpName, winningIndex, type Trump } from "../src/engine/trump";

const D = (hi: number, lo: number): Domino => ({ hi, lo });
const fours: Trump = { kind: "suit", suit: 4 };
const ones: Trump = { kind: "suit", suit: 1 };
const doubles: Trump = { kind: "doubles" };
const followMe: Trump = { kind: "followMe" };

describe("deck and count", () => {
  it("has 28 tiles and 35 count points", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(28);
    expect(new Set(deck.map(dominoKey)).size).toBe(28);
    const count = deck.reduce((sum, d) => sum + countValue(d), 0);
    expect(count).toBe(35);
    expect(count + 7).toBe(42);
  });

  it("marks only the five honors", () => {
    expect(countValue(D(5, 0))).toBe(5);
    expect(countValue(D(4, 1))).toBe(5);
    expect(countValue(D(3, 2))).toBe(5);
    expect(countValue(D(6, 4))).toBe(10);
    expect(countValue(D(5, 5))).toBe(10);
    expect(countValue(D(6, 6))).toBe(0);
    expect(countValue(D(3, 3))).toBe(0);
  });
});

describe("trump classification", () => {
  it("names the low suits Ones, Twos, and Threes", () => {
    expect(trumpName({ kind: "suit", suit: 1 })).toBe("Ones");
    expect(trumpName({ kind: "suit", suit: 2 })).toBe("Twos");
    expect(trumpName({ kind: "suit", suit: 3 })).toBe("Threes");
    expect(trumpName({ kind: "suit", suit: 0 })).toBe("Blanks");
  });

  it("treats a trump tile as trump, not as its other end", () => {
    const fourTwo = classify(D(4, 2), fours);
    expect(fourTwo.isTrump).toBe(true);
    expect(fourTwo.rank).toBe(2);
    const twoOne = classify(D(2, 1), fours);
    expect(twoOne.isTrump).toBe(false);
    expect(twoOne.suit).toBe(2);
  });

  it("ranks the double above every off-pip in a number suit", () => {
    expect(classify(D(4, 4), fours).rank).toBeGreaterThan(classify(D(6, 4), fours).rank);
    expect(classify(D(6, 4), fours).rank).toBeGreaterThan(classify(D(5, 4), fours).rank);
    expect(classify(D(4, 0), fours).rank).toBe(0);
  });

  it("ranks doubles from six-six down to blank-blank", () => {
    expect(classify(D(6, 6), doubles).isTrump).toBe(true);
    expect(classify(D(6, 6), doubles).rank).toBeGreaterThan(classify(D(5, 5), doubles).rank);
    expect(classify(D(0, 0), doubles).rank).toBe(0);
    expect(classify(D(6, 5), doubles)).toMatchObject({ isTrump: false, suit: 6, rank: 5 });
  });
});

describe("following suit", () => {
  it("forces the suit when the player holds it, and rejects an off-suit play", () => {
    const hand = [D(6, 2), D(5, 5), D(3, 3), D(6, 4)];
    expect(legalPlays(hand, [D(6, 5)], fours).map(dominoKey)).toEqual(["6-2"]);
    let state = scriptedPlayingHand();
    state = {
      ...state,
      trump: fours,
      turn: 1,
      currentTrick: [{ player: 0, domino: D(6, 5) }],
      hands: [[D(4, 4)], hand, [D(2, 2)], [D(1, 1)]],
    };
    expect(observe(state, 1).legalPlays.map(dominoKey)).toEqual(["6-2"]);
    expect(() => apply(state, { type: "play", domino: D(5, 5) })).toThrow(/follow suit/);
    expect(apply(state, { type: "play", domino: D(6, 2) }).currentTrick).toHaveLength(2);
  });

  it("does not force a trump four on a two lead", () => {
    const hand = [D(4, 2), D(6, 6), D(2, 0)];
    const legal = legalPlays(hand, [D(2, 1)], fours);
    expect(legal.map(dominoKey)).toEqual(["2-0"]);
  });

  it("requires trump when trump is led and lets a void play anything", () => {
    const hand = [D(6, 5), D(4, 3), D(4, 0)];
    expect(legalPlays(hand, [D(6, 4)], fours).map(dominoKey).sort()).toEqual(["4-0", "4-3"]);
    const voidHand = [D(6, 5), D(3, 3)];
    expect(legalPlays(voidHand, [D(6, 4)], fours).map(dominoKey).sort()).toEqual(["3-3", "6-5"]);
  });

  it("keeps the double-six out of the sixes suit when doubles are trump", () => {
    const hand = [D(6, 6), D(6, 4)];
    expect(legalPlays(hand, [D(6, 5)], doubles).map(dominoKey)).toEqual(["6-4"]);
  });

  it("follows the higher end in follow-me, and a double is in that suit", () => {
    const hand = [D(6, 5), D(5, 5), D(5, 1)];
    expect(legalPlays(hand, [D(5, 4)], followMe).map(dominoKey).sort()).toEqual(["5-1", "5-5"]);
  });

  it("can require the opening lead to be trump", () => {
    const hand = [D(6, 6), D(4, 4), D(6, 4)];
    expect(legalPlays(hand, [], fours, { mustLeadTrump: true }).map(dominoKey).sort()).toEqual(["4-4", "6-4"]);
    expect(legalPlays(hand, [], followMe, { mustLeadTrump: true })).toHaveLength(3);
  });
});

describe("winning the trick", () => {
  it("lets the highest trump take a non-trump lead", () => {
    const plays = [D(6, 6), D(6, 5), D(1, 0), D(6, 4)];
    expect(winningIndex(plays, ones)).toBe(2);
  });

  it("lets the double trump beat lower trumps", () => {
    const plays = [D(6, 5), D(6, 4), D(5, 4), D(4, 4)];
    expect(winningIndex(plays, fours)).toBe(3);
  });

  it("lets the led suit win when nobody trumps, with the double high", () => {
    const plays = [D(6, 5), D(6, 6), D(6, 4), D(3, 2)];
    expect(winningIndex(plays, ones)).toBe(1);
  });

  it("has no trumps in follow-me", () => {
    const plays = [D(5, 4), D(6, 6), D(5, 5), D(5, 0)];
    expect(winningIndex(plays, followMe)).toBe(2);
  });
});

describe("bidding", () => {
  it("raises, allows one bid each, and gates mark bids behind 84", () => {
    expect(legalBidAmounts(null)).toContain(30);
    expect(legalBidAmounts(null)).toContain(42);
    expect(legalBidAmounts(null)).toContain(84);
    expect(legalBidAmounts(null)).not.toContain(126);
    expect(legalBidAmounts(42)).toEqual(["pass", 84]);
    expect(legalBidAmounts(84)).toEqual(["pass", 126, 168]);
  });

  it("rotates one bid around the table and redeals when everyone passes", () => {
    let state = createMatch(defaultSettings(7));
    const leader = state.turn!;
    for (let i = 0; i < 4; i++) {
      expect(state.turn).toBe(((leader + i) % 4) as 0 | 1 | 2 | 3);
      state = apply(state, { type: "bid", amount: "pass" });
    }
    expect(state.phase).toBe("handComplete");
    expect(state.lastResult?.passed).toBe(true);
    const shaker = state.shaker;
    state = apply(state, { type: "nextHand" });
    expect(state.phase).toBe("bidding");
    expect(state.shaker).toBe((shaker + 1) % 4);
    expect(state.scores).toEqual([0, 0]);
  });

  it("gives the bid to the highest bidder and lets them name trump", () => {
    let state = createMatch(defaultSettings(11));
    const first = state.turn!;
    state = apply(state, { type: "bid", amount: 30 });
    state = apply(state, { type: "bid", amount: "pass" });
    state = apply(state, { type: "bid", amount: 36 });
    state = apply(state, { type: "bid", amount: "pass" });
    expect(state.phase).toBe("trump");
    expect(state.highBid).toBe(36);
    expect(state.highBidder).toBe(((first + 2) % 4) as 0 | 1 | 2 | 3);
    expect(() => apply(state, { type: "bid", amount: 40 })).toThrow();
    state = apply(state, { type: "declareTrump", trump: fours });
    expect(state.phase).toBe("playing");
    expect(state.turn).toBe(state.highBidder);
    expect(trumpName(state.trump!)).toBe("Fours");
  });
});

describe("scoring", () => {
  it("scores a made bid to both teams and a set to the defenders", () => {
    expect(scoreContract(31, 36, 6, "points")).toEqual({ made: true, bidderAward: 36, defenderAward: 6 });
    expect(scoreContract(31, 20, 22, "points")).toEqual({ made: false, bidderAward: 0, defenderAward: 53 });
  });

  it("pays the stake on bids of 42 or more", () => {
    expect(scoreContract(42, 42, 0, "points")).toMatchObject({ made: true, bidderAward: 42, defenderAward: 0 });
    expect(scoreContract(42, 30, 12, "points")).toMatchObject({ made: false, bidderAward: 0, defenderAward: 42 });
    expect(scoreContract(84, 42, 0, "points")).toMatchObject({ made: true, bidderAward: 84 });
    expect(scoreContract(84, 41, 1, "points")).toMatchObject({ made: false, defenderAward: 84 });
    expect(scoreContract(30, 30, 12, "marks")).toEqual({ made: true, bidderAward: 1, defenderAward: 0 });
    expect(scoreContract(126, 42, 0, "marks").bidderAward).toBe(3);
    expect(scoreContract(31, 10, 32, "marks")).toEqual({ made: false, bidderAward: 0, defenderAward: 1 });
  });
});

describe("a full hand", () => {
  it("always distributes exactly 42 points", () => {
    let state = scriptedPlayingHand();
    while (state.phase !== "handComplete") {
      if (state.phase === "trickComplete") {
        state = apply(state, { type: "acknowledgeTrick" });
        continue;
      }
      const seat = state.turn!;
      const legal = observe(state, seat).legalPlays;
      state = apply(state, { type: "play", domino: legal[0]! });
    }
    expect(state.handPoints[0] + state.handPoints[1]).toBe(42);
    expect(state.completedTricks).toHaveLength(7);
    const seen = new Set<string>();
    for (const trick of state.completedTricks) {
      expect(trick.points).toBe(trickPoints(trick.plays));
      for (const play of trick.plays) seen.add(dominoKey(play.domino));
    }
    expect(seen.size).toBe(28);
  });

  it("rejects a renege", () => {
    let state = scriptedPlayingHand();
    state = {
      ...state,
      trump: fours,
      turn: 1,
      currentTrick: [{ player: 0, domino: D(2, 1) }],
      hands: [
        [D(6, 6)],
        [D(4, 2), D(2, 0), D(5, 5)],
        [D(3, 3)],
        [D(6, 5)],
      ],
    };
    expect(() => apply(state, { type: "play", domino: D(4, 2) })).toThrow(/follow suit/);
    expect(apply(state, { type: "play", domino: D(2, 0) }).currentTrick).toHaveLength(2);
  });
});

describe("bot matches", () => {
  it("plays complete matches without breaking the rules", () => {
    for (const seed of [1, 2, 3, 4, 8, 99]) {
      let state = createMatch({ ...defaultSettings(seed), target: 80 });
      let steps = 0;
      while (state.phase !== "matchComplete" && steps < 8000) {
        steps += 1;
        state = stepBot(state);
        if (state.phase === "handComplete" || state.phase === "matchComplete") {
          if (!state.lastResult?.passed) {
            expect(state.handPoints[0] + state.handPoints[1]).toBe(42);
          }
        }
      }
      expect(state.phase).toBe("matchComplete");
      expect(Math.max(state.scores[0], state.scores[1])).toBeGreaterThanOrEqual(80);
    }
  });
});

function stepBot(state: GameState): GameState {
  if (state.phase === "trickComplete") return apply(state, { type: "acknowledgeTrick" });
  if (state.phase === "handComplete") return apply(state, { type: "nextHand" });
  const seat = state.turn;
  if (seat == null) throw new Error(`No turn in ${state.phase}`);
  const view = observe(state, seat);
  const margin = seat === 0 ? -2 : BOT_STYLES[seat].margin;
  return apply(state, chooseAction(view, { margin }));
}

function scriptedPlayingHand(): GameState {
  const deck = createDeck();
  const hands: GameState["hands"] = [[], [], [], []];
  deck.forEach((d, i) => hands[i % 4]!.push(d));
  return {
    settings: defaultSettings(1),
    rng: 1,
    phase: "playing",
    shaker: 3,
    handNumber: 1,
    hands,
    bids: [
      { kind: "bid", amount: 30 },
      { kind: "pass" },
      { kind: "pass" },
      { kind: "pass" },
    ],
    bidLeader: 0,
    turn: 0,
    highBid: 30,
    highBidder: 0,
    trump: { kind: "suit", suit: 6 },
    currentTrick: [],
    completedTricks: [],
    handPoints: [0, 0],
    scores: [0, 0],
    lastResult: null,
    log: [],
  };
}
