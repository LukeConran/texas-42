import type { Seat } from "../engine/domino";
import { countValue } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";
import { BOT_STYLES, chooseAction, shapedBid, type BotStyle } from "./heuristic";
import { chooseAmong, chooseSearched } from "./search";

/** How hard the empty chairs play. Medium is the usual bid and the usual play. */
export type BotLevel = "easy" | "medium" | "hard";

export function chooseBotAction(view: PlayerView, level: BotLevel): Action {
  if (view.mayLayDown) return { type: "layDown" };
  if (view.phase === "playing" && view.trump?.kind === "nello" && view.turn === view.seat) {
    return chooseAction(view);
  }
  if (level === "easy") return chooseEasy(view);
  if (level === "hard") return chooseHard(view);
  return chooseAction(view, seatStyle(view.seat));
}

function seatStyle(seat: Seat): BotStyle {
  return BOT_STYLES[seat === 0 ? 1 : seat];
}

function chooseEasy(view: PlayerView): Action {
  const style = seatStyle(view.seat);
  if (view.phase === "playing" && view.turn === view.seat) {
    const legal = [...view.legalPlays];
    if (legal.length === 0) throw new Error("No legal play");
    legal.sort((a, b) => countValue(a) - countValue(b) || a.hi + a.lo - (b.hi + b.lo) || a.hi - b.hi);
    return { type: "play", domino: legal[0]! };
  }
  const cautious = chooseAction(view, { margin: style.margin + 2 });
  if (cautious.type === "bid" && cautious.amount !== "pass" && cautious.amount > 31) {
    if (view.legalBids.includes(31)) return { type: "bid", amount: 31 };
    if (view.legalBids.includes(30)) return { type: "bid", amount: 30 };
    return { type: "bid", amount: "pass" };
  }
  return cautious;
}

function chooseHard(view: PlayerView): Action {
  const rng = { state: mixSeed(view) };
  if (view.phase === "bidding" && view.turn === view.seat) {
    const amount = shapedBid(view, { margin: seatStyle(view.seat).margin - 1 });
    if (amount === "pass") return { type: "bid", amount: "pass" };
    return chooseAmong(
      view,
      [
        { type: "bid", amount: "pass" },
        { type: "bid", amount },
      ],
      4,
      rng,
    );
  }
  const samples = view.phase === "playing" ? 3 : 4;
  return chooseSearched(view, samples, rng);
}

function mixSeed(view: PlayerView): number {
  let n = (view.settings.seed || 1) >>> 0;
  n = Math.imul(n ^ (view.handNumber || 1), 0x9e3779b1);
  n ^= view.seat * 0x85ebca6b;
  n ^= view.currentTrick.length * 0xc2b2ae35;
  n ^= view.completedTricks.length * 17;
  return n >>> 0 || 1;
}
