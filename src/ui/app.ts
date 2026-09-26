import { BOT_STYLES, chooseAction } from "../ai/heuristic";
import type { Domino, Seat } from "../engine/domino";
import { dominoKey, dominoLabel, seatPlace, teamOf } from "../engine/domino";
import {
  type GameState,
  type MatchSettings,
  type PlayerView,
  type ScoringMode,
  apply,
  bidLabel,
  createMatch,
  defaultSettings,
  observe,
} from "../engine/game";
import type { NetMessage } from "../net/messages";
import { openGuest, openHost, type GuestLink, type HostLink } from "../net/session";
import { trumpKey, trumpName, type Trump } from "../engine/trump";
import { boneHtml, sortHand } from "./dominoView";
import { type Names, RULES_HTML, contractLine, needLine, seatWord, turnLine, yourPlayLine } from "./text";

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
  let screen: "menu" | "lobby" | "table" = "menu";
  let role: "local" | "host" | "guest" = "local";
  let me: Seat = 0;
  let names: Names = [null, null, null, null];
  let humans = new Set<Seat>();
  let hostLink: HostLink | null = null;
  let guestLink: GuestLink | null = null;
  let roomCode = "";
  let playerName = "";
  let joinCode = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
  let menuNote = "";
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

  root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    if (target.dataset.field === "name") playerName = target.value;
    if (target.dataset.field === "code") joinCode = target.value.toUpperCase();
  });

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
    if (!target || !root.contains(target)) return;
    const act = target.dataset.act;
    if (act === "start") startMatch();
    else if (act === "host") void startHost();
    else if (act === "join") void startJoin();
    else if (act === "deal-online") startOnlineMatch();
    else if (act === "copy") void copyLink();
    else if (act === "menu") leaveTable();
    else if (act === "mode") scoringMode = target.dataset.mode === "marks" ? "marks" : "points";
    else if (act === "house") openingLeadMustBeTrump = !openingLeadMustBeTrump;
    else if (act === "rules") rulesOpen = !rulesOpen;
    else if (act === "close-rules") rulesOpen = false;
    else if (act === "hands" && role === "local") showHands = !showHands;
    else if (act === "sound") soundOn = !soundOn;
    else if (act === "pace") pace = (target.dataset.pace as Pace) || "normal";
    else if (act === "bid") onBid(target.dataset.amount === "pass" ? "pass" : Number(target.dataset.amount));
    else if (act === "trump") onTrump(target.dataset.trump ?? "");
    else if (act === "select") onSelect(target.dataset.key ?? "");
    else if (act === "play") playSelected();
    else if (act === "next") {
      if (state?.phase === "handComplete") commit({ type: "nextHand" });
    } else if (act === "new-match") {
      if (role === "guest") guestLink?.send({ type: "rematch" });
      else if (role === "host") startOnlineMatch();
      else startMatch();
    }
    render();
  });

  render();

  function startMatch(): void {
    stopNet();
    role = "local";
    me = 0;
    names = [null, null, null, null];
    humans = new Set();
    showHands = false;
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
    if (!state || state.phase !== "bidding" || state.turn !== me) return;
    blip(amount === "pass" ? 320 : 540, 0.04);
    commit({ type: "bid", amount });
  }

  function onTrump(key: string): void {
    if (!state || state.phase !== "trump" || state.turn !== me) return;
    blip(600, 0.04);
    commit({ type: "declareTrump", trump: parseButton(key) });
  }

  function onSelect(key: string): void {
    if (!state || state.phase !== "playing" || state.turn !== me) return;
    const legal = new Set(observe(state, me).legalPlays.map(dominoKey));
    if (!legal.has(key)) return;
    if (selectedKey === key) {
      playSelected();
      return;
    }
    selectedKey = key;
    blip(480, 0.025);
  }

  function playSelected(): void {
    if (!state || !selectedKey || state.phase !== "playing" || state.turn !== me) return;
    const legal = new Set(observe(state, me).legalPlays.map(dominoKey));
    if (!legal.has(selectedKey)) {
      selectedKey = null;
      alertText = "You have to follow suit.";
      return;
    }
    const domino = state.hands[me].find((d) => dominoKey(d) === selectedKey);
    if (!domino) return;
    selectedKey = null;
    blip(420, 0.04);
    commit({ type: "play", domino });
  }

  function commit(action: Parameters<typeof apply>[1]): void {
    if (role === "guest") {
      guestLink?.send({ type: "action", action });
      selectedKey = null;
      alertText = "";
      return;
    }
    if (!state) return;
    try {
      state = apply(state, action);
      alertText = "";
    } catch (error) {
      alertText = error instanceof Error ? error.message : "That play is not legal.";
    }
    selectedKey = null;
    if (role === "host") broadcast();
    render();
    queue();
  }

  function queue(): void {
    window.clearTimeout(timer);
    if (!state || screen !== "table" || role === "guest") return;
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
      seat !== me &&
      !humans.has(seat) &&
      (state.phase === "bidding" || state.phase === "trump" || state.phase === "playing")
    ) {
      const thinking = state;
      timer = window.setTimeout(() => {
        if (state !== thinking || state.turn !== seat) return;
        const action = chooseAction(observe(state, seat), BOT_STYLES[seat === 0 ? 1 : seat]);
        if (action.type === "play") blip(360, 0.03);
        commit(action);
      }, delays.think);
    }
  }

  function stopNet(): void {
    window.clearTimeout(timer);
    const host = hostLink;
    const guest = guestLink;
    hostLink = null;
    guestLink = null;
    host?.close();
    guest?.close();
  }

  function leaveTable(): void {
    role = "local";
    stopNet();
    me = 0;
    names = [null, null, null, null];
    humans = new Set();
    state = null;
    screen = "menu";
    roomCode = "";
    menuNote = "";
    showHands = false;
    selectedKey = null;
    alertText = "";
    rulesOpen = false;
  }

  function broadcast(): void {
    if (role !== "host" || !state || !hostLink) return;
    for (const seat of [1, 2, 3] as Seat[]) {
      if (!humans.has(seat)) continue;
      const view = observe(state, seat);
      hostLink.send(seat, {
        type: "sync",
        view: { ...view, settings: { ...view.settings, seed: 0 } },
        names: [...names],
        note: "",
      });
    }
  }

  let connecting = false;

  async function startHost(): Promise<void> {
    if (connecting) return;
    connecting = true;
    role = "local";
    stopNet();
    me = 0;
    showHands = false;
    menuNote = "Opening a room…";
    screen = "menu";
    render();
    try {
      names = [cleanName(playerName) || null, null, null, null];
      humans = new Set<Seat>([0]);
      hostLink = await openHost(onGuestMessage, onGuestClose);
      role = "host";
      roomCode = hostLink.code;
      state = null;
      screen = "lobby";
      menuNote = "";
    } catch (error) {
      stopNet();
      role = "local";
      screen = "menu";
      menuNote = error instanceof Error ? error.message : "Could not open a room.";
    } finally {
      connecting = false;
      render();
    }
  }

  function onGuestMessage(seat: Seat, message: NetMessage): void {
    if (role !== "host" || !hostLink) return;
    if (message.type === "hello") {
      const next = [...names] as Names;
      next[seat] = cleanName(message.name) || null;
      names = next;
      humans.add(seat);
      if (state) broadcast();
      render();
      return;
    }
    if (message.type === "rematch") {
      if (state?.phase === "matchComplete") startOnlineMatch();
      return;
    }
    if (message.type !== "action" || !state || state.turn !== seat) return;
    const action = message.action;
    if (action.type !== "bid" && action.type !== "declareTrump" && action.type !== "play") return;
    commit(action);
  }

  function onGuestClose(seat: Seat): void {
    if (role !== "host") return;
    humans.delete(seat);
    const next = [...names] as Names;
    next[seat] = null;
    names = next;
    if (state) {
      broadcast();
      queue();
    }
    render();
  }

  async function startJoin(): Promise<void> {
    if (connecting) return;
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      menuNote = "Enter the four-letter room code.";
      render();
      return;
    }
    connecting = true;
    stopNet();
    showHands = false;
    menuNote = "Joining the room…";
    screen = "menu";
    render();
    try {
      role = "guest";
      me = 0;
      guestLink = await openGuest(code, cleanName(playerName), onHostMessage, onHostClosed);
      roomCode = code;
      if (!state) {
        screen = "lobby";
        menuNote = "Connected. Waiting for the host to deal.";
      }
    } catch (error) {
      stopNet();
      role = "local";
      screen = "menu";
      menuNote = error instanceof Error ? error.message : "Could not join that room.";
    } finally {
      connecting = false;
      render();
    }
  }

  function onHostMessage(message: NetMessage): void {
    if (role !== "guest" || message.type !== "sync") return;
    me = message.view.seat;
    names = [message.names[0] ?? null, message.names[1] ?? null, message.names[2] ?? null, message.names[3] ?? null];
    state = stateFromView(message.view);
    screen = "table";
    alertText = "";
    selectedKey = null;
    render();
  }

  function onHostClosed(): void {
    if (role !== "guest") return;
    guestLink = null;
    role = "local";
    me = 0;
    state = null;
    screen = "menu";
    showHands = false;
    menuNote = "The host closed the room.";
    render();
  }

  function startOnlineMatch(): void {
    if (role !== "host") return;
    const settings: MatchSettings = {
      ...defaultSettings(),
      scoringMode,
      target: scoringMode === "marks" ? 7 : 250,
      openingLeadMustBeTrump,
    };
    state = createMatch(settings);
    selectedKey = null;
    alertText = "";
    showHands = false;
    screen = "table";
    rulesOpen = false;
    blip(660, 0.03);
    broadcast();
    render();
    queue();
  }

  function seatAt(place: "s" | "w" | "n" | "e"): Seat {
    const steps = { s: 0, w: 1, n: 2, e: 3 }[place];
    return ((me + steps) % 4) as Seat;
  }

  function opponentsLabel(): string {
    return `${seatWord(seatAt("w"), me, names)} & ${seatWord(seatAt("e"), me, names)}`;
  }

  function roomLink(): string {
    const url = new URL(location.href);
    url.searchParams.set("room", roomCode);
    return url.toString();
  }

  async function copyLink(): Promise<void> {
    const link = roomLink();
    try {
      await navigator.clipboard.writeText(link);
      menuNote = "Link copied.";
    } catch {
      menuNote = link;
    }
    render();
  }

  function render(): void {
    if (screen === "table" && state) root.innerHTML = tableHtml(state);
    else if (screen === "lobby") root.innerHTML = lobbyHtml();
    else root.innerHTML = menuHtml();
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
            <fieldset>
              <legend>With friends</legend>
              <label class="field">Your name
                <input data-field="name" maxlength="16" value="${escapeHtml(playerName)}" autocomplete="nickname" />
              </label>
              <div class="menu-actions">
                <button type="button" class="primary" data-act="host">Host a room</button>
              </div>
              <label class="field">Room code
                <input data-field="code" maxlength="4" value="${escapeHtml(joinCode)}" autocapitalize="characters" spellcheck="false" />
              </label>
              <div class="menu-actions">
                <button type="button" class="ghost" data-act="join">Join with code</button>
              </div>
              ${menuNote ? `<p class="fine">${escapeHtml(menuNote)}</p>` : ""}
            </fieldset>
          </section>
          ${rulesOpen ? `<section class="rules-card">${RULES_HTML}</section>` : ""}
        </main>
      </div>`;
  }

  function lobbyHtml(): string {
    const seats = ([0, 1, 2, 3] as Seat[])
      .map((seat) => {
        const label = seat === 0 ? "South (host)" : seatWord(seat, 0, names);
        if (seat === 0) return `${names[0] ? `${names[0]} · ` : ""}${label}`;
        if (humans.has(seat)) return `${seatWord(seat, 0, names)} · joined`;
        return `${label} · bot, until someone joins`;
      })
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join("");
    const hostControls =
      role === "host"
        ? `<p class="room-code">${escapeHtml(roomCode)}</p>
           <p class="fine">Share the code or this link. The first friend sits on your left, the second sits across as your partner, and the third sits on your right. Empty seats are bots. Keep this tab open for the whole match.</p>
           <p class="fine">${escapeHtml(roomLink())}</p>
           <div class="menu-actions">
             <button type="button" class="primary" data-act="deal-online">Fill empty seats and deal</button>
             <button type="button" class="ghost" data-act="copy">Copy link</button>
           </div>
           ${menuNote ? `<p class="fine">${escapeHtml(menuNote)}</p>` : ""}
           <ul class="lobby-seats">${seats}</ul>`
        : `<p class="lede">${escapeHtml(menuNote || "Waiting for the host to deal.")}</p>
           <p class="room-code">${escapeHtml(roomCode)}</p>`;
    return `
      <div class="room menu-room">
        <header class="topbar">
          <p class="brand">Texas 42</p>
          <p class="brand-sub">Room ${escapeHtml(roomCode)}</p>
        </header>
        <main class="menu-layout">
          <section class="menu-card">
            <h1>${role === "host" ? "Your table is open." : "You are in the room."}</h1>
            ${hostControls}
            <div class="menu-actions">
              <button type="button" class="ghost" data-act="menu">Leave</button>
            </div>
          </section>
        </main>
      </div>`;
  }

  function tableHtml(game: GameState): string {
    const mine = teamOf(me);
    const us = game.scores[mine];
    const them = game.scores[mine === 0 ? 1 : 0];
    const unit = game.settings.scoringMode === "marks" ? "marks" : "points";
    const target = game.settings.target;
    const handsButton =
      role === "local"
        ? `<button type="button" class="tool ${showHands ? "on" : ""}" data-act="hands">${showHands ? "Hide hands" : "Show hands"}</button>`
        : "";
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
            <span class="them"><small>${escapeHtml(opponentsLabel())}</small><strong>${them}</strong></span>
          </div>
          <div class="tools">
            ${role === "guest" ? "" : paceButtons()}
            ${handsButton}
            <button type="button" class="tool ${soundOn ? "on" : ""}" data-act="sound">${soundOn ? "Sound on" : "Sound off"}</button>
            <button type="button" class="tool" data-act="rules">Rules</button>
            <button type="button" class="tool" data-act="menu">Leave</button>
          </div>
        </header>
        <div class="play">
          <section class="table-column">
            <div class="rail">
              <div class="felt">
                ${seatBlock(game, seatAt("n"), "north")}
                <div class="middle">
                  ${seatBlock(game, seatAt("w"), "west")}
                  <div class="trick-wrap">
                    <p class="status" aria-live="polite">${escapeHtml(turnLine(game, me, names))}</p>
                    <div class="trick">${trickSlots(game)}</div>
                    <p class="contract">${escapeHtml(handBanner(game, me, names))}</p>
                    <p class="count-out">${escapeHtml(countOutLine(game))}</p>
                  </div>
                  ${seatBlock(game, seatAt("e"), "east")}
                </div>
                <div class="south-plate ${game.turn === me ? "active" : ""}">
                  <span>You</span>
                  ${game.phase === "bidding" && game.shaker === me ? "<em>shook</em>" : ""}
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
    const reveal = role === "local" && showHands;
    const hand = sortHand(game.hands[seat], game.trump);
    const active = game.turn === seat && (game.phase === "bidding" || game.phase === "trump" || game.phase === "playing");
    const tiles = hand
      .map((d) =>
        boneHtml(d, {
          size: "sm",
          faceDown: !reveal,
          trump: reveal ? game.trump : null,
        }),
      )
      .join("");
    return `
      <div class="seat seat-${place} ${active ? "active" : ""} ${reveal ? "open" : ""} ${teamOf(seat) === teamOf(me) ? "team-us" : "team-them"}">
        <div class="seat-stack">
          <div class="seat-tiles">${tiles}</div>
          ${bidChip(game, seat)}
        </div>
        <div class="nameplate">
          <strong>${escapeHtml(seatWord(seat, me, names))}</strong>
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
        const place = seatPlace(me, seat);
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
    const yourTurn = game.phase === "playing" && game.turn === me;
    return sortHand(game.hands[me], game.trump)
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
    if (game.phase === "bidding" && game.turn === me) {
      const amounts = observe(game, me).legalBids;
      const buttons = amounts
        .map((amount) => {
          const label = amount === "pass" ? "Pass" : amount >= 84 ? bidLabel(amount) : String(amount);
          const cls = amount === "pass" ? "bid pass" : "bid";
          return `<button type="button" class="${cls}" data-act="bid" data-amount="${amount}">${label}</button>`;
        })
        .join("");
      return `<div class="bids" aria-label="Your bid">${buttons}</div>`;
    }
    if (game.phase === "trump" && game.turn === me) {
      const buttons = TRUMP_BUTTONS.map(
        (item) =>
          `<button type="button" class="trump" data-act="trump" data-trump="${trumpKey(item.trump)}"><strong>${item.label}</strong><small>${item.hint}</small></button>`,
      ).join("");
      return `<div class="trumps" aria-label="Name trump">${buttons}</div>`;
    }
    if (game.phase === "playing" && game.turn === me && selectedKey && legalKeys(game).has(selectedKey)) {
      return `<div class="play-row"><p class="dock-note">${escapeHtml(yourPlayLine(game, me))}</p><button type="button" class="primary play-go" data-act="play">Play ${selectedKey}</button></div>`;
    }
    if (game.phase === "playing" && game.turn === me) {
      return `<p class="dock-note">${escapeHtml(alertText || yourPlayLine(game, me))}</p>`;
    }
    return `<p class="dock-note">${escapeHtml(alertText || waitingNote(game, me, names))}</p>`;
  }

  function legalKeys(game: GameState): Set<string> {
    if (game.phase !== "playing" || game.turn !== me || !game.trump) return new Set();
    return new Set(observe(game, me).legalPlays.map(dominoKey));
  }

  function trickBoardHtml(game: GameState): string {
    const mine = teamOf(me);
    const ours = game.completedTricks.filter((trick) => teamOf(trick.winner) === mine);
    const theirs = game.completedTricks.filter((trick) => teamOf(trick.winner) !== mine);
    return `
      <div class="trick-board">
        <section class="won theirs">
          <header>
            <h2>${escapeHtml(opponentsLabel())}</h2>
            <span>${game.handPoints[mine === 0 ? 1 : 0]}</span>
          </header>
          ${trickStack(game, theirs)}
        </section>
        <div class="stack-gap" aria-hidden="true"></div>
        <section class="won ours">
          <header>
            <h2>You &amp; Partner</h2>
            <span>${game.handPoints[mine]}</span>
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
    const bidder = result.bidder == null ? "" : seatWord(result.bidder, me, names);
    const trump = result.trump ? trumpName(result.trump) : "";
    const made = result.made ? "Made." : "Set.";
    const mine = teamOf(me);
    const usAward = result.awarded[mine];
    const themAward = result.awarded[mine === 0 ? 1 : 0];
    const unit = game.settings.scoringMode === "marks" ? "marks" : "points";
    const winner =
      result.matchWinner == null
        ? ""
        : result.matchWinner === mine
          ? "Your team wins the match."
          : `${opponentsLabel()} win the match.`;
    const next =
      game.phase === "matchComplete"
        ? `<button type="button" class="primary" data-act="new-match">New match</button>`
        : `<button type="button" class="primary" data-act="next">Next hand</button>`;
    return `
      <div class="overlay" role="dialog" aria-label="Hand result">
        <div class="result-card">
          <p class="result-kicker">${escapeHtml(bidder)} · ${escapeHtml(String(result.bid))} · ${escapeHtml(trump)}</p>
          <h2>${made}</h2>
          <p>Captured this hand: your team ${result.captured[mine]}, opponents ${result.captured[mine === 0 ? 1 : 0]}.</p>
          <p>Awarded: your team ${usAward} ${unit}, opponents ${themAward} ${unit}.</p>
          <p class="result-score">Us ${game.scores[mine]} · Them ${game.scores[mine === 0 ? 1 : 0]}</p>
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
  if (game.phase !== "bidding" && game.phase !== "trump") return "";
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

function handBanner(game: GameState, viewer: Seat, names: Names): string {
  if (game.phase === "bidding") {
    const high = game.highBid == null ? "no bid yet" : `high bid ${game.highBid}`;
    return `${seatWord(game.shaker, viewer, names)} shook · ${high}`;
  }
  const need = needLine(game, viewer);
  return [contractLine(game, viewer, names), need].filter(Boolean).join(" · ");
}

function waitingNote(game: GameState, viewer: Seat, names: Names): string {
  if (game.phase === "trickComplete") return "Gathering the trick.";
  if (game.phase === "handComplete" && game.lastResult?.passed) return "No one bid. Shaking again.";
  if (game.turn != null && game.turn !== viewer) return `${seatWord(game.turn, viewer, names)} is deciding.`;
  return "Watch the table.";
}

function stateFromView(view: PlayerView): GameState {
  const hands: GameState["hands"] = [
    faceDownStack(view.handCounts[0]),
    faceDownStack(view.handCounts[1]),
    faceDownStack(view.handCounts[2]),
    faceDownStack(view.handCounts[3]),
  ];
  hands[view.seat] = view.hand.map((domino) => ({ ...domino }));
  return {
    settings: { ...view.settings, seed: 0 },
    rng: 1,
    phase: view.phase,
    shaker: view.shaker,
    handNumber: view.handNumber,
    hands,
    bids: view.bids.map((bid) => (bid ? { ...bid } : null)) as GameState["bids"],
    bidLeader: view.bidLeader,
    turn: view.turn,
    highBid: view.highBid,
    highBidder: view.highBidder,
    trump: view.trump ? { ...view.trump } : null,
    currentTrick: view.currentTrick.map((play) => ({ player: play.player, domino: { ...play.domino } })),
    completedTricks: view.completedTricks.map((trick) => ({
      winner: trick.winner,
      points: trick.points,
      plays: trick.plays.map((play) => ({ player: play.player, domino: { ...play.domino } })),
    })),
    handPoints: [...view.handPoints] as [number, number],
    scores: [...view.scores] as [number, number],
    lastResult: view.lastResult,
    log: [],
  };
}

function faceDownStack(count: number): Domino[] {
  return Array.from({ length: count }, () => ({ hi: 0, lo: 0 }));
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 16);
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
