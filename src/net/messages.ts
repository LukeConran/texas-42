import type { Seat } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";

export type Names = (string | null)[];

export type NetMessage =
  | { type: "hello"; name: string }
  | { type: "sync"; view: PlayerView; names: Names; note: string }
  | { type: "action"; action: Action }
  | { type: "rematch" };

export function encode(message: NetMessage): string {
  return JSON.stringify(message);
}

export function decode(raw: string): NetMessage | null {
  try {
    const value = JSON.parse(raw) as NetMessage;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export function isSeat(value: number): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3;
}
