import type { Domino, Seat } from "../engine/domino";
import { countValue, dominoKey, teamOf } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";
import { classify, winningIndex, type Trump } from "../engine/trump";
import { bestEstimate } from "./evaluate";

export interface BotStyle {
  /** Subtracted from the point estimate before choosing a bid. Higher means more cautious. */
  margin: number;
}

export const BOT_STYLES: Record<Exclude<Seat, 0>, BotStyle> = {
  1: { margin: -1.2 },
  2: { margin: -2 },
  3: { margin: -2.6 },
};

export function chooseAction(view: PlayerView, style: BotStyle = { margin: 1.25 }): Action {
  if (view.phase === "bidding" && view.turn === view.seat) {
    return { type: "bid", amount: chooseBid(view, style) };
  }
  if (view.phase === "trump" && view.turn === view.seat) {
    return { type: "declareTrump", trump: bestEstimate(view.hand).trump };
  }
  if (view.phase === "playing" && view.turn === view.seat) {
    const domino = choosePlay(view);
    return { type: "play", domino };
  }
  throw new Error(`No decision for seat ${view.seat} in ${view.phase}`);
}

function chooseBid(view: PlayerView, style: BotStyle): number | "pass" {
  const best = bestEstimate(view.hand);
  const lock =
    best.sureTricks >= 6 && best.trumpLength >= 5 && best.expected >= 40 && best.trump.kind !== "followMe";
  if (lock && (view.highBid == null || view.highBid < 84)) return 84;
  if (lock && view.highBid != null && view.highBid >= 84 && view.highBid < 168 && best.sureTricks >= 7) {
    return view.highBid < 126 ? 126 : 168;
  }

  let target = Math.round(best.expected - style.margin);
  if (target > 36 && (best.sureTricks < 2 || best.trumpLength < 4)) target = 36;
  if (target > 42) target = 42;
  if (target >= 42 && best.expected < 44) target = 41;
  let choice: number | "pass";
  if (view.highBid == null) choice = target >= 30 ? target : "pass";
  else if (target > view.highBid) choice = target;
  else if (best.expected - style.margin >= view.highBid + 1 && view.highBid < 42) choice = view.highBid + 1;
  else choice = "pass";
  if (choice !== "pass" && !view.legalBids.includes(choice)) return "pass";
  return choice;
}

function choosePlay(view: PlayerView): Domino {
  const legal = view.legalPlays;
  if (legal.length === 0) throw new Error("No legal play");
  if (legal.length === 1) return legal[0]!;
  const trump = view.trump;
  if (!trump) return legal[0]!;
  if (view.currentTrick.length === 0) return chooseLead(view, trump, legal);
  return chooseFollow(view, trump, legal);
}

function chooseLead(view: PlayerView, trump: Trump, legal: Domino[]): Domino {
  const trumps = legal.filter((d) => classify(d, trump).isTrump);
  const offs = legal.filter((d) => !classify(d, trump).isTrump);
  const byCash = (a: Domino, b: Domino) =>
    countValue(b) - countValue(a) || rankOf(b, trump) - rankOf(a, trump);

  const winningTrumps = trumps.filter((d) => isUnbeatable(d, view, trump)).sort(byCash);
  if (winningTrumps.length > 0) return winningTrumps[0]!;

  const winningOffs = offs.filter((d) => isUnbeatable(d, view, trump)).sort(byCash);
  const trumpStillOut = outstandingTrump(view, trump);
  if (winningOffs.length > 0 && (!trumpStillOut || trumps.length === 0)) return winningOffs[0]!;

  if (trumps.length > 0 && trumpStillOut) {
    const safeOff = offs.filter((d) => countValue(d) === 0).sort((a, b) => discardScore(a, trump) - discardScore(b, trump));
    if (safeOff.length > 0) return safeOff[0]!;
    return [...trumps].sort((a, b) => rankOf(a, trump) - rankOf(b, trump))[0]!;
  }

  if (winningOffs.length > 0) return winningOffs[0]!;
  const dump = [...offs].sort((a, b) => discardScore(a, trump) - discardScore(b, trump));
  if (dump.length > 0) return dump[0]!;
  return [...trumps].sort((a, b) => rankOf(a, trump) - rankOf(b, trump))[0]!;
}

function chooseFollow(view: PlayerView, trump: Trump, legal: Domino[]): Domino {
  const plays = view.currentTrick.map((p) => p.domino);
  const winAt = winningIndex(plays, trump);
  const winner = view.currentTrick[winAt]!.player;
  const partnerWinning = teamOf(winner) === view.team;
  const yetToPlay = 4 - view.currentTrick.length - 1;
  const trickCount = plays.reduce((sum, d) => sum + countValue(d), 0);
  const wantTrick = trickCount > 0 || !partnerWinning || yetToPlay > 0;

  const beating = legal.filter((d) => wouldWin(d, plays, trump));
  const ducking = legal.filter((d) => !wouldWin(d, plays, trump));

  if (partnerWinning && yetToPlay === 0) {
    return highestCountThenLow(legal, trump);
  }

  if (partnerWinning && ducking.length > 0 && beating.length !== legal.length) {
    if (trickCount >= 5 && beating.length > 0 && yetToPlay > 0) {
      return cheapest(beating, trump);
    }
    return cheapest(ducking.length ? ducking : legal, trump);
  }

  if (!partnerWinning && beating.length > 0 && (wantTrick || yetToPlay === 0)) {
    return cheapest(beating, trump);
  }

  if (partnerWinning) return highestCountThenLow(ducking.length ? ducking : legal, trump);
  return cheapest(ducking.length ? ducking : legal, trump);
}

function wouldWin(domino: Domino, plays: Domino[], trump: Trump): boolean {
  const next = [...plays, domino];
  return winningIndex(next, trump) === next.length - 1;
}

function cheapest(tiles: Domino[], trump: Trump): Domino {
  return [...tiles].sort((a, b) => discardScore(a, trump) - discardScore(b, trump))[0]!;
}

function highestCountThenLow(tiles: Domino[], trump: Trump): Domino {
  return [...tiles].sort((a, b) => {
    const count = countValue(b) - countValue(a);
    if (count !== 0) return count;
    return discardScore(a, trump) - discardScore(b, trump);
  })[0]!;
}

/** Low number means "happy to spend this tile". Trumps and count are protected. */
function discardScore(d: Domino, trump: Trump): number {
  const c = classify(d, trump);
  const count = countValue(d);
  return (c.isTrump ? 100 : 0) + count * 3 + c.rank;
}

function rankOf(d: Domino, trump: Trump): number {
  return classify(d, trump).rank + (classify(d, trump).isTrump ? 20 : 0);
}

function outstandingTrump(view: PlayerView, trump: Trump): boolean {
  if (trump.kind === "followMe") return false;
  const seen = seenKeys(view);
  return trumpRankList(trump).some((rank) => {
    const key = trumpTileKey(trump, rank);
    return key != null && !seen.has(key);
  });
}

function seenKeys(view: PlayerView): Set<string> {
  const seen = new Set<string>();
  for (const tile of view.hand) seen.add(dominoKey(tile));
  for (const trick of view.completedTricks) {
    for (const play of trick.plays) seen.add(dominoKey(play.domino));
  }
  for (const play of view.currentTrick) seen.add(dominoKey(play.domino));
  return seen;
}

function isUnbeatable(d: Domino, view: PlayerView, trump: Trump): boolean {
  const c = classify(d, trump);
  const seen = seenKeys(view);

  if (c.isTrump) {
    return !anyHigherUnseen(c.rank, trumpRankList(trump), (rank) => trumpTileKey(trump, rank), seen);
  }
  return !anyHigherUnseen(c.rank, offsuitRanks(c.suit, trump), (rank) => offsuitTileKey(c.suit, rank, trump), seen);
}

function anyHigherUnseen(
  rank: number,
  orderHighToLow: number[],
  keyFor: (rank: number) => string | null,
  seen: Set<string>,
): boolean {
  for (const r of orderHighToLow) {
    if (r === rank) return false;
    const key = keyFor(r);
    if (key && !seen.has(key)) return true;
  }
  return false;
}

function trumpRankList(trump: Trump): number[] {
  if (trump.kind === "doubles") return [6, 5, 4, 3, 2, 1, 0];
  if (trump.kind === "followMe") return [];
  return [7, ...[6, 5, 4, 3, 2, 1, 0].filter((k) => k !== trump.suit)];
}

function offsuitRanks(suit: number, trump: Trump): number[] {
  if (trump.kind === "doubles") {
    const ranks: number[] = [];
    for (let k = suit - 1; k >= 0; k--) ranks.push(k);
    return ranks;
  }
  const ranks = [7];
  for (let k = suit - 1; k >= 0; k--) ranks.push(k);
  if (trump.kind === "suit" && trump.suit < suit) return ranks.filter((r) => r !== trump.suit);
  return ranks;
}

function trumpTileKey(trump: Trump, rank: number): string | null {
  if (trump.kind === "doubles") return `${rank}-${rank}`;
  if (trump.kind === "followMe") return null;
  if (rank === 7) return `${trump.suit}-${trump.suit}`;
  const hi = Math.max(trump.suit, rank);
  const lo = Math.min(trump.suit, rank);
  return `${hi}-${lo}`;
}

function offsuitTileKey(suit: number, rank: number, trump: Trump): string | null {
  if (rank === 7) {
    if (trump.kind === "doubles") return null;
    if (trump.kind === "suit" && trump.suit === suit) return null;
    return `${suit}-${suit}`;
  }
  if (trump.kind === "suit" && (rank === trump.suit || suit === trump.suit)) return null;
  const hi = Math.max(suit, rank);
  const lo = Math.min(suit, rank);
  return `${hi}-${lo}`;
}

