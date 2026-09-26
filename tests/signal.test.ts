import { afterEach, describe, expect, it } from "vitest";
import handler from "../api/signal";
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

  it("answers JSON when Vercel calls the function with a web request", async () => {
    const response = await handler.fetch(
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
