import type { Seat } from "../engine/domino";
import type { Action, PlayerView } from "../engine/game";

export type Names = (string | null)[];

export type NetMessage =
  | { type: "hello"; name: string }
  | { type: "sync"; view: PlayerView; names: Names; note: string }
  | { type: "action"; action: Action }
  | { type: "rematch" }
  | { type: "chat"; text: string; from?: string };

export const CHAT_LIMIT = 200;

/** Table talk is a room message, not a bid or a play. Blank lines are dropped. */
export function chatText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, CHAT_LIMIT);
}

export function chatSpeaker(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
}

export function encode(message: NetMessage): string {
  return JSON.stringify(message);
}

export function decode(raw: string): NetMessage | null {
  try {
    const value = JSON.parse(raw) as NetMessage;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
    if (value.type === "chat") {
      const text = chatText(value.text);
      if (!text) return null;
      const from = chatSpeaker(value.from);
      return from ? { type: "chat", text, from } : { type: "chat", text };
    }
    return value;
  } catch {
    return null;
  }
}

export function isSeat(value: number): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3;
}
