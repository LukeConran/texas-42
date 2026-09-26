export interface GuestOffer {
  id: string;
  offer: string;
  answer: string | null;
  candidates: string[];
}

async function post(body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new Error("The room service returned a page instead of a room code.");
  }
  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : "The room service failed.";
    throw new Error(error);
  }
  return payload;
}

export async function createRoom(): Promise<{ code: string; hostId: string }> {
  const payload = await post({ op: "create" });
  const code = payload.code;
  const hostId = payload.hostId;
  if (typeof code !== "string" || typeof hostId !== "string") {
    throw new Error("The room service did not return a code.");
  }
  return { code, hostId };
}

export async function joinRoom(code: string, offer: string): Promise<string> {
  const payload = await post({ op: "join", code, offer });
  const guestId = payload.guestId;
  if (typeof guestId !== "string") throw new Error("The room service did not accept the join.");
  return guestId;
}

export async function pollHost(code: string): Promise<GuestOffer[]> {
  const payload = await post({ op: "host", code });
  const guests = payload.guests;
  if (!Array.isArray(guests)) return [];
  return guests.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.offer !== "string") return [];
    return [
      {
        id: record.id,
        offer: record.offer,
        answer: typeof record.answer === "string" ? record.answer : null,
        candidates: stringList(record.candidates),
      },
    ];
  });
}

export async function publishAnswer(code: string, guestId: string, answer: string): Promise<void> {
  await post({ op: "answer", code, guestId, answer });
}

export async function publishCandidate(
  code: string,
  guestId: string,
  from: "guest" | "host",
  candidate: string,
): Promise<void> {
  await post({ op: "ice", code, guestId, from, candidate });
}

export async function enterRoom(code: string, name: string): Promise<string> {
  const payload = await post({ op: "enter", code, name });
  const guestId = payload.guestId;
  if (typeof guestId !== "string") throw new Error("The room service did not accept the join.");
  return guestId;
}

export async function postMail(
  code: string,
  guestId: string,
  box: "toHost" | "toGuest",
  body: string,
  hostId?: string,
): Promise<void> {
  await post({ op: "post", code, guestId, box, body, hostId });
}

export async function leaveRoom(code: string, guestId: string): Promise<void> {
  await post({ op: "leave", code, guestId });
}

export async function closeRoom(code: string, hostId: string): Promise<void> {
  await post({ op: "close", code, hostId });
}

export interface MailItem {
  n: number;
  body: string;
}

export interface SeatedGuest {
  id: string;
  name: string;
  lastSeen: number;
  enteredAt: number;
}

export async function hostBox(
  code: string,
  hostId: string,
  after: Record<string, number>,
): Promise<{ now: number; guests: SeatedGuest[]; mail: Array<{ guestId: string; n: number; body: string }> }> {
  const payload = await post({ op: "hostBox", code, hostId, after });
  const guests = Array.isArray(payload.guests) ? payload.guests.flatMap(readSeated) : [];
  const mail = Array.isArray(payload.mail) ? payload.mail.flatMap(readHostMail) : [];
  return { now: typeof payload.now === "number" ? payload.now : Date.now(), guests, mail };
}

export async function guestBox(code: string, guestId: string, after: number): Promise<MailItem[]> {
  const payload = await post({ op: "guestBox", code, guestId, after });
  if (!Array.isArray(payload.mail)) return [];
  return payload.mail.flatMap(readMailItem);
}

function readSeated(value: unknown): SeatedGuest[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return [];
  return [
    {
      id: record.id,
      name: typeof record.name === "string" ? record.name : "",
      lastSeen: typeof record.lastSeen === "number" ? record.lastSeen : 0,
      enteredAt: typeof record.enteredAt === "number" ? record.enteredAt : 0,
    },
  ];
}

function readHostMail(value: unknown): Array<{ guestId: string; n: number; body: string }> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.guestId !== "string" || typeof record.n !== "number" || typeof record.body !== "string") return [];
  return [{ guestId: record.guestId, n: record.n, body: record.body }];
}

function readMailItem(value: unknown): MailItem[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.n !== "number" || typeof record.body !== "string") return [];
  return [{ n: record.n, body: record.body }];
}

export async function pollGuest(code: string, guestId: string): Promise<{ answer: string | null; candidates: string[] }> {
  const payload = await post({ op: "guest", code, guestId });
  return {
    answer: typeof payload.answer === "string" ? payload.answer : null,
    candidates: stringList(payload.candidates),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
