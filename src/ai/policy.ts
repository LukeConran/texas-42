import type { Seat } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";
import { BOT_STYLES, chooseAction, type BotStyle } from "./heuristic";

/**
 * One seat, deciding from its own view. The view hides the other hands.
 * Later rungs (search, a copy of that search, then self-play) implement this
 * same function. They do not get a private look at the deck.
 */
export interface Policy {
  name: string;
  act(view: PlayerView): Action;
}

export function heuristicPolicy(style: BotStyle = { margin: 0 }, name = "heuristic"): Policy {
  return {
    name,
    act(view) {
      return chooseAction(view, style);
    },
  };
}

/** Four heuristic seats. West, North, and East keep the styles used at the table. */
export function heuristicTable(): [Policy, Policy, Policy, Policy] {
  return [
    heuristicPolicy({ margin: 0 }, "south"),
    heuristicPolicy(BOT_STYLES[1], "west"),
    heuristicPolicy(BOT_STYLES[2], "north"),
    heuristicPolicy(BOT_STYLES[3], "east"),
  ];
}

export type SeatPolicies = readonly [Policy, Policy, Policy, Policy];

export function policiesFor(seats: SeatPolicies, seat: Seat): Policy {
  return seats[seat];
}
