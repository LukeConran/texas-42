import type { Seat } from "../engine/domino";

/** Who occupies the four chairs. The host is a person, not a guest id. Null is a bot. */
export interface SeatPlan {
  host: Seat;
  guests: [string | null, string | null, string | null, string | null];
}

export function emptyPlan(): SeatPlan {
  return { host: 0, guests: [null, null, null, null] };
}

/** First open chair, skipping the host. The first arrival still lands on the host's left. */
export function claimSeat(plan: SeatPlan, guestId: string): { plan: SeatPlan; seat: Seat } | null {
  return placeGuest(plan, guestId, null);
}

/**
 * Sit a player in the chair they already held. A new player, or a chair that
 * another person took, uses the first open chair instead.
 */
export function placeGuest(
  plan: SeatPlan,
  guestId: string,
  preferred: Seat | null,
): { plan: SeatPlan; seat: Seat } | null {
  const existing = plan.guests.findIndex((id) => id === guestId);
  if (existing >= 0) return { plan, seat: existing as Seat };
  const open = preferred != null && preferred !== plan.host && plan.guests[preferred] == null;
  const seat = open ? preferred : firstOpen(plan);
  if (seat == null) return null;
  const guests = [...plan.guests] as SeatPlan["guests"];
  guests[seat] = guestId;
  return { plan: { host: plan.host, guests }, seat };
}

function firstOpen(plan: SeatPlan): Seat | null {
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    if (seat === plan.host || plan.guests[seat]) continue;
    return seat;
  }
  return null;
}

export function releaseSeat(plan: SeatPlan, guestId: string): SeatPlan {
  const guests = plan.guests.map((id) => (id === guestId ? null : id)) as SeatPlan["guests"];
  return { host: plan.host, guests };
}

/** Swap two chairs. A bot chair is empty. Partners are the chairs across from each other. */
export function swapSeats(plan: SeatPlan, a: Seat, b: Seat): SeatPlan {
  if (a === b) return plan;
  const guests = [...plan.guests] as SeatPlan["guests"];
  const held = guests[a] ?? null;
  guests[a] = guests[b] ?? null;
  guests[b] = held;
  let host = plan.host;
  if (host === a) host = b;
  else if (host === b) host = a;
  return { host, guests };
}

/** Human guests who should receive a copy of the match. The host already has it. */
export function guestSeats(host: Seat, humans: ReadonlySet<Seat>): Seat[] {
  return ([0, 1, 2, 3] as Seat[]).filter((seat) => seat !== host && humans.has(seat));
}

export interface RosterEntry {
  id: string;
  name: string;
  lastSeen: number;
  enteredAt: number;
}

export interface RosterState {
  plan: SeatPlan;
  /** Guest ids whose chair is held while their browser is quiet. */
  away: readonly string[];
}

export type RosterEvent =
  | { type: "joined"; seat: Seat; id: string; name: string }
  | { type: "left"; seat: Seat; id: string; name: string }
  | { type: "back"; seat: Seat; id: string; name: string }
  | { type: "dropped"; seat: Seat; id: string; name: string };

/**
 * Quiet players keep the chair they had. A browser that shows up again sits
 * back down there, even when an earlier chair is empty. Leaving the room
 * for good releases the chair.
 */
export function syncRoster(
  state: RosterState,
  roster: readonly RosterEntry[],
  now: number,
  staleMs: number,
  homes: Readonly<Record<string, Seat>> = {},
): { state: RosterState; events: RosterEvent[] } {
  let plan = state.plan;
  const away = new Set(state.away);
  const events: RosterEvent[] = [];
  const byId = new Map(roster.map((guest) => [guest.id, guest]));

  for (const seat of [0, 1, 2, 3] as Seat[]) {
    const id = plan.guests[seat];
    if (!id) continue;
    const guest = byId.get(id);
    if (!guest) {
      plan = releaseSeat(plan, id);
      away.delete(id);
      events.push({ type: "dropped", seat, id, name: "" });
      continue;
    }
    const stale = now - guest.lastSeen > staleMs;
    if (stale && !away.has(id)) {
      away.add(id);
      events.push({ type: "left", seat, id, name: guest.name });
    } else if (!stale && away.has(id)) {
      away.delete(id);
      events.push({ type: "back", seat, id, name: guest.name });
    }
  }

  const arrivals = roster
    .filter((guest) => !plan.guests.includes(guest.id))
    .sort((a, b) => a.enteredAt - b.enteredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const guest of arrivals) {
    const preferred = homes[guest.id];
    const placed = placeGuest(plan, guest.id, preferred ?? null);
    if (!placed) continue;
    plan = placed.plan;
    const returning = preferred != null && placed.seat === preferred;
    events.push({
      type: returning ? "back" : "joined",
      seat: placed.seat,
      id: guest.id,
      name: guest.name,
    });
  }

  return { state: { plan, away: [...away] }, events };
}
