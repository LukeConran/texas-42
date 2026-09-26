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

const SUIT_CALLS = ["Blanks", "Ones", "Twos", "Threes", "Fours", "Fives", "Sixes"];

export function trumpKey(trump: Trump): string {
  if (trump.kind === "suit") return `suit:${trump.suit}`;
  return trump.kind;
}

export function sameTrump(a: Trump, b: Trump): boolean {
  return trumpKey(a) === trumpKey(b);
}

export function trumpName(trump: Trump): string {
  if (trump.kind === "doubles") return "Doubles";
  if (trump.kind === "followMe") return "No Trump";
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

/**
 * A non-trump lead calls its higher end. Any tile with that number follows,
 * including one whose other end is higher. A trump tile belongs only to trump.
 */
export function followsLead(d: Domino, lead: Domino, trump: Trump): boolean {
  const call = ledCall(lead, trump);
  const c = classify(d, trump);
  if (call.isTrump) return c.isTrump;
  if (c.isTrump) return false;
  return d.hi === call.suit || d.lo === call.suit;
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
  const c = standing(challenger, call, trump);
  const h = standing(holder, call, trump);
  if (c.wins && !h.wins) return true;
  if (!c.wins || !h.wins) return false;
  if (c.asTrump !== h.asTrump) return c.asTrump;
  return c.rank > h.rank;
}

/** How a tile stands in this trick. Rank is the other end of the led suit. */
function standing(
  d: Domino,
  call: { isTrump: boolean; suit: number },
  trump: Trump,
): { wins: boolean; asTrump: boolean; rank: number } {
  const c = classify(d, trump);
  if (c.isTrump) return { wins: true, asTrump: true, rank: c.rank };
  if (call.isTrump || (d.hi !== call.suit && d.lo !== call.suit)) {
    return { wins: false, asTrump: false, rank: 0 };
  }
  const rank = isDouble(d) ? 7 : d.hi === call.suit ? d.lo : d.hi;
  return { wins: true, asTrump: false, rank };
}

/** Every rank that exists in a trump suit, highest first. */
export function trumpRankOrder(trump: Trump): number[] {
  if (trump.kind === "followMe") return [];
  if (trump.kind === "doubles") return [6, 5, 4, 3, 2, 1, 0];
  const offs = [6, 5, 4, 3, 2, 1, 0].filter((k) => k !== trump.suit);
  return [7, ...offs];
}

/**
 * Ranks of a non-trump suit, highest first.
 * 7 is the double. Every other rank is the off end, including numbers higher
 * than the suit, because the low end still belongs to the suit that was led.
 * Empty when that number is trump and cannot be led as an off suit.
 */
export function offsuitRankOrder(suit: number, trump: Trump): number[] {
  if (trump.kind === "suit" && trump.suit === suit) return [];
  const ranks: number[] = [];
  if (trump.kind !== "doubles") ranks.push(7);
  for (let k = 6; k >= 0; k--) {
    if (k === suit) continue;
    if (trump.kind === "suit" && k === trump.suit) continue;
    ranks.push(k);
  }
  return ranks;
}
