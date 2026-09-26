import { afterEach, describe, expect, it } from "vitest";
import { roomFetch } from "../src/server/roomFunction";
import { handleSignal, resetMemoryRooms } from "../src/server/signal";

afterEach(() => {
  resetMemoryRooms();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
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
    expect(waiting.body).toEqual({ answer: null, candidates: [] });

    const host = await handleSignal({ op: "host", code });
    const guests = (host.body as { guests: Array<{ id: string; offer: string; candidates: string[] }> }).guests;
    expect(guests).toEqual([{ id: guestId, offer: "v=0\r\noffer", answer: null, candidates: [] }]);

    const answered = await handleSignal({ op: "answer", code, guestId, answer: "v=0\r\nanswer" });
    expect(answered.status).toBe(200);
    const iced = await handleSignal({
      op: "ice",
      code,
      guestId,
      from: "host",
      candidate: JSON.stringify({ candidate: "candidate:1 1 udp 1 1.2.3.4 9 typ srflx", sdpMid: "0" }),
    });
    expect(iced.status).toBe(200);
    const ready = await handleSignal({ op: "guest", code, guestId });
    expect(ready.body).toEqual({
      answer: "v=0\r\nanswer",
      candidates: [JSON.stringify({ candidate: "candidate:1 1 udp 1 1.2.3.4 9 typ srflx", sdpMid: "0" })],
    });
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

  it("passes a move from the guest to the host and the hand back", async () => {
    const created = await handleSignal({ op: "create" });
    const { code, hostId } = created.body as { code: string; hostId: string };
    expect(hostId).toMatch(/^[A-Z2-9]{16}$/);
    const entered = await handleSignal({ op: "enter", code, name: "Ada" });
    expect(entered.status).toBe(200);
    const guestId = (entered.body as { guestId: string }).guestId;
    expect(guestId).toMatch(/^[A-Z2-9]{16}$/);

    const posted = await handleSignal({ op: "post", code, guestId, box: "toHost", body: "{\"type\":\"hello\"}" });
    expect(posted.status).toBe(200);
    const denied = await handleSignal({ op: "hostBox", code, after: {} });
    expect(denied.status).toBe(403);
    const host = await handleSignal({ op: "hostBox", code, hostId, after: {} });
    const hostBody = host.body as { guests: Array<{ id: string; name: string }>; mail: Array<{ guestId: string; n: number; body: string }> };
    expect(hostBody.guests.map((guest) => guest.name)).toEqual(["Ada"]);
    expect(hostBody.mail).toEqual([{ guestId, n: 0, body: "{\"type\":\"hello\"}" }]);

    const sneaky = await handleSignal({ op: "post", code, guestId, box: "toGuest", body: "nope" });
    expect(sneaky.status).toBe(403);
    await handleSignal({ op: "post", code, guestId, box: "toGuest", body: "sync", hostId });
    const guest = await handleSignal({ op: "guestBox", code, guestId, after: 0 });
    expect(guest.body).toEqual({ mail: [{ n: 0, body: "sync" }] });
    const rest = await handleSignal({ op: "guestBox", code, guestId, after: 1 });
    expect(rest.body).toEqual({ mail: [] });

    await handleSignal({ op: "close", code, hostId });
    const gone = await handleSignal({ op: "guestBox", code, guestId, after: 1 });
    expect(gone.status).toBe(404);
  });

  it("answers JSON when Vercel calls the function with a web request", async () => {
    const response = await roomFetch(
      new Request("https://texas42.local/api/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "create" }),
      }),
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { code: string };
    expect(body.code).toMatch(/^[A-Z2-9]{4}$/);
  });

  it("turns a non-JSON room store reply into a JSON error", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.test/redis";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("A server error has occurred", { status: 500 })) as typeof fetch;
    try {
      const result = await handleSignal({ op: "create" });
      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        error: "The room store did not return JSON. Use the Upstash REST URL and token, then redeploy.",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
