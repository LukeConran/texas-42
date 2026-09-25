import type { Seat } from "../engine/domino";
import { suitName, teamOf } from "../engine/domino";
import type { GameState } from "../engine/game";
import { bidLabel } from "../engine/game";
import { followsLead, ledCall, trumpName } from "../engine/trump";

export function contractLine(state: GameState): string {
  if (state.highBid == null || state.highBidder == null) return "No bid yet";
  const who = state.highBidder === 0 ? "You" : state.highBidder === 2 ? "Partner" : seatWord(state.highBidder);
  const trump = state.trump ? trumpName(state.trump) : "trump not named";
  return `${who} bid ${bidLabel(state.highBid)} · ${trump}`;
}

export function needLine(state: GameState): string {
  if (state.highBid == null || state.highBidder == null || state.phase === "bidding") return "";
  const bidderTeam = teamOf(state.highBidder);
  const need = Math.min(state.highBid, 42);
  const have = state.handPoints[bidderTeam];
  const defenders = state.handPoints[(1 - bidderTeam) as 0 | 1];
  if (have >= need) return "The bid is made. Finish the hand.";
  if (defenders > 42 - need) return "The bid is set. Finish the hand.";
  const who = bidderTeam === 0 ? "Your team needs" : "They need";
  return `${who} ${need - have} more.`;
}

export function turnLine(state: GameState): string {
  if (state.phase === "bidding") {
    if (state.turn === 0) return "Your bid. Pass, or name what your team can take.";
    return `${seatWord(state.turn!)} is bidding.`;
  }
  if (state.phase === "trump") {
    if (state.turn === 0) return "You won the bid. Name trump, then lead.";
    return `${seatWord(state.turn!)} is naming trump.`;
  }
  if (state.phase === "playing" || state.phase === "trickComplete") {
    if (state.phase === "trickComplete") {
      const last = state.log[state.log.length - 1] ?? "";
      return last;
    }
    if (state.turn === 0) return yourPlayLine(state);
    return `${seatWord(state.turn!)} to play.`;
  }
  if (state.phase === "handComplete" && state.lastResult?.passed) {
    return "Everyone passed. Shake again.";
  }
  if (state.phase === "matchComplete") return "Match over.";
  return "Hand complete.";
}

export function yourPlayLine(state: GameState): string {
  if (!state.trump) return "Your play.";
  const opening =
    state.settings.openingLeadMustBeTrump &&
    state.completedTricks.length === 0 &&
    state.currentTrick.length === 0 &&
    state.trump.kind !== "followMe";
  if (state.currentTrick.length === 0) {
    return opening ? "Your lead. The first tile must be a trump." : "Your lead. Play any tile.";
  }
  const lead = state.currentTrick[0]!.domino;
  const call = ledCall(lead, state.trump);
  const canFollow = state.hands[0].some((d) => followsLead(d, lead, state.trump!));
  if (!canFollow) return "You can't follow suit. Any tile is legal, and trump is optional.";
  if (call.isTrump) return "Trump was led. Play a trump.";
  return `Follow ${suitName(call.suit)}.`;
}

export function seatWord(seat: Seat): string {
  return ["You", "West", "Partner", "East"][seat] ?? "Player";
}

export function bidChip(amount: number | "pass" | null, pending: boolean): string {
  if (amount == null) return pending ? "bidding" : "—";
  if (amount === "pass") return "pass";
  return String(amount);
}

export const RULES_HTML = `
<h2>How a hand works</h2>
<p>Texas 42 is a trick-taking game for four players in two partnerships. You sit South. Partner sits across from you. West and East are the other team. A double-six set is shaken and dealt, seven tiles each. There is no boneyard.</p>
<p>There are 42 points in every hand: 1 for each of the seven tricks, plus the five count tiles. The 5-counts are 5-0, 4-1, and 3-2. The 10-counts are 6-4 and 5-5.</p>
<h2>Bidding</h2>
<p>The player to the left of the shaker bids first. Each player bids once. A bid is 30 through 42, and it must be higher than the bid before it. After 42, someone may bid 84 (two marks). Only after 84 can the table go to 126 or 168. If everyone passes, the tiles are shaken again and nobody scores.</p>
<p>The high bidder names trump before leading: blanks, aces, deuces, treys, fours, fives, sixes, doubles, or follow me (no trump). In the standard game the opening lead does not have to be a trump. There is a house rule in the menu if you want to require one.</p>
<h2>Trumps and following suit</h2>
<p>A tile that contains the trump number belongs only to trump. The other end is its rank, and the double is highest. If fours are trump, the 4-2 is a four, not a deuce. Led a deuce, you do not play the 4-2 just because it has a two.</p>
<p>On a trump lead, play a trump if you have one. On any other lead, the suit is the higher end, and you must play that suit if you can. If you cannot follow, you may play anything. Trump is allowed then, and it is not required. A trump beats the suit that was led. The highest trump wins if more than one is played. Otherwise the highest tile of the led suit wins, and a double is highest in its suit.</p>
<p>When doubles are trump, the seven doubles are trump, ranked from double-six down to double-blank. They do not follow the suit of their number. In follow me there is no trump at all.</p>
<h2>Scoring</h2>
<p>Points, to 250: if the bidding team takes at least its bid, both teams score the points they captured. If the bidding team is set, it scores nothing, and the other team scores the points it captured plus the bid. A bid of 42 or more is different. The bidder must take every point. The winner of that contract scores the bid itself, and the other team scores nothing.</p>
<p>Marks, to 7: the team that makes or sets the bid wins one mark, or one mark for every 42 in the bid.</p>
<p>The three other seats are played by a heuristic. It bids and follows suit, and it is the stand-in until a stronger policy, including one trained by reinforcement learning, takes the same decision interface.</p>
`;
