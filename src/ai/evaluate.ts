import type { Domino } from "../engine/domino";
import { countValue } from "../engine/domino";
import {
  type Trump,
  TRUMP_CHOICES,
  classify,
  offsuitRankOrder,
  trumpRankOrder,
} from "../engine/trump";

export interface HandEstimate {
  trump: Trump;
  /** Partnership points this seat expects to win if this trump is named. */
  expected: number;
  sureTricks: number;
  trumpLength: number;
}

/**
 * Bid strength on a 42-point scale.
 * A callable hand lands near 30. The number is the partnership total, so it
 * includes a modest share for the unseen partner when the hand can lead trump.
 */
export function estimateHand(hand: Domino[], trump: Trump): HandEstimate {
  if (trump.kind === "followMe") return estimateFollowMe(hand);

  const mine = hand.filter((d) => classify(d, trump).isTrump);
  const held = new Set(mine.map((d) => classify(d, trump).rank));
  const order = trumpRankOrder(trump);
  let higherOut = 0;
  let sureTricks = 0;
  let probable = 0;
  for (const rank of order) {
    if (held.has(rank)) {
      if (higherOut === 0) sureTricks += 1;
      else probable += higherOut === 1 ? 0.55 : 0.25;
    } else {
      higherOut += 1;
    }
  }

  const offs = sureOffsuitWinners(hand, trump);
  const countHeld = hand.reduce((sum, d) => sum + countValue(d), 0);
  const protectedCount = countOnWinners(hand, trump, held, order);
  const outstandingCount = 35 - countHeld;
  const control = Math.min(1, sureTricks * 0.2 + mine.length * 0.07 + probable * 0.05);

  // Trick points we can cash, count sitting on those winners, and a share of
  // the count still out. Low trumps are not each worth a trick.
  let expected = 0;
  expected += sureTricks + probable * 0.55 + offs * 0.65;
  expected += protectedCount;
  expected += (countHeld - protectedCount) * 0.4;
  expected += outstandingCount * control * 0.62;
  if (mine.length >= 3 && sureTricks >= 1) expected += 6.5;
  else if (mine.length >= 4) expected += 3;
  else if (mine.length >= 2 && sureTricks >= 1) expected += 2;
  if (mine.length <= 1) expected -= 6;
  if (trump.kind === "doubles" && mine.length < 3) expected -= 4;

  return {
    trump,
    expected,
    sureTricks,
    trumpLength: mine.length,
  };
}

export function bestEstimate(hand: Domino[]): HandEstimate {
  let best = estimateHand(hand, TRUMP_CHOICES[0]!);
  for (const trump of TRUMP_CHOICES.slice(1)) {
    const next = estimateHand(hand, trump);
    if (next.expected > best.expected + 0.75) best = next;
    else if (Math.abs(next.expected - best.expected) <= 0.75 && next.trumpLength > best.trumpLength) best = next;
  }
  return best;
}

function countOnWinners(hand: Domino[], trump: Trump, held: Set<number>, order: number[]): number {
  let count = 0;
  for (const d of hand) {
    const value = countValue(d);
    if (value === 0) continue;
    const c = classify(d, trump);
    if (c.isTrump && walkingWinner(c.rank, held, order)) count += value;
    else if (!c.isTrump && isTopOfSuit(d, trump)) count += value;
  }
  return count;
}

function walkingWinner(rank: number, held: Set<number>, order: number[]): boolean {
  for (const r of order) {
    if (r === rank) return true;
    if (!held.has(r)) return false;
  }
  return false;
}

function sureOffsuitWinners(hand: Domino[], trump: Trump): number {
  const bySuit = new Map<number, Domino[]>();
  for (const d of hand) {
    const c = classify(d, trump);
    if (c.isTrump) continue;
    const list = bySuit.get(c.suit) ?? [];
    list.push(d);
    bySuit.set(c.suit, list);
  }
  let winners = 0;
  for (const [suit, tiles] of bySuit) {
    const top = offsuitRankOrder(suit, trump)[0];
    if (top == null) continue;
    if (tiles.some((d) => classify(d, trump).rank === top)) winners += 1;
  }
  return winners;
}

function isTopOfSuit(d: Domino, trump: Trump): boolean {
  const c = classify(d, trump);
  if (c.isTrump) return false;
  return offsuitRankOrder(c.suit, trump)[0] === c.rank;
}

function estimateFollowMe(hand: Domino[]): HandEstimate {
  const trump: Trump = { kind: "followMe" };
  const bySuit = new Map<number, number[]>();
  for (const d of hand) {
    const c = classify(d, trump);
    const list = bySuit.get(c.suit) ?? [];
    list.push(c.rank);
    bySuit.set(c.suit, list);
  }

  let best = 0;
  let sureTricks = 0;
  for (const [suit, ranks] of bySuit) {
    const held = new Set(ranks);
    const order = offsuitRankOrder(suit, trump);
    let higherOut = 0;
    let walking = 0;
    for (const rank of order) {
      if (held.has(rank)) {
        if (higherOut === 0) walking += 1;
      } else higherOut += 1;
    }
    let value = ranks.length * 3.2 + walking * 4;
    if (ranks.length >= 4 && walking >= 1) value += 7;
    else if (ranks.length >= 5) value += 4;
    if (value > best) {
      best = value;
      sureTricks = walking;
    }
  }

  const count = hand.reduce((sum, d) => sum + countValue(d), 0);
  return {
    trump,
    expected: best + count * 0.4,
    sureTricks,
    trumpLength: 0,
  };
}
