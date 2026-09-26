import type { Seat } from "../engine/domino";
import { nextSeat } from "../engine/domino";
import type { Names, NetMessage } from "./messages";
import { decode, encode } from "./messages";
import { createRoom, joinRoom, pollGuest, pollHost, publishAnswer, publishCandidate } from "./signalClient";
import { addCandidate, collectIce, localDescription, peerConnection } from "./webrtc";

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
 * The host's browser keeps one direct connection per guest.
 * Guests only talk to the host. The doorbell is used until the channel opens.
 */
export async function openHost(
  onMessage: (seat: Seat, message: NetMessage) => void,
  onClose: (seat: Seat) => void,
): Promise<HostLink> {
  const code = await createRoom();
  const taken = new Set<Seat>([0]);
  const channels = new Map<Seat, RTCDataChannel>();
  const peers: RTCPeerConnection[] = [];
  const peerByGuest = new Map<string, RTCPeerConnection>();
  const answered = new Set<string>();
  const remoteReady = new Set<string>();
  const appliedCandidates = new Map<string, number>();
  let stopped = false;

  const assign = (): Seat | null => {
    let seat: Seat = 1;
    for (let i = 0; i < 3; i++) {
      if (!taken.has(seat)) return seat;
      seat = nextSeat(seat);
    }
    return null;
  };

  const accept = async (guestId: string, offer: string) => {
    const seat = assign();
    if (seat == null) return;
    taken.add(seat);
    const pc = peerConnection();
    peers.push(pc);
    peerByGuest.set(guestId, pc);
    try {
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channels.set(seat, channel);
        channel.onmessage = (message) => {
          const decoded = decode(String(message.data));
          if (decoded) onMessage(seat, decoded);
        };
        channel.onclose = () => {
          channels.delete(seat);
          taken.delete(seat);
          onClose(seat);
        };
      };
      const trickle = (json: string) => {
        void publishCandidate(code, guestId, "host", json).catch(() => undefined);
      };
      const gathering = collectIce(pc, trickle);
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      remoteReady.add(guestId);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathering;
      const answer = await localDescription(pc);
      await publishAnswer(code, guestId, answer);
    } catch {
      taken.delete(seat);
      answered.delete(guestId);
      remoteReady.delete(guestId);
      peerByGuest.delete(guestId);
      pc.close();
    }
  };

  const applyGuestCandidates = async (guestId: string, incoming: string[]) => {
    const pc = peerByGuest.get(guestId);
    if (!pc || !remoteReady.has(guestId)) return;
    const seen = appliedCandidates.get(guestId) ?? 0;
    if (incoming.length <= seen) return;
    for (const json of incoming.slice(seen)) await addCandidate(pc, json);
    appliedCandidates.set(guestId, incoming.length);
  };

  const poll = async () => {
    while (!stopped) {
      try {
        const guests = await pollHost(code);
        for (const guest of guests) {
          if (!answered.has(guest.id)) {
            answered.add(guest.id);
            void accept(guest.id, guest.offer);
          }
          void applyGuestCandidates(guest.id, guest.candidates);
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
      const channel = channels.get(seat);
      if (channel && channel.readyState === "open") channel.send(encode(message));
    },
    close() {
      stopped = true;
      for (const channel of channels.values()) channel.close();
      for (const pc of peers) pc.close();
      channels.clear();
    },
  };
}

export async function openGuest(
  code: string,
  name: string,
  onMessage: (message: NetMessage) => void,
  onClose?: () => void,
): Promise<GuestLink> {
  const pc = peerConnection();
  const channel = pc.createDataChannel("game");
  let failed = false;
  channel.onerror = () => {
    failed = true;
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") failed = true;
  };
  channel.onmessage = (message) => {
    const decoded = decode(String(message.data));
    if (decoded) onMessage(decoded);
  };
  channel.onclose = () => onClose?.();
  let guestId = "";
  const earlyCandidates: string[] = [];
  const trickle = (json: string) => {
    if (!guestId) earlyCandidates.push(json);
    else void publishCandidate(code, guestId, "guest", json).catch(() => undefined);
  };
  const gathering = collectIce(pc, trickle);
  await pc.setLocalDescription(await pc.createOffer());
  await gathering;
  const offer = await localDescription(pc);
  guestId = await joinRoom(code, offer);
  for (const json of earlyCandidates) void publishCandidate(code, guestId, "guest", json).catch(() => undefined);
  await waitUntilOpen(pc, channel, code, guestId, () => failed);
  channel.send(encode({ type: "hello", name }));
  return {
    send(message) {
      if (channel.readyState === "open") channel.send(encode(message));
    },
    close() {
      channel.close();
      pc.close();
    },
  };
}

async function waitUntilOpen(
  pc: RTCPeerConnection,
  channel: RTCDataChannel,
  code: string,
  guestId: string,
  hasFailed: () => boolean,
): Promise<void> {
  const started = Date.now();
  let remoteSet = false;
  let applied = 0;
  while (channel.readyState !== "open") {
    if (hasFailed() || pc.connectionState === "failed") throw new Error("The direct connection failed.");
    if (Date.now() - started > 25000) {
      throw new Error(
        remoteSet
          ? "The host answered, but the direct connection did not open."
          : "The host did not answer. Ask them to keep the room open.",
      );
    }
    const status = await pollGuest(code, guestId);
    if (status.answer && !remoteSet) {
      await pc.setRemoteDescription({ type: "answer", sdp: status.answer });
      remoteSet = true;
    }
    if (remoteSet) {
      for (const json of status.candidates.slice(applied)) await addCandidate(pc, json);
      applied = status.candidates.length;
    }
    await delay(400);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { Names };
