import EventEmitter from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import {
  AudioCodec,
  ClientCommandPayload,
  ClientHelloMessage,
  ClientHelloPayload,
  ClientInboundMessage,
  ClientStateMessage,
  ClientStatePayload,
  ClientTimePayload,
  ClientTimeMessage,
  GroupUpdateServerMessage,
  GroupUpdateServerPayload,
  RoleName,
  Roles,
  ServerCommandMessage,
  ServerCommandPayload,
  ServerHelloMessage,
  ServerHelloPayload,
  ServerStateMessage,
  ServerStatePayload,
  ServerTimeMessage,
  ServerTimePayload,
  StreamClearMessage,
  StreamClearPayload,
  StreamEndMessage,
  StreamEndPayload,
  StreamStartMessage,
  StreamStartPayload,
  StreamStartPlayer,
  BinaryMessageType,
  ConnectionReason,
} from '../types.js';
import { packBinaryHeaderRaw } from '../binary.js';

export type ClientConnectionSide = 'incoming' | 'outgoing';

export interface ServerClientOptions {
  connectionSide: ClientConnectionSide;
  defaultRoles?: RoleName[];
  serverId: string;
  serverName: string;
  serverVersion?: number;
}

export interface ClientEventMap {
  hello: (payload: ClientHelloPayload) => void;
  state: (payload: ClientStatePayload) => void;
  command: (payload: ClientCommandPayload) => void;
  disconnect: () => void;
}

export class ServerClient extends EventEmitter {
  private helloPayload?: ClientHelloPayload;
  private readonly ws: WebSocket;
  private readonly opts: ServerClientOptions;
  private readonly defaultRoles: RoleName[];

  constructor(ws: WebSocket, opts: ServerClientOptions) {
    super();
    this.ws = ws;
    this.opts = opts;
    this.defaultRoles = opts.defaultRoles ?? [];
    this.setup();
  }

  get clientId(): string | undefined {
    return this.helloPayload?.client_id;
  }

  get name(): string | undefined {
    return this.helloPayload?.name;
  }

  get roles(): RoleName[] {
    return this.helloPayload?.supported_roles ?? this.defaultRoles;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      return;
    }
    this.ws.close();
  }

  async sendHello(): Promise<void> {
    const payload: ServerHelloPayload = {
      server_id: this.opts.serverId,
      name: this.opts.serverName,
      version: this.opts.serverVersion ?? 1,
      active_roles: this.roles.length ? this.roles : this.defaultRoles,
      connection_reason: ConnectionReason.DISCOVERY,
    };
    const msg: ServerHelloMessage = { type: 'server/hello', payload };
    this.sendJson(msg);
  }

  sendGroupUpdate(payload: GroupUpdateServerPayload): void {
    const msg: GroupUpdateServerMessage = { type: 'group/update', payload };
    this.sendJson(msg);
  }

  sendServerState(payload: ServerStatePayload): void {
    const msg: ServerStateMessage = { type: 'server/state', payload };
    this.sendJson(msg);
  }

  sendServerCommand(payload: ServerCommandPayload): void {
    const msg: ServerCommandMessage = { type: 'server/command', payload };
    this.sendJson(msg);
  }

  sendStreamStart(payload: StreamStartPayload): void {
    const msg: StreamStartMessage = { type: 'stream/start', payload };
    this.sendJson(msg);
  }

  sendStreamClear(payload: StreamClearPayload): void {
    const msg: StreamClearMessage = { type: 'stream/clear', payload };
    this.sendJson(msg);
  }

  sendStreamEnd(payload: StreamEndPayload): void {
    const msg: StreamEndMessage = { type: 'stream/end', payload };
    this.sendJson(msg);
  }

  sendAudioChunk(timestampUs: number, pcmData: Buffer, player?: StreamStartPlayer): void {
    if (player && player.codec !== AudioCodec.PCM) {
      throw new Error('Only PCM chunks are supported in this implementation');
    }
    const header = packBinaryHeaderRaw(BinaryMessageType.AUDIO_CHUNK, timestampUs);
    const payload = Buffer.concat([header, pcmData]);
    this.ws.send(payload);
  }

  private setup(): void {
    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('close', () => this.emit('disconnect'));
    this.ws.on('error', () => this.emit('disconnect'));
  }

  private handleMessage(data: WebSocket.RawData): void {
    if (typeof data === 'string') {
      this.handleJson(data);
    } else if (data instanceof Buffer || data instanceof Uint8Array) {
      // Server currently only cares about binary audio from server to client; ignore inbound binary
    }
  }

  private handleJson(raw: string): void {
    let msg: ClientInboundMessage & { type: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'client/hello': {
        const hello = (msg as ClientHelloMessage).payload;
        this.helloPayload = hello;
        void this.sendHello();
        this.emit('hello', hello);
        break;
      }
      case 'client/time': {
        const payload = (msg as ClientTimeMessage).payload;
        this.respondTime(payload);
        break;
      }
      case 'client/state': {
        const payload = (msg as ClientStateMessage).payload;
        this.emit('state', payload);
        break;
      }
      case 'client/command': {
        const payload = (msg as { payload: ClientCommandPayload }).payload;
        this.emit('command', payload);
        break;
      }
      default:
        break;
    }
  }

  private respondTime(payload: ClientTimePayload): void {
    const nowUs = this.nowUs();
    const response: ServerTimeMessage = {
      type: 'server/time',
      payload: {
        client_transmitted: payload.client_transmitted,
        server_received: nowUs,
        server_transmitted: this.nowUs(),
      },
    };
    this.sendJson(response);
  }

  private sendJson(message: ServerOutboundMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private nowUs(): number {
    return Math.floor(performance.now() * 1000);
  }
}

type ServerOutboundMessage =
  | ServerHelloMessage
  | ServerTimeMessage
  | GroupUpdateServerMessage
  | ServerStateMessage
  | StreamStartMessage
  | StreamClearMessage
  | StreamEndMessage
  | ServerCommandMessage;
