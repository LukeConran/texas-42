import { countValue, partnerOf, teamOf, type Domino } from "../engine/domino";
import { createMatch, nextRng, type Action, type PlayerView } from "../engine/game";
import { bestEstimate, estimateHand } from "./evaluate";
import { chooseAction } from "./heuristic";
import { benchSettings, playHand } from "./ladder";
import type { Policy } from "./policy";
import { searchPolicy } from "./search";
import { classify, trumpKey, TRUMP_CHOICES, winningIndex, type Trump } from "../engine/trump";

/**
 * Rung 3. Fit a small set of weights to the choices the search made.
 * Scoring a decision is a dot product, so it is fast enough to sit at the table.
 * One input is whether the heuristic would make that choice. The other weights
 * learn where the search disagreed.
 *
 * There is one weight per fact: 15 for a bid, 10 for a trump, 19 for a tile.
 */

export interface RankExample {
  rows: number[][];
  label: number;
}

export interface Lesson {
  bids: RankExample[];
  trumps: RankExample[];
  plays: RankExample[];
}

export interface WeightVector {
  in: number;
  w: number[];
}

export interface ImitationModel {
  bid: WeightVector;
  trump: WeightVector;
  play: WeightVector;
}

export interface TrainOptions {
  epochs?: number;
  lr?: number;
  l2?: number;
  seed?: number;
}

export function collectSearchLessons(
  hands: number,
  samples: number,
  seed: number,
  onHand?: (hand: number, hands: number) => void,
): Lesson {
  const lesson: Lesson = { bids: [], trumps: [], plays: [] };
  for (let i = 0; i < hands; i++) {
    const teacher = recordingPolicy(searchPolicy({ samples, seed: seed + i * 997, name: "search" }), lesson);
    playHand(createMatch(benchSettings(seed + i, "marks")), [teacher, teacher, teacher, teacher]);
    onHand?.(i + 1, hands);
  }
  return lesson;
}

export function trainImitation(lesson: Lesson, options: TrainOptions = {}): ImitationModel {
  const epochs = options.epochs ?? 80;
  const lr = options.lr ?? 0.15;
  const l2 = options.l2 ?? 1e-4;
  const seed = options.seed ?? 1;
  return {
    bid: fitRanker(lesson.bids, epochs, lr, l2, seed),
    trump: fitRanker(lesson.trumps, epochs, lr, l2, seed + 1),
    play: fitRanker(lesson.plays, epochs, lr, l2, seed + 2),
  };
}

export function trainingAccuracy(lesson: Lesson, model: ImitationModel): { bid: number; trump: number; play: number } {
  return {
    bid: rankAccuracy(lesson.bids, model.bid.w),
    trump: rankAccuracy(lesson.trumps, model.trump.w),
    play: rankAccuracy(lesson.plays, model.play.w),
  };
}

export function imitationPolicy(model: ImitationModel, name = "imitate"): Policy {
  return {
    name,
    act(view) {
      const choices = listChoices(view);
      return choices.take(bestRow(choices.rows, model[choices.head].w));
    },
  };
}

export interface DecisionTrace {
  head: "bid" | "trump" | "play";
  rows: number[][];
  chosen: number;
}

/** Sample a legal choice and remember it so the hand's marks can update the weights. */
export function sampleChoice(
  model: ImitationModel,
  view: PlayerView,
  rng: { state: number },
): { action: Action; trace: DecisionTrace | null } {
  const choices = listChoices(view);
  const scores = choices.rows.map((row) => dot(model[choices.head].w, row));
  const chosen = scores.length <= 1 ? 0 : sampleIndex(scores, rng);
  const trace = scores.length > 1 ? { head: choices.head, rows: choices.rows, chosen } : null;
  return { action: choices.take(chosen), trace };
}

/** Move the weights toward the chosen row when the hand won marks, and away when it lost. */
export function reinforceUpdate(
  vector: WeightVector,
  rows: number[][],
  chosen: number,
  advantage: number,
  lr: number,
): void {
  if (rows.length <= 1 || advantage === 0 || chosen < 0 || chosen >= rows.length) return;
  const scores = rows.map((row) => dot(vector.w, row));
  const p = softmax(scores);
  for (let j = 0; j < vector.w.length; j++) {
    let expected = 0;
    for (let i = 0; i < rows.length; i++) expected += p[i]! * (rows[i]![j] ?? 0);
    const grad = (rows[chosen]![j] ?? 0) - expected;
    vector.w[j] = (vector.w[j] ?? 0) + lr * advantage * grad;
  }
}

export function listChoices(view: PlayerView): {
  head: "bid" | "trump" | "play";
  rows: number[][];
  take(index: number): Action;
} {
  if (view.turn !== view.seat) throw new Error(`Seat ${view.seat} is not deciding`);
  if (view.phase === "bidding") {
    const hint = chooseAction(view, { margin: 0 });
    const hintAmount = hint.type === "bid" ? hint.amount : "pass";
    const amounts = view.legalBids;
    return {
      head: "bid",
      rows: amounts.map((amount) => bidCandidate(view, amount, hintAmount)),
      take: (index) => ({ type: "bid", amount: amounts[index] ?? "pass" }),
    };
  }
  if (view.phase === "trump") {
    const hint = chooseAction(view, { margin: 0 });
    const hintKey = hint.type === "declareTrump" ? trumpKey(hint.trump) : "";
    return {
      head: "trump",
      rows: TRUMP_CHOICES.map((trump) => trumpCandidate(view, trump, hintKey)),
      take: (index) => ({ type: "declareTrump", trump: TRUMP_CHOICES[index] ?? TRUMP_CHOICES[0]! }),
    };
  }
  if (view.phase === "playing") {
    const legal = view.legalPlays;
    if (legal.length === 0) throw new Error("No legal play");
    const hint = chooseAction(view, { margin: 0 });
    const hintKey = hint.type === "play" ? `${hint.domino.hi}-${hint.domino.lo}` : "";
    return {
      head: "play",
      rows: legal.map((domino) => playCandidate(view, domino, hintKey)),
      take: (index) => ({ type: "play", domino: legal[index] ?? legal[0]! }),
    };
  }
  throw new Error(`No imitation decision in ${view.phase}`);
}

export function modelToJson(model: ImitationModel): string {
  return JSON.stringify(model);
}

export function modelFromJson(text: string): ImitationModel {
  const value = JSON.parse(text) as ImitationModel;
  for (const key of ["bid", "trump", "play"] as const) {
    const head = value[key];
    if (!head || !Array.isArray(head.w) || head.w.length !== head.in) {
      throw new Error("The imitation weights are not a complete model.");
    }
  }
  return value;
}

function recordingPolicy(inner: Policy, lesson: Lesson): Policy {
  return {
    name: inner.name,
    act(view) {
      const action = inner.act(view);
      remember(lesson, view, action);
      return action;
    },
  };
}

function remember(lesson: Lesson, view: PlayerView, action: Action): void {
  if (view.phase === "bidding" && action.type === "bid" && view.legalBids.length > 1) {
    const hint = chooseAction(view, { margin: 0 });
    const hintAmount = hint.type === "bid" ? hint.amount : "pass";
    const rows = view.legalBids.map((amount) => bidCandidate(view, amount, hintAmount));
    const label = view.legalBids.indexOf(action.amount);
    if (label >= 0) lesson.bids.push({ rows, label });
  }
  if (view.phase === "trump" && action.type === "declareTrump") {
    const hint = chooseAction(view, { margin: 0 });
    const hintKey = hint.type === "declareTrump" ? trumpKey(hint.trump) : "";
    const rows = TRUMP_CHOICES.map((trump) => trumpCandidate(view, trump, hintKey));
    const label = TRUMP_CHOICES.findIndex((trump) => trumpKey(trump) === trumpKey(action.trump));
    if (label >= 0) lesson.trumps.push({ rows, label });
  }
  if (view.phase === "playing" && action.type === "play" && view.legalPlays.length > 1 && view.trump) {
    const hint = chooseAction(view, { margin: 0 });
    const hintKey = hint.type === "play" ? `${hint.domino.hi}-${hint.domino.lo}` : "";
    const rows = view.legalPlays.map((domino) => playCandidate(view, domino, hintKey));
    const label = view.legalPlays.findIndex((domino) => domino.hi === action.domino.hi && domino.lo === action.domino.lo);
    if (label >= 0) lesson.plays.push({ rows, label });
  }
}

function fitRanker(examples: RankExample[], epochs: number, lr: number, l2: number, seed: number): WeightVector {
  const inn = examples[0]?.rows[0]?.length ?? 1;
  const w = new Array<number>(inn).fill(0);
  if (examples.length === 0) return { in: inn, w };
  const rng = { state: seed >>> 0 || 1 };
  for (let epoch = 0; epoch < epochs; epoch++) {
    shuffle(examples, rng);
    for (const example of examples) {
      const scores = example.rows.map((row) => dot(w, row));
      const p = softmax(scores);
      for (let j = 0; j < inn; j++) {
        let grad = l2 * w[j]!;
        for (let i = 0; i < example.rows.length; i++) {
          const err = p[i]! - (i === example.label ? 1 : 0);
          grad += err * example.rows[i]![j]!;
        }
        w[j] = w[j]! - lr * grad;
      }
    }
  }
  return { in: inn, w };
}

function rankAccuracy(examples: RankExample[], w: number[]): number {
  if (examples.length === 0 || w.length === 0) return 0;
  let hit = 0;
  for (const example of examples) {
    if (bestRow(example.rows, w) === example.label) hit += 1;
  }
  return hit / examples.length;
}

function bestRow(rows: number[][], w: number[]): number {
  let best = 0;
  let score = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < rows.length; i++) {
    const next = dot(w, rows[i]!);
    if (next > score) {
      score = next;
      best = i;
    }
  }
  return best;
}

function sampleIndex(scores: number[], rng: { state: number }): number {
  const weights = softmax(scores);
  const draw = nextRng(rng.state);
  rng.state = draw.state;
  let cursor = draw.value;
  for (let i = 0; i < weights.length; i++) {
    cursor -= weights[i]!;
    if (cursor <= 0) return i;
  }
  return weights.length - 1;
}

function bidCandidate(view: PlayerView, amount: number | "pass", hint: number | "pass"): number[] {
  const best = bestEstimate(view.hand);
  const pass = amount === "pass" ? 1 : 0;
  const level = typeof amount === "number" ? amount / 168 : 0;
  const partner = view.bids[partnerOf(view.seat)];
  const partnerLevel = partner == null ? 0 : partner.kind === "pass" ? -1 : partner.amount / 168;
  return [
    1,
    pass,
    level,
    typeof amount === "number" && amount >= 42 ? 1 : 0,
    typeof amount === "number" && amount >= 84 ? 1 : 0,
    amount === hint ? 1 : 0,
    best.expected / 42,
    best.sureTricks / 7,
    best.trumpLength / 7,
    pass * (best.expected / 42),
    level * (best.expected / 42),
    level * (best.sureTricks / 7),
    (view.highBid ?? 0) / 168,
    level * ((view.highBid ?? 0) / 168),
    partnerLevel,
  ];
}

function trumpCandidate(view: PlayerView, trump: Trump, hintKey: string): number[] {
  const estimate = estimateHand(view.hand, trump);
  let count = 0;
  for (const domino of view.hand) count += countValue(domino);
  return [
    1,
    trump.kind === "doubles" ? 1 : 0,
    trump.kind === "followMe" ? 1 : 0,
    trump.kind === "suit" ? trump.suit / 6 : 0,
    trumpKey(trump) === hintKey ? 1 : 0,
    estimate.expected / 42,
    estimate.sureTricks / 7,
    estimate.trumpLength / 7,
    (view.highBid ?? 0) / 168,
    count / 35,
  ];
}

function playCandidate(view: PlayerView, domino: Domino, hintKey: string): number[] {
  const trump = view.trump;
  if (!trump) return [1];
  const tile = classify(domino, trump);
  const trick = view.currentTrick.map((play) => play.domino);
  const wins = trick.length === 0 ? 1 : winningIndex([...trick, domino], trump) === trick.length ? 1 : 0;
  let trumpInHand = 0;
  let suitInHand = 0;
  for (const held of view.hand) {
    const kind = classify(held, trump);
    if (kind.isTrump) trumpInHand += 1;
    else if (!tile.isTrump && kind.suit === tile.suit) suitInHand += 1;
  }
  let partnerWinning = 0;
  if (trick.length > 0) {
    const winner = view.currentTrick[winningIndex(trick, trump)]!.player;
    if (winner === partnerOf(view.seat)) partnerWinning = 1;
  }
  const mine = teamOf(view.seat);
  const bidderTeam = view.highBidder == null ? -1 : teamOf(view.highBidder);
  return [
    1,
    `${domino.hi}-${domino.lo}` === hintKey ? 1 : 0,
    countValue(domino) / 10,
    domino.hi / 6,
    domino.lo / 6,
    domino.hi === domino.lo ? 1 : 0,
    tile.isTrump ? 1 : 0,
    tile.rank / 7,
    wins,
    trick.length === 0 ? 1 : 0,
    suitInHand / 7,
    trumpInHand / 7,
    view.hand.length / 7,
    view.handPoints[mine] / 42,
    view.handPoints[mine === 0 ? 1 : 0] / 42,
    (view.highBid ?? 0) / 168,
    bidderTeam === mine ? 1 : 0,
    view.completedTricks.length / 7,
    partnerWinning,
  ];
}

function dot(w: number[], row: number[]): number {
  let sum = 0;
  const n = Math.min(w.length, row.length);
  for (let i = 0; i < n; i++) sum += w[i]! * row[i]!;
  return sum;
}

function softmax(scores: number[]): number[] {
  let max = Number.NEGATIVE_INFINITY;
  for (const score of scores) if (score > max) max = score;
  const exps = scores.map((score) => Math.exp(score - max));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function shuffle<T>(items: T[], rng: { state: number }): void {
  for (let i = items.length - 1; i > 0; i--) {
    const next = (rng.state + 0x6d2b79f5) | 0;
    let t = Math.imul(next ^ (next >>> 15), 1 | next);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    rng.state = next >>> 0;
    const j = Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}
