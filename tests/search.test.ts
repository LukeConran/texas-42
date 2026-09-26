import { describe, expect, it } from "vitest";
import { playHands } from "../src/ai/ladder";
import { heuristicPolicy } from "../src/ai/policy";
import { completeHands, searchPolicy } from "../src/ai/search";
import { createDeck, dominoKey, type Domino, type Seat } from "../src/engine/domino";
import { defaultSettings, observe, type GameState } from "../src/engine/game";
import { followsLead, type Trump } from "../src/engine/trump";

const blanks: Trump = { kind: "suit", suit: 0 };

describe("hidden-hand search", () => {
  it("finishes a marks hand and repeats it from the same seed", () => {
    const run = () =>
      playHands(
        1,
        [
          searchPolicy({ samples: 2, seed: 5, name: "search" }),
          heuristicPolicy({ margin: 0 }, "west"),
          heuristicPolicy({ margin: 0 }, "north"),
          heuristicPolicy({ margin: 0 }, "east"),
        ],
        4,
        "marks",
      );
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    const hand = first[0]!;
    if (!hand.passed) expect(hand.captured[0] + hand.captured[1]).toBe(42);
  });

  it("does not give a ducked suit back to the player who failed to follow", () => {
    const view = observe(duckedSix(), 0);
    const rng = { state: 11 };
    const lead = view.currentTrick[0]!.domino;
    for (let sample = 0; sample < 12; sample++) {
      const hands = completeHands(view, rng);
      expect(hands[1].some((domino) => followsLead(domino, lead, blanks))).toBe(false);
      expect(hands[0]).toHaveLength(view.hand.length);
      const seen = new Set<string>();
      for (const hand of hands) for (const domino of hand) seen.add(dominoKey(domino));
      for (const play of view.currentTrick) seen.add(dominoKey(play.domino));
      expect(seen.size).toBe(28);
    }
  });
});

function duckedSix(): GameState {
  const deck = createDeck();
  const lead = take(deck, { hi: 6, lo: 5 });
  const duck = take(deck, { hi: 3, lo: 2 });
  const hands: GameState["hands"] = [[], [], [], []];
  const need = [6, 6, 7, 7];
  let seat: Seat = 0;
  for (const domino of deck) {
    while (hands[seat].length >= need[seat]!) seat = ((seat + 1) % 4) as Seat;
    hands[seat].push(domino);
    seat = ((seat + 1) % 4) as Seat;
  }
  return {
    settings: defaultSettings(1),
    rng: 1,
    phase: "playing",
    shaker: 3,
    handNumber: 1,
    hands,
    bids: [{ kind: "bid", amount: 30 }, { kind: "pass" }, { kind: "pass" }, { kind: "pass" }],
    bidLeader: 0,
    turn: 2,
    highBid: 30,
    highBidder: 0,
    trump: blanks,
    currentTrick: [
      { player: 0, domino: lead },
      { player: 1, domino: duck },
    ],
    completedTricks: [],
    handPoints: [0, 0],
    scores: [0, 0],
    lastResult: null,
    log: [],
  };
}

function take(deck: Domino[], target: Domino): Domino {
  const index = deck.findIndex((domino) => domino.hi === target.hi && domino.lo === target.lo);
  if (index < 0) throw new Error(`Missing ${target.hi}-${target.lo}`);
  return deck.splice(index, 1)[0]!;
}
