import { afterEach, describe, expect, it } from "vitest";
import { chatText, decode, encode } from "../src/net/messages";
import { handleSignal, resetMemoryRooms } from "../src/server/signal";

afterEach(() => {
  resetMemoryRooms();
});

describe("table talk", () => {
  it("keeps a spoken line and drops a blank one", () => {
    expect(chatText("  pass  ")).toBe("pass");
    expect(chatText("   ")).toBeNull();
    expect(chatText(30)).toBeNull();
    expect(chatText("x".repeat(250))).toHaveLength(200);
    expect(decode(JSON.stringify({ type: "chat", text: "  hello   table  ", from: " Ada " }))).toEqual({
      type: "chat",
      text: "hello table",
      from: "Ada",
    });
    expect(decode('{"type":"chat","text":""}')).toBeNull();
    expect(decode('{"type":"chat","text":12}')).toBeNull();
    expect(decode('{"type":"action","action":{"type":"bid","amount":"pass"}}')?.type).toBe("action");
  });

  it("relays chat through the room mailbox and drops it when the room closes", async () => {
    const created = await handleSignal({ op: "create" });
    const { code, hostId } = created.body as { code: string; hostId: string };
    const entered = await handleSignal({ op: "enter", code, name: "Ada" });
    const guestId = (entered.body as { guestId: string }).guestId;
    const body = encode({ type: "chat", text: "nice hand" });
    const posted = await handleSignal({ op: "post", code, guestId, box: "toHost", body });
    expect(posted.status).toBe(200);

    const host = await handleSignal({ op: "hostBox", code, hostId, after: {} });
    const mail = (host.body as { mail: Array<{ body: string }> }).mail;
    expect(mail.map((item) => decode(item.body))).toEqual([{ type: "chat", text: "nice hand" }]);

    await handleSignal({ op: "post", code, guestId, box: "toGuest", body: encode({ type: "chat", text: "thanks", from: "Host" }), hostId });
    const guest = await handleSignal({ op: "guestBox", code, guestId, after: 0 });
    expect((guest.body as { mail: Array<{ body: string }> }).mail.map((item) => decode(item.body))).toEqual([
      { type: "chat", text: "thanks", from: "Host" },
    ]);

    const closed = await handleSignal({ op: "close", code, hostId });
    expect(closed.status).toBe(200);
    const gone = await handleSignal({ op: "guestBox", code, guestId, after: 0 });
    expect(gone.status).not.toBe(200);
  });
});
