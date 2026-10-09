import type { Seat } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";

export type Names = (string | null)[];

export type NetMessage =
  | { type: "hello"; name: string }
  | { type: "sync"; view: PlayerView; names: Names; note: string }
  | { type: "action"; action: Action }
  | { type: "rematch" }
  | { type: "seated"; seat: Seat; names: Names };

export function encode(message: NetMessage): string {
  return JSON.stringify(message);
}

export function decode(raw: string): NetMessage | null {
  try {
    const value = JSON.parse(raw) as NetMessage;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
    if (value.type === "seated") {
      if (!isSeat(value.seat) || !Array.isArray(value.names)) return null;
      const names = [0, 1, 2, 3].map((index) => {
        const item = value.names[index];
        if (typeof item !== "string") return null;
        const name = item.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 16);
        return name || null;
      }) as Names;
      return { type: "seated", seat: value.seat, names };
    }
    return value;
  } catch {
    return null;
  }
}

export function isSeat(value: number): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3;
}
