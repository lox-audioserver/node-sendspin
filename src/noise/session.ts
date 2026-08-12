/**
 * Noise KKpsk2 — handshake and transport, no I/O.
 *
 * Implemented directly on `node:crypto` rather than pulled in as a dependency:
 * every primitive Noise needs (X25519, ChaCha20-Poly1305, AES-256-GCM,
 * HMAC-SHA256) is already there, and correctness is pinned by interop tests
 * against `noiseprotocol`, the same library the reference server uses.
 *
 * The pattern, from the Noise spec:
 *
 *     KKpsk2:
 *       -> s
 *       <- s
 *       ...
 *       -> e, es, ss
 *       <- e, ee, se, psk
 *
 * Both statics are known before the handshake starts — they arrive in the
 * cleartext `client/init` / `server/init` exchange — and the PSK is mixed at the
 * second message. That placement is what lets a responder read message 1 before
 * it knows which PSK to use: the `psk_id` it needs is inside message 1's
 * encrypted payload.
 *
 * In Sendspin the **server is the initiator** and the client the responder.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { dh, generateKeypair, publicFromPrivate, PSK_SIZE, X25519_KEY_SIZE } from './keys.js';

export const HASH_LEN = 32;
export const TAG_LEN = 16;
export const MAX_NONCE = 2n ** 64n - 1n;

export type NoiseCipherSuite = '25519_ChaChaPoly_SHA256' | '25519_AESGCM_SHA256';

export const SUPPORTED_SUITES: readonly NoiseCipherSuite[] = [
  '25519_ChaChaPoly_SHA256',
  '25519_AESGCM_SHA256',
];

export class NoiseError extends Error {}

const EMPTY = Buffer.alloc(0);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const part of parts) h.update(part);
  return h.digest();
}

function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
  const h = createHmac('sha256', key);
  for (const part of parts) h.update(part);
  return h.digest();
}

/** Noise's `HKDF`, in the 2- and 3-output forms the spec uses. */
function hkdf(chainingKey: Buffer, ikm: Buffer, outputs: 2): [Buffer, Buffer];
function hkdf(chainingKey: Buffer, ikm: Buffer, outputs: 3): [Buffer, Buffer, Buffer];
function hkdf(chainingKey: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const tempKey = hmac(chainingKey, ikm);
  const o1 = hmac(tempKey, Buffer.from([0x01]));
  const o2 = hmac(tempKey, o1, Buffer.from([0x02]));
  if (outputs === 2) return [o1, o2];
  return [o1, o2, hmac(tempKey, o2, Buffer.from([0x03]))];
}

/**
 * The 96-bit AEAD nonce for counter `n`.
 *
 * Both suites use 32 zero bits followed by the counter, but ChaChaPoly encodes it
 * little-endian and AES-GCM big-endian. Getting this backwards produces a session
 * that authenticates its own traffic perfectly and fails against every peer.
 */
function nonceBytes(suite: NoiseCipherSuite, n: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  if (suite === '25519_AESGCM_SHA256') {
    nonce.writeBigUInt64BE(n, 4);
  } else {
    nonce.writeBigUInt64LE(n, 4);
  }
  return nonce;
}

function algorithmFor(suite: NoiseCipherSuite): 'chacha20-poly1305' | 'aes-256-gcm' {
  return suite === '25519_AESGCM_SHA256' ? 'aes-256-gcm' : 'chacha20-poly1305';
}

/*
 * The AEAD surface we use, declared locally.
 *
 * `createCipheriv` picks its overload from the algorithm string, and a union of
 * two algorithms resolves to the plain non-AEAD type — which has no `setAAD` or
 * `getAuthTag`. Naming the shape ourselves avoids both a cast per call site and a
 * dependency on which AEAD type names the installed @types/node happens to export.
 */
interface AeadCipher {
  setAAD(buffer: Buffer): unknown;
  update(data: Buffer): Buffer;
  final(): Buffer;
  getAuthTag(): Buffer;
}

interface AeadDecipher {
  setAAD(buffer: Buffer): unknown;
  setAuthTag(tag: Buffer): unknown;
  update(data: Buffer): Buffer;
  final(): Buffer;
}

/** Noise `CipherState`: a key plus a nonce counter. */
class CipherState {
  private key: Buffer | null = null;
  private nonce = 0n;

  constructor(private readonly suite: NoiseCipherSuite) {}

  initializeKey(key: Buffer | null): void {
    this.key = key;
    this.nonce = 0n;
  }

  get hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.key) return plaintext;
    if (this.nonce > MAX_NONCE) throw new NoiseError('nonce exhausted');
    // Both suites default to a 16-byte tag, which is what Noise mandates, so no
    // authTagLength option is needed (and only CCM wants a plaintextLength).
    const cipher = createCipheriv(
      algorithmFor(this.suite),
      this.key,
      nonceBytes(this.suite, this.nonce),
    ) as unknown as AeadCipher;
    cipher.setAAD(ad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.nonce += 1n;
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.key) return ciphertext;
    if (this.nonce > MAX_NONCE) throw new NoiseError('nonce exhausted');
    if (ciphertext.length < TAG_LEN) throw new NoiseError('ciphertext shorter than the auth tag');
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
    const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
    const decipher = createDecipheriv(
      algorithmFor(this.suite),
      this.key,
      nonceBytes(this.suite, this.nonce),
    ) as unknown as AeadDecipher;
    decipher.setAAD(ad);
    decipher.setAuthTag(tag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // Never advance the nonce on a failed decrypt: the frame did not count.
      throw new NoiseError('failed to authenticate ciphertext');
    }
    this.nonce += 1n;
    return plaintext;
  }
}

/** Noise `SymmetricState`: chaining key, handshake hash, and the handshake cipher. */
class SymmetricState {
  private chainingKey: Buffer;
  h: Buffer;
  readonly cipher: CipherState;

  constructor(protocolName: string, readonly suite: NoiseCipherSuite) {
    const name = Buffer.from(protocolName, 'ascii');
    // Spec: names of HASHLEN bytes or fewer are zero-padded rather than hashed.
    // `Noise_KKpsk2_25519_AESGCM_SHA256` is exactly 32 bytes and takes this branch.
    if (name.length <= HASH_LEN) {
      this.h = Buffer.alloc(HASH_LEN);
      name.copy(this.h);
    } else {
      this.h = sha256(name);
    }
    this.chainingKey = Buffer.from(this.h);
    this.cipher = new CipherState(suite);
    this.cipher.initializeKey(null);
  }

  mixHash(data: Buffer): void {
    this.h = sha256(this.h, data);
  }

  /**
   * Process an `e` token's public key.
   *
   * In a PSK handshake the `e` token does more than the usual `MixHash`: it also
   * calls `MixKey` on the same bytes, so the chaining key absorbs fresh ephemeral
   * entropy before the PSK is mixed in. KKpsk2 is always a PSK handshake, so this
   * always applies — and omitting it produces a handshake that is self-consistent
   * and rejected by every conformant peer.
   */
  mixEphemeral(publicKey: Buffer): void {
    this.mixHash(publicKey);
    this.mixKey(publicKey);
  }

  mixKey(input: Buffer): void {
    const [ck, tempK] = hkdf(this.chainingKey, input, 2);
    this.chainingKey = ck;
    this.cipher.initializeKey(tempK);
  }

  /** `MixKeyAndHash`, used by the `psk` token: it touches both ck and h. */
  mixKeyAndHash(input: Buffer): void {
    const [ck, tempH, tempK] = hkdf(this.chainingKey, input, 3);
    this.chainingKey = ck;
    this.mixHash(tempH);
    this.cipher.initializeKey(tempK);
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** `Split()`: the two transport cipher states, in initiator order. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.chainingKey, EMPTY, 2);
    const c1 = new CipherState(this.suite);
    const c2 = new CipherState(this.suite);
    c1.initializeKey(k1);
    c2.initializeKey(k2);
    return [c1, c2];
  }
}

export interface NoiseSessionOptions {
  suite: NoiseCipherSuite;
  /** Our own static private key. */
  localStaticPriv: Buffer;
  /** The peer's static public key, learned from the cleartext init exchange. */
  remoteStaticPub: Buffer;
  /** Bound into the handshake so the cleartext init cannot be tampered with. */
  prologue: Buffer;
  /**
   * The pre-shared key. An initiator must supply it up front; a responder may
   * omit it and supply it with {@link NoiseSession.mixPsk} once message 1 has
   * named it.
   */
  psk?: Buffer;
}

/**
 * A Noise KKpsk2 session: handshake first, then transport.
 *
 * Create with {@link NoiseSession.asInitiator} (server) or
 * {@link NoiseSession.asResponder} (client).
 */
export class NoiseSession {
  private readonly state: SymmetricState;
  private ephemeral: { privateRaw: Buffer; publicRaw: Buffer } | null = null;
  private remoteEphemeral: Buffer | null = null;
  private psk: Buffer | null;
  private messageIndex = 0;
  private sendCipher: CipherState | null = null;
  private recvCipher: CipherState | null = null;
  private finalHandshakeHash: Buffer | null = null;

  private constructor(
    readonly initiator: boolean,
    readonly suite: NoiseCipherSuite,
    private readonly localStaticPriv: Buffer,
    private readonly localStaticPub: Buffer,
    private readonly remoteStaticPub: Buffer,
    psk: Buffer | null,
    prologue: Buffer,
  ) {
    this.psk = psk;
    this.state = new SymmetricState(`Noise_KKpsk2_${suite}`, suite);
    this.state.mixHash(prologue);
    // KK pre-messages: the initiator's static, then the responder's. Both sides
    // perform the same two MixHash calls, in the same order.
    const initiatorStatic = initiator ? this.localStaticPub : this.remoteStaticPub;
    const responderStatic = initiator ? this.remoteStaticPub : this.localStaticPub;
    this.state.mixHash(initiatorStatic);
    this.state.mixHash(responderStatic);
  }

  private static build(options: NoiseSessionOptions, initiator: boolean): NoiseSession {
    const { suite, localStaticPriv, remoteStaticPub, prologue, psk } = options;
    if (!SUPPORTED_SUITES.includes(suite)) throw new NoiseError(`unsupported suite ${suite}`);
    if (localStaticPriv.length !== X25519_KEY_SIZE) {
      throw new NoiseError('localStaticPriv must be 32 bytes');
    }
    if (remoteStaticPub.length !== X25519_KEY_SIZE) {
      throw new NoiseError('remoteStaticPub must be 32 bytes');
    }
    if (psk && psk.length !== PSK_SIZE) throw new NoiseError('psk must be 32 bytes');
    // Deriving our own static public from the private keeps the pre-message hash
    // honest even if a caller passes a mismatched pair.
    const localStaticPub = publicFromPrivate(localStaticPriv);
    return new NoiseSession(
      initiator,
      suite,
      Buffer.from(localStaticPriv),
      localStaticPub,
      Buffer.from(remoteStaticPub),
      psk ? Buffer.from(psk) : null,
      prologue,
    );
  }

  /** The server side: knows the PSK before the handshake starts. */
  static asInitiator(options: NoiseSessionOptions & { psk: Buffer }): NoiseSession {
    return NoiseSession.build(options, true);
  }

  /** The client side: may learn the PSK from message 1. */
  static asResponder(options: NoiseSessionOptions): NoiseSession {
    return NoiseSession.build(options, false);
  }

  /** Supply the real PSK between reading message 1 and writing message 2. */
  mixPsk(psk: Buffer): void {
    if (psk.length !== PSK_SIZE) throw new NoiseError('psk must be 32 bytes');
    this.psk = Buffer.from(psk);
  }

  get handshakeComplete(): boolean {
    return this.sendCipher !== null;
  }

  /** The 32-byte handshake hash `h`, available once the handshake completes. */
  get handshakeHash(): Buffer {
    if (!this.finalHandshakeHash) {
      throw new NoiseError('handshakeHash is only available after the handshake completes');
    }
    return Buffer.from(this.finalHandshakeHash);
  }

  /** Produce the next outgoing handshake message carrying `payload`. */
  writeMessage(payload: Buffer = EMPTY): Buffer {
    if (this.handshakeComplete) throw new NoiseError('handshake already complete');
    const expectInitiator = this.messageIndex === 0;
    if (expectInitiator !== this.initiator) throw new NoiseError('not our turn to write');
    return this.messageIndex === 0 ? this.writeMessage1(payload) : this.writeMessage2(payload);
  }

  /** Consume the next incoming handshake message; returns its decrypted payload. */
  readMessage(message: Buffer): Buffer {
    if (this.handshakeComplete) throw new NoiseError('handshake already complete');
    const expectInitiator = this.messageIndex === 0;
    if (expectInitiator === this.initiator) throw new NoiseError('not our turn to read');
    return this.messageIndex === 0 ? this.readMessage1(message) : this.readMessage2(message);
  }

  // -- message 1: -> e, es, ss ------------------------------------------------

  private writeMessage1(payload: Buffer): Buffer {
    this.ephemeral = generateKeypair();
    this.state.mixEphemeral(this.ephemeral.publicRaw);
    // es (initiator): DH(e, rs). ss: DH(s, rs).
    this.state.mixKey(dh(this.ephemeral.privateRaw, this.remoteStaticPub));
    this.state.mixKey(dh(this.localStaticPriv, this.remoteStaticPub));
    const encrypted = this.state.encryptAndHash(payload);
    this.messageIndex = 1;
    return Buffer.concat([this.ephemeral.publicRaw, encrypted]);
  }

  private readMessage1(message: Buffer): Buffer {
    if (message.length < X25519_KEY_SIZE) throw new NoiseError('message 1 too short');
    this.remoteEphemeral = Buffer.from(message.subarray(0, X25519_KEY_SIZE));
    this.state.mixEphemeral(this.remoteEphemeral);
    // es (responder): DH(s, re). ss: DH(s, rs).
    this.state.mixKey(dh(this.localStaticPriv, this.remoteEphemeral));
    this.state.mixKey(dh(this.localStaticPriv, this.remoteStaticPub));
    const payload = this.state.decryptAndHash(message.subarray(X25519_KEY_SIZE));
    this.messageIndex = 1;
    return payload;
  }

  // -- message 2: <- e, ee, se, psk -------------------------------------------

  private writeMessage2(payload: Buffer): Buffer {
    if (!this.remoteEphemeral) throw new NoiseError('missing remote ephemeral');
    if (!this.psk) throw new NoiseError('psk required before writing message 2');
    this.ephemeral = generateKeypair();
    this.state.mixEphemeral(this.ephemeral.publicRaw);
    // ee: DH(e, re). se (responder): DH(e, rs).
    this.state.mixKey(dh(this.ephemeral.privateRaw, this.remoteEphemeral));
    this.state.mixKey(dh(this.ephemeral.privateRaw, this.remoteStaticPub));
    this.state.mixKeyAndHash(this.psk);
    const encrypted = this.state.encryptAndHash(payload);
    const out = Buffer.concat([this.ephemeral.publicRaw, encrypted]);
    this.finish();
    return out;
  }

  private readMessage2(message: Buffer): Buffer {
    if (!this.ephemeral) throw new NoiseError('missing local ephemeral');
    if (!this.psk) throw new NoiseError('psk required before reading message 2');
    if (message.length < X25519_KEY_SIZE) throw new NoiseError('message 2 too short');
    this.remoteEphemeral = Buffer.from(message.subarray(0, X25519_KEY_SIZE));
    this.state.mixEphemeral(this.remoteEphemeral);
    // ee: DH(e, re). se (initiator): DH(s, re).
    this.state.mixKey(dh(this.ephemeral.privateRaw, this.remoteEphemeral));
    this.state.mixKey(dh(this.localStaticPriv, this.remoteEphemeral));
    this.state.mixKeyAndHash(this.psk);
    const payload = this.state.decryptAndHash(message.subarray(X25519_KEY_SIZE));
    this.finish();
    return payload;
  }

  private finish(): void {
    const [c1, c2] = this.state.split();
    // The initiator sends with the first key and receives with the second.
    this.sendCipher = this.initiator ? c1 : c2;
    this.recvCipher = this.initiator ? c2 : c1;
    this.finalHandshakeHash = Buffer.from(this.state.h);
  }

  // -- transport -------------------------------------------------------------

  encrypt(plaintext: Buffer): Buffer {
    if (!this.sendCipher) throw new NoiseError('handshake not complete');
    return this.sendCipher.encryptWithAd(EMPTY, plaintext);
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (!this.recvCipher) throw new NoiseError('handshake not complete');
    return this.recvCipher.decryptWithAd(EMPTY, ciphertext);
  }
}

/** Constant-time compare, for anywhere a secret is checked against an expectation. */
export function secretEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
