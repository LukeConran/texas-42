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

/** Wait until local candidates are folded into the description, or until the cap. */
export function waitForIce(pc: RTCPeerConnection, ms = 2500): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export async function localDescription(pc: RTCPeerConnection): Promise<string> {
  await waitForIce(pc);
  const description = pc.localDescription?.sdp;
  if (!description) throw new Error("The connection description was empty.");
  return description;
}
