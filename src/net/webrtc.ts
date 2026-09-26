const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export function peerConnection(): RTCPeerConnection {
  const servers = ICE_SERVERS.slice();
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const username = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const credential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;
  if (turnUrl && username && credential) servers.push({ urls: turnUrl, username, credential });
  return new RTCPeerConnection({ iceServers: servers });
}

/**
 * Keep reporting candidates after this resolves. The first description often
 * leaves before the public address is known, and the rest have to follow.
 */
export function collectIce(pc: RTCPeerConnection, onCandidate: (json: string) => void, ms = 4000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        finish();
        return;
      }
      onCandidate(JSON.stringify(event.candidate.toJSON()));
    };
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") finish();
    });
    setTimeout(finish, ms);
  });
}

export async function addCandidate(pc: RTCPeerConnection, json: string): Promise<void> {
  try {
    const init = JSON.parse(json) as RTCIceCandidateInit;
    if (!init || typeof init.candidate !== "string") return;
    await pc.addIceCandidate(init);
  } catch {
    // A duplicate or a candidate that arrived early is safe to skip.
  }
}

export async function localDescription(pc: RTCPeerConnection): Promise<string> {
  const description = pc.localDescription?.sdp;
  if (!description) throw new Error("The connection description was empty.");
  return description;
}
