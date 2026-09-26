/**
 * Room mailbox. The host's browser still deals and decides what is legal.
 * Messages, including each guest's own tiles, travel through this store.
 * The room code lets a friend enter. Reading or sending a hand also takes
 * the host secret or that guest's own id.
 *
 * On one machine (local dev, tests) the rooms live in memory.
 * On Vercel, set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * (or the KV_REST_API_URL and KV_REST_API_TOKEN names the Marketplace injects)
 * so every function instance reads the same room.
 */

export interface GuestSlot {
  id: string;
  offer: string;
  answer: string | null;
  /** ICE candidates the guest discovered after the offer. */
  fromGuest: string[];
  /** ICE candidates the host discovered after the answer. */
  fromHost: string[];
}

export interface RoomRecord {
  code: string;
  createdAt: number;
  /** Returned once, to the browser that created the room. */
  hostId: string;
  /** Last time that browser polled. Guests leave when this goes stale. */
  hostSeen: number;
  guests: GuestSlot[];
}

const memory = new Map<string, RoomRecord>();
const mailboxes = new Map<string, Map<string, MailGuest>>();

interface MailGuest {
  id: string;
  name: string;
  enteredAt: number;
  lastSeen: number;
  toHost: string[];
  toGuest: string[];
}
const ROOM_TTL_SECONDS = 60 * 60 * 6;
/** A quiet tab can throttle timers for about a minute, so this waits longer. */
const STALE_MS = 180_000;
const HEARTBEAT_MS = 8_000;
const MAX_OFFER = 60_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function handleSignal(body: unknown): Promise<{ status: number; body: unknown }> {
  const msg = asRecord(body);
  const op = typeof msg.op === "string" ? msg.op : "";
  try {
    if (op === "create") {
      const now = Date.now();
      const room = await saveRoom({
        code: makeCode(),
        createdAt: now,
        hostId: makeSecret(),
        hostSeen: now,
        guests: [],
      });
      return { status: 200, body: { code: room.code, hostId: room.hostId } };
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
      const guest: GuestSlot = { id: makeCode(), offer, answer: null, fromGuest: [], fromHost: [] };
      room.guests.push(guest);
      await saveRoom(room);
      return { status: 200, body: { guestId: guest.id } };
    }
    if (op === "host") {
      const room = await loadRoom(cleanCode(msg.code));
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      const guests: Array<{ id: string; offer: string; answer: string | null; candidates: string[] }> = [];
      for (const guest of room.guests) {
        guests.push({
          id: guest.id,
          offer: guest.offer,
          answer: await readAnswer(room.code, guest),
          candidates: await readCandidates(room.code, guest, "guest"),
        });
      }
      return { status: 200, body: { guests } };
    }
    if (op === "ice") {
      const room = await loadRoom(cleanCode(msg.code));
      const guestId = typeof msg.guestId === "string" ? msg.guestId : "";
      const candidate = typeof msg.candidate === "string" ? msg.candidate : "";
      const side = msg.from === "host" ? "host" : msg.from === "guest" ? "guest" : "";
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      if (!side || candidate.length < 2 || candidate.length > 2_000) {
        return { status: 400, body: { error: "Missing connection candidate." } };
      }
      const guest = room.guests.find((item) => item.id === guestId);
      if (!guest) return { status: 404, body: { error: "That player is not in the room." } };
      await pushCandidate(room.code, guest, side, candidate);
      return { status: 200, body: { ok: true } };
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
      await writeAnswer(room.code, guest, answer);
      return { status: 200, body: { ok: true } };
    }
    if (op === "guest") {
      const room = await loadRoom(cleanCode(msg.code));
      const guestId = typeof msg.guestId === "string" ? msg.guestId : "";
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      const guest = room.guests.find((item) => item.id === guestId);
      if (!guest) return { status: 404, body: { error: "That player is not in the room." } };
      return {
        status: 200,
        body: {
          answer: await readAnswer(room.code, guest),
          candidates: await readCandidates(room.code, guest, "host"),
        },
      };
    }
    if (op === "enter") {
      const code = cleanCode(msg.code);
      const room = await loadRoom(code);
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      if (Date.now() - room.hostSeen > STALE_MS) {
        return { status: 404, body: { error: "The host closed the room." } };
      }
      const now = Date.now();
      const live = (await listMailGuests(code)).filter((guest) => now - guest.lastSeen <= STALE_MS);
      if (live.length >= 3) return { status: 409, body: { error: "That room is full." } };
      const name = cleanPlayerName(msg.name);
      const guestId = makeSecret();
      await rememberGuest(code, { id: guestId, name, enteredAt: now, lastSeen: now, toHost: [], toGuest: [] });
      return { status: 200, body: { guestId } };
    }
    if (op === "post") {
      const code = cleanCode(msg.code);
      const guestId = typeof msg.guestId === "string" ? msg.guestId : "";
      const box = msg.box === "toHost" || msg.box === "toGuest" ? msg.box : "";
      const text = typeof msg.body === "string" ? msg.body : "";
      const guest = await findMailGuest(code, guestId);
      if (!guest || !box) return { status: 404, body: { error: "That player is not in the room." } };
      if (box === "toGuest") {
        const room = await loadRoom(code);
        if (!room || !hostMatches(room, msg.hostId)) {
          return { status: 403, body: { error: "Only the host can send that." } };
        }
      }
      if (text.length < 1 || text.length > 100_000) return { status: 400, body: { error: "That message cannot be delivered." } };
      guest.lastSeen = Date.now();
      await saveMailGuest(code, guest);
      await pushMail(code, guest, box, text);
      return { status: 200, body: { ok: true } };
    }
    if (op === "hostBox") {
      const code = cleanCode(msg.code);
      const room = await loadRoom(code);
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      if (!hostMatches(room, msg.hostId)) return { status: 403, body: { error: "Only the host can read that." } };
      await touchHost(room);
      const after = afterMap(msg.after);
      const guests = await listMailGuests(code);
      const mail: Array<{ guestId: string; n: number; body: string }> = [];
      for (const guest of guests) {
        const seen = after[guest.id] ?? 0;
        const items = await readMail(code, guest, "toHost", seen);
        for (const item of items) mail.push({ guestId: guest.id, n: item.n, body: item.body });
      }
      return {
        status: 200,
        body: {
          now: Date.now(),
          guests: guests.map((guest) => ({
            id: guest.id,
            name: guest.name,
            lastSeen: guest.lastSeen,
            enteredAt: guest.enteredAt,
          })),
          mail,
        },
      };
    }
    if (op === "guestBox") {
      const code = cleanCode(msg.code);
      const room = await loadRoom(code);
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      if (Date.now() - room.hostSeen > STALE_MS) {
        return { status: 404, body: { error: "The host closed the room." } };
      }
      const guestId = typeof msg.guestId === "string" ? msg.guestId : "";
      const guest = await findMailGuest(code, guestId);
      if (!guest) return { status: 404, body: { error: "That player is not in the room." } };
      const now = Date.now();
      if (now - guest.lastSeen > HEARTBEAT_MS) {
        guest.lastSeen = now;
        await saveMailGuest(code, guest);
      }
      const after = typeof msg.after === "number" && msg.after > 0 ? Math.floor(msg.after) : 0;
      const items = await readMail(code, guest, "toGuest", after);
      return { status: 200, body: { mail: items } };
    }
    if (op === "leave") {
      const code = cleanCode(msg.code);
      const guestId = typeof msg.guestId === "string" ? msg.guestId : "";
      if (code && guestId) await forgetGuest(code, guestId);
      return { status: 200, body: { ok: true } };
    }
    if (op === "close") {
      const code = cleanCode(msg.code);
      const room = await loadRoom(code);
      if (!room || !hostMatches(room, msg.hostId)) {
        return { status: 404, body: { error: "That room does not exist." } };
      }
      await deleteRoom(code);
      return { status: 200, body: { ok: true } };
    }
    return { status: 400, body: { error: "Unknown room request." } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Room service failed.";
    return { status: 503, body: { error: message } };
  }
}

export function resetMemoryRooms(): void {
  memory.clear();
  mailboxes.clear();
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

function redisCredentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
  if (!url || !token) return null;
  return { url, token };
}

async function loadRoom(code: string): Promise<RoomRecord | null> {
  if (!code) return null;
  if (!redisCredentials()) return memory.get(code) ?? null;
  const raw = await redis<string | null>(["GET", key(code)]);
  if (!raw) return null;
  const room = JSON.parse(raw) as RoomRecord;
  for (const guest of room.guests) {
    guest.fromGuest ??= [];
    guest.fromHost ??= [];
  }
  return room;
}

async function readAnswer(code: string, guest: GuestSlot): Promise<string | null> {
  if (!redisCredentials()) return guest.answer;
  const raw = await redis<string | null>(["GET", answerKey(code, guest.id)]);
  return typeof raw === "string" ? raw : guest.answer;
}

async function writeAnswer(code: string, guest: GuestSlot, answer: string): Promise<void> {
  guest.answer = answer;
  if (!redisCredentials()) return;
  // The answer lives in its own key so a candidate write cannot erase it.
  await redis(["SET", answerKey(code, guest.id), answer, "EX", String(ROOM_TTL_SECONDS)]);
}

async function readCandidates(code: string, guest: GuestSlot, side: "guest" | "host"): Promise<string[]> {
  if (!redisCredentials()) return side === "guest" ? guest.fromGuest : guest.fromHost;
  const raw = await redis<string[] | null>(["LRANGE", iceKey(code, guest.id, side), "0", "-1"]);
  return Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : [];
}

async function pushCandidate(code: string, guest: GuestSlot, side: "guest" | "host", candidate: string): Promise<void> {
  if (!redisCredentials()) {
    const list = side === "guest" ? guest.fromGuest : guest.fromHost;
    if (!list.includes(candidate)) list.push(candidate);
    return;
  }
  const slot = iceKey(code, guest.id, side);
  await redis(["RPUSH", slot, candidate]);
  await redis(["LTRIM", slot, "-40", "-1"]);
  await redis(["EXPIRE", slot, String(ROOM_TTL_SECONDS)]);
}

function answerKey(code: string, guestId: string): string {
  return `texas42:answer:${code}:${guestId}`;
}

function iceKey(code: string, guestId: string, side: "guest" | "host"): string {
  return `texas42:ice:${code}:${guestId}:${side}`;
}

async function saveRoom(room: RoomRecord): Promise<RoomRecord> {
  if (!redisCredentials()) {
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
  const creds = redisCredentials();
  if (!creds) throw new Error("Redis is not configured.");
  let response: Response;
  try {
    response = await fetch(creds.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  } catch {
    throw new Error("Could not reach the room store. Check UPSTASH_REDIS_REST_URL.");
  }
  const raw = await response.text();
  let payload: { result?: T; error?: string };
  try {
    payload = JSON.parse(raw) as { result?: T; error?: string };
  } catch {
    throw new Error("The room store did not return JSON. Use the Upstash REST URL and token, then redeploy.");
  }
  if (!response.ok || payload.error) throw new Error(payload.error || "The room store rejected the request.");
  return payload.result as T;
}

function hostMatches(room: RoomRecord, value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value === room.hostId;
}

async function touchHost(room: RoomRecord): Promise<void> {
  const now = Date.now();
  if (now - room.hostSeen < HEARTBEAT_MS) return;
  room.hostSeen = now;
  await saveRoom(room);
}

async function deleteRoom(code: string): Promise<void> {
  if (!redisCredentials()) {
    memory.delete(code);
    mailboxes.delete(code);
    return;
  }
  await redis(["DEL", key(code)]);
}

function makeSecret(): string {
  let id = "";
  for (let i = 0; i < 16; i++) id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!;
  return id;
}

function cleanPlayerName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 16);
}

function afterMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(record)) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[id] = Math.floor(n);
  }
  return out;
}

function mailMap(code: string): Map<string, MailGuest> {
  let box = mailboxes.get(code);
  if (!box) {
    box = new Map();
    mailboxes.set(code, box);
  }
  return box;
}

function guestSetKey(code: string): string {
  return `texas42:guests:${code}`;
}

function guestMetaKey(code: string, guestId: string): string {
  return `texas42:guest:${code}:${guestId}`;
}

function mailListKey(code: string, guestId: string, box: "toHost" | "toGuest"): string {
  return `texas42:mail:${code}:${guestId}:${box}`;
}

async function listMailGuests(code: string): Promise<MailGuest[]> {
  if (!redisCredentials()) return [...(mailboxes.get(code)?.values() ?? [])];
  const ids = await redis<string[] | null>(["SMEMBERS", guestSetKey(code)]);
  const guests: MailGuest[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const guest = await loadRedisGuest(code, id);
    if (guest) guests.push(guest);
  }
  return guests;
}

async function findMailGuest(code: string, guestId: string): Promise<MailGuest | null> {
  if (!guestId) return null;
  if (!redisCredentials()) return mailboxes.get(code)?.get(guestId) ?? null;
  return loadRedisGuest(code, guestId);
}

async function loadRedisGuest(code: string, guestId: string): Promise<MailGuest | null> {
  const raw = await redis<string | null>(["GET", guestMetaKey(code, guestId)]);
  if (!raw) return null;
  const meta = JSON.parse(raw) as { name?: string; enteredAt?: number; lastSeen?: number };
  return {
    id: guestId,
    name: typeof meta.name === "string" ? meta.name : "",
    enteredAt: typeof meta.enteredAt === "number" ? meta.enteredAt : 0,
    lastSeen: typeof meta.lastSeen === "number" ? meta.lastSeen : 0,
    toHost: [],
    toGuest: [],
  };
}

async function rememberGuest(code: string, guest: MailGuest): Promise<void> {
  if (!redisCredentials()) {
    mailMap(code).set(guest.id, guest);
    return;
  }
  await redis(["SADD", guestSetKey(code), guest.id]);
  await redis(["EXPIRE", guestSetKey(code), String(ROOM_TTL_SECONDS)]);
  await saveMailGuest(code, guest);
}

async function saveMailGuest(code: string, guest: MailGuest): Promise<void> {
  if (!redisCredentials()) {
    mailMap(code).set(guest.id, guest);
    return;
  }
  await redis([
    "SET",
    guestMetaKey(code, guest.id),
    JSON.stringify({ name: guest.name, enteredAt: guest.enteredAt, lastSeen: guest.lastSeen }),
    "EX",
    String(ROOM_TTL_SECONDS),
  ]);
}

async function pushMail(code: string, guest: MailGuest, box: "toHost" | "toGuest", message: string): Promise<void> {
  if (!redisCredentials()) {
    (box === "toHost" ? guest.toHost : guest.toGuest).push(message);
    return;
  }
  const slot = mailListKey(code, guest.id, box);
  await redis(["RPUSH", slot, message]);
  await redis(["EXPIRE", slot, String(ROOM_TTL_SECONDS)]);
}

async function forgetGuest(code: string, guestId: string): Promise<void> {
  if (!redisCredentials()) {
    mailboxes.get(code)?.delete(guestId);
    return;
  }
  await redis(["SREM", guestSetKey(code), guestId]);
  await redis(["DEL", guestMetaKey(code, guestId)]);
}

async function readMail(
  code: string,
  guest: MailGuest,
  box: "toHost" | "toGuest",
  start: number,
): Promise<Array<{ n: number; body: string }>> {
  const from = start > 0 ? start : 0;
  if (!redisCredentials()) {
    const list = box === "toHost" ? guest.toHost : guest.toGuest;
    return list.map((body, n) => ({ n, body })).filter((item) => item.n >= from);
  }
  const raw = await redis<string[] | null>(["LRANGE", mailListKey(code, guest.id, box), String(from), "-1"]);
  const list = Array.isArray(raw) ? raw.filter((body): body is string => typeof body === "string") : [];
  return list.map((body, i) => ({ n: from + i, body }));
}
