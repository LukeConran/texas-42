export interface GuestOffer {
  id: string;
  offer: string;
  answer: string | null;
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

export async function createRoom(): Promise<string> {
  const payload = await post({ op: "create" });
  const code = payload.code;
  if (typeof code !== "string") throw new Error("The room service did not return a code.");
  return code;
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
    return [{ id: record.id, offer: record.offer, answer: typeof record.answer === "string" ? record.answer : null }];
  });
}

export async function publishAnswer(code: string, guestId: string, answer: string): Promise<void> {
  await post({ op: "answer", code, guestId, answer });
}

export async function pollGuest(code: string, guestId: string): Promise<string | null> {
  const payload = await post({ op: "guest", code, guestId });
  return typeof payload.answer === "string" ? payload.answer : null;
}
