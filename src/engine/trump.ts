import { type Domino, isDouble } from "./domino";

/**
 * Trump named by the high bidder before the opening lead.
 * `suit` 0 is blanks. `doubles` makes the seven doubles the trump suit.
 * `followMe` is no-trump: the higher end of the led tile is the suit.
 */
export type Trump =
  | { kind: "suit"; suit: number }
  | { kind: "doubles" }
  | { kind: "followMe" };

export type TileClass = {
  isTrump: boolean;
  /** Suit index 0-6 when this tile is not trump. -1 when it is trump. */
  suit: number;
  /** Higher rank wins. Doubles in a number suit use 7, above every off-pip. */
  rank: number;
};

export const TRUMP_CHOICES: Trump[] = [
  { kind: "suit", suit: 0 },
  { kind: "suit", suit: 1 },
  { kind: "suit", suit: 2 },
  { kind: "suit", suit: 3 },
  { kind: "suit", suit: 4 },
  { kind: "suit", suit: 5 },
  { kind: "suit", suit: 6 },
  { kind: "doubles" },
  { kind: "followMe" },
];

const SUIT_CALLS = ["blanks", "ones", "twos", "threes", "fours", "fives", "sixes"];

export function trumpKey(trump: Trump): string {
  if (trump.kind === "suit") return `suit:${trump.suit}`;
  return trump.kind;
}

export function sameTrump(a: Trump, b: Trump): boolean {
  return trumpKey(a) === trumpKey(b);
}

export function trumpName(trump: Trump): string {
  if (trump.kind === "doubles") return "doubles";
  if (trump.kind === "followMe") return "no trump";
  return SUIT_CALLS[trump.suit] ?? String(trump.suit);
}

export function parseTrump(key: string): Trump {
  if (key === "doubles") return { kind: "doubles" };
  if (key === "followMe") return { kind: "followMe" };
  if (key.startsWith("suit:")) {
    const suit = Number(key.slice(5));
    if (suit >= 0 && suit <= 6) return { kind: "suit", suit };
  }
  throw new Error(`Unknown trump: ${key}`);
}

/**
 * Which suit a tile belongs to under the declared trump.
 * A tile that contains the trump number is always trump, never a member of its other end.
 */
export function classify(d: Domino, trump: Trump): TileClass {
  if (trump.kind === "doubles") {
    if (isDouble(d)) return { isTrump: true, suit: -1, rank: d.hi };
    return { isTrump: false, suit: d.hi, rank: d.lo };
  }

  if (trump.kind === "followMe") {
    if (isDouble(d)) return { isTrump: false, suit: d.hi, rank: 7 };
    return { isTrump: false, suit: d.hi, rank: d.lo };
  }

  const s = trump.suit;
  if (d.hi === s || d.lo === s) {
    if (isDouble(d)) return { isTrump: true, suit: -1, rank: 7 };
    const other = d.hi === s ? d.lo : d.hi;
    return { isTrump: true, suit: -1, rank: other };
  }
  if (isDouble(d)) return { isTrump: false, suit: d.hi, rank: 7 };
  return { isTrump: false, suit: d.hi, rank: d.lo };
}

export function ledCall(lead: Domino, trump: Trump): { isTrump: boolean; suit: number } {
  const c = classify(lead, trump);
  if (c.isTrump) return { isTrump: true, suit: -1 };
  return { isTrump: false, suit: c.suit };
}

export function followsLead(d: Domino, lead: Domino, trump: Trump): boolean {
  const call = ledCall(lead, trump);
  const c = classify(d, trump);
  if (call.isTrump) return c.isTrump;
  return !c.isTrump && c.suit === call.suit;
}

/** Tiles the player is allowed to play on this trick. Empty trick means any lead. */
export function legalPlays(
  hand: Domino[],
  trick: Domino[],
  trump: Trump,
  options?: { mustLeadTrump?: boolean },
): Domino[] {
  if (hand.length === 0) return [];
  if (trick.length === 0) {
    if (options?.mustLeadTrump && trump.kind !== "followMe") {
      const trumps = hand.filter((d) => classify(d, trump).isTrump);
      if (trumps.length > 0) return trumps;
    }
    return hand.slice();
  }
  const lead = trick[0]!;
  const following = hand.filter((d) => followsLead(d, lead, trump));
  return following.length > 0 ? following : hand.slice();
}

/**
 * Index into `plays` of the winning tile.
 * Trump beats the led suit. Highest rank of the winning role takes the trick.
 */
export function winningIndex(plays: Domino[], trump: Trump): number {
  if (plays.length === 0) throw new Error("Cannot score an empty trick");
  const call = ledCall(plays[0]!, trump);
  let best = 0;
  for (let i = 1; i < plays.length; i++) {
    if (beats(plays[i]!, plays[best]!, call, trump)) best = i;
  }
  return best;
}

function beats(
  challenger: Domino,
  holder: Domino,
  call: { isTrump: boolean; suit: number },
  trump: Trump,
): boolean {
  const c = classify(challenger, trump);
  const h = classify(holder, trump);
  const cWins = tileCanWin(c, call);
  const hWins = tileCanWin(h, call);
  if (cWins && !hWins) return true;
  if (!cWins || !hWins) return false;
  if (c.isTrump !== h.isTrump) return c.isTrump;
  return c.rank > h.rank;
}

function tileCanWin(c: TileClass, call: { isTrump: boolean; suit: number }): boolean {
  if (c.isTrump) return true;
  if (call.isTrump) return false;
  return c.suit === call.suit;
}

/** Every rank that exists in a trump suit, highest first. */
export function trumpRankOrder(trump: Trump): number[] {
  if (trump.kind === "followMe") return [];
  if (trump.kind === "doubles") return [6, 5, 4, 3, 2, 1, 0];
  const offs = [6, 5, 4, 3, 2, 1, 0].filter((k) => k !== trump.suit);
  return [7, ...offs];
}

/** Ranks of a non-trump suit, highest first. Empty when that suit cannot be led. */
export function offsuitRankOrder(suit: number, trump: Trump): number[] {
  if (trump.kind === "suit" && trump.suit === suit) return [];
  if (trump.kind === "doubles") {
    const ranks: number[] = [];
    for (let k = suit - 1; k >= 0; k--) ranks.push(k);
    return ranks;
  }
  const ranks = [7];
  for (let k = suit - 1; k >= 0; k--) ranks.push(k);
  if (trump.kind === "suit" && trump.suit < suit) {
    return ranks.filter((r) => r !== trump.suit);
  }
  return ranks;
}
