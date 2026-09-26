import type { Seat } from "../engine/domino";
import { nextSeat } from "../engine/domino";
import type { Names, NetMessage } from "./messages";
import { decode, encode } from "./messages";
import { closeRoom, createRoom, enterRoom, guestBox, hostBox, leaveRoom, postMail } from "./signalClient";

/** Matches the server. A background tab can pause timers for about a minute. */
const STALE_MS = 180_000;

export interface HostLink {
  code: string;
  send(seat: Seat, message: NetMessage): void;
  close(): void;
}

export interface GuestLink {
  send(message: NetMessage): void;
  close(): void;
}

/**
 * The host's browser keeps the match. Messages travel through the room store
 * both ways, so the players do not need a direct connection.
 */
export async function openHost(
  onMessage: (seat: Seat, message: NetMessage) => void,
  onClose: (seat: Seat) => void,
): Promise<HostLink> {
  const { code, hostId } = await createRoom();
  const taken = new Set<Seat>([0]);
  const seatOf = new Map<string, Seat>();
  const guestOf = new Map<Seat, string>();
  const seen = new Map<string, number>();
  const gone = new Set<string>();
  let stopped = false;

  const assign = (): Seat | null => {
    let seat: Seat = 1;
    for (let i = 0; i < 3; i++) {
      if (!taken.has(seat)) return seat;
      seat = nextSeat(seat);
    }
    return null;
  };

  const poll = async () => {
    while (!stopped) {
      try {
        const box = await hostBox(code, hostId, Object.fromEntries(seen));
        for (const guest of box.guests) {
          if (gone.has(guest.id) || !seatOf.has(guest.id)) continue;
          if (box.now - guest.lastSeen <= STALE_MS) continue;
          const seat = seatOf.get(guest.id);
          gone.add(guest.id);
          if (seat != null) {
            taken.delete(seat);
            seatOf.delete(guest.id);
            guestOf.delete(seat);
            onClose(seat);
          }
          void leaveRoom(code, guest.id).catch(() => undefined);
        }
        const arrivals = box.guests
          .filter((guest) => !gone.has(guest.id) && !seatOf.has(guest.id))
          .sort((a, b) => a.enteredAt - b.enteredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const guest of arrivals) {
          const seat = assign();
          if (seat == null) continue;
          taken.add(seat);
          seatOf.set(guest.id, seat);
          guestOf.set(seat, guest.id);
          onMessage(seat, { type: "hello", name: guest.name });
        }
        for (const item of box.mail) {
          seen.set(item.guestId, item.n + 1);
          const seat = seatOf.get(item.guestId);
          if (seat == null || gone.has(item.guestId)) continue;
          const decoded = decode(item.body);
          if (decoded) onMessage(seat, decoded);
        }
      } catch {
        // The next poll retries. A dropped poll should not close the table.
      }
      await delay(700);
    }
  };
  void poll();

  return {
    code,
    send(seat, message) {
      const guestId = guestOf.get(seat);
      if (!guestId) return;
      void deliver(code, guestId, "toGuest", encode(message), hostId);
    },
    close() {
      stopped = true;
      void closeRoom(code, hostId).catch(() => undefined);
    },
  };
}

export async function openGuest(
  code: string,
  name: string,
  onMessage: (message: NetMessage) => void,
  onClose?: () => void,
): Promise<GuestLink> {
  const guestId = await enterRoom(code, name);
  let after = 0;
  let stopped = false;

  const poll = async () => {
    while (!stopped) {
      try {
        const mail = await guestBox(code, guestId, after);
        for (const item of mail) {
          after = item.n + 1;
          const decoded = decode(item.body);
          if (decoded) onMessage(decoded);
        }
      } catch (error) {
        const missing = error instanceof Error && /not in the room|does not exist|closed the room/.test(error.message);
        if (missing) {
          if (!stopped) onClose?.();
          stopped = true;
          return;
        }
      }
      await delay(500);
    }
  };
  void poll();

  return {
    send(message) {
      void deliver(code, guestId, "toHost", encode(message));
    },
    close() {
      stopped = true;
      void leaveRoom(code, guestId).catch(() => undefined);
    },
  };
}

async function deliver(
  code: string,
  guestId: string,
  box: "toHost" | "toGuest",
  body: string,
  hostId?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await postMail(code, guestId, box, body, hostId);
      return;
    } catch {
      await delay(300);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { Names };
