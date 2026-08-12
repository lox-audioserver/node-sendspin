/**
 * X25519 identity keys, base64url helpers, and `psk_id` derivation.
 *
 * A Sendspin peer's identity *is* its X25519 public key: `client_id` and
 * `server_id` are that key base64url-encoded, which is why they are exactly 43
 * characters. Under encryption there is nothing else to authenticate against.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/** Core protocol version carried in `client/init` / `server/init`. */
export const NOISE_PROTOCOL_VERSION = 1;

export const PSK_SIZE = 32;
export const X25519_KEY_SIZE = 32;

/** Length of a base64url-encoded peer id (a 32-byte key, unpadded). */
export const PEER_ID_SIZE = 43;

const PSK_ID_LABEL = Buffer.from('sendspin-psk-id-v1', 'ascii');

/**
 * The published constant PSK used when no other PSK applies.
 *
 * It is public, so it authenticates nothing — it exists so that an unpaired
 * connection can still run the same encrypted handshake as a paired one, giving
 * confidentiality against a passive listener without a pairing exchange first.
 * Treat any connection admitted by it as unauthenticated.
 */
export const SENTINEL_PSK: Buffer = createHash('sha256')
  .update('sendspin-sentinel-psk-v1', 'ascii')
  .digest();

/** DER prefixes for wrapping a raw 32-byte X25519 key, which node's API requires. */
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function b64urlEncode(data: Buffer): string {
  return data.toString('base64url');
}

/** Decode base64url, tolerating missing padding. Throws on invalid input. */
export function b64urlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
    throw new Error('invalid base64url');
  }
  return Buffer.from(value, 'base64url');
}

/** The `psk_id` a peer uses to name a PSK without revealing it. */
export function pskIdFor(psk: Buffer): string {
  if (psk.length !== PSK_SIZE) {
    throw new Error(`PSK must be ${PSK_SIZE} bytes, got ${psk.length}`);
  }
  return b64urlEncode(createHash('sha256').update(PSK_ID_LABEL).update(psk).digest());
}

/** `psk_id` of the Sentinel PSK, precomputed since every unpaired handshake names it. */
export const SENTINEL_PSK_ID = pskIdFor(SENTINEL_PSK);

export function generatePsk(): Buffer {
  return randomBytes(PSK_SIZE);
}

function privateKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== X25519_KEY_SIZE) {
    throw new Error(`X25519 private key must be ${X25519_KEY_SIZE} bytes, got ${raw.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== X25519_KEY_SIZE) {
    throw new Error(`X25519 public key must be ${X25519_KEY_SIZE} bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Raw 32 bytes out of a node key object, stripping the DER wrapper again. */
function rawFromPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - X25519_KEY_SIZE));
}

function rawFromPrivateKey(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return Buffer.from(der.subarray(der.length - X25519_KEY_SIZE));
}

/** X25519 shared secret, as Noise's `DH()`. */
export function dh(privateRaw: Buffer, publicRaw: Buffer): Buffer {
  return diffieHellman({
    privateKey: privateKeyFromRaw(privateRaw),
    publicKey: publicKeyFromRaw(publicRaw),
  });
}

/** The public half of a raw X25519 private key. */
export function publicFromPrivate(privateRaw: Buffer): Buffer {
  return rawFromPublicKey(createPublicKey(privateKeyFromRaw(privateRaw)));
}

/** A fresh ephemeral keypair, as Noise's `GENERATE_KEYPAIR()`. */
export function generateKeypair(): { privateRaw: Buffer; publicRaw: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { privateRaw: rawFromPrivateKey(privateKey), publicRaw: rawFromPublicKey(publicKey) };
}

/**
 * A Sendspin static identity: the long-term X25519 keypair whose public half is
 * this peer's `server_id`.
 *
 * Persist `privateB64u` and reload it with {@link Identity.fromPrivateB64u} — a
 * server that regenerates its identity looks like a different server to every
 * client that had paired with it.
 */
export class Identity {
  private constructor(
    readonly privateBytes: Buffer,
    readonly publicBytes: Buffer,
  ) {}

  static generate(): Identity {
    const { privateRaw, publicRaw } = generateKeypair();
    return new Identity(privateRaw, publicRaw);
  }

  static fromPrivateBytes(privateBytes: Buffer): Identity {
    const key = privateKeyFromRaw(privateBytes);
    const publicBytes = rawFromPublicKey(createPublicKey(key));
    return new Identity(Buffer.from(privateBytes), publicBytes);
  }

  static fromPrivateB64u(value: string): Identity {
    return Identity.fromPrivateBytes(b64urlDecode(value));
  }

  /** The base64url public key — this peer's `server_id` / `client_id`. */
  get peerId(): string {
    return b64urlEncode(this.publicBytes);
  }

  /** The private key, base64url-encoded, for persistence. */
  get privateB64u(): string {
    return b64urlEncode(this.privateBytes);
  }
}

/** Decode a peer id to its raw public key, rejecting anything malformed. */
export function peerIdToPublicKey(peerId: string, what: string): Buffer {
  if (peerId.length !== PEER_ID_SIZE) {
    throw new Error(`invalid ${what} length: ${peerId.length} (expected ${PEER_ID_SIZE})`);
  }
  let decoded: Buffer;
  try {
    decoded = b64urlDecode(peerId);
  } catch {
    throw new Error(`invalid ${what} encoding`);
  }
  if (decoded.length !== X25519_KEY_SIZE) {
    throw new Error(
      `invalid ${what}: decoded to ${decoded.length} bytes (expected ${X25519_KEY_SIZE})`,
    );
  }
  return decoded;
}
