/** A double-six domino. `hi` is always >= `lo`. Both ends are 0 through 6. */
export interface Domino {
  hi: number;
  lo: number;
}

export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;

export function dominoKey(d: Domino): string {
  return `${d.hi}-${d.lo}`;
}

export function sameDomino(a: Domino, b: Domino): boolean {
  return a.hi === b.hi && a.lo === b.lo;
}

export function isDouble(d: Domino): boolean {
  return d.hi === d.lo;
}

/** Points a domino scores when the trick that contains it is won. */
export function countValue(d: Domino): number {
  const pips = d.hi + d.lo;
  if (pips === 5) return 5;
  if (pips === 10) return 10;
  return 0;
}

export function createDeck(): Domino[] {
  const deck: Domino[] = [];
  for (let hi = 0; hi <= 6; hi++) {
    for (let lo = 0; lo <= hi; lo++) {
      deck.push({ hi, lo });
    }
  }
  return deck;
}

const SUIT_NAMES = ["blanks", "aces", "deuces", "treys", "fours", "fives", "sixes"] as const;

export function suitName(suit: number): string {
  return SUIT_NAMES[suit] ?? String(suit);
}

export function dominoName(d: Domino): string {
  if (isDouble(d)) return `double ${suitName(d.hi)}`;
  return `${suitName(d.hi)}-${suitName(d.lo)}`;
}

/** Compact label used on buttons and logs, e.g. "6-4" or "5-5". */
export function dominoLabel(d: Domino): string {
  return `${d.hi}-${d.lo}`;
}

export function teamOf(seat: Seat): Team {
  return seat % 2 === 0 ? 0 : 1;
}

export function partnerOf(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

export const SEAT_NAMES = ["You", "West", "Partner", "East"] as const;

export function seatName(seat: Seat): string {
  return SEAT_NAMES[seat];
}
