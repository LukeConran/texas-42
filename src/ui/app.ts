import { BOT_STYLES, chooseAction } from "../ai/heuristic";
import type { Domino, Seat } from "../engine/domino";
import { dominoKey, dominoLabel, seatName, teamOf } from "../engine/domino";
import {
  type GameState,
  type MatchSettings,
  type ScoringMode,
  apply,
  bidLabel,
  createMatch,
  defaultSettings,
  observe,
} from "../engine/game";
import { trumpKey, trumpName, type Trump } from "../engine/trump";
import { boneHtml, sortHand } from "./dominoView";
import { RULES_HTML, contractLine, needLine, seatWord, turnLine, yourPlayLine } from "./text";

const PACE_MS = {
  relaxed: { think: 900, trick: 1300, pass: 1400 },
  normal: { think: 560, trick: 900, pass: 1100 },
  fast: { think: 180, trick: 360, pass: 500 },
} as const;

type Pace = keyof typeof PACE_MS;

const HONORS: Domino[] = [
  { hi: 5, lo: 0 },
  { hi: 4, lo: 1 },
  { hi: 3, lo: 2 },
  { hi: 6, lo: 4 },
  { hi: 5, lo: 5 },
];

const TRUMP_BUTTONS: Array<{ trump: Trump; label: string; hint: string }> = [
  { trump: { kind: "suit", suit: 0 }, label: "Blanks", hint: "0s" },
  { trump: { kind: "suit", suit: 1 }, label: "Ones", hint: "1s" },
  { trump: { kind: "suit", suit: 2 }, label: "Twos", hint: "2s" },
  { trump: { kind: "suit", suit: 3 }, label: "Threes", hint: "3s" },
  { trump: { kind: "suit", suit: 4 }, label: "Fours", hint: "4s" },
  { trump: { kind: "suit", suit: 5 }, label: "Fives", hint: "5s" },
  { trump: { kind: "suit", suit: 6 }, label: "Sixes", hint: "6s" },
  { trump: { kind: "doubles" }, label: "Doubles", hint: "the seven doubles" },
  { trump: { kind: "followMe" }, label: "No Trump", hint: "follow me" },
];

export function mount(root: HTMLElement): void {
  let screen: "menu" | "table" = "menu";
  let scoringMode: ScoringMode = "marks";
  let openingLeadMustBeTrump = false;
  let showHands = false;
  let soundOn = false;
  let pace: Pace = "normal";
  let rulesOpen = false;
  let state: GameState | null = null;
  let selectedKey: string | null = null;
  let alertText = "";
  let timer = 0;
  let audio: AudioContext | null = null;

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
    if (!target || !root.contains(target)) return;
    const act = target.dataset.act;
    if (act === "start") startMatch();
    else if (act === "menu") {
      window.clearTimeout(timer);
      screen = "menu";
      rulesOpen = false;
      render();
    } else if (act === "mode") scoringMode = target.dataset.mode === "marks" ? "marks" : "points";
    else if (act === "house") openingLeadMustBeTrump = !openingLeadMustBeTrump;
    else if (act === "rules") rulesOpen = !rulesOpen;
    else if (act === "close-rules") rulesOpen = false;
    else if (act === "hands") showHands = !showHands;
    else if (act === "sound") soundOn = !soundOn;
    else if (act === "pace") pace = (target.dataset.pace as Pace) || "normal";
    else if (act === "bid") onBid(target.dataset.amount === "pass" ? "pass" : Number(target.dataset.amount));
    else if (act === "trump") onTrump(target.dataset.trump ?? "");
    else if (act === "select") onSelect(target.dataset.key ?? "");
    else if (act === "play") playSelected();
    else if (act === "next") {
      if (state?.phase === "handComplete") commit({ type: "nextHand" });
    } else if (act === "new-match") startMatch();
    render();
  });

  render();

  function startMatch(): void {
    const settings: MatchSettings = {
      ...defaultSettings(),
      scoringMode,
      target: scoringMode === "marks" ? 7 : 250,
      openingLeadMustBeTrump,
    };
    state = createMatch(settings);
    selectedKey = null;
    screen = "table";
    rulesOpen = false;
    blip(660, 0.03);
    render();
    queue();
  }

  function onBid(amount: number | "pass"): void {
    if (!state || state.phase !== "bidding" || state.turn !== 0) return;
    blip(amount === "pass" ? 320 : 540, 0.04);
    commit({ type: "bid", amount });
  }

  function onTrump(key: string): void {
    if (!state || state.phase !== "trump" || state.turn !== 0) return;
    blip(600, 0.04);
    commit({ type: "declareTrump", trump: parseButton(key) });
  }

  function onSelect(key: string): void {
    if (!state || state.phase !== "playing" || state.turn !== 0) return;
    const legal = new Set(observe(state, 0).legalPlays.map(dominoKey));
    if (!legal.has(key)) return;
    if (selectedKey === key) {
      playSelected();
      return;
    }
    selectedKey = key;
    blip(480, 0.025);
  }

  function playSelected(): void {
    if (!state || !selectedKey || state.phase !== "playing" || state.turn !== 0) return;
    const legal = new Set(observe(state, 0).legalPlays.map(dominoKey));
    if (!legal.has(selectedKey)) {
      selectedKey = null;
      alertText = "You have to follow suit.";
      return;
    }
    const domino = state.hands[0].find((d) => dominoKey(d) === selectedKey);
    if (!domino) return;
    selectedKey = null;
    blip(420, 0.04);
    commit({ type: "play", domino });
  }

  function commit(action: Parameters<typeof apply>[1]): void {
    if (!state) return;
    try {
      state = apply(state, action);
      alertText = "";
    } catch (error) {
      alertText = error instanceof Error ? error.message : "That play is not legal.";
    }
    selectedKey = null;
    render();
    queue();
  }

  function queue(): void {
    window.clearTimeout(timer);
    if (!state || screen !== "table") return;
    const delays = PACE_MS[pace];
    if (state.phase === "trickComplete") {
      timer = window.setTimeout(() => commit({ type: "acknowledgeTrick" }), delays.trick);
      return;
    }
    if (state.phase === "handComplete" && state.lastResult?.passed) {
      timer = window.setTimeout(() => commit({ type: "nextHand" }), delays.pass);
      return;
    }
    const seat = state.turn;
    if (
      seat != null &&
      seat !== 0 &&
      (state.phase === "bidding" || state.phase === "trump" || state.phase === "playing")
    ) {
      const thinking = state;
      timer = window.setTimeout(() => {
        if (state !== thinking || state.turn !== seat) return;
        const action = chooseAction(observe(state, seat), BOT_STYLES[seat]);
        if (action.type === "play") blip(360, 0.03);
        commit(action);
      }, delays.think);
    }
  }

  function render(): void {
    root.innerHTML = screen === "menu" || !state ? menuHtml() : tableHtml(state);
  }

  function menuHtml(): string {
    return `
      <div class="room menu-room">
        <header class="topbar">
          <p class="brand">Texas 42</p>
          <p class="brand-sub">Official state domino game</p>
        </header>
        <main class="menu-layout">
          <section class="menu-card">
            <h1>Sit down. Seven tiles. Forty-two points.</h1>
            <p class="lede">You play South, with a partner across the table. West and East bid and play against you. The tiles never form a chain. This is a trick-taking game, closer to pitch or spades than to draw dominoes.</p>
            <fieldset>
              <legend>Match</legend>
              <div class="choice-row">
                ${choice("mode", "marks", "Marks to 7", scoringMode === "marks")}
                ${choice("mode", "points", "Points to 250", scoringMode === "points")}
              </div>
            </fieldset>
            <button type="button" class="check ${openingLeadMustBeTrump ? "on" : ""}" data-act="house">
              <span class="box" aria-hidden="true"></span>
              Opening lead must be a trump
            </button>
            <p class="fine">Leave that off for the usual game. The high bidder names trump, then may lead anything. Turn it on for the older house rule that the first tile has to be trump.</p>
            <div class="menu-actions">
              <button type="button" class="primary" data-act="start">Deal the first hand</button>
              <button type="button" class="ghost" data-act="rules">${rulesOpen ? "Hide the rules" : "How to play"}</button>
            </div>
          </section>
          ${rulesOpen ? `<section class="rules-card">${RULES_HTML}</section>` : ""}
        </main>
      </div>`;
  }

  function tableHtml(game: GameState): string {
    const us = game.scores[0];
    const them = game.scores[1];
    const unit = game.settings.scoringMode === "marks" ? "marks" : "points";
    const target = game.settings.target;
    return `
      <div class="room">
        <header class="topbar">
          <div class="brand-block">
            <p class="brand">Texas 42</p>
            <p class="brand-sub">Hand ${game.handNumber} · first to ${target} ${unit}</p>
          </div>
          <div class="scoreline" aria-label="Match score">
            <span class="us"><small>You &amp; Partner</small><strong>${us}</strong></span>
            <span class="divider" aria-hidden="true"></span>
            <span class="them"><small>West &amp; East</small><strong>${them}</strong></span>
          </div>
          <div class="tools">
            ${paceButtons()}
            <button type="button" class="tool ${showHands ? "on" : ""}" data-act="hands">${showHands ? "Hide hands" : "Show hands"}</button>
            <button type="button" class="tool ${soundOn ? "on" : ""}" data-act="sound">${soundOn ? "Sound on" : "Sound off"}</button>
            <button type="button" class="tool" data-act="rules">Rules</button>
            <button type="button" class="tool" data-act="menu">Leave</button>
          </div>
        </header>
        <div class="play">
          <section class="table-column">
            <div class="rail">
              <div class="felt">
                ${seatBlock(game, 2, "north")}
                <div class="middle">
                  ${seatBlock(game, 1, "west")}
                  <div class="trick-wrap">
                    <p class="status" aria-live="polite">${escapeHtml(turnLine(game))}</p>
                    <div class="trick">${trickSlots(game)}</div>
                    <p class="contract">${escapeHtml(handBanner(game))}</p>
                    <p class="count-out">${escapeHtml(countOutLine(game))}</p>
                  </div>
                  ${seatBlock(game, 3, "east")}
                </div>
                <div class="south-plate ${game.turn === 0 ? "active" : ""}">
                  <span>You</span>
                  ${game.phase === "bidding" && game.shaker === 0 ? "<em>shook</em>" : ""}
                </div>
              </div>
            </div>
            <div class="dock">
              ${dockHtml(game)}
            </div>
            ${yourBidRow(game)}
            <div class="your-hand" aria-label="Your hand">
              ${yourHandHtml(game)}
            </div>
          </section>
          <aside class="side">
            ${trickBoardHtml(game)}
          </aside>
        </div>
        ${trumpBadgeHtml(game)}
        ${overlayHtml(game)}
        ${rulesOpen ? `<div class="rules-pop" role="dialog" aria-label="Rules"><button type="button" class="tool close-rules" data-act="close-rules">Close</button>${RULES_HTML}</div>` : ""}
      </div>`;
  }

  function paceButtons(): string {
    const labels: Record<Pace, string> = { relaxed: "Slow", normal: "Normal", fast: "Fast" };
    return (Object.keys(PACE_MS) as Pace[])
      .map(
        (name) =>
          `<button type="button" class="tool ${pace === name ? "on" : ""}" data-act="pace" data-pace="${name}">${labels[name]}</button>`,
      )
      .join("");
  }

  function seatBlock(game: GameState, seat: Seat, place: string): string {
    const hand = sortHand(game.hands[seat], game.trump);
    const active = game.turn === seat && (game.phase === "bidding" || game.phase === "trump" || game.phase === "playing");
    const tiles = hand
      .map((d) =>
        boneHtml(d, {
          size: "sm",
          faceDown: !showHands,
          trump: showHands ? game.trump : null,
        }),
      )
      .join("");
    return `
      <div class="seat seat-${place} ${active ? "active" : ""} ${showHands ? "open" : ""} ${teamOf(seat) === 0 ? "team-us" : "team-them"}">
        <div class="seat-stack">
          <div class="seat-tiles">${tiles}</div>
          ${bidChip(game, seat)}
        </div>
        <div class="nameplate">
          <strong>${seatWord(seat)}</strong>
          ${game.phase === "bidding" && game.shaker === seat ? "<em>shook</em>" : ""}
          ${game.shaker === seat ? `<span class="shaker">shaker</span>` : ""}
        </div>
      </div>`;
  }

  function trickSlots(game: GameState): string {
    const slots: Seat[] = [0, 1, 2, 3];
    return slots
      .map((seat) => {
        const index = game.currentTrick.findIndex((p) => p.player === seat);
        const play = index >= 0 ? game.currentTrick[index] : undefined;
        const place = ["s", "w", "n", "e"][seat];
        const took = game.phase === "trickComplete" && game.turn === seat ? "took" : "";
        const inner = play
          ? boneHtml(play.domino, {
              size: "md",
              trump: game.trump,
              justPlayed: index === game.currentTrick.length - 1,
            })
          : "";
        return `<div class="slot slot-${place} ${took}">${inner}</div>`;
      })
      .join("");
  }

  function yourHandHtml(game: GameState): string {
    const legal = legalKeys(game);
    const yourTurn = game.phase === "playing" && game.turn === 0;
    return sortHand(game.hands[0], game.trump)
      .map((d) => {
        const key = dominoKey(d);
        const playable = !yourTurn || legal.has(key);
        return boneHtml(d, {
          size: "lg",
          trump: game.trump,
          interactive: playable && yourTurn,
          selected: selectedKey === key && playable,
          locked: yourTurn && !legal.has(key),
        });
      })
      .join("");
  }

  function dockHtml(game: GameState): string {
    if (game.phase === "bidding" && game.turn === 0) {
      const amounts = observe(game, 0).legalBids;
      const buttons = amounts
        .map((amount) => {
          const label = amount === "pass" ? "Pass" : amount >= 84 ? bidLabel(amount) : String(amount);
          const cls = amount === "pass" ? "bid pass" : "bid";
          return `<button type="button" class="${cls}" data-act="bid" data-amount="${amount}">${label}</button>`;
        })
        .join("");
      return `<div class="bids" aria-label="Your bid">${buttons}</div>`;
    }
    if (game.phase === "trump" && game.turn === 0) {
      const buttons = TRUMP_BUTTONS.map(
        (item) =>
          `<button type="button" class="trump" data-act="trump" data-trump="${trumpKey(item.trump)}"><strong>${item.label}</strong><small>${item.hint}</small></button>`,
      ).join("");
      return `<div class="trumps" aria-label="Name trump">${buttons}</div>`;
    }
    if (game.phase === "playing" && game.turn === 0 && selectedKey && legalKeys(game).has(selectedKey)) {
      return `<div class="play-row"><p class="dock-note">${escapeHtml(yourPlayLine(game))}</p><button type="button" class="primary play-go" data-act="play">Play ${selectedKey}</button></div>`;
    }
    if (game.phase === "playing" && game.turn === 0) {
      return `<p class="dock-note">${escapeHtml(alertText || yourPlayLine(game))}</p>`;
    }
    return `<p class="dock-note">${escapeHtml(alertText || waitingNote(game))}</p>`;
  }

  function legalKeys(game: GameState): Set<string> {
    if (game.phase !== "playing" || game.turn !== 0 || !game.trump) return new Set();
    return new Set(observe(game, 0).legalPlays.map(dominoKey));
  }

  function trickBoardHtml(game: GameState): string {
    const ours = game.completedTricks.filter((trick) => teamOf(trick.winner) === 0);
    const theirs = game.completedTricks.filter((trick) => teamOf(trick.winner) === 1);
    return `
      <div class="trick-board">
        <section class="won theirs">
          <header>
            <h2>West &amp; East</h2>
            <span>${game.handPoints[1]}</span>
          </header>
          ${trickStack(game, theirs)}
        </section>
        <div class="stack-gap" aria-hidden="true"></div>
        <section class="won ours">
          <header>
            <h2>You &amp; Partner</h2>
            <span>${game.handPoints[0]}</span>
          </header>
          ${trickStack(game, ours)}
        </section>
      </div>`;
  }

  function trickStack(game: GameState, tricks: GameState["completedTricks"]): string {
    if (tricks.length === 0) return `<p class="empty-tricks">No tricks yet</p>`;
    return `<div class="trick-list">${tricks
      .map((trick) => {
        const tiles = trick.plays
          .map((play) =>
            boneHtml(play.domino, {
              size: "xs",
              trump: game.trump,
              marked: play.player === trick.winner,
            }),
          )
          .join("");
        return `<div class="past-trick">${tiles}<span class="pts">+${trick.points}</span></div>`;
      })
      .join("")}</div>`;
  }

  function trumpBadgeHtml(game: GameState): string {
    if (!game.trump) {
      return `<aside class="trump-badge waiting" aria-label="Trump"><p class="trump-kicker">Trump</p><strong>Not named</strong></aside>`;
    }
    const label = game.trump.kind === "followMe" ? "No Trump" : trumpName(game.trump);
    const icon =
      game.trump.kind === "doubles"
        ? `<div class="doubles-grid">${[6, 5, 4, 3].map((n) => boneHtml({ hi: n, lo: n }, { size: "xs", trump: game.trump })).join("")}</div>`
        : game.trump.kind === "suit"
          ? boneHtml({ hi: game.trump.suit, lo: game.trump.suit }, { size: "sm", trump: game.trump })
          : "";
    return `<aside class="trump-badge" aria-live="polite" aria-label="Trump is ${label}"><p class="trump-kicker">Trump</p><strong>${escapeHtml(label)}</strong>${icon}</aside>`;
  }

  function overlayHtml(game: GameState): string {
    const result = game.lastResult;
    if (!result || result.passed) return "";
    if (game.phase !== "handComplete" && game.phase !== "matchComplete") return "";
    const bidder = result.bidder == null ? "" : seatName(result.bidder);
    const trump = result.trump ? trumpName(result.trump) : "";
    const made = result.made ? "Made." : "Set.";
    const usAward = result.awarded[0];
    const themAward = result.awarded[1];
    const unit = game.settings.scoringMode === "marks" ? "marks" : "points";
    const winner =
      result.matchWinner == null
        ? ""
        : result.matchWinner === 0
          ? "Your team wins the match."
          : "West and East win the match.";
    const next =
      game.phase === "matchComplete"
        ? `<button type="button" class="primary" data-act="new-match">New match</button>`
        : `<button type="button" class="primary" data-act="next">Next hand</button>`;
    return `
      <div class="overlay" role="dialog" aria-label="Hand result">
        <div class="result-card">
          <p class="result-kicker">${escapeHtml(bidder)} · ${escapeHtml(String(result.bid))} · ${escapeHtml(trump)}</p>
          <h2>${made}</h2>
          <p>Captured this hand: your team ${result.captured[0]}, opponents ${result.captured[1]}.</p>
          <p>Awarded: your team ${usAward} ${unit}, opponents ${themAward} ${unit}.</p>
          <p class="result-score">Us ${game.scores[0]} · Them ${game.scores[1]}</p>
          ${winner ? `<p class="winner">${winner}</p>` : ""}
          ${next}
        </div>
      </div>`;
  }


  function blip(freq: number, gain: number): void {
    if (!soundOn) return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!audio) audio = new AudioCtx();
    if (audio.state === "suspended") void audio.resume();
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    amp.gain.value = gain;
    osc.connect(amp);
    amp.connect(audio.destination);
    osc.start();
    amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.09);
    osc.stop(audio.currentTime + 0.1);
  }
}

function choice(act: string, mode: string, label: string, on: boolean): string {
  return `<button type="button" class="choice ${on ? "on" : ""}" data-act="${act}" data-mode="${mode}" aria-pressed="${on}">${label}</button>`;
}

function bidChip(game: GameState, seat: Seat): string {
  const bid = game.bids[seat];
  if (!bid) return "";
  if (bid.kind === "pass") return `<p class="bid-chip pass">Pass</p>`;
  return `<p class="bid-chip">${bid.amount}</p>`;
}

function yourBidRow(game: GameState): string {
  const chip = bidChip(game, 0);
  return chip ? `<div class="your-bid">${chip}</div>` : "";
}

function countOutLine(game: GameState): string {
  if (game.phase === "bidding" || game.phase === "trump") return "";
  const seen = new Set<string>();
  for (const trick of game.completedTricks) {
    for (const play of trick.plays) seen.add(dominoKey(play.domino));
  }
  for (const play of game.currentTrick) seen.add(dominoKey(play.domino));
  const left = HONORS.filter((d) => !seen.has(dominoKey(d)));
  if (left.length === 0) return "All count tiles have been played.";
  return `Count still out: ${left.map((d) => dominoLabel(d)).join(", ")}`;
}

function handBanner(game: GameState): string {
  if (game.phase === "bidding") {
    const high = game.highBid == null ? "no bid yet" : `high bid ${game.highBid}`;
    return `${seatWord(game.shaker)} shook · ${high}`;
  }
  const need = needLine(game);
  return [contractLine(game), need].filter(Boolean).join(" · ");
}

function waitingNote(game: GameState): string {
  if (game.phase === "trickComplete") return "Gathering the trick.";
  if (game.phase === "handComplete" && game.lastResult?.passed) return "No one bid. Shaking again.";
  if (game.turn != null && game.turn !== 0) return `${seatWord(game.turn)} is deciding.`;
  return "Watch the table.";
}

function parseButton(key: string): Trump {
  if (key === "doubles") return { kind: "doubles" };
  if (key === "followMe") return { kind: "followMe" };
  const suit = Number(key.slice("suit:".length));
  return { kind: "suit", suit };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
