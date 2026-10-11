import { createDeck, dominoKey, type Seat } from "../engine/domino";
import type { Bid, GameState, Phase } from "../engine/game";

const SAVE_KEY = "texas42.table";

const PHASES: readonly Phase[] = ["bidding", "trump", "playing", "trickComplete", "handComplete", "matchComplete"];

export interface LocalSave {
  kind: "local";
  version: 1;
  state: GameState;
  pace: "relaxed" | "normal" | "fast";
  me: Seat;
  names: [string | null, string | null, string | null, string | null];
  wasOnline: boolean;
}

export interface GuestSave {
  kind: "guest";
  version: 1;
  room: string;
  name: string;
}

export type TableSave = LocalSave | GuestSave;

export function writeSave(storage: Storage, save: TableSave): void {
  storage.setItem(SAVE_KEY, JSON.stringify(save));
}

export function clearSave(storage: Storage): void {
  storage.removeItem(SAVE_KEY);
}

/** A saved table this browser can show again. Hidden guest hands are not a table. */
export function readSave(storage: Storage): TableSave | null {
  const raw = storage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1) return null;
    if (record.kind === "guest") return readGuest(record);
    if (record.kind === "local") return readLocal(record);
    return null;
  } catch {
    return null;
  }
}

function readGuest(record: Record<string, unknown>): GuestSave | null {
  if (typeof record.room !== "string" || typeof record.name !== "string") return null;
  const room = record.room.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (room.length < 4) return null;
  const name = record.name.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 16);
  return { kind: "guest", version: 1, room, name };
}

function readLocal(record: Record<string, unknown>): LocalSave | null {
  if (record.pace !== "relaxed" && record.pace !== "normal" && record.pace !== "fast") return null;
  if (!isSeat(record.me) || typeof record.wasOnline !== "boolean") return null;
  if (!Array.isArray(record.names) || record.names.length !== 4) return null;
  const names = record.names.map((item) => {
    if (item == null) return null;
    if (typeof item !== "string") return undefined;
    const name = item.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 16);
    return name || null;
  });
  if (names.some((item) => item === undefined)) return null;
  const state = record.state;
  if (!isGameState(state)) return null;
  return {
    kind: "local",
    version: 1,
    state,
    pace: record.pace,
    me: record.me,
    names: names as LocalSave["names"],
    wasOnline: record.wasOnline,
  };
}

function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== "object") return false;
  const state = value as GameState;
  if (!state.settings || (state.settings.scoringMode !== "points" && state.settings.scoringMode !== "marks")) return false;
  if (typeof state.settings.target !== "number" || typeof state.settings.seed !== "number") return false;
  if (typeof state.settings.openingLeadMustBeTrump !== "boolean") return false;
  if (typeof state.rng !== "number" || !PHASES.includes(state.phase)) return false;
  if (!isSeat(state.shaker) || !isSeat(state.bidLeader) || typeof state.handNumber !== "number") return false;
  if (state.turn != null && !isSeat(state.turn)) return false;
  if (!Array.isArray(state.hands) || state.hands.length !== 4) return false;
  if (!Array.isArray(state.bids) || state.bids.length !== 4 || !state.bids.every(isBid)) return false;
  if (!Array.isArray(state.currentTrick) || !Array.isArray(state.completedTricks)) return false;
  if (!pair(state.handPoints) || !pair(state.scores)) return false;
  if (state.highBid != null && typeof state.highBid !== "number") return false;
  if (state.highBidder != null && !isSeat(state.highBidder)) return false;
  if (!Array.isArray(state.log)) return false;
  const keys = new Set<string>();
  for (const hand of state.hands) {
    if (!Array.isArray(hand) || !hand.every((domino) => keepTile(domino, keys))) return false;
  }
  for (const play of state.currentTrick) {
    if (!play || !isSeat(play.player) || !keepTile(play.domino, keys)) return false;
  }
  for (const trick of state.completedTricks) {
    if (!trick || !isSeat(trick.winner) || typeof trick.points !== "number" || !Array.isArray(trick.plays)) return false;
    for (const play of trick.plays) {
      if (!play || !isSeat(play.player) || !keepTile(play.domino, keys)) return false;
    }
  }
  const deck = new Set(createDeck().map(dominoKey));
  if (keys.size !== deck.size) return false;
  for (const key of keys) if (!deck.has(key)) return false;
  if ((state.phase === "playing" || state.phase === "trickComplete") && !state.trump) return false;
  return true;
}

function isBid(value: unknown): value is Bid | null {
  if (value == null) return true;
  if (typeof value !== "object") return false;
  const bid = value as Bid;
  if (bid.kind === "pass") return true;
  return bid.kind === "bid" && typeof bid.amount === "number";
}

function pair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number");
}

function keepTile(value: unknown, keys: Set<string>): boolean {
  if (!value || typeof value !== "object") return false;
  const tile = value as { hi?: unknown; lo?: unknown };
  if (typeof tile.hi !== "number" || typeof tile.lo !== "number") return false;
  if (!Number.isInteger(tile.hi) || !Number.isInteger(tile.lo)) return false;
  if (tile.hi < 0 || tile.hi > 6 || tile.lo < 0 || tile.lo > 6 || tile.lo > tile.hi) return false;
  const key = dominoKey({ hi: tile.hi, lo: tile.lo });
  if (keys.has(key)) return false;
  keys.add(key);
  return true;
}
