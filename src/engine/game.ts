import {
  type Domino,
  type Seat,
  type Team,
  countValue,
  createDeck,
  dominoKey,
  dominoLabel,
  nextSeat,
  partnerOf,
  sameDomino,
  seatName,
  teamOf,
} from "./domino";
import {
  type Trump,
  legalPlays,
  sameTrump,
  trumpName,
  winningIndex,
} from "./trump";

export type ScoringMode = "points" | "marks";

export interface MatchSettings {
  scoringMode: ScoringMode;
  /** First team to reach this score wins. 250 points, or 7 marks. */
  target: number;
  /**
   * House rule from some older writeups: the high bidder's first lead must be a trump.
   * Standard play (Austin 42 / digits.net) leaves this off. Follow-me ignores it.
   */
  openingLeadMustBeTrump: boolean;
  seed: number;
}

export type Bid = { kind: "pass" } | { kind: "bid"; amount: number };

export interface Play {
  player: Seat;
  domino: Domino;
}

export interface CompletedTrick {
  plays: Play[];
  winner: Seat;
  points: number;
}

export type Phase = "bidding" | "trump" | "playing" | "trickComplete" | "handComplete" | "matchComplete";

export interface HandResult {
  passed: boolean;
  bid: number | null;
  bidder: Seat | null;
  trump: Trump | null;
  made: boolean | null;
  /** Points captured in tricks this hand, before the contract payout. Always sums to 42 when played. */
  captured: [number, number];
  awarded: [number, number];
  /** Set when this hand pushed a team to the match target. */
  matchWinner: Team | null;
}

export interface GameState {
  settings: MatchSettings;
  rng: number;
  phase: Phase;
  shaker: Seat;
  handNumber: number;
  hands: [Domino[], Domino[], Domino[], Domino[]];
  bids: [Bid | null, Bid | null, Bid | null, Bid | null];
  /** Seat that bids first this hand (left of the shaker). */
  bidLeader: Seat;
  turn: Seat | null;
  highBid: number | null;
  highBidder: Seat | null;
  trump: Trump | null;
  currentTrick: Play[];
  completedTricks: CompletedTrick[];
  handPoints: [number, number];
  scores: [number, number];
  lastResult: HandResult | null;
  log: string[];
}

export type Action =
  | { type: "bid"; amount: number | "pass" }
  | { type: "declareTrump"; trump: Trump }
  | { type: "play"; domino: Domino }
  | { type: "acknowledgeTrick" }
  | { type: "nextHand" };

/** 30 through 42, then mark bids. Bids above 84 are legal only after someone has bid 84. */
export const BID_LADDER: readonly number[] = [
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 84, 126, 168,
];

export function defaultSettings(seed = randomSeed()): MatchSettings {
  return {
    scoringMode: "points",
    target: 250,
    openingLeadMustBeTrump: false,
    seed,
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) || 1;
}

export function createMatch(settings: MatchSettings = defaultSettings()): GameState {
  const seed = settings.seed >>> 0 || 1;
  const shaker = (Math.floor(nextRng(seed).value * 4) % 4) as Seat;
  const started = dealHand({
    settings: { ...settings, seed },
    rng: nextRng(seed).state,
    phase: "bidding",
    shaker,
    handNumber: 0,
    hands: [[], [], [], []],
    bids: [null, null, null, null],
    bidLeader: nextSeat(shaker),
    turn: null,
    highBid: null,
    highBidder: null,
    trump: null,
    currentTrick: [],
    completedTricks: [],
    handPoints: [0, 0],
    scores: [0, 0],
    lastResult: null,
    log: [],
  });
  return started;
}

export function legalBidAmounts(highBid: number | null): Array<number | "pass"> {
  const options: Array<number | "pass"> = ["pass"];
  for (const amount of BID_LADDER) {
    if (highBid != null && amount <= highBid) continue;
    if (amount > 84 && (highBid == null || highBid < 84)) continue;
    options.push(amount);
  }
  return options;
}

export function apply(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "bid":
      return applyBid(state, action.amount);
    case "declareTrump":
      return applyTrump(state, action.trump);
    case "play":
      return applyPlay(state, action.domino);
    case "acknowledgeTrick":
      return applyAcknowledge(state);
    case "nextHand":
      return applyNextHand(state);
  }
}

export function observe(state: GameState, seat: Seat): PlayerView {
  return {
    seat,
    team: teamOf(seat),
    phase: state.phase,
    hand: state.hands[seat].map((d) => ({ ...d })),
    bids: state.bids.map((b) => (b ? { ...b } : null)) as GameState["bids"],
    bidLeader: state.bidLeader,
    turn: state.turn,
    highBid: state.highBid,
    highBidder: state.highBidder,
    trump: state.trump ? { ...state.trump } : null,
    shaker: state.shaker,
    currentTrick: state.currentTrick.map((p) => ({ player: p.player, domino: { ...p.domino } })),
    completedTricks: state.completedTricks.map((t) => ({
      winner: t.winner,
      points: t.points,
      plays: t.plays.map((p) => ({ player: p.player, domino: { ...p.domino } })),
    })),
    handPoints: [...state.handPoints] as [number, number],
    scores: [...state.scores] as [number, number],
    legalBids: state.phase === "bidding" && state.turn === seat ? legalBidAmounts(state.highBid) : [],
    legalPlays:
      state.phase === "playing" && state.turn === seat
        ? legalPlays(state.hands[seat], state.currentTrick.map((p) => p.domino), state.trump!, {
            mustLeadTrump:
              state.settings.openingLeadMustBeTrump && state.completedTricks.length === 0 && state.currentTrick.length === 0,
          }).map((d) => ({ ...d }))
        : [],
    settings: state.settings,
    handNumber: state.handNumber,
    lastResult: state.lastResult,
  };
}

export interface PlayerView {
  seat: Seat;
  team: Team;
  phase: Phase;
  hand: Domino[];
  bids: GameState["bids"];
  bidLeader: Seat;
  turn: Seat | null;
  highBid: number | null;
  highBidder: Seat | null;
  trump: Trump | null;
  shaker: Seat;
  currentTrick: Play[];
  completedTricks: CompletedTrick[];
  handPoints: [number, number];
  scores: [number, number];
  legalBids: Array<number | "pass">;
  legalPlays: Domino[];
  settings: MatchSettings;
  handNumber: number;
  lastResult: HandResult | null;
}

function applyBid(state: GameState, amount: number | "pass"): GameState {
  if (state.phase !== "bidding" || state.turn == null) {
    throw new Error("No bid is open");
  }
  const legal = legalBidAmounts(state.highBid);
  if (!legal.includes(amount)) throw new Error(`Illegal bid: ${amount}`);

  const seat = state.turn;
  const bids = state.bids.slice() as GameState["bids"];
  bids[seat] = amount === "pass" ? { kind: "pass" } : { kind: "bid", amount };

  let highBid = state.highBid;
  let highBidder = state.highBidder;
  if (amount !== "pass") {
    highBid = amount;
    highBidder = seat;
  }

  const next = nextSeat(seat);
  const biddingDone = next === state.bidLeader;
  const spoken =
    amount === "pass" ? actor(seat, "passes", "pass") : `${actor(seat, "bids", "bid")} ${bidLabel(amount)}`;
  const log = appendLog(state.log, spoken);

  if (!biddingDone) {
    return { ...state, bids, highBid, highBidder, turn: next, log };
  }

  if (highBid == null || highBidder == null) {
    const result: HandResult = {
      passed: true,
      bid: null,
      bidder: null,
      trump: null,
      made: null,
      captured: [0, 0],
      awarded: [0, 0],
      matchWinner: null,
    };
    return {
      ...state,
      bids,
      highBid,
      highBidder,
      phase: "handComplete",
      turn: null,
      lastResult: result,
      log: appendLog(log, "Everyone passed. The tiles are shaken again."),
    };
  }

  return {
    ...state,
    bids,
    highBid,
    highBidder,
    phase: "trump",
    turn: highBidder,
    log: appendLog(log, `${actor(highBidder, "won", "won")} the bid at ${bidLabel(highBid)}.`),
  };
}

function applyTrump(state: GameState, trump: Trump): GameState {
  if (state.phase !== "trump" || state.turn == null) throw new Error("Trump is not being named");
  if (!isKnownTrump(trump)) throw new Error("Unknown trump");
  return {
    ...state,
    trump,
    phase: "playing",
    currentTrick: [],
    log: appendLog(state.log, `${actor(state.turn, "calls", "call")} ${trumpName(trump)}.`),
  };
}

function applyPlay(state: GameState, domino: Domino): GameState {
  if (state.phase !== "playing" || state.turn == null || state.trump == null) {
    throw new Error("No tile can be played now");
  }
  const seat = state.turn;
  const hand = state.hands[seat];
  const match = hand.find((d) => sameDomino(d, domino));
  if (!match) throw new Error(`${seatName(seat)} does not hold ${dominoLabel(domino)}`);

  const legal = legalPlays(
    hand,
    state.currentTrick.map((p) => p.domino),
    state.trump,
    {
      mustLeadTrump:
        state.settings.openingLeadMustBeTrump &&
        state.completedTricks.length === 0 &&
        state.currentTrick.length === 0,
    },
  );
  if (!legal.some((d) => sameDomino(d, domino))) {
    throw new Error(`${dominoLabel(domino)} does not follow suit`);
  }

  const hands = state.hands.map((h, i) =>
    i === seat ? h.filter((d) => !sameDomino(d, domino)) : h.slice(),
  ) as GameState["hands"];
  const currentTrick = [...state.currentTrick, { player: seat, domino: { ...match } }];
  const log = appendLog(state.log, `${actor(seat, "plays", "play")} ${dominoLabel(match)}`);

  if (currentTrick.length < 4) {
    return { ...state, hands, currentTrick, turn: nextSeat(seat), log };
  }

  const winner = currentTrick[winningIndex(currentTrick.map((p) => p.domino), state.trump)]!.player;
  const points = trickPoints(currentTrick);
  return {
    ...state,
    hands,
    currentTrick,
    phase: "trickComplete",
    turn: winner,
    log: appendLog(log, `${actor(winner, "takes", "take")} the trick for ${points}.`),
  };
}

function applyAcknowledge(state: GameState): GameState {
  if (state.phase !== "trickComplete" || state.trump == null || state.turn == null) {
    throw new Error("No completed trick to gather");
  }
  const winner = state.turn;
  const points = trickPoints(state.currentTrick);
  const handPoints: [number, number] = [...state.handPoints];
  handPoints[teamOf(winner)] += points;
  const completedTricks = [
    ...state.completedTricks,
    { plays: state.currentTrick, winner, points },
  ];

  if (completedTricks.length < 7) {
    return {
      ...state,
      phase: "playing",
      currentTrick: [],
      completedTricks,
      handPoints,
      turn: winner,
    };
  }

  return finishHand(state, handPoints, completedTricks);
}

function applyNextHand(state: GameState): GameState {
  if (state.phase !== "handComplete") throw new Error("The hand is still in play");
  if (state.lastResult?.matchWinner != null) throw new Error("The match is over");
  return dealHand({
    ...state,
    shaker: nextSeat(state.shaker),
  });
}

function finishHand(
  state: GameState,
  captured: [number, number],
  completedTricks: CompletedTrick[],
): GameState {
  const bid = state.highBid!;
  const bidder = state.highBidder!;
  const bidderTeam = teamOf(bidder);
  const defenderTeam = (1 - bidderTeam) as Team;
  const payout = scoreContract(bid, captured[bidderTeam], captured[defenderTeam], state.settings.scoringMode);
  const awarded: [number, number] = [0, 0];
  awarded[bidderTeam] = payout.bidderAward;
  awarded[defenderTeam] = payout.defenderAward;
  const scores: [number, number] = [state.scores[0] + awarded[0], state.scores[1] + awarded[1]];
  const matchWinner = matchVictor(scores, state.settings.target);

  const result: HandResult = {
    passed: false,
    bid,
    bidder,
    trump: state.trump,
    made: payout.made,
    captured,
    awarded,
    matchWinner,
  };

  const outcome = payout.made
    ? `${actor(bidder, "makes", "make")} ${bidLabel(bid)}.`
    : `${actor(bidder, "is set", "are set")} on ${bidLabel(bid)}.`;
  const awardLine =
    state.settings.scoringMode === "marks"
      ? `Marks: your team ${awarded[0]}, opponents ${awarded[1]}.`
      : `Score: your team ${awarded[0]}, opponents ${awarded[1]}.`;

  return {
    ...state,
    phase: matchWinner == null ? "handComplete" : "matchComplete",
    currentTrick: [],
    completedTricks,
    handPoints: captured,
    scores,
    turn: null,
    lastResult: result,
    log: appendLog(state.log, `${outcome} ${awardLine}`),
  };
}

export function scoreContract(
  bid: number,
  bidderPoints: number,
  defenderPoints: number,
  mode: ScoringMode,
): { made: boolean; bidderAward: number; defenderAward: number } {
  const made = bid >= 42 ? bidderPoints === 42 : bidderPoints >= bid;
  if (mode === "marks") {
    const marks = bid >= 42 ? bid / 42 : 1;
    return made
      ? { made, bidderAward: marks, defenderAward: 0 }
      : { made, bidderAward: 0, defenderAward: marks };
  }
  if (bid >= 42) {
    return made
      ? { made, bidderAward: bid, defenderAward: 0 }
      : { made, bidderAward: 0, defenderAward: bid };
  }
  if (made) return { made, bidderAward: bidderPoints, defenderAward: defenderPoints };
  return { made, bidderAward: 0, defenderAward: defenderPoints + bid };
}

function matchVictor(scores: [number, number], target: number): Team | null {
  const a = scores[0] >= target;
  const b = scores[1] >= target;
  if (!a && !b) return null;
  if (a && !b) return 0;
  if (b && !a) return 1;
  if (scores[0] === scores[1]) return null;
  return scores[0] > scores[1] ? 0 : 1;
}

function dealHand(state: GameState): GameState {
  const deck = createDeck();
  let rng = state.rng;
  for (let i = deck.length - 1; i > 0; i--) {
    const roll = nextRng(rng);
    rng = roll.state;
    const j = Math.floor(roll.value * (i + 1));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  const hands: GameState["hands"] = [[], [], [], []];
  deck.forEach((d, i) => {
    hands[i % 4]!.push(d);
  });
  const bidLeader = nextSeat(state.shaker);
  const handNumber = state.handNumber + 1;
  return {
    ...state,
    rng,
    phase: "bidding",
    handNumber,
    hands,
    bids: [null, null, null, null],
    bidLeader,
    turn: bidLeader,
    highBid: null,
    highBidder: null,
    trump: null,
    currentTrick: [],
    completedTricks: [],
    handPoints: [0, 0],
    lastResult: null,
    log: appendLog(
      state.log,
      `Hand ${handNumber}. ${actor(state.shaker, "shook", "shook")}. ${actor(bidLeader, "bids", "bid")} first.`,
    ),
  };
}

export function trickPoints(plays: Play[]): number {
  return 1 + plays.reduce((sum, p) => sum + countValue(p.domino), 0);
}

export function bidLabel(amount: number): string {
  if (amount === 84) return "84 (2 marks)";
  if (amount === 126) return "126 (3 marks)";
  if (amount === 168) return "168 (4 marks)";
  return String(amount);
}

export function findDomino(hand: Domino[], key: string): Domino | undefined {
  return hand.find((d) => dominoKey(d) === key);
}

function isKnownTrump(trump: Trump): boolean {
  if (trump.kind === "doubles" || trump.kind === "followMe") return true;
  return trump.kind === "suit" && trump.suit >= 0 && trump.suit <= 6 && Number.isInteger(trump.suit);
}

function actor(seat: Seat, third: string, second: string): string {
  return seat === 0 ? `You ${second}` : `${seatName(seat)} ${third}`;
}

function appendLog(log: string[], line: string): string[] {
  const next = [...log, line];
  return next.length > 80 ? next.slice(next.length - 80) : next;
}

/** mulberry32 step. `state` is a uint32; `value` is in [0, 1). */
export function nextRng(state: number): { value: number; state: number } {
  let a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: a >>> 0 };
}

export function playedDominoes(state: GameState): Domino[] {
  const out: Domino[] = [];
  for (const trick of state.completedTricks) {
    for (const play of trick.plays) out.push(play.domino);
  }
  for (const play of state.currentTrick) out.push(play.domino);
  return out;
}

export function isPartner(viewer: Seat, other: Seat): boolean {
  return partnerOf(viewer) === other;
}

export { sameTrump };
