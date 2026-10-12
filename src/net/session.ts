import type { Seat } from "../engine/domino";
import type { Names, NetMessage } from "./messages";
import { decode, encode } from "./messages";
import { isSeat } from "./messages";
import { emptyPlan, placeGuest, swapSeats, syncRoster, type RosterState, type SeatPlan } from "./seats";
import { closeRoom, createRoom, enterRoom, guestBox, hostBox, leaveRoom, postMail } from "./signalClient";

/** Matches the server. A background tab can pause timers for about a minute. */
const STALE_MS = 180_000;

export interface HostLink {
  code: string;
  send(seat: Seat, message: NetMessage): void;
  /** Swap two chairs before the deal. One of them may be the host, and one may be a bot. */
  swap(a: Seat, b: Seat): void;
  close(): void;
}

export interface GuestLink {
  id: string;
  epoch: number;
  send(message: NetMessage): Promise<void>;
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
  let roster: RosterState = { plan: emptyPlan(), away: [] };
  const homes: Record<string, Seat> = {};
  const seatOf = new Map<string, Seat>();
  const guestOf = new Map<Seat, string>();
  const seen = new Map<string, number>();
  const returnedEpoch = new Map<string, number>();
  let stopped = false;

  const syncMaps = (plan: SeatPlan): void => {
    seatOf.clear();
    guestOf.clear();
    ([0, 1, 2, 3] as Seat[]).forEach((seat) => {
      const id = plan.guests[seat];
      if (!id) return;
      seatOf.set(id, seat);
      guestOf.set(seat, id);
      homes[id] = seat;
    });
  };

  const poll = async () => {
    while (!stopped) {
      try {
        const box = await hostBox(code, hostId, Object.fromEntries(seen));
        const next = syncRoster(roster, box.guests, box.now, STALE_MS, homes);
        const dropped = new Map(next.events.filter((event) => event.type === "dropped").map((event) => [event.id, event.seat]));
        roster = next.state;
        syncMaps(roster.plan);
        for (const event of next.events) {
          if (event.type === "joined") onMessage(event.seat, { type: "hello", name: event.name });
        }
        for (const item of box.mail) {
          seen.set(item.guestId, item.n + 1);
          const seat = seatOf.get(item.guestId) ?? dropped.get(item.guestId);
          if (seat == null) continue;
          const decoded = decode(item.body);
          if (!decoded) continue;
          if (decoded.type === "away") {
            const seenEpoch = returnedEpoch.get(item.guestId) ?? 0;
            if (decoded.epoch < seenEpoch) continue;
            onClose(seat);
            continue;
          }
          if (decoded.type === "rejoin") {
            const seenEpoch = returnedEpoch.get(item.guestId) ?? 0;
            if (decoded.epoch < seenEpoch) continue;
            returnedEpoch.set(item.guestId, decoded.epoch);
            let seated = seatOf.get(item.guestId);
            if (seated == null) {
              const preferred = homes[item.guestId] ?? decoded.seat;
              const placed = placeGuest(roster.plan, item.guestId, isSeat(preferred) ? preferred : null);
              if (!placed) continue;
              roster = { plan: placed.plan, away: roster.away.filter((id) => id !== item.guestId) };
              syncMaps(roster.plan);
              seated = placed.seat;
            }
            onMessage(seated, decoded);
            continue;
          }
          onMessage(seat, decoded);
        }
        for (const event of next.events) {
          if (event.type === "dropped") {
            delete homes[event.id];
            returnedEpoch.delete(event.id);
            onClose(event.seat);
          } else if (event.type === "left") onClose(event.seat);
          else if (event.type === "back") onMessage(event.seat, { type: "rejoin", name: event.name, epoch: 1, seat: event.seat });
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
    swap(a, b) {
      roster = { ...roster, plan: swapSeats(roster.plan, a, b) };
      syncMaps(roster.plan);
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
  resume?: { guestId: string; epoch: number; seat: Seat | null },
): Promise<GuestLink> {
  const requested = resume?.guestId ?? "";
  const epoch = resume && resume.epoch > 0 ? Math.floor(resume.epoch) : 1;
  const guestId = await enterRoom(code, name, requested || undefined);
  const resumed = Boolean(requested) && guestId === requested;
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
  if (resumed) {
    void deliver(code, guestId, "toHost", encode({ type: "rejoin", name, epoch, seat: resume?.seat ?? null }));
  }

  return {
    id: guestId,
    epoch: resumed ? epoch : 1,
    send(message) {
      return deliver(code, guestId, "toHost", encode(message));
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
