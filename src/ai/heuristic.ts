import type { Domino, Seat } from "../engine/domino";
import { countValue, dominoKey, teamOf } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";
import { classify, offsuitRankOrder, trickSize, trumpRankOrder, winningIndex, type Trump } from "../engine/trump";
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
    if (view.mayLayDown) return { type: "layDown" };
    const domino = choosePlay(view);
    return { type: "play", domino };
  }
  throw new Error(`No decision for seat ${view.seat} in ${view.phase}`);
}

/** Bids a chair is willing to say. 35 and 36 need both ten-count tiles. 42 is a run. */
export const BID_BANDS = [30, 31, 32, 33, 35, 36, 42] as const;

export function shapedBid(view: PlayerView, style: BotStyle): number | "pass" {
  const best = bestEstimate(view.hand);
  const amount = bidAmount(view.hand, best, style);
  if (amount === "pass") return "pass";
  if (view.highBid != null && amount <= view.highBid) return "pass";
  if (!view.legalBids.includes(amount)) return "pass";
  return amount;
}

function chooseBid(view: PlayerView, style: BotStyle): number | "pass" {
  return shapedBid(view, style);
}

function bidAmount(hand: Domino[], best: ReturnType<typeof bestEstimate>, style: BotStyle): number | "pass" {
  const strength = best.expected - style.margin;
  const bothTens = hasKey(hand, "6-4") && hasKey(hand, "5-5");
  const flawless =
    best.sureTricks >= 6 && best.trumpLength >= 5 && strength >= 41 && best.trump.kind !== "followMe";
  if (flawless) return 42;

  let bid = 0;
  if (strength >= 27) bid = 30;
  if (strength >= 31 && best.trumpLength >= 3) bid = 31;
  if (strength >= 34 && best.trumpLength >= 3 && best.sureTricks >= 1) bid = 32;
  if (strength >= 36 && best.trumpLength >= 4 && best.sureTricks >= 2) bid = 33;
  if (bothTens && best.trumpLength >= 4 && best.sureTricks >= 2 && strength >= 35) bid = 35;
  if (bothTens && best.trumpLength >= 5 && best.sureTricks >= 3 && strength >= 38) bid = 36;
  return bid >= 30 ? bid : "pass";
}

function hasKey(hand: Domino[], key: string): boolean {
  return hand.some((domino) => dominoKey(domino) === key);
}

function choosePlay(view: PlayerView): Domino {
  const legal = view.legalPlays;
  if (legal.length === 0) throw new Error("No legal play");
  if (legal.length === 1) return legal[0]!;
  const trump = view.trump;
  if (!trump) return legal[0]!;
  if (trump.kind === "nello") return chooseNello(view, legal);
  if (view.currentTrick.length === 0) return chooseLead(view, trump, legal);
  return chooseFollow(view, trump, legal);
}

/** The bidder dumps tiles that lose. Everyone else ducks so the bidder is left with the trick. */
function chooseNello(view: PlayerView, legal: Domino[]): Domino {
  const trump = view.trump!;
  const saving = view.highBidder != null && teamOf(view.highBidder) === view.team;
  if (view.currentTrick.length === 0) return cheapest(legal, trump);
  const plays = view.currentTrick.map((play) => play.domino);
  const ducking = legal.filter((domino) => !wouldWin(domino, plays, trump));
  if (saving && ducking.length > 0) {
    return [...ducking].sort((a, b) => rankOf(b, trump) - rankOf(a, trump))[0]!;
  }
  if (ducking.length > 0) return cheapest(ducking, trump);
  return cheapest(legal, trump);
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
  const yetToPlay = trickSize(trump) - view.currentTrick.length - 1;
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
  if (trump.kind === "followMe" || trump.kind === "nello") return false;
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
  return !anyHigherUnseen(c.rank, offsuitRankOrder(c.suit, trump), (rank) => offsuitTileKey(c.suit, rank, trump), seen);
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
  return trumpRankOrder(trump);
}

function trumpTileKey(trump: Trump, rank: number): string | null {
  if (trump.kind === "doubles") return `${rank}-${rank}`;
  if (trump.kind === "followMe" || trump.kind === "nello") return null;
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

