import type { Seat } from "../engine/domino";
import { countValue } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";
import { BOT_STYLES, chooseAction, type BotStyle } from "./heuristic";

/** How hard the empty chairs play. Medium is the table bot this game already uses. */
export type BotLevel = "easy" | "medium" | "hard";

export function chooseBotAction(view: PlayerView, level: BotLevel): Action {
  const style = seatStyle(view.seat);
  if (level === "easy") return chooseEasy(view, style);
  if (level === "hard") return chooseAction(view, { margin: style.margin - 5 });
  return chooseAction(view, style);
}

function seatStyle(seat: Seat): BotStyle {
  return BOT_STYLES[seat === 0 ? 1 : seat];
}

function chooseEasy(view: PlayerView, style: BotStyle): Action {
  if (view.phase === "playing" && view.turn === view.seat) {
    const legal = [...view.legalPlays];
    if (legal.length === 0) throw new Error("No legal play");
    legal.sort((a, b) => countValue(a) - countValue(b) || a.hi + a.lo - (b.hi + b.lo) || a.hi - b.hi);
    return { type: "play", domino: legal[0]! };
  }
  const cautious = chooseAction(view, { margin: style.margin + 12 });
  if (cautious.type === "bid" && cautious.amount !== "pass" && cautious.amount > 32) {
    return view.legalBids.includes(32) ? { type: "bid", amount: 32 } : { type: "bid", amount: "pass" };
  }
  return cautious;
}
