import { afterEach, describe, expect, it } from "vitest";
import { handleSignal, resetMemoryRooms } from "../src/server/signal";

afterEach(() => {
  resetMemoryRooms();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("room doorbell", () => {
  it("stores an offer until the host posts an answer", async () => {
    const created = await handleSignal({ op: "create" });
    expect(created.status).toBe(200);
    const code = (created.body as { code: string }).code;
    expect(code).toMatch(/^[A-Z2-9]{4}$/);

    const joined = await handleSignal({ op: "join", code, offer: "v=0\r\noffer" });
    expect(joined.status).toBe(200);
    const guestId = (joined.body as { guestId: string }).guestId;

    const waiting = await handleSignal({ op: "guest", code, guestId });
    expect(waiting.body).toEqual({ answer: null });

    const host = await handleSignal({ op: "host", code });
    const guests = (host.body as { guests: Array<{ id: string; offer: string }> }).guests;
    expect(guests).toEqual([{ id: guestId, offer: "v=0\r\noffer", answer: null }]);

    const answered = await handleSignal({ op: "answer", code, guestId, answer: "v=0\r\nanswer" });
    expect(answered.status).toBe(200);
    const ready = await handleSignal({ op: "guest", code, guestId });
    expect(ready.body).toEqual({ answer: "v=0\r\nanswer" });
  });

  it("stops a fourth guest", async () => {
    const created = await handleSignal({ op: "create" });
    const code = (created.body as { code: string }).code;
    for (let i = 0; i < 3; i++) {
      const joined = await handleSignal({ op: "join", code, offer: `v=0\r\noffer-${i}` });
      expect(joined.status).toBe(200);
    }
    const full = await handleSignal({ op: "join", code, offer: "v=0\r\noffer-extra" });
    expect(full.status).toBe(409);
  });
});
