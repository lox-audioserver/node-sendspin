/**
 * Post-handshake encrypted transport.
 *
 * Once Noise is up every application message travels as a **binary** WebSocket
 * frame holding one Noise transport message. The decrypted plaintext carries a
 * leading type byte: `0` for a JSON control body, `2`/`3` for the two halves of
 * the fragmentation scheme. Role binary messages keep their own first byte (the
 * `BinaryMessageType`), which is why they need no wrapping — the type byte the
 * caller already prefixed *is* the type byte.
 */

import { NoiseError, type NoiseSession } from './session.js';

/** A JSON control body. */
export const MSG_TYPE_JSON_BODY = 0;
/** A fragment with more to follow. */
export const MSG_TYPE_FRAGMENT_MORE = 2;
/** The final fragment of a message. */
export const MSG_TYPE_FRAGMENT_END = 3;

/** Noise's 65535-byte transport limit, minus the 16-byte AEAD tag. */
export const MAX_TRANSPORT_PLAINTEXT = 65535 - 16;

/** Bounds one connection's reassembly buffer against a peer streaming endless fragments. */
export const MAX_REASSEMBLED_MESSAGE_BYTES = 64 * 1024 * 1024;

/** A decrypted application message. */
export type DecryptedFrame =
  | { kind: 'text'; data: string }
  | { kind: 'binary'; data: Buffer };

/**
 * Wraps a Noise session in the Sendspin transport framing.
 *
 * Pure translation: it produces the buffers to put on the wire and consumes the
 * ones that arrive, leaving the socket itself to the caller. That keeps it
 * testable without a WebSocket and lets the session own backpressure.
 */
export class NoiseTransport {
  private reassemblyBuffer: Buffer[] | null = null;
  private reassemblyLength = 0;
  private reassemblyType: number | null = null;

  constructor(private session: NoiseSession) {
    if (!session.handshakeComplete) {
      throw new NoiseError('NoiseSession must be in transport mode before wrapping it');
    }
  }

  /** Replace the session after a re-handshake, dropping any partial message. */
  swapSession(next: NoiseSession): void {
    if (!next.handshakeComplete) {
      throw new NoiseError('replacement NoiseSession must be in transport mode');
    }
    this.session = next;
    this.resetReassembly();
  }

  /** Encrypt a JSON control body into one or more wire frames. */
  encodeText(text: string): Buffer[] {
    return this.encodePlaintext(
      Buffer.concat([Buffer.from([MSG_TYPE_JSON_BODY]), Buffer.from(text, 'utf8')]),
    );
  }

  /**
   * Encrypt an already-typed binary message into one or more wire frames.
   *
   * `data` must start with its role type byte — for us that is whatever
   * `packBinaryHeaderRaw` put there.
   */
  encodeBinary(data: Buffer): Buffer[] {
    if (!data.length) throw new NoiseError('binary payload must include a leading type byte');
    return this.encodePlaintext(data);
  }

  private encodePlaintext(plaintext: Buffer): Buffer[] {
    if (plaintext.length <= MAX_TRANSPORT_PLAINTEXT) {
      return [this.session.encrypt(plaintext)];
    }
    return fragment(plaintext).map((frame) => this.session.encrypt(frame));
  }

  /**
   * Decrypt one wire frame.
   *
   * Returns null while a fragmented message is still being assembled. Throws
   * {@link NoiseError} on anything the transport cannot make sense of — a failed
   * tag, an empty plaintext, a stray frame mid-reassembly — all of which are
   * grounds to drop the connection rather than try to recover.
   */
  decode(frame: Buffer): DecryptedFrame | null {
    const plaintext = this.session.decrypt(frame);
    if (!plaintext.length) {
      this.resetReassembly();
      throw new NoiseError('empty plaintext after Noise decrypt');
    }
    const typeByte = plaintext[0];
    if (typeByte === MSG_TYPE_FRAGMENT_MORE) return this.onFragmentMore(plaintext);
    if (typeByte === MSG_TYPE_FRAGMENT_END) return this.onFragmentEnd(plaintext);
    if (this.reassemblyBuffer) {
      this.resetReassembly();
      throw new NoiseError('non-fragment frame while a fragmented message is in flight');
    }
    return dispatch(plaintext);
  }

  private onFragmentMore(plaintext: Buffer): null {
    if (!this.reassemblyBuffer) {
      if (plaintext.length < 2) {
        throw new NoiseError('fragment-more start frame missing its original type');
      }
      this.reassemblyType = plaintext[1];
      this.reassemblyBuffer = [Buffer.from(plaintext.subarray(2))];
      this.reassemblyLength = plaintext.length - 2;
      return null;
    }
    this.appendFragment(plaintext.subarray(1));
    return null;
  }

  private onFragmentEnd(plaintext: Buffer): DecryptedFrame {
    if (!this.reassemblyBuffer || this.reassemblyType === null) {
      this.resetReassembly();
      throw new NoiseError('fragment-end frame with no fragmented message in flight');
    }
    this.appendFragment(plaintext.subarray(1));
    const reassembled = Buffer.concat([
      Buffer.from([this.reassemblyType]),
      ...this.reassemblyBuffer,
    ]);
    this.resetReassembly();
    return dispatch(reassembled);
  }

  private appendFragment(data: Buffer): void {
    if (this.reassemblyLength + data.length > MAX_REASSEMBLED_MESSAGE_BYTES) {
      this.resetReassembly();
      throw new NoiseError('fragmented message exceeds the maximum reassembly size');
    }
    this.reassemblyBuffer!.push(Buffer.from(data));
    this.reassemblyLength += data.length;
  }

  private resetReassembly(): void {
    this.reassemblyBuffer = null;
    this.reassemblyLength = 0;
    this.reassemblyType = null;
  }
}

function dispatch(plaintext: Buffer): DecryptedFrame {
  if (plaintext[0] === MSG_TYPE_JSON_BODY) {
    return { kind: 'text', data: plaintext.subarray(1).toString('utf8') };
  }
  return { kind: 'binary', data: Buffer.from(plaintext) };
}

/** Split an oversized type-prefixed plaintext into fragment frames. */
export function fragment(plaintext: Buffer): Buffer[] {
  const originalType = plaintext[0];
  const body = plaintext.subarray(1);
  // The opening frame spends two bytes on its header (tag + original type), every
  // continuation only one.
  const firstCapacity = MAX_TRANSPORT_PLAINTEXT - 2;
  const contCapacity = MAX_TRANSPORT_PLAINTEXT - 1;

  const frames: Buffer[] = [
    Buffer.concat([
      Buffer.from([MSG_TYPE_FRAGMENT_MORE, originalType]),
      body.subarray(0, firstCapacity),
    ]),
  ];
  const rest = body.subarray(firstCapacity);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < rest.length; offset += contCapacity) {
    chunks.push(rest.subarray(offset, offset + contCapacity));
  }
  chunks.forEach((chunk, index) => {
    const tag = index === chunks.length - 1 ? MSG_TYPE_FRAGMENT_END : MSG_TYPE_FRAGMENT_MORE;
    frames.push(Buffer.concat([Buffer.from([tag]), chunk]));
  });
  return frames;
}
