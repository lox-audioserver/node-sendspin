/**
 * Server-side driver for the cleartext init exchange and the KKpsk2 handshake.
 *
 * The sequence, all of it before a single application message:
 *
 *   1. client -> `client/init`  {client_id, version, suite}   (cleartext TEXT)
 *   2. server -> `server/init`  {server_id, version}          (cleartext TEXT)
 *   3. server -> `noise/handshake` message 1, payload {psk_id}
 *   4. client -> `noise/handshake` message 2, payload {}
 *   5. transport mode: binary frames only
 *
 * The two init frames are concatenated verbatim into the Noise prologue, so a
 * tampered suite or identity fails the handshake rather than silently downgrading
 * anything. Steps 2 and 3 go out back-to-back — the spec has the server wait for
 * nothing in between.
 */

import {
  b64urlDecode,
  b64urlEncode,
  Identity,
  NOISE_PROTOCOL_VERSION,
  peerIdToPublicKey,
  PSK_SIZE,
  SENTINEL_PSK,
  SENTINEL_PSK_ID,
  pskIdFor,
} from './keys.js';
import { NoiseSession, SUPPORTED_SUITES, type NoiseCipherSuite } from './session.js';
import { NoiseTransport } from './wire.js';

/** Raised when the handshake cannot complete. The caller closes the socket silently. */
export class HandshakeAbortedError extends Error {}

/** How a connection was admitted, which is what its trust ultimately rests on. */
export enum PskCategory {
  /** The published Sentinel PSK: authenticates nothing. Unpaired playback only. */
  SENTINEL = 'sentinel',
  /** A stored per-client credential from a completed pairing. */
  LONG_TERM = 'long_term',
}

export interface ResolvedPsk {
  pskId: string;
  psk: Buffer;
  category: PskCategory;
}

/** The Sentinel PSK as a resolved record, which is what unpaired access admits with. */
export const SENTINEL_RESOLVED: ResolvedPsk = {
  pskId: SENTINEL_PSK_ID,
  psk: SENTINEL_PSK,
  category: PskCategory.SENTINEL,
};

/**
 * Given a `client_id`, return the PSK that admits it, or null to refuse.
 *
 * A host that has no pairing store returns {@link SENTINEL_RESOLVED} to admit
 * everyone for unpaired playback. Returning null aborts before `server/init` goes
 * out, so a client we will not admit never even learns our identity.
 */
export type PskProvider = (clientId: string) => ResolvedPsk | null | Promise<ResolvedPsk | null>;

export interface HandshakeResult {
  transport: NoiseTransport;
  session: NoiseSession;
  /** The client's static public key, base64url — its authenticated `client_id`. */
  clientId: string;
  suite: NoiseCipherSuite;
  psk: ResolvedPsk;
  /** The Noise handshake hash, which a pairing exchange would bind to. */
  handshakeHash: Buffer;
  /** The prologue, kept so a re-handshake can reuse it. */
  prologue: Buffer;
}

/** What the driver wants sent, in order, as cleartext TEXT frames. */
export interface HandshakeStep1 {
  /** `server/init` followed by `noise/handshake` message 1. */
  send: string[];
  /** Feed the client's `noise/handshake` message 2 here to finish. */
  finish: (message2Text: string) => HandshakeResult;
}

function parseJson(text: string, what: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HandshakeAbortedError(`malformed ${what}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new HandshakeAbortedError(`malformed ${what}`);
  return parsed as Record<string, any>;
}

/** Whether a first frame is the start of an encrypted connection. */
export function isClientInit(text: string): boolean {
  try {
    return (JSON.parse(text) as { type?: unknown })?.type === 'client/init';
  } catch {
    return false;
  }
}

/**
 * Begin the server-side handshake from the client's `client/init` frame.
 *
 * Split into "what to send" and a `finish` callback rather than owning the socket,
 * so the session keeps one place where bytes go out and the whole exchange stays
 * testable without a WebSocket.
 */
export async function beginServerHandshake(options: {
  clientInitText: string;
  identity: Identity;
  pskProvider: PskProvider;
}): Promise<HandshakeStep1> {
  const { clientInitText, identity, pskProvider } = options;
  const init = parseJson(clientInitText, 'client/init');
  if (init.type !== 'client/init') {
    throw new HandshakeAbortedError(`expected client/init, got ${String(init.type)}`);
  }
  const payload = (init.payload ?? {}) as Record<string, any>;
  if (payload.version !== NOISE_PROTOCOL_VERSION) {
    throw new HandshakeAbortedError(`unsupported protocol version ${String(payload.version)}`);
  }
  const suite = payload.suite as NoiseCipherSuite;
  if (!SUPPORTED_SUITES.includes(suite)) {
    throw new HandshakeAbortedError(`unsupported suite ${String(payload.suite)}`);
  }
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
  const clientStaticPub = peerIdToPublicKey(clientId, 'client_id');

  // Resolve the PSK and build message 1 before sending anything, so a client we
  // will not admit is dropped without ever seeing server/init.
  const resolved = await pskProvider(clientId);
  if (!resolved) throw new HandshakeAbortedError(`no PSK admits client_id=${clientId}`);
  if (resolved.psk.length !== PSK_SIZE) throw new HandshakeAbortedError('PSK must be 32 bytes');

  const serverInitText = JSON.stringify({
    type: 'server/init',
    payload: { server_id: identity.peerId, version: NOISE_PROTOCOL_VERSION },
  });
  const prologue = Buffer.concat([
    Buffer.from(clientInitText, 'utf8'),
    Buffer.from(serverInitText, 'utf8'),
  ]);
  const session = NoiseSession.asInitiator({
    suite,
    localStaticPriv: identity.privateBytes,
    remoteStaticPub: clientStaticPub,
    prologue,
    psk: resolved.psk,
  });

  const message1 = session.writeMessage(
    Buffer.from(JSON.stringify({ psk_id: resolved.pskId }), 'utf8'),
  );

  return {
    send: [serverInitText, packHandshake(message1)],
    finish: (message2Text: string): HandshakeResult => {
      const parsed = parseJson(message2Text, 'noise/handshake');
      if (parsed.type !== 'noise/handshake') {
        throw new HandshakeAbortedError(`expected noise/handshake, got ${String(parsed.type)}`);
      }
      const data = (parsed.payload ?? {}).data;
      if (typeof data !== 'string') {
        throw new HandshakeAbortedError('malformed noise/handshake payload');
      }
      let ciphertext: Buffer;
      try {
        ciphertext = b64urlDecode(data);
      } catch {
        throw new HandshakeAbortedError('malformed Noise message 2 encoding');
      }
      let plaintext: Buffer;
      try {
        plaintext = session.readMessage(ciphertext);
      } catch {
        throw new HandshakeAbortedError('Noise message 2 failed authentication');
      }
      // The payload is an empty object; anything else means we are not talking to
      // what we think we are.
      parseJson(plaintext.toString('utf8'), 'Noise message 2 payload');
      return {
        transport: new NoiseTransport(session),
        session,
        clientId,
        suite,
        psk: resolved,
        handshakeHash: session.handshakeHash,
        prologue,
      };
    },
  };
}

function packHandshake(noiseBytes: Buffer): string {
  return JSON.stringify({
    type: 'noise/handshake',
    payload: { data: b64urlEncode(noiseBytes) },
  });
}

export { pskIdFor };
