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
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    if (seat === plan.host || plan.guests[seat]) continue;
    const guests = [...plan.guests] as SeatPlan["guests"];
    guests[seat] = guestId;
    return { plan: { host: plan.host, guests }, seat };
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
