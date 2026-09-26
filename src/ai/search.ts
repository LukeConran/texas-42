import { createDeck, dominoKey, teamOf, type Domino, type Seat, type Team } from "../engine/domino";
import {
  apply,
  nextRng,
  observe,
  type Action,
  type GameState,
  type PlayerView,
} from "../engine/game";
import { followsLead, trumpKey, TRUMP_CHOICES, type Trump } from "../engine/trump";
import { chooseAction } from "./heuristic";
import type { Policy } from "./policy";

/**
 * Rung 2. At each decision, deal the cards still out several times, try each
 * legal choice, and finish the hand with the heuristic. Keep the choice whose
 * team award is highest on average.
 *
 * The live table does not call this. It is too slow for a click. Run
 * `npm run search` to play it against the heuristic.
 */

export interface SearchOptions {
  /** Hidden deals tried at each decision. */
  samples?: number;
  /** Seed for those deals. The same seed replays the same choices. */
  seed?: number;
  name?: string;
}

interface Rng {
  state: number;
}

const ROLLOUT_CAP = 80;

export function searchPolicy(options: SearchOptions = {}): Policy {
  const samples = Math.max(1, Math.floor(options.samples ?? 16));
  const rng: Rng = { state: (options.seed ?? 1) >>> 0 || 1 };
  return {
    name: options.name ?? `search-${samples}`,
    act(view) {
      return chooseSearched(view, samples, rng);
    },
  };
}

export function chooseSearched(view: PlayerView, samples: number, rng: Rng): Action {
  const actions = legalActions(view);
  if (actions.length === 1) return actions[0]!;
  const team = teamOf(view.seat);
  const totals = new Map<string, number>();
  for (const action of actions) totals.set(actionKey(action), 0);
  for (let sample = 0; sample < samples; sample++) {
    const world = worldFrom(view, completeHands(view, rng));
    for (const action of actions) {
      const key = actionKey(action);
      totals.set(key, (totals.get(key) ?? 0) + awardAfter(world, action, team));
    }
  }
  const prefer = actionKey(chooseAction(view, { margin: 0 }));
  let bestScore = Number.NEGATIVE_INFINITY;
  let chosen = actions[0]!;
  for (const action of actions) {
    const score = totals.get(actionKey(action)) ?? 0;
    const key = actionKey(action);
    if (score > bestScore || (score === bestScore && key === prefer)) {
      bestScore = score;
      chosen = action;
    }
  }
  return chosen;
}

/** Deal the unseen cards into the other seats, respecting suits they have ducked. */
export function completeHands(view: PlayerView, rng: Rng): GameState["hands"] {
  const unknown = unseenCards(view);
  const voids = shownVoids(view);
  const trump = view.trump;
  for (let attempt = 0; attempt < 80; attempt++) {
    shuffle(unknown, rng);
    const dealt = deal(view, unknown);
    if (trump == null || respectsVoids(dealt, voids, trump)) return dealt;
  }
  shuffle(unknown, rng);
  return deal(view, unknown);
}

function legalActions(view: PlayerView): Action[] {
  if (view.turn !== view.seat) throw new Error(`Seat ${view.seat} is not deciding`);
  if (view.phase === "bidding") return view.legalBids.map((amount) => ({ type: "bid", amount }));
  if (view.phase === "trump") return TRUMP_CHOICES.map((trump) => ({ type: "declareTrump", trump }));
  if (view.phase === "playing") return view.legalPlays.map((domino) => ({ type: "play", domino: { ...domino } }));
  throw new Error(`No search decision in ${view.phase}`);
}

function awardAfter(world: GameState, action: Action, team: Team): number {
  let state = apply(world, action);
  for (let step = 0; step < ROLLOUT_CAP && state.phase !== "handComplete" && state.phase !== "matchComplete"; step++) {
    if (state.phase === "trickComplete") {
      state = apply(state, { type: "acknowledgeTrick" });
      continue;
    }
    const seat = state.turn;
    if (seat == null) break;
    state = apply(state, chooseAction(observe(state, seat), { margin: 0 }));
  }
  if ((state.phase !== "handComplete" && state.phase !== "matchComplete") || !state.lastResult) return 0;
  // A mark is worth more than any count. Count breaks ties between the same contract result.
  const ours = state.lastResult.awarded[team];
  const theirs = state.lastResult.awarded[team === 0 ? 1 : 0];
  return (ours - theirs) * 100 + state.lastResult.captured[team];
}

function worldFrom(view: PlayerView, hands: GameState["hands"]): GameState {
  return {
    settings: view.settings,
    rng: 1,
    phase: view.phase,
    shaker: view.shaker,
    handNumber: view.handNumber,
    hands: hands.map((hand) => hand.map(copy)) as GameState["hands"],
    bids: view.bids.map((bid) => (bid ? { ...bid } : null)) as GameState["bids"],
    bidLeader: view.bidLeader,
    turn: view.turn,
    highBid: view.highBid,
    highBidder: view.highBidder,
    trump: view.trump ? { ...view.trump } : null,
    currentTrick: view.currentTrick.map((play) => ({ player: play.player, domino: copy(play.domino) })),
    completedTricks: view.completedTricks.map((trick) => ({
      winner: trick.winner,
      points: trick.points,
      plays: trick.plays.map((play) => ({ player: play.player, domino: copy(play.domino) })),
    })),
    handPoints: [view.handPoints[0], view.handPoints[1]],
    scores: [view.scores[0], view.scores[1]],
    lastResult: null,
    log: [],
  };
}

function unseenCards(view: PlayerView): Domino[] {
  const seen = new Set<string>();
  for (const domino of view.hand) seen.add(dominoKey(domino));
  for (const trick of view.completedTricks) {
    for (const play of trick.plays) seen.add(dominoKey(play.domino));
  }
  for (const play of view.currentTrick) seen.add(dominoKey(play.domino));
  return createDeck().filter((domino) => !seen.has(dominoKey(domino)));
}

interface Void {
  seat: Seat;
  lead: Domino;
}

function shownVoids(view: PlayerView): Void[] {
  if (!view.trump) return [];
  const trump = view.trump;
  const voids: Void[] = [];
  const tricks = [...view.completedTricks.map((trick) => trick.plays), view.currentTrick];
  for (const plays of tricks) {
    if (plays.length < 2) continue;
    const lead = plays[0]!.domino;
    for (let i = 1; i < plays.length; i++) {
      const play = plays[i]!;
      if (!followsLead(play.domino, lead, trump)) voids.push({ seat: play.player, lead });
    }
  }
  return voids;
}

function deal(view: PlayerView, unknown: Domino[]): GameState["hands"] {
  const hands: GameState["hands"] = [[], [], [], []];
  hands[view.seat] = view.hand.map(copy);
  let cursor = 0;
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    if (seat === view.seat) continue;
    const need = view.handCounts[seat];
    hands[seat] = unknown.slice(cursor, cursor + need).map(copy);
    cursor += need;
  }
  return hands;
}

function respectsVoids(hands: GameState["hands"], voids: Void[], trump: Trump): boolean {
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    for (const domino of hands[seat]) {
      for (const hole of voids) {
        if (hole.seat === seat && followsLead(domino, hole.lead, trump)) return false;
      }
    }
  }
  return true;
}

function shuffle(cards: Domino[], rng: Rng): void {
  for (let i = cards.length - 1; i > 0; i--) {
    const next = nextRng(rng.state);
    rng.state = next.state;
    const j = Math.floor(next.value * (i + 1));
    const tmp = cards[i]!;
    cards[i] = cards[j]!;
    cards[j] = tmp;
  }
}

function actionKey(action: Action): string {
  if (action.type === "bid") return `bid:${action.amount}`;
  if (action.type === "declareTrump") return `trump:${trumpKey(action.trump)}`;
  if (action.type === "play") return `play:${dominoKey(action.domino)}`;
  return action.type;
}

function copy(domino: Domino): Domino {
  return { hi: domino.hi, lo: domino.lo };
}
