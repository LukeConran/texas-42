/**
 * Room doorbell. It stores a WebRTC offer and answer so two browsers can find
 * each other. It never sees dominos or hands.
 *
 * On one machine (local dev, tests) the rooms live in memory.
 * On Vercel, set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN so every
 * function instance reads the same room.
 */

export interface GuestSlot {
  id: string;
  offer: string;
  answer: string | null;
}

export interface RoomRecord {
  code: string;
  createdAt: number;
  guests: GuestSlot[];
}

const memory = new Map<string, RoomRecord>();
const ROOM_TTL_SECONDS = 60 * 60 * 6;
const MAX_OFFER = 20_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function handleSignal(body: unknown): Promise<{ status: number; body: unknown }> {
  const msg = asRecord(body);
  const op = typeof msg.op === "string" ? msg.op : "";
  try {
    if (op === "create") {
      const room = await saveRoom({ code: makeCode(), createdAt: Date.now(), guests: [] });
      return { status: 200, body: { code: room.code } };
    }
    if (op === "join") {
      const code = cleanCode(msg.code);
      const offer = typeof msg.offer === "string" ? msg.offer : "";
      if (!code || offer.length < 10 || offer.length > MAX_OFFER) {
        return { status: 400, body: { error: "Missing room code or connection offer." } };
      }
      const room = await loadRoom(code);
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      if (room.guests.length >= 3) return { status: 409, body: { error: "That room is full." } };
      const guest: GuestSlot = { id: makeCode(), offer, answer: null };
      room.guests.push(guest);
      await saveRoom(room);
      return { status: 200, body: { guestId: guest.id } };
    }
    if (op === "host") {
      const room = await loadRoom(cleanCode(msg.code));
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      return {
        status: 200,
        body: { guests: room.guests.map((guest) => ({ id: guest.id, offer: guest.offer, answer: guest.answer })) },
      };
    }
    if (op === "answer") {
      const room = await loadRoom(cleanCode(msg.code));
      const answer = typeof msg.answer === "string" ? msg.answer : "";
      const guestId = typeof msg.guestId === "string" ? msg.guestId : "";
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      if (answer.length < 10 || answer.length > MAX_OFFER) {
        return { status: 400, body: { error: "Missing connection answer." } };
      }
      const guest = room.guests.find((item) => item.id === guestId);
      if (!guest) return { status: 404, body: { error: "That player is not in the room." } };
      guest.answer = answer;
      await saveRoom(room);
      return { status: 200, body: { ok: true } };
    }
    if (op === "guest") {
      const room = await loadRoom(cleanCode(msg.code));
      const guestId = typeof msg.guestId === "string" ? msg.guestId : "";
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      const guest = room.guests.find((item) => item.id === guestId);
      if (!guest) return { status: 404, body: { error: "That player is not in the room." } };
      return { status: 200, body: { answer: guest.answer } };
    }
    return { status: 400, body: { error: "Unknown room request." } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Room service failed.";
    return { status: 503, body: { error: message } };
  }
}

export function resetMemoryRooms(): void {
  memory.clear();
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    try {
      return asRecord(JSON.parse(body));
    } catch {
      return {};
    }
  }
  if (body && typeof body === "object") return body as Record<string, unknown>;
  return {};
}

function cleanCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function makeCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!;
  return code;
}

function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function loadRoom(code: string): Promise<RoomRecord | null> {
  if (!code) return null;
  if (!redisConfigured()) return memory.get(code) ?? null;
  const raw = await redis<string | null>(["GET", key(code)]);
  if (!raw) return null;
  return JSON.parse(raw) as RoomRecord;
}

async function saveRoom(room: RoomRecord): Promise<RoomRecord> {
  if (!redisConfigured()) {
    memory.set(room.code, room);
    return room;
  }
  await redis(["SET", key(room.code), JSON.stringify(room), "EX", String(ROOM_TTL_SECONDS)]);
  return room;
}

function key(code: string): string {
  return `texas42:room:${code}`;
}

async function redis<T>(command: string[]): Promise<T> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis is not configured.");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("The room store rejected the request.");
  const payload = (await response.json()) as { result?: T; error?: string };
  if (payload.error) throw new Error(payload.error);
  return payload.result as T;
}
