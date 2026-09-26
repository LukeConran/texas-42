import type { Domino } from "../engine/domino";
import { countValue, dominoKey, dominoName, isDouble } from "../engine/domino";
import type { Trump } from "../engine/trump";
import { classify } from "../engine/trump";

const PIPS: Record<number, Array<[number, number]>> = {
  0: [],
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 2], [1, 1], [2, 0]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]],
  5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [1, 0], [2, 0], [0, 2], [1, 2], [2, 2]],
};

export type BoneSize = "xs" | "sm" | "md" | "lg";

export function boneHtml(
  d: Domino,
  options: {
    size?: BoneSize;
    faceDown?: boolean;
    trump?: Trump | null;
    interactive?: boolean;
    selected?: boolean;
    disabled?: boolean;
    justPlayed?: boolean;
    marked?: boolean;
    locked?: boolean;
  } = {},
): string {
  const size = options.size ?? "md";
  const count = countValue(d);
  const isTrump = options.trump ? classify(d, options.trump).isTrump : false;
  const classes = [
    "bone",
    `bone-${size}`,
    options.faceDown ? "face-down" : "face-up",
    isTrump && !options.faceDown ? "is-trump" : "",
    count && !options.faceDown ? "has-count" : "",
    options.selected ? "selected" : "",
    options.justPlayed ? "just-played" : "",
    options.marked ? "marked" : "",
    options.locked ? "locked" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const label = options.faceDown ? "Face-down domino" : ariaLabel(d, isTrump);
  const inner = options.faceDown
    ? `<span class="back-mark"></span>`
    : `${half(d.hi)}${half(d.lo)}${count ? `<span class="count-tab">${count}</span>` : ""}`;

  if (!options.interactive) {
    return `<div class="${classes}" role="img" aria-label="${label}">${inner}</div>`;
  }

  return `<button type="button" class="${classes} tile" data-act="select" data-key="${dominoKey(d)}" aria-label="${label}" ${
    options.disabled ? "disabled" : ""
  }>${inner}</button>`;
}

export function sortHand(hand: Domino[], trump: Trump | null): Domino[] {
  return [...hand].sort((a, b) => compareDisplay(a, b, trump));
}

function compareDisplay(a: Domino, b: Domino, trump: Trump | null): number {
  if (trump) {
    const ca = classify(a, trump);
    const cb = classify(b, trump);
    if (ca.isTrump !== cb.isTrump) return ca.isTrump ? -1 : 1;
    if (!ca.isTrump && ca.suit !== cb.suit) return cb.suit - ca.suit;
    if (ca.rank !== cb.rank) return cb.rank - ca.rank;
  }
  if (a.hi !== b.hi) return b.hi - a.hi;
  return b.lo - a.lo;
}

function half(n: number): string {
  const pips = (PIPS[n] ?? [])
    .map(([row, col]) => `<i class="pip pip-${n}" style="grid-row:${row + 1};grid-column:${col + 1}"></i>`)
    .join("");
  return `<span class="half">${pips}</span>`;
}

function ariaLabel(d: Domino, isTrump: boolean): string {
  const count = countValue(d);
  const name = isDouble(d) ? `double ${d.hi}` : `${d.hi}-${d.lo}, ${dominoName(d)}`;
  return [name, count ? `${count} count` : "", isTrump ? "trump" : ""].filter(Boolean).join(", ");
}
