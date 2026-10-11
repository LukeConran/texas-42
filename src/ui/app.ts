import { BOT_STYLES, chooseAction } from "../ai/heuristic";
import type { Domino, Seat } from "../engine/domino";
import { dominoKey, dominoLabel, partnerOf, seatPlace, teamOf } from "../engine/domino";
import {
  type Action,
  type GameState,
  type MatchSettings,
  type PlayerView,
  apply,
  bidLabel,
  createMatch,
  defaultSettings,
  observe,
  scoreUnit,
} from "../engine/game";
import { chatSpeaker, chatText, isSeat, type NetMessage } from "../net/messages";
import { guestSeats } from "../net/seats";
import { openGuest, openHost, type GuestLink, type HostLink } from "../net/session";
import { trumpKey, trumpName, type Trump } from "../engine/trump";
import { boneHtml, sortHand } from "./dominoView";
import { lessonById, sameLessonAction, wantedKey, type Lesson } from "./lessons";
import { type Names, RULES_HTML, contractLine, needLine, seatWord, turnLine, yourPlayLine } from "./text";

const PACE_MS = {
  relaxed: { think: 900, trick: 1300, pass: 1400 },
  normal: { think: 560, trick: 900, pass: 1100 },
  fast: { think: 180, trick: 360, pass: 500 },
} as const;

type Pace = keyof typeof PACE_MS;

const HERO_TILES: Domino[] = [
  { hi: 6, lo: 6 },
  { hi: 5, lo: 4 },
  { hi: 3, lo: 2 },
];

function heroTilesHtml(): string {
  return `<div class="hero-tiles" aria-hidden="true">
    ${HERO_TILES.map((d) => boneHtml(d, { size: "lg" })).join("")}
  </div>`;
}

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
  let screen: "home" | "online" | "host" | "join" | "lobby" | "table" = "home";
  let role: "local" | "host" | "guest" = "local";
  let me: Seat = 0;
  let names: Names = [null, null, null, null];
  let humans = new Set<Seat>();
  let hostLink: HostLink | null = null;
  let guestLink: GuestLink | null = null;
  let roomCode = "";
  let playerName = "";
  let joinCode = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
  if (joinCode) screen = "join";
  let menuNote = "";
  let showHands = false;
  let soundOn = false;
  let pace: Pace = "normal";
  let rulesOpen = false;
  let placed = false;
  let state: GameState | null = null;
  let lesson: { def: Lesson; beat: number } | null = null;
  let lessonToken = 0;
  let selectedKey: string | null = null;
  let alertText = "";
  let timer = 0;
  let audio: AudioContext | null = null;
  let chat: Array<{ from: string; text: string; mine: boolean }> = [];
  let chatDraft = "";

  root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    if (target.dataset.field === "name") playerName = target.value;
    if (target.dataset.field === "code") joinCode = target.value.toUpperCase();
    if (target.dataset.field === "chat") chatDraft = target.value;
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.act !== "chat-form") return;
    event.preventDefault();
    const field = form.querySelector<HTMLInputElement>('[data-field="chat"]');
    sendChat(field?.value ?? "");
  });

  root.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.act !== "seat") return;
    const from = Number(target.dataset.from);
    const to = Number(target.value);
    if (!isSeat(from) || !isSeat(to)) return;
    moveSeat(from, to);
  });

  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
    if (!target || !root.contains(target)) return;
    const act = target.dataset.act;
    if (act === "seat" || act === "chat-form") return;
    if (act === "online") {
      menuNote = "";
      screen = "online";
    } else if (act === "offline") startMatch();
    else if (act === "tutorial") startLesson("follow");
    else if (act === "host-form") {
      menuNote = "";
      screen = "host";
    } else if (act === "join-form") {
      menuNote = "";
      screen = "join";
    } else if (act === "back") goBack();
    else if (act === "lesson") startLesson(target.dataset.lesson ?? "");
    else if (act === "host") void startHost();
    else if (act === "join") void startJoin();
    else if (act === "deal-online") startOnlineMatch();
    else if (act === "copy") void copyLink();
    else if (act === "menu") leaveTable();
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
    endLesson();
    state = createMatch(matchSettings());
    selectedKey = null;
    screen = "table";
    rulesOpen = false;
    blip(660, 0.03);
    render();
    queue();
  }

  function onBid(amount: number | "pass"): void {
    if (!state || state.phase !== "bidding" || state.turn !== me) return;
    if (finishLessonStep({ type: "bid", amount })) return;
    blip(amount === "pass" ? 320 : 540, 0.04);
    commit({ type: "bid", amount });
  }

  function onTrump(key: string): void {
    if (!state || state.phase !== "trump" || state.turn !== me) return;
    if (finishLessonStep({ type: "declareTrump", trump: parseButton(key) })) return;
    blip(600, 0.04);
    commit({ type: "declareTrump", trump: parseButton(key) });
  }

  function onSelect(key: string): void {
    if (!state || state.phase !== "playing" || state.turn !== me) return;
    const legal = new Set(observe(state, me).legalPlays.map(dominoKey));
    if (lesson) {
      if (!legal.has(key)) return;
      const domino = state.hands[me].find((d) => dominoKey(d) === key);
      if (!domino) return;
      finishLessonStep({ type: "play", domino });
      return;
    }
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
    if (lesson) return;
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
    roomCode = "";
    menuNote = "";
    showHands = false;
    selectedKey = null;
    alertText = "";
    rulesOpen = false;
    endLesson();
    chat = [];
    chatDraft = "";
    placed = false;
    screen = "home";
  }

  function goBack(): void {
    if (screen === "online") {
      menuNote = "";
      screen = "home";
      return;
    }
    if (screen === "lobby" || connecting || hostLink || guestLink) {
      netToken += 1;
      connecting = false;
      stopNet();
      role = "local";
      me = 0;
      names = [null, null, null, null];
      humans = new Set();
      state = null;
      roomCode = "";
      chat = [];
      chatDraft = "";
      placed = false;
    }
    menuNote = "";
    screen = "online";
  }

  function endLesson(): void {
    lesson = null;
    lessonToken += 1;
  }

  function startLesson(id: string): void {
    const def = lessonById(id);
    if (!def) return;
    stopNet();
    endLesson();
    role = "local";
    me = 0;
    names = [null, null, null, null];
    humans = new Set();
    showHands = false;
    lesson = { def, beat: 0 };
    state = createMatch(matchSettings(def.seed));
    selectedKey = null;
    alertText = "";
    screen = "table";
    rulesOpen = false;
    pumpLesson();
  }

  function finishLessonStep(action: Action): boolean {
    if (!lesson || !state) return false;
    const beat = lesson.def.beats[lesson.beat];
    if (!beat) return true;
    if (beat.kind !== "you" || !sameLessonAction(beat.action, action)) {
      alertText = beat && beat.kind === "you" ? beat.hint : "Watch the table.";
      return true;
    }
    const before = state;
    alertText = "";
    blip(action.type === "play" ? 420 : 540, 0.04);
    commit(action);
    if (state === before) return true;
    lesson.beat += 1;
    pumpLesson();
    return true;
  }

  function pumpLesson(): void {
    const token = (lessonToken += 1);
    const step = (): void => {
      if (token !== lessonToken || !lesson || !state) return;
      const beat = lesson.def.beats[lesson.beat];
      if (!beat || beat.kind === "you") {
        render();
        return;
      }
      const paced = beat.action.type === "play" || beat.action.type === "acknowledgeTrick";
      const run = (): void => {
        if (token !== lessonToken || !lesson || !state) return;
        try {
          state = apply(state, beat.action);
        } catch (error) {
          alertText = error instanceof Error ? error.message : "The lesson could not continue.";
          render();
          return;
        }
        lesson.beat += 1;
        step();
      };
      if (!paced) {
        run();
        return;
      }
      timer = window.setTimeout(run, 360);
      render();
    };
    step();
  }

  function broadcast(): void {
    if (role !== "host" || !state || !hostLink) return;
    for (const seat of guestSeats(me, humans)) {
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
  let netToken = 0;

  async function startHost(): Promise<void> {
    if (connecting) return;
    connecting = true;
    const token = (netToken += 1);
    role = "local";
    stopNet();
    me = 0;
    showHands = false;
    menuNote = "Opening a room…";
    screen = "host";
    render();
    try {
      names = [cleanName(playerName) || null, null, null, null];
      humans = new Set<Seat>([0]);
      chat = [];
      chatDraft = "";
      const opened = await openHost(onGuestMessage, onGuestClose);
      if (token !== netToken) {
        opened.close();
        return;
      }
      hostLink = opened;
      role = "host";
      roomCode = hostLink.code;
      state = null;
      screen = "lobby";
      menuNote = "";
    } catch (error) {
      if (token !== netToken) return;
      stopNet();
      role = "local";
      screen = "host";
      menuNote = error instanceof Error ? error.message : "Could not open a room.";
    } finally {
      if (token !== netToken) return;
      connecting = false;
      render();
    }
  }

  function onGuestMessage(seat: Seat, message: NetMessage): void {
    if (role !== "host" || !hostLink) return;
    if (message.type === "chat") {
      const text = chatText(message.text);
      if (!text) return;
      const from = names[seat] || seatWord(seat, me, names);
      relayChat(from, text, seat);
      rememberChat(from, text, false);
      return;
    }
    if (message.type === "hello") {
      const next = [...names] as Names;
      next[seat] = cleanName(message.name) || null;
      names = next;
      humans.add(seat);
      if (state) broadcast();
      else tellSeats();
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
    } else tellSeats();
    render();
  }

  function moveSeat(from: Seat, to: Seat): void {
    if (role !== "host" || !hostLink || state || from === to) return;
    hostLink.swap(from, to);
    const nextNames = [...names] as Names;
    const held = nextNames[from] ?? null;
    nextNames[from] = nextNames[to] ?? null;
    nextNames[to] = held;
    names = nextNames;
    const nextHumans = new Set(humans);
    const fromHuman = humans.has(from);
    const toHuman = humans.has(to);
    if (fromHuman !== toHuman) {
      if (fromHuman) {
        nextHumans.delete(from);
        nextHumans.add(to);
      } else {
        nextHumans.delete(to);
        nextHumans.add(from);
      }
    }
    humans = nextHumans;
    if (me === from) me = to;
    else if (me === to) me = from;
    tellSeats();
    render();
  }

  function tellSeats(): void {
    if (role !== "host" || !hostLink || state) return;
    for (const seat of guestSeats(me, humans)) {
      hostLink.send(seat, { type: "seated", seat, names: [...names] });
    }
  }

  async function startJoin(): Promise<void> {
    if (connecting) return;
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      menuNote = "Enter the four-letter room code.";
      screen = "join";
      render();
      return;
    }
    connecting = true;
    const token = (netToken += 1);
    stopNet();
    role = "guest";
    me = 0;
    chat = [];
    chatDraft = "";
    showHands = false;
    menuNote = "Joining the room…";
    screen = "join";
    render();
    try {
      placed = false;
      const opened = await openGuest(code, cleanName(playerName), onHostMessage, onHostClosed);
      if (token !== netToken) {
        opened.close();
        role = "local";
        return;
      }
      guestLink = opened;
      roomCode = code;
      if (!state) {
        screen = "lobby";
        menuNote = "Connected. Waiting for the host to deal.";
      }
    } catch (error) {
      if (token !== netToken) return;
      stopNet();
      role = "local";
      screen = "join";
      menuNote = error instanceof Error ? error.message : "Could not join that room.";
    } finally {
      if (token !== netToken) return;
      connecting = false;
      render();
    }
  }

  function onHostMessage(message: NetMessage): void {
    if (role !== "guest") return;
    if (message.type === "seated") {
      if (state || !isSeat(message.seat)) return;
      me = message.seat;
      names = [message.names[0] ?? null, message.names[1] ?? null, message.names[2] ?? null, message.names[3] ?? null];
      placed = true;
      render();
      return;
    }
    if (message.type === "chat") {
      const text = chatText(message.text);
      if (!text) return;
      rememberChat(chatSpeaker(message.from) || "Table", text, false);
      return;
    }
    if (message.type !== "sync") return;
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
    screen = "home";
    showHands = false;
    placed = false;
    chat = [];
    chatDraft = "";
    menuNote = "The host closed the room.";
    render();
  }

  function sendChat(raw: string): void {
    const text = chatText(raw);
    if (!text) return;
    if (role === "guest") {
      if (!guestLink) return;
      guestLink.send({ type: "chat", text });
    } else if (role === "host") {
      if (!hostLink) return;
      relayChat(names[me] || "Host", text, null);
    } else {
      return;
    }
    chatDraft = "";
    rememberChat("You", text, true);
  }

  function relayChat(from: string, text: string, except: Seat | null): void {
    if (!hostLink) return;
    for (const seat of guestSeats(me, humans)) {
      if (seat === except) continue;
      hostLink.send(seat, { type: "chat", text, from });
    }
  }

  function rememberChat(from: string, text: string, mine: boolean): void {
    chat = [...chat, { from, text, mine }].slice(-40);
    render();
  }

  function startOnlineMatch(): void {
    if (role !== "host") return;
    state = createMatch(matchSettings());
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
    const active = document.activeElement;
    const chatFocused = active instanceof HTMLInputElement && active.dataset.field === "chat";
    const caret = chatFocused ? active.selectionStart : null;
    if (screen === "table" && state) root.innerHTML = tableHtml(state);
    else if (screen === "lobby") root.innerHTML = lobbyHtml();
    else if (screen === "online") root.innerHTML = onlineHtml();
    else if (screen === "host") root.innerHTML = hostFormHtml();
    else if (screen === "join") root.innerHTML = joinFormHtml();
    else root.innerHTML = homeHtml();
    const log = root.querySelector<HTMLElement>(".chat-log");
    if (log) log.scrollTop = log.scrollHeight;
    if (!chatFocused) return;
    const field = root.querySelector<HTMLInputElement>('[data-field="chat"]');
    if (!field) return;
    field.focus();
    const pos = caret ?? field.value.length;
    field.setSelectionRange(pos, pos);
  }

  function homeHtml(): string {
    return `
      <div class="room menu-room">
        <main class="front">
          ${heroTilesHtml()}
          <h1 class="front-title">Texas 42</h1>
          <p class="front-tagline">The trick-taking domino game, dealt out online or on the couch.</p>
          <div class="front-actions">
            <button type="button" class="primary" data-act="online">Play Online</button>
            <button type="button" class="secondary" data-act="offline">Play Offline</button>
          </div>
          <button type="button" class="link-action" data-act="tutorial">New to 42? Start the tutorial</button>
          ${menuNote ? `<p class="fine">${escapeHtml(menuNote)}</p>` : ""}
        </main>
      </div>`;
  }

  function onlineHtml(): string {
    return cardPage(
      "Play online",
      "Host a table for friends or drop into one with a room code.",
      `<div class="front-actions">
        <button type="button" class="primary" data-act="host-form">Host a Room</button>
        <button type="button" class="secondary" data-act="join-form">Join a Room</button>
      </div>
      <button type="button" class="link-action" data-act="back">Back</button>`,
    );
  }

  function hostFormHtml(): string {
    return cardPage(
      "Host a room",
      "You'll get a code to share. Empty seats play as bots until friends take them.",
      `<label class="field">Your name
        <input data-field="name" maxlength="16" value="${escapeHtml(playerName)}" autocomplete="nickname" placeholder="e.g. Dana" />
      </label>
      <div class="front-actions">
        <button type="button" class="primary" data-act="host">Host</button>
      </div>
      <button type="button" class="link-action" data-act="back">Back</button>
      ${menuNote ? `<p class="fine">${escapeHtml(menuNote)}</p>` : ""}`,
    );
  }

  function joinFormHtml(): string {
    return cardPage(
      "Join a room",
      "Ask the host for their 4-letter room code.",
      `<label class="field">Your name
        <input data-field="name" maxlength="16" value="${escapeHtml(playerName)}" autocomplete="nickname" placeholder="e.g. Dana" />
      </label>
      <label class="field">Room code
        <input data-field="code" maxlength="4" value="${escapeHtml(joinCode)}" autocapitalize="characters" spellcheck="false" placeholder="ABCD" />
      </label>
      <div class="front-actions">
        <button type="button" class="primary" data-act="join">Join</button>
      </div>
      <button type="button" class="link-action" data-act="back">Back</button>
      ${menuNote ? `<p class="fine">${escapeHtml(menuNote)}</p>` : ""}`,
    );
  }

  function cardPage(title: string, lede: string, body: string): string {
    return `
      <div class="room menu-room">
        <header class="topbar">
          <div class="brand-block">
            <p class="brand">Texas 42</p>
            <p class="brand-sub">Play online</p>
          </div>
        </header>
        <main class="menu-layout">
          <section class="menu-card sheet">
            <h1>${title}</h1>
            <p class="lede">${escapeHtml(lede)}</p>
            ${body}
          </section>
        </main>
      </div>`;
  }

  function lobbyHtml(): string {
    const hostControls =
      role === "host"
        ? `<p class="room-code">${escapeHtml(roomCode)}</p>
           <p class="fine">Share the code or link below. Partners sit across: South with North, West with East. Put two people across from each other to partner them, or side by side to oppose them. An empty seat is a bot. Seats stay put once the first hand is dealt. Keep this tab open for the whole match.</p>
           <p class="fine room-link">${escapeHtml(roomLink())}</p>
           <div class="menu-actions">
             <button type="button" class="primary" data-act="deal-online">Deal the first hand</button>
             <button type="button" class="secondary" data-act="copy">Copy link</button>
           </div>
           ${menuNote ? `<p class="fine">${escapeHtml(menuNote)}</p>` : ""}
           ${seatPicker()}`
        : `<p class="lede">${escapeHtml(placed ? guestPlaceLine() : menuNote || "Waiting for the host to deal.")}</p>
           <p class="room-code">${escapeHtml(roomCode)}</p>`;
    return `
      <div class="room menu-room">
        <header class="topbar">
          <p class="brand">Texas 42</p>
          <p class="brand-sub">Room ${escapeHtml(roomCode)}</p>
        </header>
        <main class="menu-layout with-aside">
          <section class="menu-card sheet">
            <h1>${role === "host" ? "Your table is open." : "You are in the room."}</h1>
            ${hostControls}
            <button type="button" class="link-action" data-act="back">Back</button>
          </section>
          <aside class="lobby-chat">${chatHtml()}</aside>
        </main>
      </div>`;
  }

  function tableHtml(game: GameState): string {
    const mine = teamOf(me);
    const us = game.scores[mine];
    const them = game.scores[mine === 0 ? 1 : 0];
    const matchUnit = scoreUnit(game.settings.scoringMode, game.settings.target);
    const target = game.settings.target;
    const handsButton =
      role === "local" && !lesson
        ? `<button type="button" class="tool ${showHands ? "on" : ""}" data-act="hands">${showHands ? "Hide hands" : "Show hands"}</button>`
        : "";
    return `
      <div class="room">
        ${coachHtml()}
        <header class="topbar">
          <div class="brand-block">
            <p class="brand">Texas 42</p>
            <p class="brand-sub">Hand ${game.handNumber} · first to ${target} ${matchUnit}</p>
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
                    <p class="status" aria-live="polite">${escapeHtml(lessonOver() ? "Lesson complete." : turnLine(game, me, names))}</p>
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
            ${yourBidRow(game, me)}
            <div class="your-hand" aria-label="Your hand">
              ${yourHandHtml(game)}
            </div>
          </section>
          <aside class="side">
            ${trickBoardHtml(game)}
            ${chatHtml()}
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
    const yourTurn = game.phase === "playing" && game.turn === me && !lessonOver();
    return sortHand(game.hands[me], game.trump)
      .map((d) => {
        const key = dominoKey(d);
        const playable = !yourTurn || legal.has(key);
        const wanted = wantedKey(lesson?.def.beats[lesson.beat]);
        return boneHtml(d, {
          size: "lg",
          trump: game.trump,
          interactive: playable && yourTurn,
          selected: selectedKey === key && playable,
          locked: yourTurn && !legal.has(key),
          marked: yourTurn && wanted === key,
        });
      })
      .join("");
  }

  function lessonOver(): boolean {
    return Boolean(lesson && lesson.beat >= lesson.def.beats.length);
  }

  function dockHtml(game: GameState): string {
    if (lessonOver()) return `<p class="dock-note">Lesson complete.</p>`;
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

  function coachHtml(): string {
    if (!lesson) return "";
    const beat = lesson.def.beats[lesson.beat];
    const say = beat ? (beat.kind === "you" ? beat.say : "Watch the table.") : lesson.def.done;
    const next = beat
      ? ""
      : `<div class="menu-actions">
          <button type="button" class="primary" data-act="lesson" data-lesson="follow">Follow suit</button>
          <button type="button" class="ghost" data-act="lesson" data-lesson="count">Count the points</button>
        </div>`;
    return `
      <section class="coach" aria-live="polite">
        <p class="coach-kicker">${escapeHtml(lesson.def.title)}</p>
        <p>${escapeHtml(say)}</p>
        ${alertText ? `<p class="coach-hint">${escapeHtml(alertText)}</p>` : ""}
        ${next}
      </section>`;
  }

  function overlayHtml(game: GameState): string {
    if (lesson) return "";
    const result = game.lastResult;
    if (!result || result.passed) return "";
    if (game.phase !== "handComplete" && game.phase !== "matchComplete") return "";
    const bidder = result.bidder == null ? "" : seatWord(result.bidder, me, names);
    const trump = result.trump ? trumpName(result.trump) : "";
    const made = result.made ? "Made." : "Set.";
    const mine = teamOf(me);
    const usAward = result.awarded[mine];
    const themAward = result.awarded[mine === 0 ? 1 : 0];
    const ourUnit = scoreUnit(game.settings.scoringMode, usAward);
    const theirUnit = scoreUnit(game.settings.scoringMode, themAward);
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
          <p>Awarded: your team ${usAward} ${ourUnit}, opponents ${themAward} ${theirUnit}.</p>
          <p class="result-score">Us ${game.scores[mine]} · Them ${game.scores[mine === 0 ? 1 : 0]}</p>
          ${winner ? `<p class="winner">${winner}</p>` : ""}
          ${next}
        </div>
      </div>`;
  }


  function seatPicker(): string {
    const rows = ([0, 1, 2, 3] as Seat[])
      .map((seat) => {
        const options = ([0, 1, 2, 3] as Seat[])
          .map((other) => {
            const who = personAt(other);
            const selected = other === seat ? "selected" : "";
            return `<option value="${other}" ${selected}>${escapeHtml(who)} · ${seatTitle(other)}</option>`;
          })
          .join("");
        return `<label class="field">${seatTitle(seat)} · with ${seatTitle(partnerOf(seat))}
          <select data-act="seat" data-from="${seat}" aria-label="Who sits ${seatTitle(seat)}">${options}</select>
        </label>`;
      })
      .join("");
    return `<div class="seat-picker">${rows}</div>`;
  }

  function guestPlaceLine(): string {
    const partner = names[partnerOf(me)] || "a bot";
    return `You are sitting ${seatTitle(me)}. Your partner is ${partner}.`;
  }

  function personAt(seat: Seat): string {
    if (seat === me) return names[seat] ? `${names[seat]} (you)` : "You";
    if (humans.has(seat)) return names[seat] || "Friend";
    return "Bot";
  }

  function chatHtml(): string {
    if (role !== "host" && role !== "guest") return "";
    const lines = chat
      .map(
        (line) =>
          `<p class="chat-line ${line.mine ? "mine" : ""}"><strong>${escapeHtml(line.from)}</strong> ${escapeHtml(line.text)}</p>`,
      )
      .join("");
    return `
      <section class="chat" aria-label="Table talk">
        <h2>Table talk</h2>
        <div class="chat-log">
          ${lines || `<p class="chat-empty">Messages stay in this room, and they are not bids or plays.</p>`}
        </div>
        <form class="chat-form" data-act="chat-form">
          <input data-field="chat" maxlength="200" placeholder="Message the table" value="${escapeHtml(chatDraft)}" autocomplete="off" />
          <button type="submit" class="primary">Send</button>
        </form>
      </section>`;
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

function seatTitle(seat: Seat): string {
  return (["South", "West", "North", "East"] as const)[seat];
}

function matchSettings(seed?: number): MatchSettings {
  return {
    ...defaultSettings(seed),
    scoringMode: "marks",
    target: 7,
    openingLeadMustBeTrump: false,
  };
}

function bidChip(game: GameState, seat: Seat): string {
  if (game.phase !== "bidding" && game.phase !== "trump") return "";
  const bid = game.bids[seat];
  if (!bid) return "";
  if (bid.kind === "pass") return `<p class="bid-chip pass">Pass</p>`;
  return `<p class="bid-chip">${bid.amount}</p>`;
}

function yourBidRow(game: GameState, viewer: Seat): string {
  const chip = bidChip(game, viewer);
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
