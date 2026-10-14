import { chooseBotAction, type BotLevel } from "../ai/levels";
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
  trickPoints,
} from "../engine/game";
import { chatSpeaker, chatText, isSeat, type NetMessage } from "../net/messages";
import { guestSeats } from "../net/seats";
import { openGuest, openHost, type GuestLink, type HostLink } from "../net/session";
import { classify, trumpKey, trumpName, type Trump } from "../engine/trump";
import { boneHtml, sortHand } from "./dominoView";
import { lessonById, sameLessonAction, wantedKey, type Lesson, type LessonSpot } from "./lessons";
import { type Names, RULES_HTML, contractLine, needLine, seatWord, teamTag, turnLine } from "./text";

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
  { trump: { kind: "nello" }, label: "Nello", hint: "lose every trick" },
];

export function mount(root: HTMLElement): void {
  let screen: "home" | "online" | "offline" | "host" | "join" | "lobby" | "table" = "home";
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
  let botLevel: BotLevel = "medium";
  let rulesOpen = false;
  let settingsOpen = false;
  let placed = false;
  let state: GameState | null = null;
  let lesson: { def: Lesson; beat: number; guide: number; hold: boolean; sawTrick: boolean } | null = null;
  let lessonToken = 0;
  let selectedKey: string | null = null;
  let alertText = "";
  let timer = 0;
  let audio: AudioContext | null = null;
  let chat: Array<{ from: string; text: string; mine: boolean }> = [];
  let chatDraft = "";
  let handOrder: string[] = [];
  let mayLayDown = false;
  let ignoreSelectUntil = 0;
  let handDrag: { pointerId: number; key: string; startX: number; moved: boolean } | null = null;

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

  window.addEventListener("resize", () => placeCoach());

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const tile = (event.target as HTMLElement | null)?.closest<HTMLElement>(".your-hand .tile");
    if (!tile?.dataset.key) return;
    handDrag = { pointerId: event.pointerId, key: tile.dataset.key, startX: event.clientX, moved: false };
  });

  root.addEventListener("pointermove", (event) => {
    if (!handDrag || event.pointerId !== handDrag.pointerId) return;
    if (Math.abs(event.clientX - handDrag.startX) > 8) handDrag.moved = true;
    if (!handDrag.moved) return;
    const hand = root.querySelector(".your-hand");
    const tile = hand?.querySelector<HTMLElement>(`.tile[data-key="${handDrag.key}"]`);
    if (!hand || !tile) return;
    tile.classList.add("dragging");
    const others = Array.from(hand.querySelectorAll<HTMLElement>(".tile")).filter((item) => item !== tile);
    let before: HTMLElement | null = null;
    for (const other of others) {
      const rect = other.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        before = other;
        break;
      }
    }
    if (before) hand.insertBefore(tile, before);
    else hand.appendChild(tile);
  });

  root.addEventListener("pointerup", (event) => {
    if (!handDrag || event.pointerId !== handDrag.pointerId) return;
    const moved = handDrag.moved;
    handDrag = null;
    if (!moved) return;
    const hand = root.querySelector(".your-hand");
    if (!hand) return;
    handOrder = Array.from(hand.querySelectorAll<HTMLElement>(".tile"))
      .map((tile) => tile.dataset.key ?? "")
      .filter(Boolean);
    hand.querySelectorAll(".dragging").forEach((tile) => tile.classList.remove("dragging"));
    ignoreSelectUntil = performance.now() + 400;
  });

  root.addEventListener("pointercancel", () => {
    handDrag = null;
  });

  root.addEventListener("click", (event) => {
    const raw = event.target as HTMLElement | null;
    const insideSettings = Boolean(raw?.closest(".settings"));
    const target = raw?.closest<HTMLElement>("[data-act]");
    if (!target || !root.contains(target)) {
      if (settingsOpen && !insideSettings) {
        settingsOpen = false;
        render();
      }
      return;
    }
    const act = target.dataset.act;
    if (act === "seat" || act === "chat-form") return;
    if (settingsOpen && !insideSettings) settingsOpen = false;
    if (act === "online") {
      menuNote = "";
      screen = "online";
    } else if (act === "offline") {
      menuNote = "";
      screen = "offline";
    } else if (act === "deal-offline") startMatch();
    else if (act === "bots") {
      const next = target.dataset.level;
      if (next === "easy" || next === "medium" || next === "hard") botLevel = next;
    }
    else if (act === "tutorial") startLesson("follow");
    else if (act === "host-form") {
      menuNote = "";
      screen = "host";
    } else if (act === "join-form") {
      menuNote = "";
      screen = "join";
    } else if (act === "back") goBack();
    else if (act === "guide-next") advanceGuide();
    else if (act === "lesson") startLesson(target.dataset.lesson ?? "");
    else if (act === "host") void startHost();
    else if (act === "join") void startJoin();
    else if (act === "deal-online") startOnlineMatch();
    else if (act === "copy") void copyLink();
    else if (act === "settings") settingsOpen = !settingsOpen;
    else if (act === "menu") {
      settingsOpen = false;
      leaveTable();
    } else if (act === "rules") {
      settingsOpen = false;
      rulesOpen = !rulesOpen;
    }
    else if (act === "close-rules") rulesOpen = false;
    else if (act === "hands" && role === "local") showHands = !showHands;
    else if (act === "sound") soundOn = !soundOn;
    else if (act === "pace") pace = (target.dataset.pace as Pace) || "normal";
    else if (act === "bid") onBid(target.dataset.amount === "pass" ? "pass" : Number(target.dataset.amount));
    else if (act === "trump") onTrump(target.dataset.trump ?? "");
    else if (act === "select") {
      if (performance.now() < ignoreSelectUntil) ignoreSelectUntil = 0;
      else onSelect(target.dataset.key ?? "");
    } else if (act === "play") playSelected();
    else if (act === "lay-down") {
      if (state?.phase === "playing" && state.turn === me) commit({ type: "layDown" });
    }
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
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !settingsOpen) return;
    settingsOpen = false;
    render();
  });

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
    settingsOpen = false;
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
        const action = chooseBotAction(observe(state, seat), botLevel);
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
    if (screen === "online" || screen === "offline") {
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
    pace = "relaxed";
    lesson = { def, beat: 0, guide: 0, hold: false, sawTrick: false };
    state = createMatch(matchSettings(def.seed));
    selectedKey = null;
    alertText = "";
    screen = "table";
    rulesOpen = false;
    settingsOpen = false;
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

  function advanceGuide(): void {
    if (!lesson) return;
    if (lesson.guide < lesson.def.guide.length) {
      lesson.guide += 1;
      pumpLesson();
      return;
    }
    if (lesson.hold) {
      lesson.hold = false;
      pumpLesson();
    }
  }

  function coachMoment(): { say: string; spot: LessonSpot | "watch" | "done"; showNext: boolean } | null {
    if (!lesson) return null;
    if (lesson.hold) {
      return { say: "This trick stays in the middle until you hit Next.", spot: "played", showNext: true };
    }
    const guide = lesson.def.guide[lesson.guide];
    if (guide) return { say: guide.say, spot: guide.spot, showNext: true };
    const beat = lesson.def.beats[lesson.beat];
    if (!beat) return { say: lesson.def.done, spot: "done", showNext: false };
    if (beat.kind === "you") return { say: beat.say, spot: beat.spot ?? "hand", showNext: false };
    if (state && state.completedTricks.length >= 1 && state.currentTrick.length === 0) {
      return { say: "That trick is in the column now.", spot: "tricks", showNext: false };
    }
    return { say: "Watch the table.", spot: "watch", showNext: false };
  }

  function activeSpot(): LessonSpot | null {
    const moment = coachMoment();
    if (!moment || moment.spot === "watch" || moment.spot === "done") return null;
    return moment.spot;
  }

  function spotClass(spot: LessonSpot): string {
    return activeSpot() === spot ? "lit" : "";
  }

  function pumpLesson(): void {
    const token = (lessonToken += 1);
    if (lesson && lesson.guide < lesson.def.guide.length) {
      render();
      return;
    }
    const step = (): void => {
      if (token !== lessonToken || !lesson || !state) return;
      const beat = lesson.def.beats[lesson.beat];
      if (!beat || beat.kind === "you") {
        render();
        return;
      }
      if (
        beat.action.type === "acknowledgeTrick" &&
        !lesson.sawTrick &&
        state.currentTrick.length === 4 &&
        state.completedTricks.length === 0
      ) {
        lesson.sawTrick = true;
        lesson.hold = true;
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
      timer = window.setTimeout(run, PACE_MS[pace].trick);
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
      const from = names[seat] || seatWord(seat, names);
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
    if (action.type !== "bid" && action.type !== "declareTrump" && action.type !== "play" && action.type !== "layDown") return;
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
    mayLayDown = message.view.mayLayDown;
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
    settingsOpen = false;
    blip(660, 0.03);
    broadcast();
    render();
    queue();
  }

  function seatAt(place: "s" | "w" | "n" | "e"): Seat {
    const steps = { s: 0, w: 1, n: 2, e: 3 }[place];
    return ((me + steps) % 4) as Seat;
  }

  function teamLabel(team: 0 | 1): string {
    const seats: [Seat, Seat] = team === 0 ? [0, 2] : [1, 3];
    return teamTag(seats, names);
  }

  function opponentsLabel(): string {
    return teamLabel(teamOf(me) === 0 ? 1 : 0);
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
    else if (screen === "offline") root.innerHTML = offlineHtml();
    else if (screen === "host") root.innerHTML = hostFormHtml();
    else if (screen === "join") root.innerHTML = joinFormHtml();
    else root.innerHTML = homeHtml();
    const log = root.querySelector<HTMLElement>(".chat-log");
    if (log) log.scrollTop = log.scrollHeight;
    placeCoach();
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

  function offlineHtml(): string {
    const choice = (level: BotLevel, label: string) =>
      `<button type="button" class="choice ${botLevel === level ? "on" : ""}" data-act="bots" data-level="${level}" aria-pressed="${botLevel === level}">${label}</button>`;
    return cardPage(
      "Play offline",
      "Choose how hard the other three chairs play, then deal. Medium is the usual bot.",
      `<div class="choice-row">
        ${choice("easy", "Easy")}
        ${choice("medium", "Medium")}
        ${choice("hard", "Hard")}
      </div>
      <div class="front-actions">
        <button type="button" class="primary" data-act="deal-offline">Deal</button>
      </div>
      <button type="button" class="link-action" data-act="back">Back</button>`,
      "On this computer",
    );
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

  function cardPage(title: string, lede: string, body: string, kicker = "Play online"): string {
    return `
      <div class="room menu-room">
        <header class="topbar">
          <div class="brand-block">
            <p class="brand">Texas 42</p>
            <p class="brand-sub">${escapeHtml(kicker)}</p>
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
           <p class="fine">Share the code or link below. Partners sit across: Player 1 with Player 3, Player 2 with Player 4. Put two people across from each other to partner them, or side by side to oppose them. An empty seat is a bot. Seats stay put once the first hand is dealt. Keep this tab open for the whole match.</p>
           <p class="fine room-link">${escapeHtml(roomLink())}</p>
           <p class="fine">Empty seats</p>
           <div class="choice-row">${botButtons()}</div>
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
            <p class="brand-sub">Hand ${game.handNumber} · first to ${target} ${matchUnit}${role === "local" && !lesson ? ` · ${botLevel} bots` : ""}</p>
          </div>
          <div class="scoreline ${spotClass("marks")}" data-spot="marks" aria-label="Match score">
            <span class="us"><small>${escapeHtml(teamLabel(mine))}</small><strong>${us}</strong></span>
            <span class="divider" aria-hidden="true"></span>
            <span class="them"><small>${escapeHtml(opponentsLabel())}</small><strong>${them}</strong></span>
          </div>
          ${settingsHtml(handsButton)}
        </header>
        <div class="play">
          <section class="table-column">
            <div class="rail">
              <div class="felt">
                ${seatBlock(game, seatAt("n"), "north")}
                <div class="middle">
                  ${seatBlock(game, seatAt("w"), "west")}
                  <div class="trick-wrap">
                    <div class="trick ${spotClass("played")}" data-spot="played">
                      <p class="status" aria-live="polite">${escapeHtml(lessonOver() ? "Lesson complete." : turnLine(game, me, names))}</p>
                      ${trickSlots(game)}
                    </div>
                    <p class="contract">${escapeHtml(handBanner(game, me, names))}</p>
                    <p class="count-out">${escapeHtml(countOutLine(game))}</p>
                  </div>
                  ${seatBlock(game, seatAt("e"), "east")}
                </div>
                <div class="south-plate ${game.turn === me ? "active" : ""}">
                  <span>${escapeHtml(seatWord(me, names))}</span>
                  ${game.phase === "bidding" && game.shaker === me ? "<em>shook</em>" : ""}
                </div>
              </div>
            </div>
            <div class="dock">
              ${dockHtml(game)}
            </div>
            ${yourBidRow(game, me)}
            <div class="your-hand ${spotClass("hand")}" data-spot="hand" aria-label="Your hand">
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

  function settingsHtml(handsButton: string): string {
    const bots = role === "guest" || lesson ? "" : `<p class="settings-label">Bots</p><div class="choice-row">${botButtons()}</div>`;
    const speed = role === "guest" ? "" : `<p class="settings-label">Speed</p><div class="choice-row">${paceButtons()}</div>`;
    const open = settingsOpen ? "on" : "";
    return `
      <div class="settings">
        <button type="button" class="tool settings-toggle ${open}" data-act="settings" aria-expanded="${settingsOpen ? "true" : "false"}" aria-haspopup="dialog" aria-label="Settings">
          ${settingsIcon()}
        </button>
        ${
          settingsOpen
            ? `<div class="settings-pop" role="dialog" aria-label="Settings">
                ${bots}
                ${speed}
                <div class="settings-actions">
                  ${handsButton}
                  <button type="button" class="tool ${soundOn ? "on" : ""}" data-act="sound">${soundOn ? "Sound on" : "Sound off"}</button>
                  <button type="button" class="tool" data-act="rules">Rules</button>
                  <button type="button" class="tool settings-leave" data-act="menu">Leave</button>
                </div>
              </div>`
            : ""
        }
      </div>`;
  }

  function settingsIcon(): string {
    return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.22-1.14.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.49.4 1.04.72 1.63.94l.36 2.54c.05.24.26.42.49.42h3.84c.23 0 .44-.18.49-.42l.36-2.54c.59-.22 1.14-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>`;
  }

  function botButtons(): string {
    const labels: Record<BotLevel, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };
    return (Object.keys(labels) as BotLevel[])
      .map(
        (level) =>
          `<button type="button" class="tool ${botLevel === level ? "on" : ""}" data-act="bots" data-level="${level}">${labels[level]}</button>`,
      )
      .join("");
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
      <div class="seat seat-${place} ${active ? "active" : ""} ${reveal ? "open" : ""} ${teamOf(seat) === teamOf(me) ? "team-us" : "team-them"} ${spotClass(place === "north" ? "partner" : "opponents")}" data-spot="${place === "north" ? "partner" : "opponents"}">
        <div class="seat-stack">
          <div class="seat-tiles">${tiles}</div>
          ${bidChip(game, seat)}
        </div>
        <div class="nameplate">
          <strong>${escapeHtml(seatWord(seat, names))}</strong>
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
    return orderedHand(game)
      .map((d) => {
        const key = dominoKey(d);
        const wanted = wantedKey(lesson?.def.beats[lesson.beat]);
        return boneHtml(d, {
          size: "lg",
          trump: game.trump,
          interactive: true,
          selected: selectedKey === key && yourTurn && legal.has(key),
          locked: yourTurn && !legal.has(key),
          marked: yourTurn && wanted === key,
        });
      })
      .join("");
  }

  function orderedHand(game: GameState): Domino[] {
    const hand = game.hands[me];
    const byKey = new Map(hand.map((domino) => [dominoKey(domino), domino]));
    const current = new Set(byKey.keys());
    const known = handOrder.filter((key) => current.has(key));
    const hasNew = [...current].some((key) => !handOrder.includes(key));
    if (hasNew || known.length !== current.size) {
      const sorted = sortHand(hand, game.trump);
      handOrder = sorted.map(dominoKey);
      return sorted;
    }
    handOrder = known;
    return known.map((key) => byKey.get(key)!);
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
      return `<div class="bids ${spotClass("bids")}" data-spot="bids" aria-label="Your bid">${buttons}</div>`;
    }
    if (game.phase === "trump" && game.turn === me) {
      const buttons = TRUMP_BUTTONS.map(
        (item) =>
          `<button type="button" class="trump" data-act="trump" data-trump="${trumpKey(item.trump)}"><strong>${item.label}</strong><small>${item.hint}</small></button>`,
      ).join("");
      return `<div class="trumps ${spotClass("trumps")}" data-spot="trumps" aria-label="Name trump">${buttons}</div>`;
    }
    const lay = viewerMayLayDown(game)
      ? `<button type="button" class="primary" data-act="lay-down">Lay down</button>`
      : "";
    if (game.phase === "playing" && game.turn === me && selectedKey && legalKeys(game).has(selectedKey)) {
      return `<div class="play-row">${lay}<button type="button" class="primary play-go" data-act="play">Play ${selectedKey}</button></div>`;
    }
    if (alertText) return `<p class="dock-note">${escapeHtml(alertText)}</p>${lay}`;
    if (lay) return `<div class="play-row">${lay}</div>`;
    return "";
  }

  function viewerMayLayDown(game: GameState): boolean {
    if (game.phase !== "playing" || game.turn !== me || lessonOver()) return false;
    if (role === "guest") return mayLayDown;
    return observe(game, me).mayLayDown;
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
      <div class="trick-board ${spotClass("tricks")}" data-spot="tricks">
        <section class="won theirs">
          <header>
            <h2>${escapeHtml(opponentsLabel())}</h2>
            <span>${shownPoints(game, mine === 0 ? 1 : 0)}</span>
          </header>
          ${bidMeterHtml(game, mine === 0 ? 1 : 0, me)}
          ${trickStack(game, theirs)}
        </section>
        <div class="stack-gap" aria-hidden="true"></div>
        <section class="won ours">
          <header>
            <h2>${escapeHtml(teamLabel(mine))}</h2>
            <span>${shownPoints(game, mine)}</span>
          </header>
          ${bidMeterHtml(game, mine, me)}
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
              marked: game.trump ? classify(play.domino, game.trump).isTrump : false,
            }),
          )
          .join("");
        return `<div class="past-trick">${tiles}<span class="pts">+${trick.points}</span></div>`;
      })
      .join("")}</div>`;
  }

  function trumpBadgeHtml(game: GameState): string {
    if (!game.trump) {
      return `<aside class="trump-badge waiting ${spotClass("trump")}" data-spot="trump" aria-label="Trump"><p class="trump-kicker">Trump</p><strong>Not named</strong></aside>`;
    }
    const label = game.trump.kind === "followMe" ? "No Trump" : trumpName(game.trump);
    const icon =
      game.trump.kind === "doubles"
        ? `<div class="doubles-grid">${[6, 5, 4, 3].map((n) => boneHtml({ hi: n, lo: n }, { size: "xs", trump: game.trump })).join("")}</div>`
        : game.trump.kind === "suit"
          ? boneHtml({ hi: game.trump.suit, lo: game.trump.suit }, { size: "sm", trump: game.trump })
          : "";
    return `<aside class="trump-badge ${spotClass("trump")}" data-spot="trump" aria-live="polite" aria-label="Trump is ${label}"><p class="trump-kicker">Trump</p><strong>${escapeHtml(label)}</strong>${icon}</aside>`;
  }

  function coachHtml(): string {
    const moment = coachMoment();
    if (!lesson || !moment) return "";
    const next = moment.showNext
      ? `<button type="button" class="primary" data-act="guide-next">Next</button>`
      : moment.spot === "done"
        ? `<div class="menu-actions">
          <button type="button" class="primary" data-act="lesson" data-lesson="follow">Follow suit</button>
          <button type="button" class="ghost" data-act="lesson" data-lesson="count">Count the points</button>
        </div>`
        : "";
    return `
      <section class="coach" data-coach="${moment.spot}" aria-live="polite">
        <p class="coach-kicker">${escapeHtml(lesson.def.title)}</p>
        <p>${escapeHtml(moment.say)}</p>
        ${alertText && !moment.showNext && moment.spot !== "done" ? `<p class="coach-hint">${escapeHtml(alertText)}</p>` : ""}
        ${next}
      </section>`;
  }

  function placeCoach(): void {
    const coach = root.querySelector<HTMLElement>(".coach");
    if (!coach) return;
    if (window.innerWidth <= 720) {
      coach.classList.add("coach-pinned", "coach-no-arrow");
      coach.style.left = "";
      coach.style.top = "";
      return;
    }
    coach.classList.remove("coach-pinned");
    const width = coach.offsetWidth;
    const height = coach.offsetHeight;
    const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-spot].lit"));
    const felt = root.querySelector<HTMLElement>(".felt");
    if (targets.length === 0 && felt) {
      const box = felt.getBoundingClientRect();
      coach.style.left = `${Math.round(box.left + (box.width - width) / 2)}px`;
      coach.style.top = `${Math.round(box.top + (box.height - height) / 2)}px`;
      coach.classList.add("coach-no-arrow");
      return;
    }
    const target = targets.reduce((best, item) => (item.getBoundingClientRect().left < best.getBoundingClientRect().left ? item : best));
    const box = target.getBoundingClientRect();
    const gap = 16;
    const spots = [
      { left: box.left + box.width / 2 - width / 2, top: box.top - height - gap },
      { left: box.left + box.width / 2 - width / 2, top: box.bottom + gap },
      { left: box.right + gap, top: box.top + box.height / 2 - height / 2 },
      { left: box.left - width - gap, top: box.top + box.height / 2 - height / 2 },
    ].map((spot) => ({
      left: clamp(spot.left, 8, window.innerWidth - width - 8),
      top: clamp(spot.top, 8, window.innerHeight - height - 8),
    }));
    const placed = spots
      .map((spot) => ({ ...spot, hit: overlaps(spot, width, height, box) }))
      .sort((a, b) => Number(a.hit) - Number(b.hit))[0]!;
    coach.style.left = `${Math.round(placed.left)}px`;
    coach.style.top = `${Math.round(placed.top)}px`;
    coach.classList.remove("coach-no-arrow");
    const placedBox = { left: placed.left, top: placed.top, right: placed.left + width, bottom: placed.top + height, width, height };
    const tx = box.left + box.width / 2;
    const ty = box.top + box.height / 2;
    const cx = placedBox.left + width / 2;
    const cy = placedBox.top + height / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    let arrowX = width / 2 - 7;
    let arrowY = -8;
    let turn = "-135deg";
    if (Math.abs(dx) > Math.abs(dy)) {
      arrowY = clamp(ty - placedBox.top - 7, 10, height - 24);
      if (dx > 0) {
        arrowX = width - 6;
        turn = "-45deg";
      } else {
        arrowX = -8;
        turn = "135deg";
      }
    } else {
      arrowX = clamp(tx - placedBox.left - 7, 10, width - 24);
      if (dy > 0) {
        arrowY = height - 6;
        turn = "45deg";
      }
    }
    coach.style.setProperty("--arrow-x", `${Math.round(arrowX)}px`);
    coach.style.setProperty("--arrow-y", `${Math.round(arrowY)}px`);
    coach.style.setProperty("--arrow-turn", turn);
  }

  function overlayHtml(game: GameState): string {
    if (lesson) return "";
    const result = game.lastResult;
    if (!result || result.passed) return "";
    if (game.phase !== "handComplete" && game.phase !== "matchComplete") return "";
    const bidder = result.bidder == null ? "" : seatWord(result.bidder, names);
    const trump = result.trump ? trumpName(result.trump) : "";
    const nello = result.trump?.kind === "nello";
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
      role === "guest"
        ? `<p class="dock-note">${game.phase === "matchComplete" ? "Waiting for the host to start the next match." : "Waiting for the host to start the next hand."}</p>`
        : game.phase === "matchComplete"
          ? `<button type="button" class="primary" data-act="new-match">New match</button>`
          : `<button type="button" class="primary" data-act="next">Next hand</button>`;
    const kicker = nello
      ? `${bidder} · Nello`
      : `${bidder} · ${String(result.bid)} · ${trump}`;
    return `
      <div class="overlay" role="dialog" aria-label="Hand result">
        <div class="result-card">
          <p class="result-kicker">${escapeHtml(kicker)}</p>
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
    return `You are ${seatTitle(me)}. Your partner is ${partner}.`;
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
  return `Player ${seat + 1}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function overlaps(spot: { left: number; top: number }, width: number, height: number, box: DOMRect): boolean {
  return !(spot.left + width < box.left || spot.left > box.right || spot.top + height < box.top || spot.top > box.bottom);
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
    return `${seatWord(game.shaker, names)} shook · ${high}`;
  }
  const need = needLine(game, viewer);
  return [contractLine(game, names), need].filter(Boolean).join(" · ");
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
  if (key === "nello") return { kind: "nello" };
  const suit = Number(key.slice("suit:".length));
  return { kind: "suit", suit };
}

function shownPoints(game: GameState, team: 0 | 1): number {
  let points = game.handPoints[team];
  if (game.phase === "trickComplete" && game.turn != null && teamOf(game.turn) === team && game.trump?.kind !== "nello") {
    points += trickPoints(game.currentTrick);
  }
  return points;
}

function bidMeterHtml(game: GameState, team: 0 | 1, viewer: Seat): string {
  if (game.highBid == null || game.highBidder == null) return "";
  if (game.phase === "bidding" || game.phase === "handComplete" || game.phase === "matchComplete") return "";
  const bidderTeam = teamOf(game.highBidder);
  const nello = game.trump?.kind === "nello";
  let fill = 0;
  let mark = 0;
  let label = "";
  if (nello) {
    const tricks = game.completedTricks.filter((trick) => teamOf(trick.winner) === team).length;
    fill = tricks / 7;
    mark = team === bidderTeam ? 1 / 7 : 1;
    label = team === bidderTeam ? "Any trick sets nello" : "Take every trick";
  } else {
    const need = Math.min(game.highBid, 42);
    const points = shownPoints(game, team);
    fill = points / 42;
    if (team === bidderTeam) {
      mark = need / 42;
      label = `${need} to make`;
    } else {
      const setAt = game.highBid >= 42 ? 1 : 42 - need + 1;
      mark = Math.min(setAt, 42) / 42;
      label = `${setAt} to set`;
    }
  }
  const width = Math.max(0, Math.min(100, fill * 100));
  const left = Math.max(0, Math.min(100, mark * 100));
  const tone = team === teamOf(viewer) ? "us" : "them";
  return `<div class="bid-meter ${tone}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="bid-meter-fill" style="width:${width.toFixed(2)}%"></span><span class="bid-meter-mark" style="left:${left.toFixed(2)}%"></span></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
