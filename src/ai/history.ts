import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Seat } from "../engine/domino";
import { createMatch, type GameState } from "../engine/game";
import { trumpName } from "../engine/trump";
import type { ImitationModel } from "./imitate";
import { imitationPolicy } from "./imitate";
import {
  benchSettings,
  duelHands,
  playHand,
  summarize,
  type DuelResult,
  type LadderSummary,
} from "./ladder";
import { heuristicPolicy, type SeatPolicies } from "./policy";

/**
 * One line in stats/data/runs.jsonl. The page at `npm run stats` reads these
 * back. Trick lists live in stats/data/samples.json for the latest run.
 */

export const RUNS_PATH = "stats/data/runs.jsonl";
export const SAMPLES_PATH = "stats/data/samples.json";
export const FACTS_PATH = "stats/data/facts.json";

/** Names for the 15 bid, 10 trump, and 19 play weights, in vector order. */
export const WEIGHT_FACTS = {
  bid: [
    "Bias",
    "Pass",
    "Level",
    "42 or more",
    "84 or more",
    "Matches heuristic",
    "Expected",
    "Sure tricks",
    "Trump length",
    "Pass × expected",
    "Level × expected",
    "Level × sure",
    "High bid",
    "Level × high bid",
    "Partner",
  ],
  trump: [
    "Bias",
    "Doubles",
    "No trump",
    "Suit",
    "Matches heuristic",
    "Expected",
    "Sure tricks",
    "Length",
    "High bid",
    "Count",
  ],
  play: [
    "Bias",
    "Matches heuristic",
    "Count",
    "High end",
    "Low end",
    "Double",
    "Trump",
    "Rank",
    "Wins the trick",
    "Leading",
    "Suit in hand",
    "Trump in hand",
    "Hand length",
    "Our count",
    "Their count",
    "High bid",
    "Our bid",
    "Tricks played",
    "Partner winning",
  ],
} as const;

const PLACES = ["South", "West", "North", "East"] as const;
const BAND_SEEDS = Array.from({ length: 16 }, (_, index) => 72000 + index);
const SAMPLE_SEEDS = Array.from({ length: 6 }, (_, index) => 73000 + index);

export interface SamplePlay {
  seat: Seat;
  name: string;
  hi: number;
  lo: number;
}

export interface SampleTrick {
  plays: SamplePlay[];
  winner: Seat;
  winnerName: string;
  points: number;
}

export interface SampleBid {
  seat: Seat;
  name: string;
  amount: number | "pass";
}

export interface SampleHand {
  seed: number;
  passed: boolean;
  bids: SampleBid[];
  bid: number | null;
  bidderName: string | null;
  trump: string | null;
  made: boolean | null;
  captured: [number, number];
  awarded: [number, number];
  tricks: SampleTrick[];
}

export interface RunRecord {
  at: string;
  kind: "rl" | "imitate" | "score";
  hands: number;
  /** Shake scale for rl, or the imitation step size. */
  lr: number;
  samples?: number;
  seed: number;
  seconds: number;
  accepted: boolean;
  versusHeuristic: DuelResult;
  versusStart?: DuelResult;
  confirmation?: DuelResult;
  confirmationStart?: DuelResult;
  fitAccuracy?: { bid: number; trump: number; play: number };
  bands: LadderSummary;
  bandsStart?: LadderSummary;
  weightL1: { bid: number; trump: number; play: number };
  weights: ImitationModel;
}

export function weightL1(next: ImitationModel, previous: ImitationModel): { bid: number; trump: number; play: number } {
  const arm = (key: "bid" | "trump" | "play") => {
    const left = next[key].w;
    const right = previous[key].w;
    let sum = 0;
    for (let i = 0; i < left.length; i++) sum += Math.abs((left[i] ?? 0) - (right[i] ?? 0));
    return sum;
  };
  return { bid: arm("bid"), trump: arm("trump"), play: arm("play") };
}

export function appendRun(record: RunRecord, runsPath = RUNS_PATH, factsPath = FACTS_PATH): void {
  mkdirSync(dirname(runsPath), { recursive: true });
  appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
  writeFileSync(factsPath, JSON.stringify(WEIGHT_FACTS));
}

export function writeSamples(at: string, hands: SampleHand[], path = SAMPLES_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ at, hands }));
}

/** Made and set counts for both seatings of the band deals. */
export function captureBands(model: ImitationModel, start: ImitationModel | null): {
  bands: LadderSummary;
  bandsStart?: LadderSummary;
} {
  const learned = imitationPolicy(model, "weights");
  const heuristic = heuristicPolicy({ margin: 0 }, "heuristic");
  const bands = summarize(duelHands(BAND_SEEDS, learned, heuristic));
  if (!start) return { bands };
  return { bands, bandsStart: summarize(duelHands(BAND_SEEDS, imitationPolicy(start, "previous"), heuristic)) };
}

/** A few full hands, preferring deals that were actually bid. */
export function captureSamples(model: ImitationModel): SampleHand[] {
  const learned = imitationPolicy(model, "weights");
  const heuristic = heuristicPolicy({ margin: 0 }, "heuristic");
  const hands: SampleHand[] = [];
  for (const seed of SAMPLE_SEEDS) {
    hands.push(sampleHand(seed, [learned, heuristic, learned, heuristic], ["weights", "heuristic", "weights", "heuristic"]));
    hands.push(sampleHand(seed, [heuristic, learned, heuristic, learned], ["heuristic", "weights", "heuristic", "weights"]));
  }
  const played = hands.filter((hand) => !hand.passed);
  return (played.length > 0 ? played : hands).slice(0, 8);
}

export function sampleHand(seed: number, seats: SeatPolicies, names: [string, string, string, string]): SampleHand {
  return describeHand(playHand(createMatch(benchSettings(seed, "marks")), seats), names);
}

export function describeHand(state: GameState, names: [string, string, string, string]): SampleHand {
  const result = state.lastResult;
  if (!result) throw new Error("The hand ended without a result");
  const bidderName = result.bidder == null ? null : placeName(result.bidder, names);
  return {
    seed: state.settings.seed,
    passed: result.passed,
    bids: state.bids.map((bid, seat) => ({
      seat: seat as Seat,
      name: placeName(seat as Seat, names),
      amount: bid == null || bid.kind === "pass" ? "pass" : bid.amount,
    })),
    bid: result.bid,
    bidderName,
    trump: result.trump ? trumpName(result.trump) : null,
    made: result.made,
    captured: [result.captured[0], result.captured[1]],
    awarded: [result.awarded[0], result.awarded[1]],
    tricks: state.completedTricks.map((trick) => ({
      winner: trick.winner,
      winnerName: placeName(trick.winner, names),
      points: trick.points,
      plays: trick.plays.map((play) => ({
        seat: play.player,
        name: placeName(play.player, names),
        hi: play.domino.hi,
        lo: play.domino.lo,
      })),
    })),
  };
}

function placeName(seat: Seat, names: [string, string, string, string]): string {
  return `${PLACES[seat]} · ${names[seat]}`;
}
