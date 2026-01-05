import EventEmitter from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

import { type RoleName, Roles } from '../types.js';
import { ClientAddedEvent, ClientRemovedEvent, SendspinEvent } from './events.js';
import { ServerClient, ServerClientOptions } from './server-client.js';

export interface SendspinServerOptions {
  path?: string;
  defaultRoles?: RoleName[];
  serverVersion?: number;
}

export interface StartOptions extends SendspinServerOptions {
  port?: number;
  host?: string;
}

export class SendspinServer extends EventEmitter {
  private readonly serverId: string;
  private readonly serverName: string;
  private readonly opts: SendspinServerOptions;
  private wss?: WebSocketServer;
  private clients = new Set<ServerClient>();

  constructor(serverId: string, serverName: string, opts: SendspinServerOptions = {}) {
    super();
    this.serverId = serverId;
    this.serverName = serverName;
    this.opts = opts;
  }

  get connectedClients(): ReadonlySet<ServerClient> {
    return this.clients;
  }

  async start(options: StartOptions = {}): Promise<void> {
    if (this.wss) return;
    const port = options.port ?? 8927;
    const host = options.host ?? '0.0.0.0';
    const path = options.path ?? this.opts.path ?? '/sendspin';

    this.wss = new WebSocketServer({ port, host, path });
    this.wss.on('connection', (ws) => this.registerClient(ws, 'incoming'));
  }

  async stop(): Promise<void> {
    for (const client of [...this.clients]) {
      client.close();
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
      this.wss = undefined;
    });
  }

  connectToClient(url: string): void {
    const ws = new WebSocket(url);
    ws.on('open', () => this.registerClient(ws, 'outgoing'));
    ws.on('error', () => ws.close());
  }

  private registerClient(ws: WebSocket, side: 'incoming' | 'outgoing'): void {
    const opts: ServerClientOptions = {
      connectionSide: side,
      defaultRoles: this.opts.defaultRoles,
      serverId: this.serverId,
      serverName: this.serverName,
      serverVersion: this.opts.serverVersion,
    };
    const client = new ServerClient(ws, opts);
    this.clients.add(client);
    this.emitEvent(new ClientAddedEvent(client.clientId ?? 'unknown'));

    client.on('disconnect', () => {
      this.clients.delete(client);
      this.emitEvent(new ClientRemovedEvent(client.clientId ?? 'unknown'));
    });
  }

  private emitEvent(event: SendspinEvent): void {
    this.emit(event.type, event);
  }
}
