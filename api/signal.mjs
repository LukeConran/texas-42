// src/server/signal.ts
var memory = /* @__PURE__ */ new Map();
var ROOM_TTL_SECONDS = 60 * 60 * 6;
var MAX_OFFER = 2e4;
var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function handleSignal(body) {
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
      const guest = { id: makeCode(), offer, answer: null };
      room.guests.push(guest);
      await saveRoom(room);
      return { status: 200, body: { guestId: guest.id } };
    }
    if (op === "host") {
      const room = await loadRoom(cleanCode(msg.code));
      if (!room) return { status: 404, body: { error: "That room does not exist." } };
      return {
        status: 200,
        body: { guests: room.guests.map((guest) => ({ id: guest.id, offer: guest.offer, answer: guest.answer })) }
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
function asRecord(body) {
  if (typeof body === "string") {
    try {
      return asRecord(JSON.parse(body));
    } catch {
      return {};
    }
  }
  if (body && typeof body === "object") return body;
  return {};
}
function cleanCode(value) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}
function makeCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}
function redisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
  if (!url || !token) return null;
  return { url, token };
}
async function loadRoom(code) {
  if (!code) return null;
  if (!redisCredentials()) return memory.get(code) ?? null;
  const raw = await redis(["GET", key(code)]);
  if (!raw) return null;
  return JSON.parse(raw);
}
async function saveRoom(room) {
  if (!redisCredentials()) {
    memory.set(room.code, room);
    return room;
  }
  await redis(["SET", key(room.code), JSON.stringify(room), "EX", String(ROOM_TTL_SECONDS)]);
  return room;
}
function key(code) {
  return `texas42:room:${code}`;
}
async function redis(command) {
  const creds = redisCredentials();
  if (!creds) throw new Error("Redis is not configured.");
  let response;
  try {
    response = await fetch(creds.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command)
    });
  } catch {
    throw new Error("Could not reach the room store. Check UPSTASH_REDIS_REST_URL.");
  }
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("The room store did not return JSON. Use the Upstash REST URL and token, then redeploy.");
  }
  if (!response.ok || payload.error) throw new Error(payload.error || "The room store rejected the request.");
  return payload.result;
}

// src/server/roomFunction.ts
async function roomFetch(request) {
  try {
    if (request.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const result = await handleSignal(body);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Room service failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
export {
  roomFetch
};

export default {
  async fetch(request) {
    return roomFetch(request);
  },
};
