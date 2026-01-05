import { BinaryMessageType } from './types.js';

export interface BinaryHeader {
  messageType: number;
  timestampUs: number;
}

export const BINARY_HEADER_FORMAT = '>Bq';
export const BINARY_HEADER_SIZE = 9;

export function unpackBinaryHeader(data: Buffer | Uint8Array): BinaryHeader {
  if (data.byteLength < BINARY_HEADER_SIZE) {
    throw new Error(`Expected at least ${BINARY_HEADER_SIZE} bytes, got ${data.byteLength}`);
  }
  const buffer = Buffer.from(data);
  const messageType = buffer.readUInt8(0);
  const timestampUs = Number(buffer.readBigInt64BE(1));
  return { messageType, timestampUs };
}

export function packBinaryHeader(header: BinaryHeader): Buffer {
  const buffer = Buffer.alloc(BINARY_HEADER_SIZE);
  buffer.writeUInt8(header.messageType, 0);
  buffer.writeBigInt64BE(BigInt(header.timestampUs), 1);
  return buffer;
}

export function packBinaryHeaderRaw(messageType: BinaryMessageType | number, timestampUs: number): Buffer {
  return packBinaryHeader({ messageType: Number(messageType), timestampUs });
}
