import type { Seat } from "../engine/domino";
import { nextSeat } from "../engine/domino";
import type { Names, NetMessage } from "./messages";
import { decode, encode } from "./messages";
import { createRoom, joinRoom, pollGuest, pollHost, publishAnswer } from "./signalClient";
import { localDescription, peerConnection } from "./webrtc";

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
  const answered = new Set<string>();
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
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      await pc.setLocalDescription(await pc.createAnswer());
      const answer = await localDescription(pc);
      await publishAnswer(code, guestId, answer);
    } catch {
      taken.delete(seat);
      answered.delete(guestId);
      pc.close();
    }
  };

  const poll = async () => {
    while (!stopped) {
      try {
        const guests = await pollHost(code);
        for (const guest of guests) {
          if (answered.has(guest.id)) continue;
          answered.add(guest.id);
          void accept(guest.id, guest.offer);
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
  const opened = new Promise<void>((resolve, reject) => {
    channel.onopen = () => resolve();
    channel.onerror = () => reject(new Error("The direct connection failed."));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") reject(new Error("The direct connection failed."));
    };
  });
  channel.onmessage = (message) => {
    const decoded = decode(String(message.data));
    if (decoded) onMessage(decoded);
  };
  channel.onclose = () => onClose?.();
  await pc.setLocalDescription(await pc.createOffer());
  const offer = await localDescription(pc);
  const guestId = await joinRoom(code, offer);
  const answer = await waitForAnswer(code, guestId);
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  await Promise.race([opened, delay(12000).then(() => Promise.reject(new Error("The host did not answer.")))]);
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

async function waitForAnswer(code: string, guestId: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const answer = await pollGuest(code, guestId);
    if (answer) return answer;
    await delay(500);
  }
  throw new Error("The host did not answer. Ask them to keep the room open.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { Names };
