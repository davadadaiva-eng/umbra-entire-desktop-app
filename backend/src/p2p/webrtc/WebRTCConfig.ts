/**
 * WebRTC signaling protocol + pluggable media backend for P2P phone control.
 *
 * The PWA (browser) implements a standard RTCPeerConnection. It sends SDP
 * offers/answers and ICE candidates here; the Node side relays them to a
 * pluggable media backend (e.g. werift) that can terminate the media stream.
 *
 * NAT traversal: public STUN servers are used strictly for the initial
 * handshake to establish the direct link — no media ever transits them.
 */

export interface WebRTCConfig {
  enabled: boolean;
  stunServers: string[];
  /** Backend that answers signaling messages with a peer for media. */
  onSignal: (signal: SignalingMessage, deviceId: string) => SignalingMessage | null;
}

export interface RTCSessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp: string;
}

export interface RTCIceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export type SignalingMessage =
  | { kind: 'offer' | 'answer'; description: RTCSessionDescription }
  | { kind: 'candidate'; candidate: RTCIceCandidate }
  | { kind: 'bye' };

export interface PeerMedia {
  /** Ready-to-serve keyframe(s) as JPEG for low-latency preview. */
  snapshot: () => Promise<Buffer | null>;
}

/**
 * NoOpMediaBridge — the default "backend not installed" transport.
 * Keeps the signaling endpoint functional while clients transparently fall
 * back to the encrypted JPEG relay. Swap in werift (or another Node WebRTC
 * implementation) by supplying a real onSignal callback.
 */
export function noOpMediaBridge(stunServers: string[]): WebRTCConfig {
  return {
    enabled: false,
    stunServers,
    onSignal: () => null,
  };
}

export const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];
