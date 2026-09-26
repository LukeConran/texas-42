import type { Seat, Team } from "../engine/domino";
import {
  apply,
  createMatch,
  observe,
  type GameState,
  type HandResult,
  type MatchSettings,
  type ScoringMode,
} from "../engine/game";
import { policiesFor, type Policy, type SeatPolicies } from "./policy";

/**
 * Rung 1. Play seeded hands and record the team award.
 * Rung 2 (`src/ai/search.ts`) searches the cards still out on these same deals.
 * Later: copy that search into a fast policy, then train on the award at the end of the hand.
 */

const HAND_STEP_CAP = 80;
const MATCH_HAND_CAP = 400;

export interface HandRecord {
  matchSeed: number;
  handNumber: number;
  passed: boolean;
  bid: number | null;
  bidder: Seat | null;
  made: boolean | null;
  captured: [number, number];
  /** Index 0 is South and North. Index 1 is West and East. */
  awarded: [number, number];
}

export interface BandStats {
  hands: number;
  made: number;
}

export interface LadderSummary {
  hands: number;
  passes: number;
  made: number;
  set: number;
  awarded: [number, number];
  bands: Record<string, BandStats>;
}

export interface MatchRecord {
  hands: HandRecord[];
  scores: [number, number];
  winner: Team | null;
}

export interface DuelResult {
  hands: number;
  /** Marks or points won while sitting as a team, summed over both seatings. */
  awardA: number;
  awardB: number;
}

const BANDS = ["pass", "30-35", "36-41", "42", "84", "126", "168"] as const;

export function bidBand(bid: number | null): (typeof BANDS)[number] {
  if (bid == null) return "pass";
  if (bid >= 168) return "168";
  if (bid >= 126) return "126";
  if (bid >= 84) return "84";
  if (bid >= 42) return "42";
  if (bid >= 36) return "36-41";
  return "30-35";
}

export function benchSettings(seed: number, scoringMode: ScoringMode = "marks"): MatchSettings {
  const clean = seed >>> 0 || 1;
  return {
    scoringMode,
    target: scoringMode === "marks" ? 7 : 250,
    openingLeadMustBeTrump: false,
    seed: clean,
  };
}

/** Finish the hand already dealt. Trick gathering is bookkeeping, not a decision. */
export function playHand(state: GameState, seats: SeatPolicies): GameState {
  let current = state;
  for (let step = 0; step < HAND_STEP_CAP; step++) {
    if (current.phase === "handComplete" || current.phase === "matchComplete") return current;
    if (current.phase === "trickComplete") {
      current = apply(current, { type: "acknowledgeTrick" });
      continue;
    }
    const seat = current.turn;
    if (seat == null) throw new Error(`No seat to act in ${current.phase}`);
    current = apply(current, policiesFor(seats, seat).act(observe(current, seat)));
  }
  throw new Error("The hand did not finish");
}

export function playHands(count: number, seats: SeatPolicies, seed = 1, scoringMode: ScoringMode = "marks"): HandRecord[] {
  const records: HandRecord[] = [];
  for (let i = 0; i < count; i++) {
    const matchSeed = (seed + i) >>> 0 || 1;
    const done = playHand(createMatch(benchSettings(matchSeed, scoringMode)), seats);
    records.push(toRecord(matchSeed, done));
  }
  return records;
}

export function playMatch(seed: number, seats: SeatPolicies, scoringMode: ScoringMode = "marks"): MatchRecord {
  let state = createMatch(benchSettings(seed, scoringMode));
  const hands: HandRecord[] = [];
  for (let n = 0; n < MATCH_HAND_CAP && state.phase !== "matchComplete"; n++) {
    if (state.phase === "handComplete") {
      state = apply(state, { type: "nextHand" });
      continue;
    }
    state = playHand(state, seats);
    hands.push(toRecord(seed, state));
  }
  return {
    hands,
    scores: [state.scores[0], state.scores[1]],
    winner: state.phase === "matchComplete" ? (state.lastResult?.matchWinner ?? null) : null,
  };
}

/**
 * Replay each deal twice, swapping which team sits where.
 * Award A is what the first policy's team won across both seatings.
 */
export function duel(seeds: readonly number[], a: Policy, b: Policy, scoringMode: ScoringMode = "marks"): DuelResult {
  let awardA = 0;
  let awardB = 0;
  let hands = 0;
  for (const seed of seeds) {
    const first = toRecord(seed, playHand(createMatch(benchSettings(seed, scoringMode)), [a, b, a, b]));
    const second = toRecord(seed, playHand(createMatch(benchSettings(seed, scoringMode)), [b, a, b, a]));
    awardA += first.awarded[0] + second.awarded[1];
    awardB += first.awarded[1] + second.awarded[0];
    hands += 2;
  }
  return { hands, awardA, awardB };
}

export function summarize(records: readonly HandRecord[]): LadderSummary {
  const bands = Object.fromEntries(BANDS.map((band) => [band, { hands: 0, made: 0 }])) as Record<
    (typeof BANDS)[number],
    BandStats
  >;
  const summary: LadderSummary = {
    hands: records.length,
    passes: 0,
    made: 0,
    set: 0,
    awarded: [0, 0],
    bands,
  };
  for (const record of records) {
    summary.awarded[0] += record.awarded[0];
    summary.awarded[1] += record.awarded[1];
    const band = bands[bidBand(record.bid)];
    band.hands += 1;
    if (record.passed) summary.passes += 1;
    else if (record.made) {
      summary.made += 1;
      band.made += 1;
    } else summary.set += 1;
  }
  return summary;
}

function toRecord(matchSeed: number, state: GameState): HandRecord {
  const result = state.lastResult;
  if (!result) throw new Error("The hand ended without a result");
  return fromResult(matchSeed, state.handNumber, result);
}

function fromResult(matchSeed: number, handNumber: number, result: HandResult): HandRecord {
  return {
    matchSeed,
    handNumber,
    passed: result.passed,
    bid: result.bid,
    bidder: result.bidder,
    made: result.made,
    captured: [result.captured[0], result.captured[1]],
    awarded: [result.awarded[0], result.awarded[1]],
  };
}
